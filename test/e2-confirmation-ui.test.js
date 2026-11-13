'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bytes, digest, text } = require('../src/bytes');
const { host, result, stale, button } = require('./helpers/plugin-host');

test('E2: thirty decisions prompt once after completion, unchanged rounds stay quiet and new entries prompt once', async () => {
  const h = await host(), rows = Array.from({ length: 30 }, (_, i) => stale(i + '.md'));
  h.setResult(result({ staleCopies: rows })); await h.p.run('sync', false);
  assert.equal(h.modals.length, 1); assert.match(h.p.statusMessage, /30 个文件等待确认/);
  assert.equal(h.syncCalls, 1); h.p.confirmationModal.close();
  for (let i = 0; i < 5; i++) await h.p.run('sync', false);
  assert.equal(h.modals.length, 1);
  h.setResult(result({ staleCopies: [...rows, stale('new.md')] })); await h.p.run('sync', false);
  assert.equal(h.modals.length, 2);
  h.setResult(result({ staleCopies: [...rows, stale('new.md'), stale('another.md')] })); await h.p.run('sync', false);
  assert.equal(h.modals.length, 2, 'an open window updates without creating another one');
  h.p.confirmationModal.close(); await h.p.run('sync', false); assert.equal(h.modals.length, 2);
  h.commands.get('show-conflicts').callback(); assert.equal(h.modals.length, 3);
  h.commands.get('show-conflicts').callback(); assert.equal(h.modals.length, 3);
});

test('E2: a fifty-file bulk deletion asks for count confirmation and submits exactly one engine operation', async () => {
  const h = await host(), rows = Array.from({ length: 50 }, (_, i) => stale(i + '.md'));
  h.setResult(result({ staleCopies: rows })); await h.p.run('sync', false);
  const modal = h.p.confirmationModal;
  await button(modal, '全部删除本机副本').click();
  assert.equal(h.confirmCalls, 0); assert.ok(modal.contentEl.texts.some(t => /50/.test(t) && /回收站/.test(t)));
  await button(modal, '确认删除本机副本').click();
  assert.equal(h.confirmCalls, 1); assert.equal(h.received[0].length, 50); assert.equal(h.syncCalls, 1);
  assert.ok(h.received[0].every(a => a.kind === 'stale-delete'));
});

test('E2: modified deletion conflicts are excluded from the unchanged bulk action', async () => {
  const h = await host(), entries = [true, false].map((unchanged, i) => ({ path: i + '.md', tips: ['tip-' + i], unchanged,
    files: [{ physical: i + '.md', hash: digest('old') }], devices: ['PC'] }));
  h.setResult(result({ deletionConflicts: entries })); await h.p.run('sync', false);
  const modal = h.p.confirmationModal;
  assert.ok(modal.contentEl.settings.some(row => row.desc?.includes('删除后有改动')));
  await button(modal, '删除内容未变的 1 个').click();
  await button(modal, '确认删除内容未变的文件').click();
  assert.equal(h.confirmCalls, 1); assert.equal(h.received[0].length, 1);
  assert.equal(h.received[0][0].entry.path, '0.md');
});

test('E2: trash callback uses FileManager and preserves changed content or unsaved buffers', async () => {
  const h = await host(), hash = digest('old');
  h.files.set('a.md', bytes('old')); h.files.set('b.md', bytes('edited'));
  h.files.set('c.md', bytes('old'));
  h.setLeaves([{ view: { file: { path: 'c.md' }, getMode: () => 'source', editor: { getValue: () => 'unsaved' } } }]);
  assert.equal(await h.p.trashConfirmed('b.md', hash), false);
  assert.equal(await h.p.trashConfirmed('c.md', hash), false);
  assert.equal(await h.p.trashConfirmed('a.md', hash), true);
  assert.deepEqual([...h.trashed.keys()], ['a.md']);
  assert.equal(text(h.files.get('b.md')), 'edited'); assert.equal(text(h.files.get('c.md')), 'old');
});

