'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, mobileRequest, MOBILE_LIMIT, DOWNLOAD_CHUNK } = require('../src/mobile');
const { DavRemote } = require('../src/dav');
const { AdaptiveDavRemote } = require('../src/sharded');
const { bytes, arrayBuffer, digest } = require('../src/bytes');
function nativeBlob(source, options = {}) {
  const calls = [];
  const request = mobileRequest(async ({ method, headers }) => {
    calls.push(method);
    if (method === 'HEAD') return { status: options.headStatus || 200, headers: options.noLength ? {} : { 'Content-Length': String(options.size ?? source.length) }, arrayBuffer: arrayBuffer('') };
    if (options.getFails) throw new Error('network');
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.Range || '');
    if (range) {
      const lo = Number(range[1]), hi = Number(range[2]);
      return { status: 206, headers: { 'Content-Range': `bytes ${lo}-${hi}/${source.length}` }, arrayBuffer: arrayBuffer(source.subarray(lo, hi + 1 - (options.truncated ? 1 : 0))) };
    }
    return { status: 200, headers: {}, arrayBuffer: arrayBuffer(source) };
  }, () => options.active !== false);
  return { calls, remote: new DavRemote({ url: 'https://example.test/vault/', request }), request };
}

test('B4: mobile prefetch consumes its HEAD once and a later get requires a fresh HEAD', async () => {
  const source = bytes('hello'), f = nativeBlob(source), id = digest(source);
  assert.equal(await f.remote.getBlobSize(id), source.length);
  assert.deepEqual(await f.remote.getBlob(id), source);
  assert.deepEqual(f.calls, ['HEAD', 'GET']);
  await f.remote.getBlob(id);
  assert.deepEqual(f.calls, ['HEAD', 'GET', 'HEAD', 'GET']);
});

test('B4: a prefetched large mobile blob keeps range validation and one HEAD', async () => {
  const source = new Uint8Array(DOWNLOAD_CHUNK + 17).fill(23), f = nativeBlob(source), id = digest(source);
  assert.equal(await f.remote.getBlobSize(id), source.length);
  assert.deepEqual(await f.remote.getBlob(id), source);
  assert.deepEqual(f.calls, ['HEAD', 'GET', 'GET']);
  const broken = nativeBlob(source, { truncated: true }); await broken.remote.getBlobSize(id);
  await assert.rejects(broken.remote.getBlob(id), /范围|完整/);
});

test('B4: prefetched mobile size remains bounded and requires the exact HEAD length', async () => {
  const source = bytes('hello'), id = digest(source), tooLarge = nativeBlob(source, { size: MOBILE_LIMIT + 1 });
  await assert.rejects(tooLarge.remote.getBlobSize(id), /128 MiB/);
  assert.deepEqual(tooLarge.calls, ['HEAD']);
  for (const size of [source.length - 1, source.length + 1]) {
    const wrong = nativeBlob(source, { size }); await wrong.remote.getBlobSize(id);
    await assert.rejects(wrong.remote.getBlob(id), /大小|范围|完整/);
  }
});

test('B4: preflight does not bypass the foreground guard or content checksum', async () => {
  const source = bytes('hello'), options = {}, f = nativeBlob(source, options), id = digest(source);
  await f.remote.getBlobSize(id); options.active = false;
  await assert.rejects(f.remote.getBlob(id), /暂停/); assert.deepEqual(f.calls, ['HEAD']);
  options.active = true; await f.remote.getBlob(id); assert.deepEqual(f.calls, ['HEAD', 'HEAD', 'GET']);
  const corrupt = nativeBlob(bytes('other')); await corrupt.remote.getBlobSize(id);
  await assert.rejects(corrupt.remote.getBlob(id), /版本标识/);
});

