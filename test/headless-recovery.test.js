'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { fakeDav } = require('./helpers/headless-dav');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');

const cli = path.resolve(__dirname, '../headless/cli.js');
function peer(dav) {
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, dav.url, dav.username);
  const engine = new SyncEngine({ local, state, remote: dav.remote(), device: 'Mac' });
  return { adapter, sync: () => engine.sync({ full: true }) };
}
function revisions(dav) {
  return [...dav.entries].filter(([name]) => name.endsWith('.json')).map(([, data]) => JSON.parse(data)).filter(row => row.path);
}
function deadline(promise, message, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function fixture(t) {
  const dav = await fakeDav(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
  const configFile = path.join(root, 'config.json');
  const config = { url: dav.url, username: dav.username, dataDir: root, intervalSeconds: 0.01, settleSeconds: 0.001, allowInsecureLoopback: true };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const children = [];
  t.after(async () => {
    for (const childRun of children) if (childRun.child.exitCode === null && childRun.child.signalCode === null) childRun.child.kill('SIGKILL');
    await Promise.all(children.map(childRun => childRun.done));
    fs.rmSync(root, { recursive: true, force: true });
    for (const childRun of children) assert.equal(childRun.output().includes(dav.password), false, 'Child output must not expose the password');
  });
  function launch(command, { preload, env = {} } = {}) {
    const args = [...(preload ? ['--require', preload] : []), cli, '--config', configFile, ...command];
    const child = spawn(process.execPath, args, { env: { ...process.env, HEADLESS_PASSWORD: dav.password, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const childRun = { child, done, output: () => stdout + stderr };
    children.push(childRun);
    return childRun;
  }
  async function complete(command, options) {
    const process = launch(command, options);
    const result = await deadline(process.done, 'CLI did not finish');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.signal, null);
    assert.equal((result.stdout + result.stderr).includes(dav.password), false);
    return result;
  }
  await complete(['init']);
  return { dav, root, vault: path.join(root, 'vault'), state: path.join(root, 'state'), launch, complete };
}

test('H26: SIGKILL after remote revision commit but before acknowledgement resumes without duplicate revisions', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.vault, 'upload.md'), 'Muse complete content survives process death');
  let committedResolve;
  const committed = new Promise(resolve => { committedResolve = resolve; });
  let stopped = false;
  f.dav.intercept = ({ method, path: name, data, fixture }) => {
    if (method !== 'PUT' || !name.endsWith('.json') || stopped) return false;
    const revision = JSON.parse(data);
    if (revision.path !== 'upload.md') return false;
    fixture.entries.set(name, data);
    stopped = true; committedResolve();
    // The durable remote commit happened, but this TCP response never arrives.
    return true;
  };
  const first = f.launch(['run', '--once']);
  await deadline(Promise.race([committed, first.done.then(result => { throw new Error('Child exited before remote fault point: ' + result.stdout + result.stderr); })]), 'Upload never reached remote commit');
  assert.equal(revisions(f.dav).length, 1);
  assert.ok(fs.readdirSync(f.state).some(name => name.startsWith('pending-')));
  first.child.kill('SIGKILL');
  assert.equal((await deadline(first.done, 'SIGKILL did not exit')).signal, 'SIGKILL');
  f.dav.intercept = null;
  await f.complete(['run', '--once']);
  const writesAfterRecovery = f.dav.calls.filter(call => call.method === 'PUT').length;
  await f.complete(['run', '--once']);
  assert.equal(revisions(f.dav).length, 1);
  assert.equal(f.dav.calls.filter(call => call.method === 'PUT').length, writesAfterRecovery);
  assert.equal(fs.readFileSync(path.join(f.vault, 'upload.md'), 'utf8'), 'Muse complete content survives process death');
  const mac = peer(f.dav); await mac.sync();
  assert.equal(Buffer.from(mac.adapter.files.get('upload.md')).toString(), 'Muse complete content survives process death');
  assert.equal(fs.readdirSync(f.state).some(name => name.startsWith('pending-')), false);
  for (const file of [path.join(f.state, 'status.json'), path.join(f.vault, '.sync-status.json')]) assert.equal(fs.readFileSync(file, 'utf8').includes(f.dav.password), false);
});

test('H26: SIGKILL during last-note download replacement recovers transaction before empty-vault deletion protection', { timeout: 45000 }, async t => {
  const f = await fixture(t), mac = peer(f.dav);
  mac.adapter.put('only.md', 'original contents'); await mac.sync();
  await f.complete(['run', '--once']);
  assert.equal(fs.readFileSync(path.join(f.vault, 'only.md'), 'utf8'), 'original contents');
  mac.adapter.put('only.md', 'new remote contents'); await mac.sync();
  const preload = path.join(f.root, 'fault.cjs');
  fs.writeFileSync(preload, `
'use strict';
const fs = require('node:fs');
const original = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = original.apply(this, arguments);
  if (from === process.env.HEADLESS_TEST_NOTE && String(to).endsWith('/file-transaction/previous')) {
    fs.writeSync(1, 'H26_TRANSACTION_MOVED\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
`);
  const first = f.launch(['run', '--once'], { preload, env: { HEADLESS_TEST_NOTE: fs.realpathSync(path.join(f.vault, 'only.md')) } });
  const moved = new Promise(resolve => { first.child.stdout.on('data', () => { if (first.output().includes('H26_TRANSACTION_MOVED')) resolve(); }); });
  await deadline(Promise.race([moved, first.done.then(result => { throw new Error('Child exited before local fault point: ' + result.stdout + result.stderr); })]), 'Download never reached local transaction rename');
  assert.equal(fs.existsSync(path.join(f.vault, 'only.md')), false);
  assert.equal(fs.readFileSync(path.join(f.state, 'file-transaction/previous'), 'utf8'), 'original contents');
  assert.equal(fs.readFileSync(path.join(f.state, 'file-transaction/next'), 'utf8'), 'new remote contents');
  first.child.kill('SIGKILL');
  assert.equal((await deadline(first.done, 'SIGKILL did not exit')).signal, 'SIGKILL');
  const before = revisions(f.dav).length;
  await f.complete(['run', '--once']);
  assert.equal(fs.readFileSync(path.join(f.vault, 'only.md'), 'utf8'), 'new remote contents');
  assert.equal(fs.existsSync(path.join(f.state, 'file-transaction')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'status.json'), 'utf8')).state, 'ok');
  const writesAfterRecovery = f.dav.calls.filter(call => call.method === 'PUT').length;
  await f.complete(['run', '--once']);
  assert.equal(revisions(f.dav).length, before);
  assert.equal(f.dav.calls.filter(call => call.method === 'PUT').length, writesAfterRecovery);
  assert.deepEqual(fs.readdirSync(f.vault).filter(name => !name.startsWith('.')), ['only.md']);
});

