'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncEngine } = require('../src/engine');
const { MobileVault, MobileState } = require('../src/mobile');
const { Adapter } = require('./helpers/adapter');
const { bytes, text } = require('../src/bytes');

function store() {
  return { revs: new Map(), blobs: new Map(), gets: 0,
    async listRevisions() { return [...this.revs.values()]; },
    async putRevision(r) { this.revs.set(r.id, r); },
    async putBlob(id, data) { this.blobs.set(id, bytes(data).slice()); },
    async getBlob(id) { this.gets++; return this.blobs.get(id).slice(); }
  };
}
function client(remote, device, adapter = new Adapter()) {
  const local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test/recovery/', 'test');
  return { adapter, local, state, engine: new SyncEngine({ remote, local, state, device }) };
}
async function interrupted({ existing = true, localizedStat = false } = {}) {
  const remote = store(), mac = client(remote, 'Mac'), phone = client(remote, 'iPhone');
  if (existing) {
    mac.adapter.put('note.md', 'old'); await mac.engine.sync(); await phone.engine.sync();
  }
  mac.adapter.put('note.md', 'new'); await mac.engine.sync();
  const stage = phone.local.transaction + '/next';
  phone.adapter.hook = async (operation, name, when) => {
    if (operation === 'copy' && name === 'note.md' && when === 'before') {
      await phone.adapter.remove(stage);
      throw Object.assign(new Error("文件 'next' 不存在"), { code: 'ENOENT' });
    }
  };
  await assert.rejects(phone.engine.sync(), /next/);
  phone.adapter.hook = async () => {};
  if (localizedStat) {
    const stat = phone.adapter.stat.bind(phone.adapter);
    phone.adapter.stat = async name => {
      const value = await stat(name);
      if (name === stage && !value) throw new Error("文件 'next' 不存在");
      return value;
    };
    // CapacitorAdapter.exists probes the native filesystem and catches absence
    // independently; unlike this test helper, it does not call adapter.stat.
    phone.adapter.exists = async name => Boolean(await stat(name));
  }
  assert.equal(await phone.local.read('note.md'), null);
  assert.ok(await phone.state.loadPending());
  return { remote, mac, phone, stage };
}

for (const existing of [false, true]) test('missing next: resumes ' + (existing ? 'replacement' : 'first download') + ' with verified remote bytes', async () => {
  const { remote, phone } = await interrupted({ existing });
  const revisionCount = remote.revs.size;
  const restarted = client(remote, 'iPhone', phone.adapter);
  const result = await restarted.engine.sync();
  assert.equal(text(await restarted.local.read('note.md')), 'new');
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 0);
  assert.equal(remote.revs.size, revisionCount);
  assert.equal(await restarted.state.loadPending(), null);
  assert.equal(await restarted.adapter.exists(restarted.local.transaction), false);
});

test('missing next: localized native missing-file error is checked against the private directory listing', async () => {
  const { remote, phone } = await interrupted({ localizedStat: true });
  await client(remote, 'iPhone', phone.adapter).engine.sync();
  assert.equal(text(await phone.local.read('note.md')), 'new');
});

test('missing next: remote failure preserves transaction and old bytes until retry succeeds', async () => {
  const { remote, phone } = await interrupted();
  const read = remote.getBlob.bind(remote);
  remote.getBlob = async () => { throw new Error('offline'); };
  await assert.rejects(phone.engine.sync(), /offline/);
  assert.equal(text(phone.adapter.files.get(phone.local.transaction + '/previous')), 'old');
  assert.ok(await phone.state.loadPending());
  remote.getBlob = read;
  await phone.engine.sync();
  assert.equal(text(await phone.local.read('note.md')), 'new');
});

test('missing next: corrupt remote bytes cannot replace the staged payload or discard the old bytes', async () => {
  const { remote, phone, stage } = await interrupted();
  remote.getBlob = async () => bytes('wrong');
  await assert.rejects(phone.engine.sync(), /校验/);
  assert.equal(phone.adapter.files.has(stage), false);
  assert.equal(text(phone.adapter.files.get(phone.local.transaction + '/previous')), 'old');
  assert.ok(await phone.state.loadPending());
  assert.equal(await phone.local.read('note.md'), null);
});

test('missing next: a new local edit during refetch survives and is retained as a conflict', async () => {
  const { remote, phone } = await interrupted();
  const read = remote.getBlob.bind(remote);
  let changed = false;
  remote.getBlob = async id => {
    const value = await read(id);
    if (!changed) { changed = true; phone.adapter.put('note.md', 'concurrent local edit'); }
    return value;
  };
  const result = await phone.engine.sync();
  assert.equal(result.conflicts, 1);
  assert.deepEqual((await phone.local.list()).map(name => text(phone.adapter.files.get(name))).sort(), ['concurrent local edit', 'new']);
});

