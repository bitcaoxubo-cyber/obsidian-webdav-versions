'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fakeDav } = require('./helpers/headless-dav');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');
const { makeRevision, digest, isConflictPath } = require('../src/protocol');
const { init, createRunner } = require('../headless/runtime');

function peer(dav, device) {
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, dav.url, dav.username);
  const engine = new SyncEngine({ local, state, remote: dav.remote(), device });
  return { adapter, engine, sync: () => engine.sync({ full: true }),
    put(p, content) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) adapter.folders.add(parts.slice(0, i).join('/')); adapter.put(p, content); },
    remove(p) { adapter.files.delete(p); },
    text(p) { return Buffer.from(adapter.files.get(p)).toString(); },
    names() { return [...adapter.files.keys()].filter(p => !p.startsWith('.')).sort(); } };
}
async function setup(t, seed = ['a.md', 'b.md', 'c.md'], davOptions = {}) {
  const dav = await fakeDav(t, davOptions), root = fs.mkdtempSync(path.join(os.tmpdir(), 'hi-'));
  let runner;
  t.after(async () => { if (runner) await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { dataDir: root, vaultDir: path.join(root, 'vault'), stateDir: path.join(root, 'state'), url: dav.url, username: dav.username, password: dav.password, device: 'NAS', intervalSeconds: .01, settleSeconds: .001, deletionLimit: 20, allowInsecureLoopback: true };
  await init(config);
  const mac = peer(dav, 'Mac'), phone = peer(dav, 'iPhone');
  for (const p of seed) mac.put(p, 'original ' + p);
  await mac.sync(); await phone.sync();
  const logs = [], pending = { mutation: null };
  runner = await createRunner(config, { sleep: async () => { const f = pending.mutation; pending.mutation = null; f?.(); }, logger: line => logs.push(line) });
  assert.equal((await runner.round()).state, 'ok');
  const put = (p, text) => { fs.mkdirSync(path.dirname(path.join(config.vaultDir, p)), { recursive: true }); fs.writeFileSync(path.join(config.vaultDir, p), text); };
  const remove = p => fs.unlinkSync(path.join(config.vaultDir, p));
  const text = p => fs.readFileSync(path.join(config.vaultDir, p), 'utf8');
  return { dav, root, config, mac, phone, runner, put, remove, text, logs, pending };
}
const numbered = n => Array.from({ length: n }, (_, i) => `notes/${i}.md`);
function revisions(dav) { return [...dav.entries.entries()].filter(([p]) => p.endsWith('.json')).map(([, v]) => JSON.parse(v)); }
function checkSecret(f) {
  for (const file of ['state/status.json', 'vault/.sync-status.json']) assert.ok(!fs.readFileSync(path.join(f.root, file), 'utf8').includes(f.dav.password));
  assert.ok(!f.logs.join('\n').includes(f.dav.password));
}

test('H5/H6/H10/H29: Muse and two mobile adapters exchange ordinary Markdown in both directions', async t => {
  const f = await setup(t);
  f.put('new/note.md', 'Muse new'); f.put('a.md', 'Muse edit'); f.remove('b.md');
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync(); await f.phone.sync();
  for (const device of [f.mac, f.phone]) { assert.equal(device.text('new/note.md'), 'Muse new'); assert.equal(device.text('a.md'), 'Muse edit'); assert.ok(!device.names().includes('b.md')); }
  f.mac.put('from-mac.md', 'Mac new'); f.mac.put('c.md', 'Mac edit'); f.mac.remove('new/note.md'); await f.mac.sync();
  assert.equal((await f.runner.round()).state, 'ok');
  assert.equal(f.text('from-mac.md'), 'Mac new'); assert.equal(f.text('c.md'), 'Mac edit'); assert.ok(!fs.existsSync(path.join(f.config.vaultDir, 'new/note.md')));
  assert.deepEqual(fs.readdirSync(f.config.vaultDir).filter(n => n.startsWith('.')), ['.sync-status.json']);
  assert.ok(!revisions(f.dav).some(r => r.path?.startsWith('.')));
  const mirror = fs.readFileSync(path.join(f.config.vaultDir, '.sync-status.json'), 'utf8');
  for (const value of [f.config.url, f.config.username, f.config.stateDir]) assert.ok(!mirror.includes(value));
  checkSecret(f);
});

test('H5/H6: existing sharded v2 layout syncs through AdaptiveDavRemote without migration', async t => {
  const f = await setup(t, ['a.md', 'b.md'], { layout: 'v2' });
  f.put('Muse.md', 'v2 outside edit'); f.remove('b.md');
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync(); await f.phone.sync();
  assert.equal(f.phone.text('Muse.md'), 'v2 outside edit');
  assert.ok(!f.mac.names().includes('b.md'));
  f.mac.put('a.md', 'v2 remote edit'); await f.mac.sync();
  assert.equal((await f.runner.round()).state, 'ok'); assert.equal(f.text('a.md'), 'v2 remote edit');
  assert.ok([...f.dav.entries.keys()].every(p => p.includes('/obsidian-webdav-versions-v2/')));
  assert.ok(!f.dav.calls.some(call => ['DELETE', 'MOVE'].includes(call.method)));
});

test('H7/H8: conflicting edits retain both versions and delete/edit retains file', async t => {
  const f = await setup(t);
  f.mac.put('a.md', 'Mac concurrent'); await f.mac.sync(); f.put('a.md', 'Muse concurrent');
  let status = await f.runner.round(); assert.equal(status.state, 'ok'); assert.ok(status.conflicts.includes('a.md'));
  await f.mac.sync();
  const contents = f.mac.names().filter(n => n.startsWith('a')).map(n => f.mac.text(n));
  assert.ok(contents.includes('Mac concurrent')); assert.ok(contents.includes('Muse concurrent'));
  assert.ok(f.mac.names().some(n => n.includes(' (sync-conflict ')));
  f.phone.remove('b.md'); await f.phone.sync(); f.put('b.md', 'Muse survives deletion');
  status = await f.runner.round(); assert.equal(status.state, 'ok'); assert.equal(f.text('b.md'), 'Muse survives deletion');
  checkSecret(f);
});

// Freeze only the next revision nonce; receipt operation identifiers retain
// their real randomness. Fixed baseline + explicit nonces cover both canonical
// path orderings without retry-until-lucky tests or changing engine behavior.
async function withNextNonce(t, nonce, run) {
  const crypto = globalThis.crypto, original = crypto.getRandomValues.bind(crypto);
  const bytes = Buffer.from(nonce.replaceAll('-', ''), 'hex'); let consumed = false;
  const mock = t.mock.method(crypto, 'getRandomValues', array => {
    if (consumed) return original(array);
    assert.equal(array.byteLength, 16); array.set(bytes); consumed = true; return array;
  });
  try { const result = await run(); assert.ok(consumed, 'the deterministic revision nonce was used'); return result; }
  finally { mock.mock.restore(); }
}
function noteVersions(f, basename) {
  return fs.readdirSync(f.config.vaultDir)
    .filter(name => name === basename + '.md' || (name.startsWith(basename + ' (sync-conflict ') && isConflictPath(name) && / [0-9a-f]{64}\)\.md$/.test(name)))
    .map(name => ({ name, text: f.text(name) }));
}
for (const [canonical, macNonce] of [
  ['Mac', '00000000-0000-4000-8000-000000000001'],
  ['Muse', '00000000-0000-4000-8000-000000000011'],
]) test(`H9 revised: Muse content survives in original or standard conflict copy when ${canonical} sorts first`, async t => {
  const f = await setup(t, []), remote = f.dav.remote();
  const base = makeRevision({ path: 'c.md', blob: digest('original c.md'), device: 'Mac', nonce: 'H9-fixed-base' });
  await remote.putBlob(base.blob, Buffer.from('original c.md')); await remote.putRevision(base);
  assert.equal((await f.runner.round()).state, 'ok'); await f.mac.sync();
  const museNonce = '00000000-0000-4000-8000-000000000001';
  const macRevision = makeRevision({ path: 'c.md', parents: [base.id], blob: digest('Incoming c'), device: 'Mac', nonce: macNonce });
  const museRevision = makeRevision({ path: 'c.md', parents: [base.id], blob: digest('Muse just typed c'), device: 'NAS', nonce: museNonce });
  assert.equal(macRevision.id < museRevision.id, canonical === 'Mac');
  f.mac.put('c.md', 'Incoming c'); await withNextNonce(t, macNonce, () => f.mac.sync());
  f.put('c.md', 'Muse just typed c');
  const status = await withNextNonce(t, museNonce, () => f.runner.round());
  assert.equal(status.state, 'ok'); assert.ok(status.conflicts.includes('c.md'));
  const local = noteVersions(f, 'c');
  assert.equal(local.length, 2); assert.deepEqual(local.map(row => row.text).sort(), ['Incoming c', 'Muse just typed c'].sort());
  assert.equal(f.text('c.md'), canonical === 'Mac' ? 'Incoming c' : 'Muse just typed c');
  const remoteRows = revisions(f.dav).filter(row => row.path === 'c.md');
  for (const expected of [macRevision, museRevision]) assert.ok(remoteRows.some(row => row.id === expected.id && row.blob === expected.blob));
  await f.phone.sync();
  const phoneContents = f.phone.names().filter(name => name === 'c.md' || isConflictPath(name)).map(name => f.phone.text(name));
  assert.deepEqual(phoneContents.sort(), ['Incoming c', 'Muse just typed c'].sort());
  checkSecret(f);
});

test('CAS race, separate from H9: an edit after capture and before download completion stays at its original path', async t => {
  const f = await setup(t, ['c.md']);
  const incoming = 'Mac remote version waiting for download', edited = 'Muse complete edit made after the engine scan';
  f.mac.put('c.md', incoming); await f.mac.sync();
  const wanted = digest(incoming), original = digest('original c.md');
  const local = f.runner.engine.local, originalCAS = local.compareAndSet.bind(local);
  const attempts = [];
  t.mock.method(local, 'compareAndSet', async (name, expected, next) => {
    const applied = await originalCAS(name, expected, next);
    attempts.push({ name, expected, next: next === null ? null : digest(next), applied });
    return applied;
  });
  let editedDuringDownload = false;
  f.dav.intercept = ({ method, path: requested }) => {
    if (method === 'GET' && requested.endsWith('/' + wanted + '.blob') && !editedDuringDownload) {
      assert.equal(f.text('c.md'), 'original c.md');
      // This GET belongs to _apply, after its local capture/observation. The
      // fake server has not completed the response when Muse changes the file.
      f.put('c.md', edited); editedDuringDownload = true;
    }
    return false;
  };
  const status = await f.runner.round(); f.dav.intercept = undefined;
  assert.equal(status.state, 'ok'); assert.ok(editedDuringDownload);
  assert.deepEqual(attempts, [{ name: 'c.md', expected: original, next: wanted, applied: false }]);
  assert.equal(f.text('c.md'), edited); assert.equal(status.lastResult.downloaded, 0);
  assert.ok(!revisions(f.dav).some(row => row.path === 'c.md' && row.blob === digest(edited)), 'the after-capture edit was not already published');
  const next = await f.runner.round(); assert.equal(next.state, 'ok'); assert.ok(next.conflicts.includes('c.md'));
  assert.deepEqual(noteVersions(f, 'c').map(row => row.text).sort(), [incoming, edited].sort());
  checkSecret(f);
});

for (const change of ['size', 'add', 'remove']) test(`H11: ${change} between scans makes zero DAV requests; stable next round publishes once`, async t => {
  const f = await setup(t), before = f.dav.calls.length;
  f.pending.mutation = () => change === 'size' ? f.put('a.md', 'complete long document') : change === 'add' ? f.put('new.md', 'complete new document') : f.remove('b.md');
  assert.equal((await f.runner.round()).state, 'paused'); assert.equal(f.dav.calls.length, before);
  const old = revisions(f.dav).length;
  assert.equal((await f.runner.round()).state, 'ok'); assert.equal(revisions(f.dav).length - old, 1);
  await f.mac.sync();
  if (change === 'size') assert.equal(f.mac.text('a.md'), 'complete long document');
  if (change === 'add') assert.equal(f.mac.text('new.md'), 'complete new document');
  if (change === 'remove') assert.ok(!f.mac.names().includes('b.md'));
});

test('H12/H16: deleting 21 pauses without network access; restoring automatically resumes', async t => {
  const f = await setup(t, numbered(24));
  for (const p of numbered(21)) f.remove(p);
  const before = f.dav.calls.length, status = await f.runner.round();
  assert.equal(status.state, 'paused'); assert.equal(status.pendingDeletions.count, 21); assert.equal(status.pendingDeletions.paths.length, 20); assert.equal(f.dav.calls.length, before);
  await f.phone.sync(); assert.equal(f.phone.names().length, 24);
  for (const p of numbered(21)) f.put(p, 'original ' + p);
  assert.equal((await f.runner.round()).state, 'ok');
});

test('H13: exactly 20 missing files sync normally', async t => {
  const f = await setup(t, numbered(21)); for (const p of numbered(20)) f.remove(p);
  assert.equal((await f.runner.round()).state, 'ok'); await f.phone.sync(); assert.deepEqual(f.phone.names(), ['notes/20.md']);
});

test('H14/H15: completely empty or moved-away vault pauses without invoking engine', async t => {
  const f = await setup(t);
  for (const p of ['a.md', 'b.md', 'c.md']) f.remove(p);
  let before = f.dav.calls.length;
  assert.equal((await f.runner.round()).state, 'paused'); assert.equal(f.dav.calls.length, before);
  const moved = path.join(f.root, 'moved'); fs.renameSync(f.config.vaultDir, moved);
  before = f.dav.calls.length; assert.equal((await f.runner.round()).state, 'paused'); assert.equal(f.dav.calls.length, before);
  assert.ok(!fs.existsSync(f.config.vaultDir));
  fs.renameSync(moved, f.config.vaultDir);
});

test('H17: approval count must match and changed deletion group invalidates approval', async t => {
  const f = await setup(t, numbered(24)); for (const p of numbered(21)) f.remove(p);
  assert.equal((await f.runner.round()).state, 'paused');
  await assert.rejects(f.runner.gates.approve(20), /数量/); await f.runner.gates.approve(21);
  f.remove('notes/21.md'); assert.equal((await f.runner.round()).state, 'paused');
  await f.runner.gates.approve(22); assert.equal((await f.runner.round()).state, 'ok');
  await f.phone.sync(); assert.equal(f.phone.names().length, 2);
});

test('H17/H28/H29: approval is consumed before a failed sync, cannot be reused on retry', async t => {
  const f = await setup(t, numbered(22)); for (const p of numbered(21)) f.remove(p);
  await f.runner.gates.approve(21); f.dav.failStatus = 503;
  assert.equal((await f.runner.round()).state, 'error'); f.dav.failStatus = 0;
  assert.equal((await f.runner.round()).state, 'paused'); checkSecret(f);
});

test('H18: renaming 30-note directory with preserved metadata does not trip deletion gate', async t => {
  const f = await setup(t, numbered(30));
  fs.renameSync(path.join(f.config.vaultDir, 'notes'), path.join(f.config.vaultDir, 'renamed'));
  assert.equal((await f.runner.round()).state, 'ok'); await f.phone.sync();
  assert.equal(f.phone.names().length, 30); assert.ok(f.phone.names().every(n => n.startsWith('renamed/')));
});

test('H19: 30 remote deletions are included in the post-sync baseline', async t => {
  const f = await setup(t, numbered(31)); for (const p of numbered(30)) f.mac.remove(p);
  await f.mac.sync(); assert.equal((await f.runner.round()).state, 'ok');
  assert.deepEqual(fs.readdirSync(path.join(f.config.vaultDir, 'notes')), ['30.md']);
  assert.equal((await f.runner.round()).state, 'ok');
});

test('H20: every bad filename pauses with Chinese path diagnostic, leaves bytes intact and resumes after rename', async t => {
  const f = await setup(t);
  for (const name of ['Q: idea.md', 'draft.', 'draft ', 'a\\b.md', ...['*', '"', '<', '>', ':', '|', '?'].map(c => `bad${c}name.md`)]) {
    f.put(name, 'untouched bytes'); const before = f.dav.calls.length;
    const status = await f.runner.round(); assert.equal(status.state, 'paused'); assert.ok(status.reason.includes(name)); assert.match(status.reason, /名字|路径/);
    assert.equal(f.dav.calls.length, before); assert.equal(f.text(name), 'untouched bytes');
    fs.renameSync(path.join(f.config.vaultDir, name), path.join(f.config.vaultDir, 'fixed.md'));
    assert.equal((await f.runner.round()).state, 'ok');
  }
});

test('H20: actual case-colliding files pause before any DAV request', async t => {
  const f = await setup(t); f.put('A.md', 'capital');
  if (f.text('a.md') === 'capital') { t.skip('filesystem cannot hold A.md and a.md simultaneously; unit collision tests still run'); return; }
  const before = f.dav.calls.length, status = await f.runner.round();
  assert.equal(status.state, 'paused'); assert.match(status.reason, /大小写/); assert.equal(f.dav.calls.length, before);
  fs.renameSync(path.join(f.config.vaultDir, 'A.md'), path.join(f.config.vaultDir, 'uppercase.md'));
  assert.equal((await f.runner.round()).state, 'ok');
});

test('H21: hidden entries, generated conflict copy and empty folder do not block ordinary note sync', async t => {
  const f = await setup(t);
  f.put('.hidden.md', 'ignored'); f.put('.hidden-folder/note.md', 'ignored'); f.put('a (sync-conflict sample).md', 'preserved conflict');
  fs.mkdirSync(path.join(f.config.vaultDir, 'empty')); f.put('good.md', 'normal');
  assert.equal((await f.runner.round()).state, 'ok'); await f.phone.sync(); assert.equal(f.phone.text('good.md'), 'normal');
  assert.ok(fs.statSync(path.join(f.config.vaultDir, 'empty')).isDirectory()); assert.equal(f.text('a (sync-conflict sample).md'), 'preserved conflict');
  assert.ok(!revisions(f.dav).some(r => r.path?.includes('sync-conflict') || r.path?.startsWith('.')));
});
