'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { disk, mobile, remote } = require('./helpers/empty-folders');
const { host, result, stale, button } = require('./helpers/plugin-host');
const { SyncScheduler } = require('../src/scheduler');
const { text } = require('../src/bytes');

async function ready(t, { phone = true, count = 3, ds = false, nested = false } = {}) {
  const r = remote(), source = disk(t, r), names = Array.from({ length: count }, (_, i) => `folder-${i}${nested ? '/b/c' : ''}/old.md`);
  for (const p of names) source.put(p, 'old');
  await source.engine.sync(); for (const p of names) source.remove(p); await source.engine.sync();
  const client = phone ? mobile(r) : disk(t, r);
  for (const p of names) client.mkdir(p.slice(0, p.lastIndexOf('/')));
  if (ds) client.put('folder-0/.DS_Store', 'finder');
  const h = await host({ mobile: phone }); h.p.engine = client.engine; h.engine = client.engine;
  client.engine.retainedDirectories = () => h.p.settings.retainedEmptyDirectories;
  const folders = new Map();
  const getFolder = name => {
    if (!client.has(name)) return null;
    if (!folders.has(name)) folders.set(name, { path: name, children: [] });
    return folders.get(name);
  };
  h.p.app.vault.getAbstractFileByPath = getFolder;
  h.p.app.fileManager.trashFile = async file => {
    assert.ok(Array.isArray(file.children), 'trashFile receives a directory');
    h.trashed.set(file.path, file);
    if (phone) { client.adapter.folders.add('.trash'); await client.adapter.rename(file.path, '.trash/' + file.path); }
    else { fs.mkdirSync(path.join(client.root, '.trash'), { recursive: true }); fs.renameSync(path.join(client.root, file.path), path.join(client.root, '.trash', file.path)); }
    h.events.get('delete')(file); folders.delete(file.path);
  };
  h.p.result = await client.engine.sync();
  h.p.scheduler.complete(h.p.scheduler.begin({ manual: true }), h.p.result);
  const paths = h.p.result.emptyDirectories.map(e => e.path);
  return { ...h, client, source, r, paths, get savedData() { return h.savedData; } };
}

