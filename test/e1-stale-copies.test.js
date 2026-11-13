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
const { headsFor, makeRevision, project } = require('../src/protocol');
const ENDPOINT = 'https://example.test/stale-copies/';
const FRESH_ENDPOINT = 'https://example.test/new-state-key/';
const FILES = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
const STALE = ['a.md', 'b.md', 'c.md'];
const original = name => 'original content of ' + name;

function remote() {
  return { blobs: new Map(), revisions: new Map(), lists: 0,
    async listRevisions() { this.lists++; return [...this.revisions.values()]; },
    async getBlob(hash) { return Buffer.from(this.blobs.get(hash)); },
    async getBlobSize(hash) { return this.blobs.get(hash).length; },
    async putBlob(hash, data) { assert.equal(digest(data), hash); this.blobs.set(hash, Buffer.from(data)); },
    async putRevision(rev) { this.revisions.set(rev.id, rev); },
  };
}
function client(t, kind, r, device, storage, url = ENDPOINT) {
  let local, state;
  if (kind === 'mobile') {
    storage ||= new Adapter();
    local = new MobileVault(storage); state = new MobileState(storage, local.privateDir, url, 'test');
  } else {
    if (!storage) {
      storage = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-e1-'));
      const directory = storage; t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    }
    local = new DiskVault(storage); state = new DiskState(local.privateDir, url, 'test');
  }
  const c = { kind, storage, local, state, engine: new SyncEngine({ remote: r, local, state, device }),
    async write(name, content) {
      if (kind === 'mobile') {
        const parts = name.split('/');
        for (let i = 1; i < parts.length; i++) storage.folders.add(parts.slice(0, i).join('/'));
        storage.put(name, content);
      } else {
        const file = path.join(storage, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
      }
    },
    async remove(name) { if (kind === 'mobile') await storage.remove(name); else fs.unlinkSync(path.join(storage, name)); },
    async content(name) { const data = await local.read(name); return data === null ? null : text(data); },
    restart(nextUrl = url) { return client(t, kind, r, device, storage, nextUrl); },
  };
  return c;
}
async function scenario(t, kind, { fresh = true, offlineEdit = false } = {}) {
  const r = remote(), mac = client(t, kind, r, 'Mac'), phone = client(t, kind, r, 'iPhone'), pc = client(t, kind, r, 'PC');
  for (const name of FILES) await mac.write(name, original(name));
  await mac.engine.sync(); await phone.engine.sync(); await pc.engine.sync();
  if (offlineEdit) for (const name of STALE) await pc.write(name, 'unique offline edit: ' + name);
  for (const name of STALE) await phone.remove(name);
  await phone.engine.sync(); await mac.write('d.md', 'd edited on Mac'); await mac.engine.sync(); await phone.engine.sync();
  const tombstones = new Map(STALE.map(name => [name, headsFor(r.revisions.values(), name)]));
  return { r, mac, phone, pc: fresh ? pc.restart(FRESH_ENDPOINT) : pc, tombstones };
}
function noTransfer(result) {
  assert.equal(result.uploaded, 0); assert.equal(result.downloaded, 0); assert.equal(result.deleted, 0); assert.equal(result.conflicts, 0);
}
function pending(result, names) {
  assert.deepEqual(result.stalePaths, names);
  assert.deepEqual(result.deferredPaths, []);
  assert.equal(result.deferred, 0);
  assert.deepEqual(result.staleCopies.map(entry => entry.path), names);
  for (const entry of result.staleCopies) {
    assert.equal(entry.hash, digest(original(entry.path)));
    assert.ok(entry.tips.length > 0);
  }
}

for (const kind of ['mobile', 'disk']) {
  test(`E1: ${kind} fresh-state historical copies wait while an old live note adopts the latest version`, async t => {
    const c = await scenario(t, kind), count = c.r.revisions.size;
    const result = await c.pc.engine.sync();
    assert.equal(result.uploaded, 0); assert.equal(result.deleted, 0); assert.equal(result.conflicts, 0); assert.equal(result.downloaded, 1);
    pending(result, STALE);
    for (const name of STALE) {
      assert.equal(await c.pc.content(name), original(name));
      assert.deepEqual(result.staleCopies.find(entry => entry.path === name).tips, c.tombstones.get(name));
    }
    assert.equal(await c.pc.content('d.md'), 'd edited on Mac');
    const state = await c.pc.state.load(), bindings = new Map(state.files), absent = new Map(state.absent);
    for (const name of STALE) { assert.equal(bindings.has(name), false); assert.equal(absent.has(name), false); }
    assert.equal(bindings.get('e.md').blob, digest(original('e.md')), 'identical current content is adopted without upload');
    assert.equal(c.r.revisions.size, count);
  });

  test(`E1: ${kind} peers stay unchanged after a fresh-state device observes stale copies`, async t => {
    const c = await scenario(t, kind); await c.pc.engine.sync();
    noTransfer(await c.phone.engine.sync()); noTransfer(await c.mac.engine.sync());
    for (const peer of [c.phone, c.mac]) assert.deepEqual((await peer.local.list()).sort(), ['d.md', 'e.md']);
  });

  test(`E1: ${kind} undecided copies stay pending across full, incremental and restarted rounds`, async t => {
    const c = await scenario(t, kind); pending(await c.pc.engine.sync(), STALE);
    const count = c.r.revisions.size;
    for (const options of [{}, {}, { full: false, dirty: [] }]) {
      const result = await c.pc.engine.sync(options); noTransfer(result); pending(result, STALE);
    }
    const restarted = c.pc.restart(); const result = await restarted.engine.sync();
    noTransfer(result); pending(result, STALE); assert.equal(c.r.revisions.size, count);
  });

  test(`E1: ${kind} one round accepts confirmed local removals and keeps one copy as a tombstone successor`, async t => {
    const c = await scenario(t, kind); await c.pc.engine.sync();
    const count = c.r.revisions.size;
    const histories = new Map(['a.md', 'b.md'].map(name => [name, [...c.r.revisions.values()].filter(r => r.path === name).length]));
    // Models local files already trashed by an explicit user decision; E2 tests
    // separately require the actual app.fileManager.trashFile entry point.
    await c.pc.remove('a.md'); await c.pc.remove('b.md');
    const lists = c.r.lists, result = await c.pc.engine.sync({ keep: ['c.md'] });
    assert.equal(c.r.lists - lists, 1);
    assert.equal(result.uploaded, 1); assert.equal(result.conflicts, 0); pending(result, []);
    assert.equal(await c.pc.content('a.md'), null); assert.equal(await c.pc.content('b.md'), null);
    assert.equal(await c.pc.content('c.md'), original('c.md')); assert.equal(c.r.revisions.size, count + 1);
    const [tip] = headsFor(c.r.revisions.values(), 'c.md'); assert.deepEqual(c.r.revisions.get(tip).parents, c.tombstones.get('c.md'));
    for (const name of ['a.md', 'b.md']) assert.equal([...c.r.revisions.values()].filter(r => r.path === name).length, histories.get(name));
    for (const peer of [c.phone, c.mac]) { const next = await peer.engine.sync(); assert.equal(next.downloaded, 1); assert.equal(next.conflicts, 0); }
  });

  test(`E1: ${kind} intact bindings receive deletion and witnessed identical recreation stays deliberate`, async t => {
    const c = await scenario(t, kind, { fresh: false });
    const result = await c.pc.engine.sync(); assert.equal(result.deleted, 3); assert.equal(result.conflicts, 0); pending(result, []);
    await c.pc.write('a.md', original('a.md'));
    const recreated = await c.pc.engine.sync(); assert.equal(recreated.uploaded, 1); assert.equal(recreated.conflicts, 0); pending(recreated, []);
    const [tip] = headsFor(c.r.revisions.values(), 'a.md'); assert.deepEqual(c.r.revisions.get(tip).parents, c.tombstones.get('a.md'));
    assert.equal((await c.phone.engine.sync()).conflicts, 0);
  });

  test(`E1: ${kind} unique unbound content and genuine bound offline edits retain deletion conflicts`, async t => {
    const fresh = await scenario(t, kind); await fresh.pc.write('a.md', 'a unique fresh edit');
    const first = await fresh.pc.engine.sync(); assert.equal(first.uploaded, 1); assert.equal(first.conflicts, 1); pending(first, ['b.md', 'c.md']);
    assert.equal(await fresh.pc.content('a.md'), 'a unique fresh edit');
    const bound = await scenario(t, kind, { fresh: false, offlineEdit: true });
    const second = await bound.pc.engine.sync(); assert.equal(second.uploaded, 3); assert.equal(second.conflicts, 3); pending(second, []);
    for (const name of STALE) assert.equal(await bound.pc.content(name), 'unique offline edit: ' + name);
  });

  test(`E1: ${kind} an adopted historical copy is edited from the latest baseline`, async t => {
    const c = await scenario(t, kind); await c.pc.engine.sync();
    const parents = headsFor(c.r.revisions.values(), 'd.md'); await c.pc.write('d.md', 'd edited after adoption');
    const result = await c.pc.engine.sync(); assert.equal(result.uploaded, 1); assert.equal(result.conflicts, 0); pending(result, STALE);
    const [tip] = headsFor(c.r.revisions.values(), 'd.md'); assert.deepEqual(c.r.revisions.get(tip).parents, parents);
  });

  test(`E1: ${kind} historical matching never borrows content from another logical path`, async t => {
    const r = remote(), c = client(t, kind, r, 'fresh');
    const other = makeRevision({ path: 'other.md', parents: [], blob: digest('shared text'), device: 'peer' });
    const old = makeRevision({ path: 'note.md', parents: [], blob: digest('different text'), device: 'peer' });
    const deleted = makeRevision({ path: 'note.md', parents: [old.id], blob: null, device: 'peer' });
    await r.putBlob(other.blob, bytes('shared text')); await r.putBlob(old.blob, bytes('different text'));
    for (const row of [other, old, deleted]) await r.putRevision(row);
    await c.write('note.md', 'shared text'); const result = await c.engine.sync();
    assert.equal(result.uploaded, 1); assert.equal(result.conflicts, 1); pending(result, []);
    assert.equal(project(r.revisions.values()).get('note.md').blob, digest('shared text'));
  });

  test(`E1: ${kind} incremental pending lists react to remote resurrection and local events`, async t => {
    const c = await scenario(t, kind); await c.pc.engine.sync();
    await c.phone.write('a.md', original('a.md')); await c.phone.engine.sync();
    const remoteChange = await c.pc.engine.sync({ full: false, dirty: [] });
    assert.equal(remoteChange.uploaded, 0); assert.equal(remoteChange.conflicts, 0); pending(remoteChange, ['b.md', 'c.md']);
    await c.pc.remove('b.md'); pending(await c.pc.engine.sync({ full: false, dirty: ['b.md'] }), ['c.md']);
    await c.pc.write('c.md', 'new independent c'); const edited = await c.pc.engine.sync({ full: false, dirty: ['c.md'] });
    assert.equal(edited.uploaded, 1); assert.equal(edited.conflicts, 1); pending(edited, []);
  });
}

test('E1: steady mobile full rounds with pending copies read zero vault bodies', async t => {
  const c = await scenario(t, 'mobile'); await c.pc.engine.sync();
  let bodyReads = 0; const read = c.pc.storage.readBinary.bind(c.pc.storage);
  c.pc.storage.readBinary = async name => { if (!name.startsWith('.obsidian/')) bodyReads++; return read(name); };
  for (let i = 0; i < 2; i++) {
    const result = await c.pc.engine.sync(); pending(result, STALE);
    assert.equal(result.stats.vaultReads, 0); assert.equal(bodyReads, 0);
  }
});

for (const kind of ['mobile', 'disk']) test(`E1: ${kind} explicit keep acknowledges every current deletion leaf`, async t => {
  const r = remote(), c = client(t, kind, r, 'fresh');
  const old = makeRevision({ path: 'a.md', parents: [], blob: digest(original('a.md')), device: 'origin' });
  const deletions = ['one', 'two'].map(device => makeRevision({ path: 'a.md', parents: [old.id], blob: null, device }));
  await r.putBlob(old.blob, bytes(original('a.md')));
  for (const row of [old, ...deletions]) await r.putRevision(row);
  await c.write('a.md', original('a.md')); pending(await c.engine.sync(), ['a.md']);
  const parents = deletions.map(row => row.id).sort();
  const result = await c.engine.sync({ full: false, dirty: [], keep: ['a.md'] });
  assert.equal(result.uploaded, 1); assert.equal(result.conflicts, 0); pending(result, []);
  const [tip] = headsFor(r.revisions.values(), 'a.md'); assert.deepEqual(r.revisions.get(tip).parents, parents);
});

for (const kind of ['mobile', 'disk']) {
  test(`E1: ${kind} edits made while an adopted historical copy downloads survive CAS and stay concurrent`, async t => {
    const c = await scenario(t, kind);
    const old = [...c.r.revisions.values()].find(row => row.path === 'd.md' && row.blob === digest(original('d.md')));
    const get = c.r.getBlob.bind(c.r);
    c.r.getBlob = async hash => {
      c.r.getBlob = get; await c.pc.write('d.md', 'd edited during adoption'); return get(hash);
    };
    const first = await c.pc.engine.sync();
    assert.equal(first.uploaded, 0); assert.deepEqual(first.deferredPaths, ['d.md']);
    assert.equal(await c.pc.content('d.md'), 'd edited during adoption');
    assert.deepEqual(first.stalePaths, STALE);
    const second = await c.pc.engine.sync(); assert.equal(second.uploaded, 1); assert.equal(second.conflicts, 1);
    const edited = [...c.r.revisions.values()].find(row => row.path === 'd.md' && row.blob === digest('d edited during adoption'));
    assert.deepEqual(edited.parents, [old.id]);
    const contents = [...project(c.r.revisions.values()).values()].filter(row => row.path === 'd.md').map(row => text(c.r.blobs.get(row.blob))).sort();
    assert.deepEqual(contents, ['d edited during adoption', 'd edited on Mac']);
  });

  test(`E1: ${kind} unsaved editor guard blocks replacing an adopted historical copy`, async t => {
    const c = await scenario(t, kind), count = c.r.revisions.size;
    c.pc.local.guard = name => name !== 'd.md';
    const result = await c.pc.engine.sync();
    assert.equal(result.uploaded, 0); assert.equal(result.downloaded, 0); assert.equal(result.deleted, 0);
    assert.deepEqual(result.deferredPaths, ['d.md']); assert.deepEqual(result.stalePaths, STALE);
    assert.equal(await c.pc.content('d.md'), original('d.md')); assert.equal(c.r.revisions.size, count);
  });
}
