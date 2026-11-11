'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SyncEngine } = require('../src/engine');
const { makeRevision } = require('../src/protocol');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const MiB = 1024 * 1024;
const wait = () => new Promise(resolve => setTimeout(resolve, 2));
function fixture({ budget = 32 * MiB, concurrency = 4 } = {}) {
  const meter = { active: 0, peakActive: 0, held: 0, peakHeld: 0, calls: 0, committed: 0, starts: [], failAt: null, sizeActive: 0, peakSizeActive: 0 };
  const blobs = new Map(), revisions = new Map(), confirmed = new Set();
  const enter = (kind, hash, data) => {
    meter.active++; meter.peakActive = Math.max(meter.peakActive, meter.active); meter.calls++; meter.starts.push([kind, hash]);
    if (kind === 'get') { meter.held += data.length; meter.peakHeld = Math.max(meter.peakHeld, meter.held); }
  };
  const remote = { blobs, revisions,
    async listRevisions() { return [...revisions.values()]; },
    async putBlob(hash, data) {
      if (confirmed.has(hash)) return;
      enter('put', hash, data); const call = meter.calls;
      try { await wait(); if (meter.failAt === call) throw new Error('injected transfer failure'); blobs.set(hash, data); confirmed.add(hash); }
      finally { meter.active--; }
    },
    async getBlobSize(hash) { meter.sizeActive++; meter.peakSizeActive = Math.max(meter.peakSizeActive, meter.sizeActive); try { await wait(); return blobs.get(hash).length; } finally { meter.sizeActive--; } },
    async getBlob(hash) {
      const data = blobs.get(hash); enter('get', hash, data); const call = meter.calls;
      try { await wait(); if (meter.failAt === call) throw new Error('injected transfer failure'); return data; }
      finally { meter.active--; }
    },
    async putRevision(revision) { revisions.set(revision.id, revision); meter.committed++; },
  };
  const data = new Map(), heldUploads = new Map();
  const local = { data, transferBudget: budget,
    async list() { return [...data.keys()]; },
    async size(name) { return data.get(name)?.length ?? null; },
    async read(name, limit) {
      const value = data.get(name) ?? null;
      if (value && value.length > (limit ?? Infinity)) throw new Error('grew beyond reserved size');
      if (value && !heldUploads.has(name)) { heldUploads.set(name, value); meter.held += value.length; meter.peakHeld = Math.max(meter.peakHeld, meter.held); }
      return value;
    },
    async compareAndSet(name, expected, value) {
      const actual = data.get(name) ?? null;
      if ((actual === null ? null : digest(actual)) !== expected) return false;
      if (value === null) data.delete(name); else { data.set(name, value); meter.held -= value.length; }
      return true;
    },
  };
  const state = { disk: null, pending: null, staged: new Map(),
    async load() { return structuredClone(this.disk); }, async save(v) { this.disk = structuredClone(v); },
    async loadPending() { return structuredClone(this.pending); }, async savePending(v) { this.pending = structuredClone(v); }, async clearPending() { this.pending = null; },
    async stageBlob(hash, value) { this.staged.set(hash, value); }, async readStaged(hash) { return this.staged.get(hash); },
    async clearStaged(hash) {
      const staged = this.staged.get(hash); this.staged.delete(hash);
      for (const [name, value] of heldUploads) if (value === staged) { meter.held -= value.length; heldUploads.delete(name); break; }
    },
  };
  const engine = new SyncEngine({ remote, local, state, device: 'transfer', concurrency });
  return { engine, remote, local, state, meter, resetMeter() { meter.active = meter.peakActive = meter.held = meter.peakHeld = meter.calls = meter.committed = 0; meter.starts = []; meter.failAt = null; heldUploads.clear(); },
    seed(name, body) { const hash = digest(body); blobs.set(hash, body); const rev = makeRevision({ path: name, blob: hash, device: 'seed' }); revisions.set(rev.id, rev); } };
}

test('B4: downloads prefetch four ways while journals and local commits remain serial', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.seed('note-' + i + '.md', Buffer.from('remote-' + i));
  let applying = 0, peakApplying = 0;
  const cas = f.local.compareAndSet.bind(f.local);
  f.local.compareAndSet = async (...args) => { applying++; peakApplying = Math.max(peakApplying, applying); await wait(); try { return await cas(...args); } finally { applying--; } };
  const result = await f.engine.sync();
  assert.equal(result.downloaded, 12); assert.equal(f.meter.peakActive, 4); assert.equal(peakApplying, 1);
  assert.ok(f.meter.peakSizeActive > 1 && f.meter.peakSizeActive <= 4);
  assert.equal(f.local.data.size, 12);
});

