'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DavRemote, NAMESPACE } = require('../src/dav');
const { makeRevision, digest } = require('../src/protocol');

const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const user = '本机', pass = 'testing 非公开';
const root = '/笔记 & PDF/';
const store = root + NAMESPACE + '/';
function response(path, isDir, status = 200) {
  return `<ns:response><ns:href>${xml(path)}</ns:href><ns:propstat><ns:prop><ns:resourcetype>${isDir ? '<ns:collection/>' : ''}</ns:resourcetype></ns:prop><ns:status>HTTP/1.1 ${status} Status</ns:status></ns:propstat></ns:response>`;
}
function listing(entries) {
  return '<?xml version="1.0"?><ns:multistatus xmlns:ns="DAV:">' + entries.join('') + '</ns:multistatus>';
}
async function server(t, options = {}) {
  const entries = new Map();
  const dirs = new Set([root]);
  const calls = [];
  let origin = '';
  const srv = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, origin).pathname);
    const method = req.method;
    const segments = [];
    for await (const chunk of req) segments.push(chunk);
    const data = Buffer.concat(segments);
    calls.push({ method, path, auth: req.headers.authorization, depth: req.headers.depth, condition: req.headers['if-none-match'] });
    const send = (status, body = '') => { res.writeHead(status); res.end(body); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')) return send(401, pass);
    if (options.intercept?.({ method, path, req, res, data, send, entries, dirs, origin })) return;
    if (method === 'PROPFIND') {
      if (!dirs.has(path)) return send(404);
      const children = req.headers.depth === '0' ? [] : Array.from(entries.keys()).filter(k => k.startsWith(path));
      const makeHref = p => encodeURI(p);
      return send(207, listing([response(makeHref(path), true), ...children.map(p => response(origin + makeHref(p), false))]));
    }
    if (method === 'MKCOL') {
      if (dirs.has(path)) return send(405);
      dirs.add(path);
      return send(201);
    }
    if (method === 'GET') return entries.has(path) ? send(200, entries.get(path)) : send(404);
    if (method === 'PUT') {
      if (!dirs.has(path.slice(0, path.lastIndexOf('/') + 1))) return send(409);
      // Like the previously observed NAS response, this test endpoint always
      // returns 201 even if If-None-Match:* should have prevented a write.
      entries.set(path, data);
      return send(201);
    }
    return send(405);
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }));
  origin = 'http://127.0.0.1:' + srv.address().port;
  const url = origin + encodeURI(root);
  const remote = (more = {}) => new DavRemote({ url, username: user, password: pass, allowInsecureLoopback: true, ...more });
  return { entries, calls, dirs, remote, origin, url };
}
const note = (blob, device, parents = []) => makeRevision({ path: '课题/测量&分析.md', blob, device, parents });

test('two independent desktop clients append divergent histories on weak DAV and read verified bytes', async t => {
  const f = await server(t);
  const a = f.remote(), b = f.remote();
  assert.equal(await a.probe(), true);
  assert.deepEqual(await a.listRevisions(), []);
  assert.ok(f.calls.every(c => c.method === 'PROPFIND')); // setup/probe cannot write
  const base = Buffer.from('共同起点');
  const baseId = digest(base);
  await Promise.all([a.putBlob(baseId, base), b.putBlob(baseId, base)]);
  const ancestor = note(baseId, '丙');
  await Promise.all([a.putRevision(ancestor), b.putRevision(ancestor)]);
  const changes = [Buffer.from('机器 A'), Buffer.from('另一台电脑 B')];
  const revisions = changes.map((data, i) => note(digest(data), 'Mac-' + i, [ancestor.id]));
  await Promise.all([a, b].map(async (client, i) => {
    const r = revisions[i];
    await client.putBlob(r.blob, changes[i]);
    await client.putRevision(r);
  }));
  const fresh = f.remote();
  const result = await fresh.listRevisions();
  assert.deepEqual(result.map(r => r.id).sort(), [ancestor.id, ...revisions.map(r => r.id)].sort());
  assert.deepEqual(await fresh.getBlob(revisions[1].blob), changes[1]);
  const before = f.calls.length;
  await fresh.listRevisions();
  assert.deepEqual(f.calls.slice(before).map(c => [c.method, c.depth]), [['PROPFIND', '1']]);
  const written = f.calls.filter(c => c.method === 'PUT');
  assert.ok(written.every(c => c.path.startsWith(store) && c.condition === '*'));
  assert.ok(f.calls.every(c => !['DELETE', 'MOVE'].includes(c.method)));
  const count = written.length;
  await fresh.putBlob(baseId, base);
  await fresh.putRevision(ancestor);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, count);
  f.entries.delete(store + revisions[0].id + '.json');
  await assert.rejects(() => fresh.listRevisions(), /以前确认/);
});

