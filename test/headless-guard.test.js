'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { init, createRunner, approve } = require('../headless/runtime');
const { GuardedVault, LateDisappearance } = require('../headless/round-guard');
const { fakeDav } = require('./helpers/headless-dav');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');

const options = { sleep: async () => {}, logger() {} };
async function setup(t, names) {
  const dav = await fakeDav(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const config = { dataDir: root, vaultDir: path.join(root, 'vault'), stateDir: path.join(root, 'state'), url: dav.url,
    username: dav.username, password: dav.password, device: 'NAS', allowInsecureLoopback: true, settleSeconds: 0, deletionLimit: 2 };
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const mac = new SyncEngine({ local, state: new MobileState(adapter, local.privateDir, dav.url, dav.username), remote: dav.remote(), device: 'Mac' });
  let runner;
  t.after(async () => { if (runner) await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await init(config);
  for (const name of names) adapter.put(name, name);
  await mac.sync();
  runner = await createRunner(config, options);
  assert.equal((await runner.round()).state, 'ok');
  return { config, dav, mac, adapter, get runner() { return runner; },
    async restart() { await runner.close(); runner = await createRunner(config, options); },
    file: name => path.join(config.vaultDir, name) };
}

for (const interrupted of [false, true]) test('last witness disappears inside the download hard link; interrupted=' + interrupted, async t => {
  const originals = ['a.md', 'b.md'];
  const f = await setup(t, originals);
  // The pending download deliberately collides with a missing note's move
  // signature. It must not reduce the count or hide the all-empty gate.
  const stamp = 1700000000;
  for (const name of originals) fs.utimesSync(f.file(name), stamp, stamp);
  assert.equal((await f.runner.round()).state, 'ok');
  f.adapter.put('incoming.md', 'same');
  await f.mac.sync();
  const link = fs.linkSync, destination = path.join(fs.realpathSync(f.config.vaultDir), 'incoming.md');
  let hit = false;
  const hook = t.mock.method(fs, 'linkSync', (from, to) => {
    if (to !== destination) return link(from, to);
    hit = true;
    for (const name of originals) fs.unlinkSync(f.file(name));
    link(from, to);
    fs.utimesSync(to, stamp, stamp);
    if (interrupted) throw new Error('interrupted before post-link witness check');
  });
  const first = await f.runner.round();
  hook.mock.restore();
  assert.ok(hit);
  assert.equal(first.state, interrupted ? 'error' : 'paused');
  await f.restart();
  const before = (await f.dav.remote().listRevisions()).length;
  const blocked = await f.runner.round();
  assert.equal(blocked.state, 'paused');
  assert.deepEqual(blocked.pendingDeletions.paths, originals);
  assert.equal(fs.readFileSync(f.file('incoming.md'), 'utf8'), 'same');
  assert.equal((await f.dav.remote().listRevisions()).length, before);
  await approve(f.config, 2, options);
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync();
  for (const name of originals) assert.equal(f.adapter.files.has(name), false);
  assert.equal((await f.dav.remote().listRevisions()).length, before + 2);
});

for (const completed of [false, true]) test('pending remote removal distinguishes the engine CAS from an external unlink; applied=' + completed, async t => {
  const f = await setup(t, ['target.md', 'keep.md']);
  f.config.deletionLimit = 0;
  f.adapter.files.delete('target.md'); await f.mac.sync();
  const local = f.runner.local, cas = local.compareAndSet.bind(local);
  const hook = t.mock.method(local, 'compareAndSet', async (name, expected, next) => {
    if (name !== 'target.md' || next !== null) return cas(name, expected, next);
    if (completed) assert.equal(await cas(name, expected, next), true);
    throw new Error('interrupted with pending apply');
  });
  assert.equal((await f.runner.round()).state, 'error');
  hook.mock.restore();
  if (!completed) fs.unlinkSync(f.file('target.md'));
  await f.restart();
  const state = await f.runner.round();
  if (completed) assert.equal(state.state, 'ok', state.reason);
  else {
    assert.equal(state.state, 'paused');
    assert.deepEqual(state.pendingDeletions.paths, ['target.md']);
    fs.writeFileSync(f.file('target.md'), 'target.md');
    assert.equal((await f.runner.round()).state, 'ok');
  }
  assert.equal(fs.existsSync(f.file('target.md')), false);
  assert.equal((await f.dav.remote().listRevisions()).filter(row => row.blob === null).length, 1);
});

test('a successful CAS updates the same path on every creation and removal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'vault'), privateDir = path.join(root, 'state');
  fs.mkdirSync(dir); fs.mkdirSync(privateDir);
  const vault = new GuardedVault(dir, '.obsidian', () => true, { privateDir });
  const name = 'note.md', value = Buffer.from('first version');
  fs.writeFileSync(path.join(dir, name), value);
  vault.startGate({ snapshot: { files: [{ path: name }] }, allowed: new Set() });
  const hash = await vault.hash(name);
  assert.equal(await vault.compareAndSet(name, hash, null), true);
  assert.equal(await vault.hash(name), null);
  assert.equal(await vault.compareAndSet(name, null, value), true);
  fs.unlinkSync(path.join(dir, name));
  for (const call of ['hash', 'size', 'read']) await assert.rejects(vault[call](name), LateDisappearance);
});

test('a checkpointed pending deletion clears once after two interrupted acknowledgements', async t => {
  const f = await setup(t, ['target.md', 'keep.md']);
  const journal = f.runner.state;
  const hook = t.mock.method(journal, 'clearPending', async () => { throw new Error('stop after recording completion'); });
  fs.unlinkSync(f.file('target.md'));
  assert.equal((await f.runner.round()).state, 'error');
  const pending = await journal.loadPending();
  assert.equal(pending.rev.blob, null);
  // Discovery of another revision forces the engine to checkpoint the earlier
  // completion receipt in _open, before it tries to clear the stale intent.
  f.adapter.put('keep.md', 'remote edit');
  await f.mac.sync();
  assert.equal((await f.runner.round()).state, 'error');
  const checkpoint = f.runner.gates.readBaseline().checkpoint;
  const current = await f.runner.gates.recovery.read(checkpoint.receiptSequence);
  assert.equal(current.compactedPending, true);
  assert.equal(current.pending.operationId, pending.operationId);
  hook.mock.restore();
  fs.writeFileSync(f.file('target.md'), 'restored');
  await f.restart();
  const deletesBefore = (await f.dav.remote().listRevisions()).filter(row => row.blob === null);
  assert.equal((await f.runner.round()).state, 'ok');
  assert.equal(await f.runner.state.loadPending(), null);
  const final = await f.dav.remote().listRevisions();
  assert.deepEqual(final.filter(row => row.blob === null), deletesBefore);
  await f.mac.sync();
  assert.equal(Buffer.from(f.adapter.files.get('target.md')).toString(), 'restored');
});