test('B4: failed prefetch clears all unused HEAD reservations', async () => {
  const source = bytes('hello'), options = {}, f = nativeBlob(source, options), id = digest(source);
  await f.remote.getBlobSize(id); await f.remote.getBlobSize(digest('other'));
  options.getFails = true; await assert.rejects(f.remote.getBlob(id), /传输失败/);
  assert.equal(f.remote.blobPreflights.size, 0);
});

test('B4: desktop HEAD absence falls back without making mobile HEAD optional', async () => {
  const source = bytes('hello'), id = digest(source);
  for (const result of [{ status: 405 }, { status: 501 }, { status: 200, headers: {} }]) {
    const remote = new DavRemote({ url: 'https://example.test/vault/', request: async ({ method }) => method === 'HEAD' ? { ...result, body: new Uint8Array(0) } : { status: 200, body: source } });
    assert.equal(await remote.getBlobSize(id), null); assert.deepEqual(await remote.getBlob(id), source);
  }
  const mobile = nativeBlob(source, { headStatus: 405 });
  await assert.rejects(mobile.remote.getBlobSize(id), /HEAD/);
});

test('B4: adaptive store forwards size preflight and explicit cleanup', async () => {
  const remote = new AdaptiveDavRemote({ url: 'https://example.test/vault/', request: async () => ({ status: 200, headers: { 'content-length': '7' }, body: new Uint8Array(0) }) });
  remote.selected = remote.legacy;
  assert.equal(await remote.getBlobSize(digest('content')), 7);
  assert.equal(remote.legacy.blobPreflights.size, 1); remote.clearBlobPreflights();
  assert.equal(remote.legacy.blobPreflights.size, 0);
});

test('B4: mobile size reuses a listing stamp without reading content or weakening validation', async () => {
  const adapter = new Adapter(), local = new MobileVault(adapter); adapter.put('x.md', 'hello');
  let stats = 0; const stat = adapter.stat.bind(adapter);
  adapter.stat = async name => { if (name === 'x.md') stats++; return stat(name); };
  adapter.readBinary = async () => { throw new Error('unexpected file read'); };
  local.beginRound(); await local.list(); assert.equal(await local.size('x.md'), 5); assert.equal(stats, 1);
  assert.equal(await local.size('absent.md'), null); assert.equal(local.transferBudget, 32 * 1024 * 1024);
  await assert.rejects(local.size('../escape'), /不安全/);
  await assert.rejects(new MobileVault(adapter, '.obsidian', () => true, () => false).size('x.md'), /暂停/);
  adapter.stat = async () => ({ type: 'file', size: MOBILE_LIMIT + 1 });
  local.beginRound(); await assert.rejects(local.size('x.md'), /128 MiB/);
});