test('server truncation, wrong GET bytes, missing blob, and successful-looking bad PUT stop sync', async t => {
  const data = Buffer.from([0, 127, 128, 255]);
  const sha = digest(data);
  const f = await server(t);
  const client = f.remote();
  f.dirs.add(store);
  const blobKey = store + sha + '.blob';
  f.entries.set(blobKey, Buffer.from('damaged'));
  await assert.rejects(client.putBlob(sha, data), /不符/);
  assert.ok(!f.calls.some(c => c.method === 'PUT')); // never overwrite an existing damaged object
  await assert.rejects(client.getBlob(sha), /不符/);
  const rev = note(sha, 'Mac');
  f.entries.set(store + rev.id + '.json', Buffer.from(JSON.stringify({ ...rev, device: 'changed' })));
  await assert.rejects(client.listRevisions(), /不符/);
  f.entries.set(store + rev.id + '.json', Buffer.from(JSON.stringify(rev)));
  f.entries.delete(blobKey);
  await assert.rejects(client.listRevisions(), /缺失/);
  await assert.rejects(client.putRevision(rev), /HTTP 404/);

  const bad = await server(t, { intercept({ method, path, data, send, entries }) {
    if (method !== 'PUT') return false;
    entries.set(path, data.subarray(0, data.length - 1));
    send(201);
    return true;
  } });
  await assert.rejects(bad.remote().putBlob(sha, data), /不符/);
});

test('412 is idempotent only when the readback verifies; interrupted writes can be retried', async t => {
  for (const correct of [true, false]) {
    const f = await server(t, { intercept({ method, path, data, send, entries }) {
      if (method !== 'PUT') return false;
      entries.set(path, correct ? data : Buffer.from('stale'));
      send(412);
      return true;
    } });
    const client = f.remote();
    const data = Buffer.from('new');
    if (correct) await client.putBlob(digest(data), data);
    else await assert.rejects(client.putBlob(digest(data), data), /不符/);
  }
  const f = await server(t, { intercept({ method, path, data, req, entries }) {
    if (method !== 'PUT') return false;
    entries.set(path, data);
    req.socket.destroy(); // server committed but acknowledgement never reached client
    return true;
  } });
  const client = f.remote(), data = Buffer.from('saved');
  await assert.rejects(client.putBlob(digest(data), data), /传输失败/);
  await client.putBlob(digest(data), data);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});

test('Depth:1 fails closed on truncated XML, wrong namespace, cross-origin paths and partial statuses', async t => {
  let payload;
  const f = await server(t, { intercept({ method, path, req, send }) {
    if (method === 'PROPFIND' && path === store && req.headers.depth === '1') { send(207, payload); return true; }
  } });
  const self = response(encodeURI(store), true);
  const id = 'b'.repeat(64) + '.json';
  const full = listing([self, response(encodeURI(store + id), false)]);
  const cases = [
    listing([]), full.slice(0, -10), listing([self, response(encodeURI(store + id), false, 507)]),
    listing([self, response('https://host.invalid/' + id, false)]),
    listing([self, response('/outside/' + id, false)]), listing([self, response(encodeURI(store) + 'a%2F' + id, false)]),
    full.replace('DAV:', 'WRONG:'), full.replace('HTTP/1.1 200 Status', 'HTTP/1.1 401 Unauthorized'),
    full.replace('<ns:multistatus', '<!DOCTYPE x [<!ENTITY x "x">]><ns:multistatus'), listing([self, self]),
    listing([self, response(encodeURI(store + id), false).replaceAll('ns:response', 'response')]),
    listing([self, '<ns:error/>']), listing([self, response(encodeURI(store + 'unrecognized'), false)]),
  ];
  for (payload of cases) await assert.rejects(f.remote().listRevisions(), /清单|未知条目/);
  assert.ok(f.calls.every(c => c.method === 'PROPFIND'));
});

test('credentials stay on the original HTTPS endpoint, failures disclose no response or password', async t => {
  assert.throws(() => new DavRemote({ url: 'http://127.0.0.1/' }), /HTTPS/);
  assert.throws(() => new DavRemote({ url: 'http://192.168.1.10/', allowInsecureLoopback: true }), /HTTPS/);
  for (const url of ['https://user:password@example.invalid/', 'https://example.invalid/?token=x']) {
    assert.throws(() => new DavRemote({ url }), /不可含/);
  }
  const other = await server(t);
  const f = await server(t, { intercept({ res }) { res.writeHead(307, { Location: other.url }); res.end(); return true; } });
  await assert.rejects(f.remote().probe(), /HTTP 307/);
  assert.equal(other.calls.length, 0);
  const safe = await server(t);
  await assert.rejects(safe.remote({ password: 'wrong' }).probe(), err => err.message.includes('401') && !err.message.includes(pass));
  let intercepted = false;
  const denied = await server(t, { intercept({ method, send }) {
    if (method === 'MKCOL') { intercepted = true; send(403); return true; }
  } });
  const data = Buffer.from('x');
  await assert.rejects(denied.remote().putBlob(digest(data), data), /HTTP 403/);
  assert.ok(intercepted);
  assert.ok(denied.calls.every(c => c.method !== 'PUT'));
});