test('F3: empty entries never auto-open in five rounds, status counts them, manual window has fourth group', async () => {
  const h = await host(), entry = { path: 'a', subdirectoryCount: 2, containsDSStore: true };
  h.setResult({ ...result(), emptyDirectories: [entry] });
  for (let i = 0; i < 5; i++) await h.p.run('sync', false);
  assert.equal(h.modals.length, 0); assert.equal(h.p.statusMessage, '已同步');
  h.p.openStatus(); assert.ok(h.modals.at(-1).contentEl.texts.some(s => s.includes('有 1 个空文件夹可清理')));
  h.p.openConfirmations(); const modal = h.p.confirmationModal;
  assert.ok(modal.contentEl.texts.includes('空文件夹 · 1'));
  assert.match(modal.contentEl.settings.find(s => s.name === 'a').desc, /2.*DS_Store/);
  await button(modal, '全部清理').click();
  assert.ok(modal.contentEl.texts.some(s => s.includes('1 个空文件夹') && s.includes('不删除任何笔记')));
  modal.close(); h.setResult({ ...result({ staleCopies: [stale('new.md')] }), emptyDirectories: [entry] });
  await h.p.run('sync', false); assert.ok(h.p.confirmationModal?.opened);
});
test('F3: mobile batch trashes three directories once each without adapter rmdir, sync or remote access', async t => {
  const h = await ready(t), { reads, writes } = h.r, count = h.r.revisions.size;
  h.client.adapter.rmdir = () => { throw new Error('forbidden rmdir'); };
  const result = await h.p.runDirectories(h.paths);
  assert.deepEqual(result.cleaned, h.paths); assert.deepEqual(result.skipped, []);
  assert.equal(h.trashed.size, 3); assert.equal(h.r.reads, reads); assert.equal(h.r.writes, writes); assert.equal(h.r.revisions.size, count);
  for (const dir of h.paths) assert.ok(h.client.has('.trash/' + dir));
  assert.ok(h.notices.some(s => /已清理 3 个.*跳过 0 个/.test(s))); assert.equal(h.p.directoryTokens.size, 0);
});
for (const change of ['on-disk', 'event-only', 'hidden-event', 'rename', 'unsaved', 'background', 'identity']) test(`F3: ${change} between validation and trash skips only affected directory`, async t => {
  const h = await ready(t), inspect = h.client.local.inspectDirectories.bind(h.client.local);
  let calls = 0;
  h.client.local.inspectDirectories = async name => {
    if (name === h.paths[0] && ++calls === 2) {
      if (change === 'on-disk') h.client.put(name + '/new.md', 'new bytes');
      else if (change === 'event-only' || change === 'hidden-event') h.events.get('create')({ path: name + (change === 'hidden-event' ? '/.new' : '/new.md') });
      else if (change === 'rename') h.events.get('rename')({ path: 'outside/new.md' }, name + '/old.md');
      else if (change === 'unsaved') h.setLeaves([{ view: { file: { path: name + '/draft.md' }, editor: { getValue: () => 'unsaved' } } }]);
      else if (change === 'identity') { const original = h.p.app.vault.getAbstractFileByPath; h.p.app.vault.getAbstractFileByPath = p => p === name ? { path: name, children: [] } : original(p); }
      else h.document.visibilityState = 'hidden';
    }
    return inspect(name);
  };
  const outcome = await h.p.runDirectories(h.paths);
  assert.ok(outcome.skipped.includes(h.paths[0])); assert.ok(h.client.has(h.paths[0]));
  if (change !== 'background') { assert.equal(outcome.cleaned.length, 2); assert.equal(outcome.skipped.length, 1); assert.ok(h.notices.some(s => s.includes('跳过 1 个'))); }
  else assert.equal(h.trashed.size, 0);
  if (change === 'on-disk') assert.equal(text(h.client.adapter.files.get(h.paths[0] + '/new.md')), 'new bytes');
});
for (const option of ['none', undefined, 'unreadable', 'missing-interface']) for (const phone of [true, false]) test(`F3: ${phone ? 'mobile' : 'desktop DS_Store'} refuses ${option} trash setting`, async t => {
  const h = await ready(t, { phone, count: 1, ds: !phone });
  if (option === 'unreadable') h.p.app.vault.getConfig = () => { throw new Error('unreadable'); };
  else if (option === 'missing-interface') h.p.app.fileManager.trashFile = null;
  else h.setTrash(option);
  await h.p.runDirectories(h.paths);
  assert.ok(h.client.has(h.paths[0])); assert.equal(h.trashed.size, 0);
  assert.ok(h.notices.some(s => /未完成/.test(s)));
});
test('F3: desktop pure tree uses nonrecursive rmdir even with permanent deletion preference', async t => {
  const h = await ready(t, { phone: false, count: 1, nested: true }); h.setTrash('none');
  const outcome = await h.p.runDirectories(h.paths);
  assert.equal(outcome.cleaned.length, 1); assert.equal(h.client.has('folder-0'), false); assert.equal(h.trashed.size, 0);
});
test('F3: desktop DS_Store tree uses exactly one trash operation and preserves its metadata', async t => {
  const h = await ready(t, { phone: false, count: 1, ds: true, nested: true });
  const outcome = await h.p.runDirectories(h.paths);
  assert.equal(outcome.cleaned.length, 1); assert.equal(h.trashed.size, 1);
  assert.equal(h.client.read('.trash/folder-0/.DS_Store'), 'finder');
});
for (const phone of [true, false]) test(`F3: ${phone ? 'mobile' : 'desktop DS_Store'} false trash result is a skip`, async t => {
  const h = await ready(t, { phone, count: 1, ds: !phone });
  h.p.app.fileManager.trashFile = async () => false;
  const outcome = await h.p.runDirectories(h.paths);
  assert.equal(outcome.cleaned.length, 0); assert.equal(outcome.skipped.length, 1); assert.ok(h.client.has(h.paths[0]));
});
test('F3: stale window selection is skipped after another sync downloads content into the folder', async t => {
  const h = await ready(t, { phone: false, count: 1 });
  h.source.put('folder-0/new.md', 'download'); await h.source.engine.sync(); await h.client.engine.sync();
  const outcome = await h.p.runDirectories(h.paths);
  assert.equal(outcome.cleaned.length, 0); assert.equal(outcome.skipped.length, 1); assert.equal(h.client.read('folder-0/new.md'), 'download');
});
test('F3: failure and unfinished journal invalidate prior directory permission without recovery or network access', async t => {
  const h = await ready(t, { phone: false, count: 1 });
  const list = h.r.listRevisions; h.r.listRevisions = async () => { throw new Error('offline'); };
  await assert.rejects(h.client.engine.sync(), /offline/); h.r.listRevisions = list;
  const before = h.r.reads;
  const outcome = await h.client.engine.cleanDirectories(h.paths);
  assert.deepEqual(outcome.skipped, h.paths); assert.ok(h.client.has(h.paths[0])); assert.equal(h.r.reads, before);
});
test('F3: protected forged requests reject before deleting anything; content is skipped', async t => {
  const h = await ready(t, { phone: false, count: 1 });
  for (const dir of ['', '.obsidian', '.trash', '.', '../outside', 'folder-0/../outside']) {
    await assert.rejects(h.client.engine.cleanDirectories([h.paths[0], dir])); assert.ok(h.client.has(h.paths[0]));
  }
  h.client.put(h.paths[0] + '/new.md', 'new');
  assert.deepEqual((await h.client.engine.cleanDirectories(h.paths)).skipped, h.paths);
  assert.equal(h.client.read(h.paths[0] + '/new.md'), 'new');
});
test('F3: interrupted batch restarts with exactly the remaining directory list', async t => {
  const h = await ready(t, { phone: false, count: 4 });
  const prune = h.client.local.pruneEmptyDirectories.bind(h.client.local); let calls = 0;
  h.client.local.pruneEmptyDirectories = dirs => { if (++calls === 3) throw new Error('interrupt'); return prune(dirs); };
  await assert.rejects(h.client.engine.cleanDirectories(h.paths), /interrupt/);
  const { SyncEngine } = require('../src/engine');
  const restarted = new SyncEngine({ remote: h.r, local: h.client.local, state: h.client.state, device: 'restarted' });
  const result = await restarted.sync();
  assert.deepEqual(result.emptyDirectories.map(e => e.path), h.paths.slice(2));
  assert.equal(result.uploaded + result.downloaded + result.deleted, 0);
});
test('F3: retained data survives plugin restart, blocks ancestors and reset persists without touching sync state', async t => {
  const h = await ready(t, { phone: false, count: 1, nested: true });
  const before = fs.readFileSync(h.client.state.file);
  await h.p.runDirectories(['folder-0/b'], true);
  assert.deepEqual([...h.p.settings.retainedEmptyDirectories], ['folder-0/b']);
  assert.equal(h.p.result.emptyDirectories.length, 0); assert.deepEqual(fs.readFileSync(h.client.state.file), before);
  const next = await host({ mobile: false, savedData: h.savedData });
  assert.deepEqual([...next.p.settings.retainedEmptyDirectories], ['folder-0/b']);
  next.settingTabs[0].display();
  const row = next.settingTabs[0].containerEl.settings.find(s => s.name === '已保留 1 个空文件夹');
  await row.buttons[0].click(); assert.equal(next.savedData.retainedEmptyDirectories.length, 0);
  const last = await host({ savedData: next.savedData }); assert.equal(last.p.settings.retainedEmptyDirectories.length, 0);
});