test('B4: desktop size checks paths and bytes without opening a file body', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DiskVault } = require('../src/local');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-size-'));
  try {
    fs.writeFileSync(path.join(root, 'x.md'), 'hello');
    const local = new DiskVault(root); local.read = async () => { throw new Error('unexpected read'); };
    assert.equal(await local.size('x.md'), 5); assert.equal(await local.size('absent.md'), null);
    assert.equal(local.transferBudget, 128 * 1024 * 1024);
    await assert.rejects(local.size('../escape'), /不安全/);
    fs.symlinkSync(path.join(root, 'x.md'), path.join(root, 'linked.md'));
    await assert.rejects(local.size('linked.md'), /符号链接/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('B4: bounded local reads reject growth between sizing and allocation', async () => {
  const adapter = new Adapter(), local = new MobileVault(adapter); adapter.put('x.md', 'small');
  const size = await local.size('x.md'); adapter.put('x.md', 'larger after metadata');
  let bodyReads = 0; const read = adapter.readBinary.bind(adapter);
  adapter.readBinary = async name => { bodyReads++; return read(name); };
  await assert.rejects(local.read('x.md', size)); assert.equal(bodyReads, 0);
  adapter.put('new.md', 'created after missing stat'); await assert.rejects(local.read('new.md', 0)); assert.equal(bodyReads, 0);
});

test('B4: desktop GET uses the HEAD reservation as its streaming response limit', async () => {
  const source = bytes('hello'), seen = [], id = digest(source);
  const remote = new DavRemote({ url: 'https://example.test/vault/', request: async ({ method, limit }) => {
    seen.push({ method, limit });
    return method === 'HEAD' ? { status: 200, headers: { 'content-length': String(source.length) }, body: new Uint8Array(0) } : { status: 200, body: source };
  } });
  assert.equal(await remote.getBlobSize(id), source.length); assert.deepEqual(await remote.getBlob(id), source);
  assert.equal(seen[1].limit, source.length);
});

test('B4: every shared-blob HEAD reservation keeps its own desktop GET limit', async () => {
  const source = bytes('hello'), id = digest(source), limits = [];
  const remote = new DavRemote({ url: 'https://example.test/vault/', request: async ({ method, limit }) => {
    if (method === 'GET') limits.push(limit);
    return { status: 200, headers: { 'Content-Length': '5' }, body: method === 'HEAD' ? new Uint8Array(0) : source };
  } });
  const sizes = await Promise.all([remote.getBlobSize(id), remote.getBlobSize(id)]);
  await Promise.all(sizes.map(size => remote.getBlob(id, size)));
  assert.deepEqual(limits, [5, 5]); assert.equal(remote.blobPreflights.size, 0);
});

test('B4: concurrent HEAD completion order cannot exchange different planned GET limits', async () => {
  const source = bytes('hello'), id = digest(source), limits = [];
  let calls = 0, first;
  const remote = new DavRemote({ url: 'https://example.test/vault/', request: async ({ method, limit }) => {
    if (method === 'HEAD') {
      const size = ++calls === 1 ? 5 : 7;
      if (size === 5) await new Promise(resolve => { first = resolve; });
      return { status: 200, headers: { 'Content-Length': String(size) }, body: new Uint8Array(0) };
    }
    limits.push(limit); return { status: 200, body: source };
  } });
  const firstSize = remote.getBlobSize(id), secondSize = remote.getBlobSize(id);
  const seven = await secondSize; first();
  const sizes = [await firstSize, seven];
  assert.deepEqual(sizes, [5, 7]);
  assert.deepEqual(await remote.getBlob(id, sizes[0]), source);
  await assert.rejects(remote.getBlob(id, sizes[1]), /大小与预检不符/);
  assert.deepEqual(limits, [5, 7]);
});

test('B4: an explicit download reservation remains a GET cap even without a matching HEAD entry', async () => {
  const source = bytes('hello'), id = digest(source), limits = [];
  const options = { url: 'https://example.test/vault/', request: async ({ method, limit }) => { limits.push(limit); return { status: 200, body: source }; } };
  const remote = new AdaptiveDavRemote(options); remote.selected = remote.legacy;
  assert.deepEqual(await remote.getBlob(id, 5), source); assert.deepEqual(limits, [5]);
  await assert.rejects(remote.getBlob(id, -1), /reservation|预约/);
});

test('B4: nine mobile files sharing one blob consume nine HEADs across three payload batches', async () => {
  const { SyncEngine } = require('../src/engine');
  const { makeRevision } = require('../src/protocol');
  const source = bytes('shared content'), id = digest(source), f = nativeBlob(source);
  const rows = Array.from({ length: 9 }, (_, i) => makeRevision({ path: 'shared-' + i + '.md', blob: id, device: 'seed' }));
  f.remote.listRevisions = async () => rows;
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const state = { disk: null, async load() { return structuredClone(this.disk); }, async save(value) { this.disk = structuredClone(value); } };
  const engine = new SyncEngine({ remote: f.remote, local, state, device: 'mobile' });
  assert.equal((await engine.sync()).downloaded, 9);
  assert.equal(f.calls.filter(method => method === 'HEAD').length, 9);
  assert.equal(f.calls.filter(method => method === 'GET').length, 9);
  for (const row of rows) assert.deepEqual(adapter.files.get(row.path), source);
});