test('real filesystem vaults keep concurrent Markdown and PDF byte-for-byte through restart, new device, and resolution', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { DiskState, DiskVault } = require('../src/local');
  const { SyncEngine } = require('../src/engine');
  const f = await server(t);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dav-vault-integration-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const connect = async device => {
    const dir = path.join(temp, device);
    await fs.mkdir(dir, { recursive: true });
    const local = new DiskVault(dir);
    return { local, engine: new SyncEngine({ local, remote: f.remote(), device,
      state: new DiskState(local.privateDir, f.url, user) }) };
  };
  const write = async (client, name, data) => {
    const file = path.join(client.local.root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  const files = async client => {
    const pairs = [];
    for (const name of (await client.local.list()).sort()) {
      pairs.push([name, await fs.readFile(path.join(client.local.root, name))]);
    }
    return pairs;
  };
  const noteName = '资料/会议.md', pdfName = '资料/参考文献.pdf';
  const texts = [Buffer.from('共同底稿\n'), Buffer.from('Mac A 修改\r\n'), Buffer.from('Mac B 修改\n')];
  const pdf = mark => Buffer.concat([Buffer.from('%PDF-1.7\r\n'), Buffer.from([0, 255, 128, mark, 0]), Buffer.from('\n%%EOF')]);
  let a = await connect('Mac-A'), b = await connect('Mac-B');
  await write(a, noteName, texts[0]); await write(a, pdfName, pdf(0));
  await a.engine.sync(); await b.engine.sync();
  assert.deepEqual(await files(b), await files(a));
  await write(a, noteName, texts[1]); await write(b, noteName, texts[2]);
  await write(a, pdfName, pdf(1)); await write(b, pdfName, pdf(2));
  await Promise.all([a.engine.sync(), b.engine.sync()]);
  a = await connect('Mac-A'); // both transport caches and the engine are gone; only files/state persist
  b = await connect('Mac-B');
  const c = await connect('Mac-C');
  const stats = await Promise.all([a.engine.sync(), b.engine.sync(), c.engine.sync()]);
  assert.ok(stats.every(s => s.conflicts === 2 && s.deferred === 0));
  const divergent = await files(a);
  assert.deepEqual(await files(b), divergent); assert.deepEqual(await files(c), divergent);
  assert.equal(divergent.length, 4);
  for (const content of [texts[1], texts[2], pdf(1), pdf(2)]) {
    assert.ok(divergent.some(([, bytes]) => bytes.equals(content)));
  }
  const merged = Buffer.from('Mac A 修改\nMac B 修改\n');
  await write(a, noteName, merged);
  assert.equal((await a.engine.resolve(noteName)).conflicts, 1);
  const alternate = divergent.find(([name]) => name.endsWith('.pdf') && name !== pdfName);
  assert.equal((await a.engine.resolve(alternate[0])).conflicts, 0);
  await Promise.all([b.engine.sync(), c.engine.sync()]);
  const converged = [[noteName, merged], [pdfName, alternate[1]]].sort((x, y) => x[0] < y[0] ? -1 : 1);
  for (const client of [a, b, c]) assert.deepEqual(await files(client), converged);
  assert.equal((await f.remote().listRevisions()).length, 8);
});

test('acceptance receipts attest each check without exposing settings and reject stale, mismatched or malformed records', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { checkAcceptance, readAcceptanceReceipt, endpointFingerprint } = require('../scripts/verify-webdav');
  const f = await server(t);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const receiptFile = path.join(tmp, '.local', 'acceptance.json');
  const options = { url: f.url, username: user, password: pass, allowInsecureLoopback: true };
  assert.equal(await readAcceptanceReceipt(f.url, receiptFile), null);
  const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
  const log = () => assert.deepEqual(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s)), before);
  const passed = await checkAcceptance(options, { receiptFile, log });
  assert.equal(passed.status, 'passed');
  assert.deepEqual(await readAcceptanceReceipt(f.url, receiptFile), passed);
  assert.equal(passed.checks.length, 9);
  assert.ok(f.calls.some(c => c.method === 'MKCOL' && c.path.includes(passed.testId)));
  assert.equal(await readAcceptanceReceipt(f.url + 'different/', receiptFile), null);
  const normalized = new URL(f.url);
  normalized.username = 'excluded-user'; normalized.password = 'excluded-password';
  normalized.search = 'api_token=excluded-token'; normalized.hash = 'excluded-fragment';
  assert.equal(endpointFingerprint(normalized.href.replace('/?', '?')), passed.endpointSha256);
  const size = (await fs.stat(receiptFile)).size;
  assert.ok(size > 0 && size < 2048);
  assert.equal((await fs.stat(receiptFile)).mode & 0o777, 0o600);
  for (const secret of [f.origin, new URL(f.url).pathname, root, user, pass, 'http://']) {
    assert.ok(!(await fs.readFile(receiptFile, 'utf8')).includes(secret));
  }
  const failed = await checkAcceptance({ ...options, password: 'bad-test-password' }, { receiptFile, log });
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.failure, { stage: 'parent-readable', category: 'http-auth' });
  assert.deepEqual(await readAcceptanceReceipt(f.url, receiptFile), failed);
  assert.notEqual(failed.testId, passed.testId); assert.deepEqual(failed.checks, ['configuration']);
  const abort = new AbortController(); abort.abort();
  const cancelled = await checkAcceptance(options, { receiptFile, signal: abort.signal });
  assert.deepEqual(cancelled.failure, { stage: 'configuration', category: 'cancelled' });
  assert.deepEqual(await readAcceptanceReceipt(f.url, receiptFile), cancelled);
  await fs.writeFile(receiptFile, JSON.stringify({ ...failed, status: 'passed', failure: null }));
  assert.equal(await readAcceptanceReceipt(f.url, receiptFile), null);
  await fs.writeFile(receiptFile, JSON.stringify({ ...passed, extraPayload: 'unexpected' }));
  assert.equal(await readAcceptanceReceipt(f.url, receiptFile), null);
});