test('B4: uploads prefetch four blobs then commit each revision with a single pending journal', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.local.data.set('note-' + i + '.md', Buffer.from('local-' + i));
  const savePending = f.state.savePending.bind(f.state);
  f.state.savePending = async value => { assert.equal(f.state.pending, null); await savePending(value); };
  const result = await f.engine.sync();
  assert.equal(result.uploaded, 12); assert.equal(f.meter.peakActive, 4);
  assert.equal(f.meter.calls, 12); assert.equal(f.remote.revisions.size, 12); assert.equal(f.state.pending, null);
  assert.ok(f.meter.peakHeld <= 32 * MiB);
});

for (const direction of ['upload', 'download']) test('B4: ' + direction + ' budget includes completed bodies awaiting serial commit and oversized blobs run alone', async () => {
  const f = fixture();
  const large = Buffer.alloc(40 * MiB, 7), medium = Buffer.alloc(12 * MiB, 3);
  const source = [medium, medium, medium, large, medium];
  for (let i = 0; i < source.length; i++) {
    if (direction === 'download') f.seed('file-' + i + '.bin', source[i]);
    else { const body = Buffer.from(source[i]); body[0] = i; f.local.data.set('file-' + i + '.bin', body); }
  }
  const enter = direction === 'download' ? f.remote.getBlob.bind(f.remote) : f.remote.putBlob.bind(f.remote);
  f.remote[direction === 'download' ? 'getBlob' : 'putBlob'] = async (...args) => {
    const size = direction === 'download' ? f.remote.blobs.get(args[0]).length : args[1].length;
    if (size > 32 * MiB) assert.equal(f.meter.active, 0);
    else assert.ok(f.meter.held <= 32 * MiB);
    return enter(...args);
  };
  await f.engine.sync();
  assert.equal(f.meter.peakHeld, 40 * MiB);
  assert.ok(f.meter.peakActive <= 2);
});

test('B4: desktop budget admits three 40 MiB downloads and keeps the fourth outside the held batch', async () => {
  const f = fixture({ budget: 128 * MiB }), body = Buffer.alloc(40 * MiB, 5);
  for (let i = 0; i < 4; i++) f.seed('attachment-' + i + '.bin', body);
  await f.engine.sync();
  assert.equal(f.meter.peakActive, 3); assert.equal(f.meter.peakHeld, 120 * MiB);
});

for (const direction of ['upload', 'download']) test('B4: ' + direction + ' failure settles the current batch, dispatches no later batch, then converges on retry', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    const body = Buffer.from('body-' + i);
    if (direction === 'download') f.seed('note-' + i + '.md', body); else f.local.data.set('note-' + i + '.md', body);
  }
  f.meter.failAt = 2;
  await assert.rejects(f.engine.sync(), /injected transfer failure/);
  assert.equal(f.meter.active, 0); assert.equal(f.meter.calls, 4); assert.equal(f.meter.committed, 0);
  f.resetMeter(); await f.engine.sync(); await f.engine.sync();
  assert.equal(f.local.data.size, 12); assert.equal(f.remote.revisions.size, 12);
  for (let i = 0; i < 12; i++) assert.equal(f.local.data.get('note-' + i + '.md').toString(), 'body-' + i);
});

test('B4: concurrency one is supported and changing files cannot outgrow their reserved upload slots', async () => {
  const f = fixture({ concurrency: 1 });
  for (let i = 0; i < 4; i++) f.local.data.set('note-' + i + '.md', Buffer.from('body-' + i));
  await f.engine.sync(); assert.equal(f.meter.peakActive, 1);
  const g = fixture(); g.local.data.set('growing.md', Buffer.from('small'));
  g.local.size = async () => { g.local.data.set('growing.md', Buffer.alloc(100)); return 5; };
  await assert.rejects(g.engine.sync(), /reserved size/); assert.equal(g.remote.revisions.size, 0);
});

test('B4: unknown remote sizes reserve an exclusive channel', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.seed('unknown-' + i + '.md', Buffer.from('content-' + i));
  f.remote.getBlobSize = async () => null;
  await f.engine.sync(); assert.equal(f.meter.peakActive, 1); assert.equal(f.local.data.size, 5);
});

test('B4: a local edit during concurrent downloads is deferred by CAS and retained on retry', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.seed('note-' + i + '.md', Buffer.from('remote-' + i));
  let edited = false;
  const get = f.remote.getBlob.bind(f.remote);
  f.remote.getBlob = async hash => {
    const body = await get(hash);
    if (!edited) { edited = true; f.local.data.set('note-0.md', Buffer.from('local edit during prefetch')); }
    return body;
  };
  const first = await f.engine.sync();
  assert.deepEqual(first.deferredPaths, ['note-0.md']);
  assert.equal(f.local.data.get('note-0.md').toString(), 'local edit during prefetch');
  await f.engine.sync(); await f.engine.sync();
  const contents = [...f.local.data.values()].map(v => v.toString());
  assert.ok(contents.includes('local edit during prefetch')); assert.ok(contents.includes('remote-0'));
});