test('H26: SIGKILL after thirty remote deletions but before baseline publication resumes without approving remote deletes', { timeout: 45000 }, async t => {
  const f = await fixture(t), mac = peer(f.dav);
  for (let i = 0; i < 30; i++) mac.adapter.put('delete-' + i + '.md', 'original ' + i);
  mac.adapter.put('keep.md', 'retained'); await mac.sync();
  await f.complete(['run', '--once']);
  for (let i = 0; i < 30; i++) mac.adapter.files.delete('delete-' + i + '.md');
  await mac.sync();
  const preload = path.join(f.root, 'baseline-fault.cjs');
  fs.writeFileSync(preload, `
'use strict';
const fs = require('node:fs');
const original = fs.renameSync;
fs.renameSync = function (from, to) {
  if (String(to).endsWith('/state/baseline.json')) {
    fs.writeSync(1, 'H26_BASELINE_NOT_YET_PUBLISHED\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return original.apply(this, arguments);
};
`);
  const first = f.launch(['run', '--once'], { preload });
  const deleted = new Promise(resolve => { first.child.stdout.on('data', () => { if (first.output().includes('H26_BASELINE_NOT_YET_PUBLISHED')) resolve(); }); });
  await deadline(Promise.race([deleted, first.done.then(result => { throw new Error('Child exited before baseline fault point: ' + result.stdout + result.stderr); })]), 'Sync never reached baseline publication');
  assert.deepEqual(fs.readdirSync(f.vault).filter(name => !name.startsWith('.')), ['keep.md']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'baseline.json'), 'utf8')).files.length, 31);
  first.child.kill('SIGKILL');
  assert.equal((await deadline(first.done, 'SIGKILL did not exit')).signal, 'SIGKILL');
  const before = revisions(f.dav).length;
  await f.complete(['run', '--once']);
  await f.complete(['run', '--once']);
  assert.equal(revisions(f.dav).length, before);
  assert.equal(fs.readFileSync(path.join(f.vault, 'keep.md'), 'utf8'), 'retained');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'status.json'), 'utf8')).state, 'ok');
});