for (const field of ['physical', 'blob', 'parents', 'expected', 'missing journal']) test('missing next: refuses mismatched ' + field, async () => {
  const { remote, phone } = await interrupted();
  if (field === 'missing journal') await phone.state.clearPending();
  else if (field === 'expected') {
    const name = phone.local.transaction + '/intent.json';
    const intent = JSON.parse(text(phone.adapter.files.get(name)));
    // No moved previous bytes: this represents a new-file transaction instead.
    await phone.adapter.remove(phone.local.transaction + '/previous');
    intent.expected = null; phone.adapter.put(name, JSON.stringify(intent));
  } else {
    const pending = await phone.state.loadPending();
    await phone.state.clearPending();
    if (field === 'physical') pending.physical = 'another.md';
    if (field === 'blob') pending.next.blob = '2'.repeat(64);
    if (field === 'parents') pending.next.parents = [];
    await phone.state.savePending(pending);
  }
  const gets = remote.gets;
  await assert.rejects(phone.engine.sync(), /日志|暂存|校验/);
  assert.equal(remote.gets, gets, 'must not fetch before journal validation');
  assert.equal(await phone.adapter.exists(phone.local.transaction), true);
});

test('missing next: an already applied target needs no staged payload and no download', async () => {
  const { remote, phone } = await interrupted();
  phone.adapter.put('note.md', 'new');
  const gets = remote.gets;
  const result = await phone.engine.sync();
  assert.equal(remote.gets, gets); assert.equal(result.uploaded, 0);
  assert.equal(text(await phone.local.read('note.md')), 'new');
  assert.equal(await phone.state.loadPending(), null);
});

test('missing next: a present but unreadable payload is not silently replaced', async () => {
  const { remote, phone, stage } = await interrupted();
  phone.adapter.put(stage, 'new');
  const read = phone.adapter.readBinary.bind(phone.adapter);
  phone.adapter.readBinary = async name => { if (name === stage) throw new Error('permission denied'); return read(name); };
  const gets = remote.gets;
  await assert.rejects(phone.engine.sync(), /permission denied/);
  assert.equal(remote.gets, gets); assert.equal(text(phone.adapter.files.get(stage)), 'new');
  assert.ok(await phone.state.loadPending());
});

test('missing next: existing corrupt stage remains available for diagnosis and is never refetched over', async () => {
  const { remote, phone, stage } = await interrupted();
  phone.adapter.put(stage, 'unexpected staged data');
  const gets = remote.gets;
  await assert.rejects(phone.engine.sync(), /校验/);
  assert.equal(remote.gets, gets);
  assert.equal(text(phone.adapter.files.get(stage)), 'unexpected staged data');
  assert.equal(text(phone.adapter.files.get(phone.local.transaction + '/previous')), 'old');
});

test('missing next: remote history loss stops recovery before any payload fetch', async () => {
  const { remote, phone, stage } = await interrupted();
  remote.revs.delete(remote.revs.keys().next().value);
  const gets = remote.gets;
  await assert.rejects(phone.engine.sync(), /missing|incomplete/i);
  assert.equal(remote.gets, gets); assert.equal(phone.adapter.files.has(stage), false);
  assert.ok(await phone.state.loadPending());
});

test('missing next: changed local intent during refetch is preserved without installing the payload', async () => {
  const { remote, phone, stage } = await interrupted();
  const intent = phone.local.transaction + '/intent.json';
  const read = remote.getBlob.bind(remote);
  remote.getBlob = async id => {
    const tx = JSON.parse(text(phone.adapter.files.get(intent)));
    phone.adapter.put(intent, JSON.stringify({ ...tx, name: 'different.md' }));
    return read(id);
  };
  await assert.rejects(phone.engine.sync(), /恢复记录已变化/);
  assert.equal(phone.adapter.files.has(stage), false);
  assert.equal(JSON.parse(text(phone.adapter.files.get(intent))).name, 'different.md');
  assert.equal(text(phone.adapter.files.get(phone.local.transaction + '/previous')), 'old');
});

test('missing next: legacy embedded apply journals can recover the exact downloaded payload', async () => {
  const { remote, phone } = await interrupted();
  const pending = await phone.state.loadPending(), state = await phone.state.load();
  await phone.state.clearPending();
  state.pending = pending; await phone.state.save(state);
  const result = await client(remote, 'iPhone', phone.adapter).engine.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 0);
  assert.equal(text(await phone.local.read('note.md')), 'new');
});

test('deletion conflict: deleting the final content branch still confirms deletion on both clients', async () => {
  const remote = store(), mac = client(remote, 'Mac'), phone = client(remote, 'iPhone');
  mac.adapter.put('note.md', 'base'); await mac.engine.sync(); await phone.engine.sync();
  await mac.adapter.remove('note.md'); phone.adapter.put('note.md', 'phone edit');
  await mac.engine.sync(); assert.equal((await phone.engine.sync()).conflicts, 1); await mac.engine.sync();
  await phone.adapter.remove('note.md');
  assert.equal((await phone.engine.sync()).conflicts, 0); assert.equal((await mac.engine.sync()).conflicts, 0);
  assert.equal(await phone.local.read('note.md'), null); assert.equal(await mac.local.read('note.md'), null);
});