function initializationDAV() {
  const dirs = new Set(['/vault/']), files = new Map(), calls = [];
  const f = { dirs, files, calls, fail: false };
  const entry = p => `<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  f.options = { url: 'https://example.test/vault/', request: async ({ method, url, body, headers }) => {
    const p = url.pathname; calls.push([method, p]); await wait();
    const send = (status, value = '') => ({ status, headers: {}, body: Buffer.from(value) });
    if (method === 'PROPFIND') {
      const children = headers.Depth === '1' ? [...files.keys()].filter(name => name.startsWith(p) && !name.slice(p.length).includes('/')).map(name => entry(name).replace('<d:collection/>', '')).join('') : '';
      return dirs.has(p) ? send(207, '<d:multistatus xmlns:d="DAV:">' + entry(p) + children + '</d:multistatus>') : send(404);
    }
    if (method === 'MKCOL') { if (f.fail) return send(500); if (dirs.has(p)) return send(405); dirs.add(p); return send(201); }
    if (method === 'GET') return files.has(p) ? send(200, files.get(p)) : send(404);
    if (method === 'PUT') { if (files.has(p)) return send(412); files.set(p, body); return send(201); }
    return send(405);
  } };
  return f;
}

test('B4: concurrent flat-store initialization is shared and a failed initialization can retry', async () => {
  const { DavRemote } = require('../src/dav');
  for (const failFirst of [false, true]) {
    const f = initializationDAV(), remote = new DavRemote(f.options);
    const values = Array.from({ length: 4 }, (_, i) => Buffer.from('init-' + i));
    if (failFirst) {
      f.fail = true;
      const failed = await Promise.allSettled(values.map(value => remote.putBlob(digest(value), value)));
      assert.ok(failed.every(result => result.status === 'rejected'));
      assert.equal(f.calls.filter(([method]) => method === 'MKCOL').length, 1);
      f.fail = false; f.calls.length = 0;
    }
    await Promise.all(values.map(value => remote.putBlob(digest(value), value)));
    assert.equal(f.calls.filter(([method]) => method === 'MKCOL').length, 1);
    assert.equal(f.calls.filter(([method]) => method === 'PROPFIND').length, 3);
  }
});

test('B4: concurrent sharded writes share bucket initialization and clear a failed bucket promise', async () => {
  const { DavRemote } = require('../src/dav');
  const { ShardedStore, V2_NAMESPACE } = require('../src/sharded');
  const values = [];
  for (let i = 0; values.length < 4; i++) { const body = Buffer.from('bucket-' + i); if (digest(body).startsWith('a')) values.push(body); }
  for (const failFirst of [false, true]) {
    const f = initializationDAV(); f.dirs.add('/vault/' + V2_NAMESPACE + '/');
    const remote = new ShardedStore(f.options, new DavRemote(f.options)); remote.created = true;
    if (failFirst) {
      f.fail = true;
      const failed = await Promise.allSettled(values.map(value => remote.putBlob(digest(value), value)));
      assert.ok(failed.every(result => result.status === 'rejected'));
      assert.equal(f.calls.filter(([method]) => method === 'MKCOL').length, 1);
      f.fail = false; f.calls.length = 0;
    }
    await Promise.all(values.map(value => remote.putBlob(digest(value), value)));
    assert.equal(f.calls.filter(([method]) => method === 'MKCOL').length, 1);
    assert.equal(f.calls.filter(([method]) => method === 'PROPFIND').length, 2);
  }
});


test('B4: verified preuploads are reused only until the next listing, which restores existing-object verification', async () => {
  const { DavRemote } = require('../src/dav');
  const f = initializationDAV(), remote = new DavRemote(f.options), body = Buffer.from('verified upload'), hash = digest(body);
  await remote.putBlob(hash, body);
  let before = f.calls.length;
  await remote.putBlob(hash, body); assert.equal(f.calls.length, before);
  await remote.listRevisions(); before = f.calls.length;
  await remote.putBlob(hash, body);
  assert.deepEqual(f.calls.slice(before).map(([method]) => method), ['GET']);
  await remote.listRevisions();
  f.files.set(remote.objectURL(hash, '.blob').pathname, Buffer.from('corrupted remote bytes'));
  await assert.rejects(remote.putBlob(hash, body), /对象内容与版本标识不符/);
});