test('H26: SIGKILL midway through a thirty-file remote deletion replays completed receipts and pending deletion', { timeout: 45000 }, async t => {
  const f = await fixture(t), mac = peer(f.dav);
  for (let i = 0; i < 30; i++) mac.adapter.put('delete-' + i + '.md', 'original ' + i);
  mac.adapter.put('keep.md', 'retained'); await mac.sync();
  await f.complete(['run', '--once']);
  for (let i = 0; i < 30; i++) mac.adapter.files.delete('delete-' + i + '.md');
  await mac.sync();
  const preload = path.join(f.root, 'deletion-fault.cjs');
  fs.writeFileSync(preload, `
'use strict';
const fs = require('node:fs');
const original = fs.renameSync;
let moved = 0;
fs.renameSync = function (from, to) {
  const result = original.apply(this, arguments);
  if (String(from).includes('/vault/delete-') && String(to).endsWith('/file-transaction/previous') && ++moved === 21) {
    fs.writeSync(1, 'H26_TWENTY_ONE_DELETIONS\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
`);
  const first = f.launch(['run', '--once'], { preload });
  const deleted = new Promise(resolve => { first.child.stdout.on('data', () => { if (first.output().includes('H26_TWENTY_ONE_DELETIONS')) resolve(); }); });
  await deadline(Promise.race([deleted, first.done.then(result => { throw new Error('Child exited before deletion fault point: ' + result.stdout + result.stderr); })]), 'Sync never reached twenty-first delete');
  assert.equal(fs.readdirSync(f.vault).filter(name => !name.startsWith('.')).length, 10);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'file-transaction/intent.json'), 'utf8')).next, null);
  first.child.kill('SIGKILL');
  assert.equal((await deadline(first.done, 'SIGKILL did not exit')).signal, 'SIGKILL');
  const before = revisions(f.dav).length;
  await f.complete(['run', '--once']);
  await f.complete(['run', '--once']);
  assert.equal(revisions(f.dav).length, before);
  assert.deepEqual(fs.readdirSync(f.vault).filter(name => !name.startsWith('.')), ['keep.md']);
  assert.equal(fs.readFileSync(path.join(f.vault, 'keep.md'), 'utf8'), 'retained');
});

test('H17 H26: old tombstones cannot exempt later external deletion of files present in a successful baseline', { timeout: 45000 }, async t => {
  const f = await fixture(t), mac = peer(f.dav);
  for (let i = 0; i < 24; i++) mac.adapter.put('stale-' + i + '.md', 'original ' + i);
  mac.adapter.put('keep.md', 'retained'); await mac.sync();
  await f.complete(['run', '--once']);
  for (let i = 0; i < 24; i++) mac.adapter.files.delete('stale-' + i + '.md');
  await mac.sync();
  // Model Muse restoring the old copies immediately after remote deletion has
  // finished, before the wrapper scans the successful round's new baseline.
  // These files and already-known tombstones are captured together. A later
  // external deletion must not inherit authorization from those old tombstones.
  const preload = path.join(f.root, 'restore-before-baseline.cjs');
  fs.writeFileSync(preload, `
'use strict';
const fs = require('node:fs'), path = require('node:path');
const original = fs.readFileSync;
let restored = false;
fs.readFileSync = function () {
  const data = original.apply(this, arguments);
  if (!restored) {
    let row;
    try { row = JSON.parse(String(data)); } catch {}
    if (row?.version === 1 && Array.isArray(row.known) && row.absent?.length === 24 && row.files?.length === 1 && row.pending === null) {
      restored = true;
      for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(process.env.HEADLESS_TEST_VAULT, 'stale-' + i + '.md'), 'original ' + i);
    }
  }
  return data;
};
`);
  await f.complete(['run', '--once'], { preload, env: { HEADLESS_TEST_VAULT: f.vault } });
  const saved = JSON.parse(fs.readFileSync(path.join(f.state, 'baseline.json'), 'utf8'));
  assert.equal(saved.files.length, 25);
  assert.equal(saved.checkpoint.absent.length, 24);
  for (let i = 0; i < 21; i++) fs.unlinkSync(path.join(f.vault, 'stale-' + i + '.md'));
  const calls = f.dav.calls.length;
  const paused = await deadline(f.launch(['run', '--once']).done, 'Paused round did not finish');
  assert.equal(paused.code, 2, paused.stdout + paused.stderr);
  assert.equal(f.dav.calls.length, calls);
  const status = JSON.parse(fs.readFileSync(path.join(f.state, 'status.json'), 'utf8'));
  assert.equal(status.state, 'paused');
  assert.equal(status.pendingDeletions.count, 21);
});