function clock() {
  let now = 0, sequence = 0; const timers = new Map();
  return { now: () => now, setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, async advance(target) {
      while (true) { const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; timers.delete(next[0]); now = next[1].at; await next[1].fn(); }
      now = target;
    } };
}
test('F3: 200 folders use one engine queue and zero remote writes, followed by at most one extra full round', async t => {
  const h = await ready(t, { count: 200 }), c = clock(), rounds = [];
  const scheduler = h.p.scheduler = new SyncScheduler({ ...c, mobile: true, enabled: () => true, active: () => true,
    run: async () => { const ticket = scheduler.begin(); rounds.push(ticket.full); scheduler.complete(ticket, await h.client.engine.sync({ full: ticket.full, dirty: ticket.dirty })); } });
  scheduler.complete(scheduler.begin({ manual: true }), h.p.result);
  let queues = 0; const enqueue = h.client.engine._enqueue.bind(h.client.engine);
  h.client.engine._enqueue = fn => { queues++; return enqueue(fn); };
  const { reads, writes } = h.r;
  const outcome = await h.p.runDirectories(h.paths);
  assert.equal(outcome.cleaned.length, 200); assert.equal(queues, 1); assert.equal(h.r.reads, reads); assert.equal(h.r.writes, writes);
  await c.advance(600000); assert.equal(rounds.filter(Boolean).length, 1);
  assert.deepEqual(h.client.engine.emptyDirectories, []); assert.equal(h.r.writes, writes);
});
test('F1: real automatic rmdir events cause one extra full round and no loop over ten idle minutes', async t => {
  const { seeded } = require('./helpers/empty-folders'); const { a, b } = await seeded(t);
  a.remove('p/q/note.md'); await a.engine.sync();
  const c = clock(), rounds = [], scheduler = new SyncScheduler({ ...c, mobile: false, enabled: () => true, active: () => true,
    run: async () => { const ticket = scheduler.begin(); rounds.push(ticket.full); scheduler.complete(ticket, await b.engine.sync({ full: ticket.full, dirty: ticket.dirty })); } });
  const original = fs.promises.rmdir; t.after(() => { fs.promises.rmdir = original; });
  fs.promises.rmdir = async (...args) => { const r = await original(...args); scheduler.change([], { full: true }); return r; };
  await scheduler.run(); assert.equal(b.has('p'), false);
  await c.advance(600000); assert.equal(rounds.filter(Boolean).length, 2);
});
