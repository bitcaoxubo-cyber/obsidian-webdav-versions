'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState, mobileRequest } = require('../src/mobile');
const { DavRemote } = require('../src/dav');
const { digest, arrayBuffer } = require('../src/bytes');
const stats = () => ({ vaultReads: 0, hashBytes: 0, httpRequests: 0 });

test('A0: mobile metrics count real vault reads and content/state hashing', async () => {
  const adapter = new Adapter(), local = new MobileVault(adapter), meter = stats();
  local.stats = meter;
  adapter.put('note.md', 'hello');
  assert.equal(await local.hash('note.md'), digest('hello'));
  assert.equal(meter.vaultReads, 1);
  assert.equal(meter.hashBytes, 5);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test/vault/', 'u');
  state.stats = meter;
  await state.save({ known: [] });
  assert.equal(meter.vaultReads, 1, 'private snapshot reads are not vault reads');
  assert.ok(meter.hashBytes > 5);
});

test('A0: mobile transport metrics include HEAD and GET without double counting', async () => {
  const meter = stats(), calls = [];
  const request = mobileRequest(async ({ method }) => {
    calls.push(method);
    return { status: 200, headers: { 'Content-Length': '5' }, arrayBuffer: arrayBuffer(method === 'HEAD' ? '' : 'hello') };
  });
  request.stats = meter;
  const remote = new DavRemote({ url: 'https://example.test/vault/', request });
  remote.stats = meter;
  await remote.getBlob(digest('hello'));
  assert.deepEqual(calls, ['HEAD', 'GET']);
  assert.equal(meter.httpRequests, 2);
  assert.equal(meter.hashBytes, 5);
});

test('A0: desktop transport counts one HTTP request per call', async () => {
  const meter = stats();
  const remote = new DavRemote({ url: 'https://example.test/vault/', request: async () => ({ status: 200, body: new Uint8Array(0) }) });
  remote.stats = meter;
  await remote.call('GET', new URL('https://example.test/vault/x'), {}, undefined, 100);
  assert.equal(meter.httpRequests, 1);
});

test('A0: desktop native hash reads count only vault content', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DiskVault } = require('../src/local');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-stats-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), 'hello');
    const local = new DiskVault(root), meter = stats(); local.stats = meter;
    assert.equal(await local.hash('note.md'), digest('hello'));
    assert.equal(meter.vaultReads, 1); assert.equal(meter.hashBytes, 5);
    assert.equal(await local.hash('note.md'), digest('hello'));
    assert.equal(meter.vaultReads, 1);
    assert.equal((await local.read('note.md')).toString(), 'hello');
    assert.equal(meter.vaultReads, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
