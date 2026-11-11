'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.OBSIDIAN_PERF_REPO || path.resolve(__dirname, '..');
const { SyncEngine } = require(path.join(root, 'src/engine'));
const { MobileVault, MobileState } = require(path.join(root, 'src/mobile'));
const { Adapter } = require(path.join(root, 'test/helpers/adapter'));
const { bytes, text, digest } = require(path.join(root, 'src/bytes'));

function store() {
  return {
    blobs: new Map(), revs: new Map(),
    async listRevisions() { return [...this.revs.values()]; },
    async putBlob(hash, data) { assert.equal(digest(data), hash); this.blobs.set(hash, bytes(data).slice()); },
    async getBlobSize(hash) { return this.blobs.get(hash).length; },
    async getBlob(hash) { return this.blobs.get(hash).slice(); },
    async putRevision(rev) { this.revs.set(rev.id, rev); },
  };
}
function client(remote, device) {
  const adapter = new Adapter();
  let active = true;
  const local = new MobileVault(adapter, '.obsidian', () => true, () => active);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test/vault/', 'u');
  return { adapter, local, state, setActive: value => { active = value; },
    engine: new SyncEngine({ remote, local, state, device }) };
}

test('B4: an editor change during preupload follows the exact completed snapshot with real mobile receipts', async () => {
  const r = store(), a = client(r, 'A');
  a.adapter.put('edit.md', 'base'); await a.engine.sync();
  const put = r.putBlob.bind(r);
  let edited = false;
  r.putBlob = async (hash, data) => {
    await put(hash, data);
    if (!edited && hash === digest('snapshot')) {
      edited = true; a.adapter.put('edit.md', 'typed during preupload');
    }
  };
  a.adapter.put('edit.md', 'snapshot'); await a.engine.sync();
  assert.equal(text(await a.local.read('edit.md')), 'typed during preupload');
  await a.engine.sync(); await a.engine.sync();
  assert.equal(r.revs.size, 3);
  const rows = [...r.revs.values()];
  const snapshot = rows.find(rev => rev.blob === digest('snapshot'));
  const typed = rows.find(rev => rev.blob === digest('typed during preupload'));
  assert.deepEqual(typed.parents, [snapshot.id]);
  assert.equal(await a.state.loadPending(), null);
  assert.equal((await a.state.loadReceipts((await a.state.load()).receiptSequence)).length, 0);
});

test('B4: background after prefetch stops before pending/CAS and foreground retry converges with mobile state', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.adapter.put('edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  a.adapter.put('edit.md', 'remote'); await a.engine.sync();
  const get = r.getBlob.bind(r);
  let paused = false;
  r.getBlob = async hash => {
    const body = await get(hash);
    if (!paused) { paused = true; b.setActive(false); }
    return body;
  };
  await assert.rejects(b.engine.sync(), /暂停/);
  assert.equal(text(b.adapter.files.get('edit.md')), 'base');
  assert.equal(await b.state.loadPending(), null);
  b.setActive(true); await b.engine.sync(); await b.engine.sync();
  assert.equal(text(await b.local.read('edit.md')), 'remote');
  assert.equal(r.revs.size, 2);
});

test('B4: failed prefetch leaves no apply intent and retains a simultaneous new local file on retry', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  for (let i = 0; i < 4; i++) a.adapter.put('n' + i + '.md', 'remote ' + i);
  await a.engine.sync();
  const get = r.getBlob.bind(r);
  let calls = 0;
  r.getBlob = async hash => {
    if (++calls === 2) {
      b.adapter.put('external.md', 'local during failure');
      throw new Error('injected read failure');
    }
    return get(hash);
  };
  await assert.rejects(b.engine.sync(), /injected read failure/);
  assert.equal(await b.state.loadPending(), null);
  assert.equal(b.adapter.files.has('n0.md'), false);
  r.getBlob = get; await b.engine.sync(); await b.engine.sync();
  assert.equal(r.revs.size, 5);
  assert.equal(text(await b.local.read('external.md')), 'local during failure');
  for (let i = 0; i < 4; i++) assert.equal(text(await b.local.read('n' + i + '.md')), 'remote ' + i);
});