test('E2: permanent deletion settings block the whole action and are rechecked immediately before each trash call', async () => {
  const h = await host(); h.setResult(result({ staleCopies: [stale('a.md')] }));
  await h.p.run('sync', false); h.setTrash('none');
  await button(h.p.confirmationModal, '删除本机副本').click();
  assert.equal(h.confirmCalls, 0); assert.equal(h.trashed.size, 0); assert.equal(h.p.confirmationModal.opened, true);
  h.setTrash('local'); h.files.set('a.md', bytes('old'));
  const read = h.engine.local.read;
  h.engine.local.read = async name => { const value = await read(name); h.setTrash('none'); return value; };
  await assert.rejects(h.p.trashConfirmed('a.md', digest('old')), /回收站/);
  assert.equal(h.trashed.size, 0); assert.equal(h.files.has('a.md'), true);
});

for (const change of ['background', 'stopped', 'saved', 'recreated', 'event', 'unsaved']) test(`E2: ${change} after asynchronous validation invalidates permission before trashFile`, async () => {
  const h = await host(); h.files.set('a.md', bytes('old'));
  const validate = h.p.trashToken.bind(h.p);
  h.p.trashToken = async (...args) => {
    const token = await validate(...args);
    if (change === 'background') h.document.visibilityState = 'hidden';
    else if (change === 'stopped') h.p.stopped = true;
    else if (change === 'saved') h.files.set('a.md', bytes('new saved content'));
    else if (change === 'recreated') { h.files.delete('a.md'); h.files.set('a.md', bytes('old')); }
    else if (change === 'event') h.p.scheduler.dirty.set('a.md', 100);
    else h.setLeaves([{ view: { file: { path: 'a.md' }, getMode: () => 'source', editor: { getValue: () => 'unsaved new content' } } }]);
    return token;
  };
  assert.equal(await h.p.trashConfirmed('a.md', digest('old')), false);
  assert.equal(h.trashed.size, 0); assert.equal(h.files.has('a.md'), true);
  if (change === 'saved') assert.equal(text(h.files.get('a.md')), 'new saved content');
});

test('E2: status exposes the waiting count and the completion notice reports skipped items', async () => {
  const h = await host(); h.setResult(result({ staleCopies: [stale('a.md'), stale('b.md')] }));
  await h.p.run('sync', false); h.p.openStatus();
  assert.ok(h.modals.at(-1).contentEl.texts.some(t => t.includes('2 个文件等待确认')));
  h.engine.confirm = async () => ({ ...result(), appliedDecisions: 1, skippedDecisions: [{ path: 'a.md' }] });
  await h.p.run('decide', true, [{ kind: 'resolve', entry: { path: 'a.md' } }]);
  assert.ok(h.notices.some(t => t.includes('已处理 1 个，跳过 1 个')));
  h.engine.confirm = async () => ({ ...result(), appliedDecisions: 0, trashedFiles: 1, skippedDecisions: [{ path: 'a.md' }] });
  await h.p.run('decide', true, [{ kind: 'conflict-delete', entry: { path: 'a.md' } }]);
  assert.ok(h.notices.some(t => t.includes('已将 1 个文件移入回收站') && t.includes('已处理 0 个，跳过 1 个')));
});

test('E2: pending confirmation alone leaves idle polling at 60, 120, 240 and 300 seconds', async () => {
  const h = await host(); h.setResult(result({ staleCopies: [stale('a.md')] }));
  const intervals = [h.p.scheduler.pollIntervalMs];
  for (let i = 0; i < 3; i++) { await h.p.run('sync', false); intervals.push(h.p.scheduler.pollIntervalMs); }
  assert.deepEqual(intervals, [60000, 120000, 240000, 300000]);
});

test('E2: old-version bulk adoption and bulk keep also require one count confirmation', async () => {
  for (const kind of ['keep', 'adopt']) {
    const h = await host();
    const rows = [stale('a.md'), stale('b.md')];
    h.setResult(kind === 'keep' ? result({ staleCopies: rows }) : result({ staleConflicts: rows.map(e => ({ ...e, selected: e.path, files: [{ physical: e.path, hash: e.hash }] })) }));
    await h.p.run('sync', false);
    const modal = h.p.confirmationModal;
    await button(modal, kind === 'keep' ? '全部保留' : '全部采用较新版本').click();
    assert.equal(h.confirmCalls, 0);
    await button(modal, kind === 'keep' ? '确认全部保留' : '确认采用较新版本').click();
    assert.equal(h.confirmCalls, 1); assert.equal(h.received[0].length, 2);
  }
});
