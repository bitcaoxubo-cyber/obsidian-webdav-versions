'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncEngine } = require('../src/engine');
const { MobileVault, MobileState } = require('../src/mobile');
const { DiskVault, DiskState } = require('../src/local');
const { Adapter } = require('./helpers/adapter');
const { bytes, text, digest } = require('../src/bytes');
const { makeRevision, headsFor, project } = require('../src/protocol');
const legacy = require('./fixtures/beta3-resurrection.json');

function remote(fixture) {
  return { revisions: new Map((fixture?.revisions || []).map(rev => [rev.id, structuredClone(rev)])),
    blobs: new Map((fixture?.blobs || []).map(row => [row.hash, Buffer.from(row.base64, 'base64')])), lists: 0,
    async listRevisions() { this.lists++; return [...this.revisions.values()]; },
    async putBlob(hash, value) { assert.equal(digest(value), hash); this.blobs.set(hash, Buffer.from(value)); },
    async getBlob(hash) { return Buffer.from(this.blobs.get(hash)); },
    async getBlobSize(hash) { return this.blobs.get(hash).length; },
    async putRevision(rev) { this.revisions.set(rev.id, rev); },
  };
}
function client(t, kind, r, device = 'PC', { fixture, storage } = {}) {
  let local, state;
  if (kind === 'mobile') {
    storage ||= new Adapter(); local = new MobileVault(storage);
    state = new MobileState(storage, local.privateDir, legacy.endpoint, legacy.username);
  } else {
    if (!storage) {
      storage = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-e2-'));
      const dir = storage; t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    local = new DiskVault(storage); state = new DiskState(local.privateDir, legacy.endpoint, legacy.username);
  }
  const c = { kind, storage, local, state, r, device, engine: new SyncEngine({ remote: r, local, state, device }),
    write(name, value) {
      if (kind === 'mobile') {
        const parts = name.split('/'); for (let i = 1; i < parts.length; i++) storage.folders.add(parts.slice(0, i).join('/'));
        storage.put(name, value);
      } else { const target = path.join(storage, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
    },
    async remove(name) { if (kind === 'mobile') await storage.remove(name); else fs.unlinkSync(path.join(storage, name)); },
    async content(name) { const value = await local.read(name); return value === null ? null : text(value); },
    restart() { return client(t, kind, r, device, { storage }); },
  };
  if (fixture) {
    for (const file of fixture.vaultFiles) c.write(file.path, Buffer.from(file.base64, 'base64'));
    if (kind === 'mobile') for (const slot of fixture.mobileSnapshots) c.write(state.directory + '/' + slot.name, slot.text);
    else fs.writeFileSync(state.file, JSON.stringify(fixture.diskState));
  }
  return c;
}
function trashHooks(c) {
  const trashed = new Map(), blocked = new Set(), calls = [];
  const hooks = {
    async canTrash(physical, hash) {
      const value = await c.local.read(physical);
      return value !== null && digest(value) === hash && !blocked.has(physical);
    },
    async trash(physical, hash) {
      calls.push(physical);
      if (!await hooks.canTrash(physical, hash)) return false;
      trashed.set(physical, await c.local.read(physical));
      await c.remove(physical); return true;
    },
  };
  return { hooks, trashed, blocked, calls };
}
function action(kind, entry, selected) { return { kind, entry, ...(selected ? { selected } : {}) }; }
const rows = result => result.confirmations;
async function seedDeleted(r, c, names) {
  for (const name of names) {
    const content = 'old content: ' + name;
    const old = makeRevision({ path: name, blob: digest(content), device: 'origin' });
    const deleted = makeRevision({ path: name, blob: null, parents: [old.id], device: 'phone' });
    await r.putBlob(old.blob, bytes(content)); await r.putRevision(old); await r.putRevision(deleted);
    c.write(name, content);
  }
}
function skippedPaths(result) { return result.skippedDecisions.map(row => row.path).sort(); }

for (const kind of ['mobile', 'disk']) test(`E2: ${kind} reads genuine beta3 state and classifies the old resurrection fixture`, async t => {
  assert.equal(legacy.baselineCommit, '19955ebf3ed0089b893e0ca0a3e70a57b08a096c');
  assert.deepEqual(legacy.expected.resurrection, { uploaded: 4, conflicts: 4 });
  const r = remote(legacy), c = client(t, kind, r, 'PC', { fixture: legacy });
  assert.deepEqual(await c.state.load(), legacy.diskState);
  const result = await c.engine.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 4);
  assert.deepEqual(rows(result).deletionConflicts.map(row => row.path), ['a.md', 'b.md', 'c.md']);
  assert.ok(rows(result).deletionConflicts.every(row => row.unchanged && row.files.length === 1 && row.devices.includes('PC')));
  assert.deepEqual(rows(result).staleConflicts.map(row => row.path), ['d.md']);
  assert.equal(await c.content(rows(result).staleConflicts[0].selected), legacy.expected.latestContent);
  assert.equal(typeof c.engine.confirm, 'function');
});

for (const kind of ['mobile', 'disk']) {
  test(`E2: ${kind} one confirmation cleans legacy deletion and old-version conflicts on all devices`, async t => {
    const r = remote(legacy);
    const devices = ['PC', 'Mac', 'iPhone'].map(name => client(t, kind, r, name, { fixture: legacy }));
    const c = devices[0], first = await c.engine.sync(), hooks = trashHooks(c);
    const actions = rows(first).deletionConflicts.map(entry => action('conflict-delete', entry));
    actions.push(...rows(first).staleConflicts.map(entry => action('resolve', entry, entry.selected)));
    const before = r.lists, result = await c.engine.confirm(actions, hooks.hooks);
    assert.ok(r.lists - before <= 2); assert.equal(result.appliedDecisions, 4); assert.deepEqual(result.skippedDecisions, []);
    assert.deepEqual(hooks.calls.sort(), ['a.md', 'b.md', 'c.md']); assert.equal(hooks.trashed.size, 3);
    for (const peer of devices) {
      const synced = await peer.engine.sync(); assert.equal(synced.conflicts, 0);
      assert.deepEqual((await peer.local.list()).sort(), ['d.md', 'e.md']);
      assert.equal(await peer.content('d.md'), legacy.expected.latestContent);
      assert.equal(await peer.content('e.md'), 'content of e.md');
    }
  });

  test(`E2: ${kind} fifty-file confirmation trashes through callbacks in at most two remote listings`, async t => {
    const r = remote(), c = client(t, kind, r), names = Array.from({ length: 50 }, (_, i) => `old-${String(i).padStart(2, '0')}.md`);
    await seedDeleted(r, c, names); const first = await c.engine.sync(), hooks = trashHooks(c);
    assert.equal(rows(first).staleCopies.length, 50);
    const before = r.lists, revisions = r.revisions.size;
    const result = await c.engine.confirm(rows(first).staleCopies.map(entry => action('stale-delete', entry)), hooks.hooks);
    assert.ok(r.lists - before <= 2, 'one user batch must not sync once per file');
    assert.equal(result.appliedDecisions, 50); assert.deepEqual(result.skippedDecisions, []);
    assert.equal(hooks.trashed.size, 50); assert.equal(hooks.calls.length, 50);
    assert.equal(r.revisions.size, revisions); assert.deepEqual(await c.local.list(), []);
  });

  test(`E2: ${kind} changed content and an unsaved guard skip individually while another stale copy is trashed`, async t => {
    const r = remote(), c = client(t, kind, r); await seedDeleted(r, c, ['a.md', 'b.md', 'c.md']);
    const first = await c.engine.sync(), hooks = trashHooks(c);
    c.write('a.md', 'new unique local edit'); hooks.blocked.add('b.md');
    const cHistory = [...r.revisions.values()].filter(rev => rev.path === 'c.md').length;
    const result = await c.engine.confirm(rows(first).staleCopies.map(entry => action('stale-delete', entry)), hooks.hooks);
    assert.equal(result.appliedDecisions, 1); assert.deepEqual(skippedPaths(result), ['a.md', 'b.md']);
    assert.deepEqual(hooks.calls, ['c.md']); assert.equal(hooks.trashed.size, 1);
    assert.equal(await c.content('a.md'), 'new unique local edit'); assert.equal(await c.content('b.md'), 'old content: b.md'); assert.equal(await c.content('c.md'), null);
    assert.equal([...r.revisions.values()].filter(rev => rev.path === 'c.md').length, cHistory);
  });

  test(`E2: ${kind} changed remote heads skip one old decision without blocking another path`, async t => {
    const r = remote(), c = client(t, kind, r); await seedDeleted(r, c, ['a.md', 'b.md']);
    const first = await c.engine.sync(), hooks = trashHooks(c);
    const newContent = 'a recreated by a peer';
    const rev = makeRevision({ path: 'a.md', parents: headsFor(r.revisions.values(), 'a.md'), blob: digest(newContent), device: 'peer' });
    await r.putBlob(rev.blob, bytes(newContent)); await r.putRevision(rev);
    const result = await c.engine.confirm(rows(first).staleCopies.map(entry => action('stale-delete', entry)), hooks.hooks);
    assert.equal(result.appliedDecisions, 1); assert.deepEqual(skippedPaths(result), ['a.md']);
    assert.deepEqual(hooks.calls, ['b.md']); assert.equal(await c.content('a.md'), newContent); assert.equal(await c.content('b.md'), null);
  });

  test(`E2: ${kind} modified deletion conflicts are distinct from unchanged conflicts selected for bulk deletion`, async t => {
    const r = remote(legacy), c = client(t, kind, r, 'PC', { fixture: legacy });
    const live = headsFor(r.revisions.values(), 'a.md').filter(id => r.revisions.get(id).blob !== null);
    const changed = makeRevision({ path: 'a.md', parents: live, blob: digest('unique edit after deletion'), device: 'offline editor' });
    await r.putBlob(changed.blob, bytes('unique edit after deletion')); await r.putRevision(changed);
    const first = await c.engine.sync(), entries = rows(first).deletionConflicts, hooks = trashHooks(c);
    assert.equal(entries.find(entry => entry.path === 'a.md').unchanged, false);
    assert.ok(entries.filter(entry => entry.path !== 'a.md').every(entry => entry.unchanged));
    const selected = entries.filter(entry => entry.unchanged);
    const result = await c.engine.confirm(selected.map(entry => action('conflict-delete', entry)), hooks.hooks);
    assert.equal(result.appliedDecisions, 2); assert.equal(hooks.calls.includes('a.md'), false);
    assert.equal(await c.content('a.md'), 'unique edit after deletion');
    assert.ok(rows(result).deletionConflicts.some(entry => entry.path === 'a.md' && !entry.unchanged));
  });

  test(`E2: ${kind} one mixed confirmation deletes two stale copies and keeps the third as a tombstone successor`, async t => {
    const r = remote(), c = client(t, kind, r); await seedDeleted(r, c, ['a.md', 'b.md', 'c.md']);
    const first = await c.engine.sync(), hooks = trashHooks(c), oldCount = r.revisions.size;
    const parents = headsFor(r.revisions.values(), 'c.md');
    const actions = rows(first).staleCopies.map(entry => action(entry.path === 'c.md' ? 'stale-keep' : 'stale-delete', entry));
    const before = r.lists, result = await c.engine.confirm(actions, hooks.hooks);
    assert.ok(r.lists - before <= 2); assert.equal(result.appliedDecisions, 3); assert.deepEqual(result.skippedDecisions, []);
    assert.equal(result.uploaded, 1); assert.equal(result.conflicts, 0); assert.deepEqual(result.stalePaths, []);
    assert.equal(r.revisions.size, oldCount + 1); assert.deepEqual((await c.local.list()).sort(), ['c.md']);
    const [tip] = headsFor(r.revisions.values(), 'c.md'); assert.deepEqual(r.revisions.get(tip).parents, parents);
    assert.deepEqual(hooks.calls.sort(), ['a.md', 'b.md']);
  });

  test(`E2: ${kind} a partial legacy deletion batch interrupted before sync converges like the uninterrupted batch`, async t => {
    const controlRemote = remote(legacy), control = client(t, kind, controlRemote, 'control', { fixture: legacy });
    const controlResult = await control.engine.sync(), controlHooks = trashHooks(control);
    const allActions = value => [...rows(value).deletionConflicts.map(entry => action('conflict-delete', entry)),
      ...rows(value).staleConflicts.map(entry => action('resolve', entry, entry.selected))];
    await control.engine.confirm(allActions(controlResult), controlHooks.hooks);
    const r = remote(legacy), c = client(t, kind, r, 'interrupted', { fixture: legacy });
    const first = await c.engine.sync(), hooks = trashHooks(c), trash = hooks.hooks.trash;
    hooks.hooks.trash = async (physical, hash) => {
      if (physical === 'b.md') throw new Error('process interrupted after first confirmed trash');
      return trash(physical, hash);
    };
    await assert.rejects(c.engine.confirm(allActions(first), hooks.hooks), /process interrupted/);
    assert.equal(await c.content('a.md'), null); assert.equal(await c.content('b.md'), 'content of b.md');
    assert.equal(text(hooks.trashed.get('a.md')), 'content of a.md');
    const restarted = c.restart(), recovered = await restarted.engine.sync(), nextHooks = trashHooks(restarted);
    assert.equal(await restarted.content('a.md'), null, 'a completed local decision must not resurrect during restart');
    await restarted.engine.confirm(allActions(recovered), nextHooks.hooks);
    await restarted.engine.sync();
    assert.equal(r.revisions.size, controlRemote.revisions.size);
    assert.deepEqual((await restarted.local.list()).sort(), ['d.md', 'e.md']);
    for (const name of ['d.md', 'e.md']) assert.equal(await restarted.content(name), await control.content(name));
  });
}

for (const kind of ['mobile', 'disk']) {
  for (const change of ['expired review', 'other copy edited', 'other copy removed', 'selected missing', 'selected changed', 'unsaved selected', 'selected changes during preflight', 'other copy changes during preflight']) {
    test(`E2: ${kind} resolve rejects ${change} while an independent deletion still completes`, async t => {
      const r = remote(legacy), c = client(t, kind, r, 'PC', { fixture: legacy });
      const first = await c.engine.sync(), hooks = trashHooks(c);
      const entry = rows(first).staleConflicts[0], selected = entry.selected;
      const sibling = entry.files.find(file => file.physical !== selected).physical;
      const a = rows(first).deletionConflicts.find(row => row.path === 'a.md');
      let editedPath = null;
      if (change === 'expired review') {
        const state = await c.state.load(); state.reviewed = state.reviewed.filter(([name]) => name !== 'd.md'); await c.state.save(state);
      } else if (change === 'other copy edited') { editedPath = sibling; c.write(sibling, 'unconfirmed sibling edit'); }
      else if (change === 'other copy removed') await c.remove(sibling);
      else if (change === 'selected missing') await c.remove(selected);
      else if (change === 'selected changed') { editedPath = selected; c.write(selected, 'unconfirmed selected edit'); }
      else if (change === 'unsaved selected') c.local.guard = physical => physical !== selected;
      else {
        editedPath = change.startsWith('selected') ? selected : sibling;
        const read = c.local.read.bind(c.local); let changed = false;
        c.local.read = async (physical, ...rest) => {
          const value = await read(physical, ...rest);
          if (!changed && physical === editedPath) { changed = true; c.write(physical, 'edit after first validation read'); }
          return value;
        };
      }
      const baseline = new Map((await c.state.load()).files).get(editedPath || selected);
      const result = await c.engine.confirm([action('resolve', entry, selected), action('conflict-delete', a)], hooks.hooks);
      assert.equal(result.appliedDecisions, 1); assert.deepEqual(skippedPaths(result), ['d.md']);
      assert.equal(await c.content('a.md'), null); assert.deepEqual(hooks.calls, ['a.md']);
      if (editedPath) {
        const expected = change.includes('preflight') ? 'edit after first validation read' : change === 'selected changed' ? 'unconfirmed selected edit' : 'unconfirmed sibling edit';
        const published = [...r.revisions.values()].find(rev => rev.blob === digest(expected));
        assert.ok(published, 'the saved edit may be captured, but must not be treated as confirmed conflict resolution');
        assert.deepEqual(published.parents, baseline.parents);
        assert.ok([...project(r.revisions.values()).values()].some(file => file.blob === digest(expected)));
      }
    });
  }

  test(`E2: ${kind} network and callback IO failures abort instead of being counted as skipped decisions`, async t => {
    for (const failure of ['network', 'content-io', 'validation-io', 'trash-io']) {
      const r = remote(), c = client(t, kind, r, failure); await seedDeleted(r, c, ['a.md']);
      const first = await c.engine.sync(), hooks = trashHooks(c), actions = rows(first).staleCopies.map(entry => action('stale-delete', entry));
      const originalRead = c.local.read;
      if (failure === 'content-io') c.local.read = async () => { throw Object.assign(new Error('content IO unavailable'), { code: 'EIO' }); };
      if (failure === 'network') r.listRevisions = async () => { throw new Error('network failure during confirmation'); };
      if (failure === 'validation-io') hooks.hooks.canTrash = async () => { throw Object.assign(new Error('validation IO unavailable'), { code: 'EIO' }); };
      if (failure === 'trash-io') hooks.hooks.trash = async () => { throw Object.assign(new Error('trash IO unavailable'), { code: 'EIO' }); };
      await assert.rejects(c.engine.confirm(actions, hooks.hooks), /network failure|IO unavailable/);
      c.local.read = originalRead;
      assert.equal(await c.content('a.md'), 'old content: a.md'); assert.equal(hooks.trashed.size, 0);
    }
  });

  test(`E2: ${kind} current equal-content live parents are durable before trash and cannot resurrect after a crash`, async t => {
    const r = remote(), c = client(t, kind, r), value = 'same old content';
    const roots = ['first', 'second', 'third'].map(device => makeRevision({ path: 'same.md', blob: digest(value), device }));
    const deleted = makeRevision({ path: 'same.md', parents: [roots[0].id], blob: null, device: 'deleter' });
    await r.putBlob(digest(value), bytes(value));
    for (const rev of [...roots, deleted]) await r.putRevision(rev);
    c.write('same.md', value);
    const tips = headsFor(r.revisions.values(), 'same.md');
    await c.state.save({ version: 1, known: [...r.revisions.keys()],
      files: [['same.md', { path: 'same.md', blob: digest(value), parents: [roots[0].id] }]],
      reviewed: [['same.md', tips]], absent: [], pending: null });
    const first = await c.engine.sync({ full: false, dirty: [] });
    assert.deepEqual(new Map((await c.state.load()).files).get('same.md').parents, [roots[0].id], 'clean incremental must retain its older observed baseline');
    const entry = rows(first).deletionConflicts[0]; assert.equal(entry.unchanged, true);
    const hooks = trashHooks(c), trash = hooks.hooks.trash;
    const liveParents = roots.slice(1).map(rev => rev.id).sort();
    hooks.hooks.trash = async (physical, hash) => {
      const durable = new Map((await c.state.load()).files).get(physical);
      assert.deepEqual(durable.parents, liveParents, 'all current equal-content parents must be checkpointed before the local deletion');
      await trash(physical, hash);
      throw new Error('killed after confirmed deletion before publication');
    };
    await assert.rejects(c.engine.confirm([action('conflict-delete', entry)], hooks.hooks), /killed after confirmed deletion/);
    assert.equal(await c.content('same.md'), null); assert.equal(r.revisions.size, 4);
    const restarted = c.restart(); const result = await restarted.engine.sync(); await restarted.engine.sync();
    assert.equal(result.conflicts, 0); assert.equal(result.downloaded, 0); assert.equal(await restarted.content('same.md'), null);
    assert.equal(r.revisions.size, 5);
    assert.ok(headsFor(r.revisions.values(), 'same.md').every(id => r.revisions.get(id).blob === null));
    assert.equal(text(hooks.trashed.get('same.md')), value);
  });
}

for (const kind of ['mobile', 'disk']) test(`E2: ${kind} a second copy changed during trash skips its path and reports the one file already trashed`, async t => {
  const r = remote(legacy), c = client(t, kind, r, 'PC', { fixture: legacy });
  const ancestor = [...r.revisions.values()].find(rev => rev.path === 'd.md' && !rev.parents.length && rev.device === 'Mac');
  assert.ok(ancestor);
  await r.putRevision(makeRevision({ path: 'd.md', parents: [ancestor.id], blob: null, device: 'delete branch' }));
  const first = await c.engine.sync(), entry = rows(first).deletionConflicts.find(row => row.path === 'd.md');
  assert.equal(entry.files.length, 2);
  const hooks = trashHooks(c), trash = hooks.hooks.trash;
  let once = false;
  hooks.hooks.trash = async (physical, hash) => {
    const removed = await trash(physical, hash);
    if (!once && removed) {
      once = true;
      const other = entry.files.find(file => file.physical !== physical);
      c.write(other.physical, 'saved edit between the two trash calls');
    }
    return removed;
  };
  const result = await c.engine.confirm([action('conflict-delete', entry)], hooks.hooks);
  assert.equal(result.appliedDecisions, 0); assert.deepEqual(skippedPaths(result), ['d.md']);
  assert.equal(result.trashedFiles, 1); assert.equal(hooks.trashed.size, 1);
  assert.ok([...project(r.revisions.values()).values()].some(file => file.path === 'd.md' && file.blob === digest('saved edit between the two trash calls')));
  const saved = await Promise.all((await c.local.list()).map(name => c.content(name)));
  assert.ok(saved.includes('saved edit between the two trash calls'));
});

for (const bidirectional of [true, false]) test(`E2: equal-hash independent roots do not hide ${bidirectional ? 'bidirectional ambiguity' : 'one-way historical evidence'} in old-version classification`, async t => {
  const r = remote(), c = client(t, 'mobile', r);
  const name = 'repeated-content.md', a = digest('content A'), b = digest('content B');
  const oldA = makeRevision({ path: name, blob: a, device: 'old A' });
  const independentA = makeRevision({ path: name, blob: a, device: 'independent A' });
  const b1 = makeRevision({ path: name, parents: [oldA.id], blob: b, device: 'B from old A' });
  const graph = [oldA, independentA, b1];
  if (bidirectional) {
    graph.push(makeRevision({ path: name, parents: [b1.id], blob: a, device: 'A from B' }));
    graph.push(makeRevision({ path: name, parents: [oldA.id], blob: b, device: 'parallel B' }));
  } else graph.push(makeRevision({ path: name, blob: b, device: 'independent B' }));
  await r.putBlob(a, bytes('content A')); await r.putBlob(b, bytes('content B'));
  for (const rev of graph) await r.putRevision(rev);
  const result = await c.engine.sync(); assert.equal(result.conflicts, 1);
  assert.deepEqual(rows(result).deletionConflicts, []);
  if (bidirectional) assert.deepEqual(rows(result).staleConflicts, [], 'both content groups have reverse history evidence, so user review remains required');
  else {
    assert.equal(rows(result).staleConflicts.length, 1);
    assert.equal(await c.content(rows(result).staleConflicts[0].selected), 'content B');
  }
});

for (const kind of ['mobile', 'disk']) test(`E2: ${kind} a failed current-parent checkpoint aborts before any trash callback`, async t => {
  const r = remote(), c = client(t, kind, r), name = 'same.md', value = 'same content';
  const old = makeRevision({ path: name, blob: digest(value), device: 'old baseline' });
  const live = makeRevision({ path: name, blob: digest(value), device: 'independent live' });
  const deletion = makeRevision({ path: name, parents: [old.id], blob: null, device: 'delete old baseline' });
  await r.putBlob(digest(value), bytes(value));
  for (const rev of [old, live, deletion]) await r.putRevision(rev);
  c.write(name, value);
  await c.state.save({ version: 1, known: [...r.revisions.keys()], files: [[name, { path: name, blob: digest(value), parents: [old.id] }]],
    reviewed: [[name, headsFor(r.revisions.values(), name)]], absent: [], pending: null });
  const first = await c.engine.sync({ full: false, dirty: [] }), hooks = trashHooks(c);
  c.state.save = async () => { throw Object.assign(new Error('checkpoint IO unavailable'), { code: 'EIO' }); };
  await assert.rejects(c.engine.confirm([action('conflict-delete', rows(first).deletionConflicts[0])], hooks.hooks), /checkpoint IO unavailable/);
  assert.deepEqual(hooks.calls, []); assert.equal(hooks.trashed.size, 0);
  assert.equal(await c.content(name), value); assert.equal(r.revisions.size, 3);
  assert.deepEqual(new Map((await c.state.load()).files).get(name).parents, [old.id]);
});