test('B2: complete inventory skips existence GETs but preserves readback and known-object verification', async t => {
  const f = await server(t); f.dirs.add(store); const client = f.remote();
  await client.listRevisions();
  const body = Buffer.from('B2 new object'), id = digest(body); f.calls.length = 0;
  await client.putBlob(id, body);
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET']);
  assert.equal(f.calls[0].condition, '*');
  const revision = note(id, 'B2'); f.calls.length = 0;
  await client.putRevision(revision);
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET']);
  const reader = f.remote(); await reader.listRevisions(); f.calls.length = 0;
  await reader.putBlob(id, body);
  assert.deepEqual(f.calls.map(c => c.method), ['GET']);
  // An already verified successful put can be reused by B4 preupload/commit.
  f.calls.length = 0; await client.putBlob(id, body);
  assert.equal(f.calls.length, 0);
  await assert.rejects(client.putBlob(id, Buffer.from('wrong input')), /不符/);
  assert.equal(f.calls.length, 0, 'cached publication never bypasses input SHA-256');
});

test('B2: stale empty inventories converge when two clients PUT the same object concurrently', async t => {
  for (const conditional of [false, true]) {
    const f = await server(t, { intercept({ method, path, data, entries, send }) {
      if (!conditional || method !== 'PUT') return false;
      if (entries.has(path)) send(412);
      else { entries.set(path, data); send(201); }
      return true;
    } });
    f.dirs.add(store); const a = f.remote(), b = f.remote();
    await Promise.all([a.listRevisions(), b.listRevisions()]);
    const data = Buffer.from('same concurrently addressed bytes'), id = digest(data); f.calls.length = 0;
    await Promise.all([a.putBlob(id, data), b.putBlob(id, data)]);
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 2);
    assert.equal(f.calls.filter(c => c.method === 'GET').length, 2, 'each successful or 412 PUT has its own verified readback');
    assert.deepEqual(await a.getBlob(id), data); assert.deepEqual(await b.getBlob(id), data);
  }
});

test('B2: lost PUT response after inventory is probed on retry and later inventory invalidates removed preuploads', async t => {
  let interrupted = false;
  const f = await server(t, { intercept({ method, path, data, req, entries }) {
    if (method !== 'PUT' || interrupted) return false;
    interrupted = true; entries.set(path, data); req.socket.destroy(); return true;
  } });
  f.dirs.add(store); const client = f.remote(); await client.listRevisions();
  const data = Buffer.from('unreferenced preupload'), id = digest(data);
  await assert.rejects(client.putBlob(id, data), /传输失败/);
  await client.putBlob(id, data);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  f.entries.delete(store + id + '.blob'); await client.listRevisions(); f.calls.length = 0;
  await client.putBlob(id, data);
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET']);
  assert.deepEqual(f.entries.get(store + id + '.blob'), data);
});
