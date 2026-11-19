'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { init, createRunner } = require('../headless/runtime');
const { main } = require('../headless/cli');
const { loadConfig } = require('../headless/config');
const { fakeDav } = require('./helpers/headless-dav');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');

async function setup(t, { deletionLimit = 20, username = 'notes', engineFactory } = {}) {
  const dav = await fakeDav(t);
  dav.username = username;
  dav.password = 'Secret 特征?%42';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-names-'));
  const file = path.join(root, 'config.json');
  const settings = { url: dav.url, username, password: dav.password, dataDir: root, allowInsecureLoopback: true, deletionLimit };
  fs.writeFileSync(file, JSON.stringify(settings));
  const config = loadConfig(file, { env: {} }), logs = [];
  await init(config);
  const runner = await createRunner(config, { sleep: async () => {}, logger: line => logs.push(line), engineFactory });
  t.after(async () => { await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const mac = new SyncEngine({ local, state: new MobileState(adapter, local.privateDir, dav.url, username), remote: dav.remote(), device: 'Mac' });
  const absolute = name => path.join(config.vaultDir, name);
  function put(name, body = 'note contents') {
    fs.mkdirSync(path.dirname(absolute(name)), { recursive: true });
    fs.writeFileSync(absolute(name), body);
  }
  async function outputs() {
    const stdout = [], stderr = [];
    assert.equal(await main(['status', '--config', file], { env: {}, stdout: s => stdout.push(s), stderr: s => stderr.push(s) }), 0);
    assert.deepEqual(stderr, []);
    return {
      status: fs.readFileSync(path.join(config.stateDir, 'status.json'), 'utf8'),
      mirror: fs.readFileSync(absolute('.sync-status.json'), 'utf8'),
      cli: stdout.join('\n'), logs: logs.join('\n'),
    };
  }
  return { dav, config, file, settings, logs, runner, absolute, put, mac, adapter, outputs };
}

// The intermediate spelling also works on normalization-insensitive APFS.
function rename(f, before, after) {
  const temporary = f.absolute('.rename-intermediate');
  fs.renameSync(f.absolute(before), temporary);
  fs.renameSync(temporary, f.absolute(after));
}
for (const { kind, leaf, directory } of [
  { kind: 'file', leaf: 'cafe\u0301.md' },
  { kind: 'folder', leaf: 'か\u3099', directory: true },
  { kind: 'name containing the conflict marker', leaf: 'cafe\u0301 (sync-conflict).md' },
]) test('J16: decomposed ' + kind + ' pauses before sync and resumes after an external NFC rename', async t => {
  const f = await setup(t), normal = leaf.normalize('NFC');
  const suffix = directory ? '/note.md' : '';
  f.put(leaf + suffix);
  const paused = await f.runner.round();
  assert.equal(paused.state, 'paused');
  assert.ok(paused.reason.includes(leaf));
  assert.match(paused.reason, /名字不是规范合成形式，请用规范形式重新命名/);
  assert.equal(f.runner.engine, null);
  assert.deepEqual(f.dav.calls, []);
  assert.ok(fs.readdirSync(f.config.vaultDir).includes(leaf));
  assert.equal(fs.readFileSync(f.absolute(leaf + suffix), 'utf8'), 'note contents');
  rename(f, leaf, normal);
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync();
  assert.equal(Buffer.from(f.adapter.files.get(normal + suffix)).toString(), 'note contents');
});

test('J16: a bound conflict copy also pauses on a decomposed name and syncs its edit after NFC rename', async t => {
  const f = await setup(t);
  const name = 'café.md';
  f.put(name, 'base');
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync();
  f.adapter.put(name, 'Mac edit'); await f.mac.sync();
  f.put(name, 'NAS edit'); assert.equal((await f.runner.round()).state, 'ok');
  const copy = fs.readdirSync(f.config.vaultDir).find(p => p.includes(' (sync-conflict '));
  assert.ok(copy);
  const decomposed = copy.normalize('NFD');
  rename(f, copy, decomposed);
  f.put(decomposed, 'edited copy');
  const before = f.dav.calls.length;
  const paused = await f.runner.round();
  assert.equal(paused.state, 'paused'); assert.ok(paused.reason.includes(decomposed));
  assert.equal(f.dav.calls.length, before);
  rename(f, decomposed, copy);
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync();
  assert.ok([...f.adapter.files].some(([p, data]) => !p.startsWith('.') && Buffer.from(data).toString() === 'edited copy'));
});

test('J17: NFC Chinese, Japanese kana and accented Latin names sync with their original spelling', async t => {
  const f = await setup(t), names = ['中文/笔记.md', 'が/ガ.md', 'café/résumé.md'];
  for (const name of names) f.put(name, name);
  assert.equal((await f.runner.round()).state, 'ok');
  await f.mac.sync();
  for (const name of names) assert.equal(Buffer.from(f.adapter.files.get(name)).toString(), name);
});

test('J18: conflict and pending deletion paths retain the account name in files, CLI and logs', async t => {
  const name = 'notes/plan.md';
  for (const kind of ['conflict', 'deletion']) {
    const f = await setup(t, { deletionLimit: 0 });
    f.put(name, 'original'); f.put('keep.md');
    assert.equal((await f.runner.round()).state, 'ok');
    await f.mac.sync(); f.logs.length = 0;
    if (kind === 'conflict') {
      f.adapter.put(name, 'Mac edit'); await f.mac.sync();
      f.put(name, 'NAS edit');
      const status = await f.runner.round();
      assert.equal(status.state, 'ok'); assert.ok(status.conflicts.includes(name));
    } else {
      fs.unlinkSync(f.absolute(name));
      const status = await f.runner.round();
      assert.equal(status.state, 'paused'); assert.deepEqual(status.pendingDeletions.paths, [name]);
    }
    for (const [surface, output] of Object.entries(await f.outputs())) assert.ok(output.includes(name), kind + ' ' + surface);
  }
});

test('J18: a name-check reason shows the complete notes/plan.md path on every surface', async t => {
  const f = await setup(t), name = 'notes/plan.md', alternate = 'notes/PLAN.md';
  f.put(name);
  if (fs.existsSync(f.absolute(alternate))) {
    // A case-insensitive volume cannot create both spellings. Supply the
    // second directory entry to the real gate, as seen on a Linux NAS.
    const scan = f.runner.gates.scan;
    f.runner.gates.scan = root => {
      const snapshot = scan(root);
      snapshot.files.push({ ...snapshot.files.find(row => row.path === name), path: alternate });
      return snapshot;
    };
  } else f.put(alternate);
  const status = await f.runner.round();
  assert.equal(status.state, 'paused');
  assert.ok(status.reason.includes(name + '（')); assert.match(status.reason, /仅大小写或 Unicode/);
  assert.deepEqual(f.dav.calls, []);
  for (const [surface, output] of Object.entries(await f.outputs())) assert.ok(output.includes(name), surface);
});

test('J19: server errors and credential-bearing exceptions keep authentication out of all outputs', async t => {
  const f = await setup(t);
  const { url, username, password, stateDir } = f.config;
  const forms = [password, encodeURIComponent(password), Buffer.from(username + ':' + password).toString('base64'),
    new URLSearchParams([['', password]]).toString().slice(1)];
  const message = [url, stateDir, ...forms, 'Basic ' + forms[2]].join(' ');
  f.dav.intercept = ({ send }) => { send(503, message); return true; };
  assert.equal((await f.runner.round()).state, 'error');
  for (const text of Object.values(await f.outputs())) {
    assert.match(text, /503/);
    for (const value of [url, stateDir, ...forms]) assert.ok(!text.includes(value));
  }
  // DAV discards HTTP error bodies. Also exercise the runtime's own error
  // boundary with raw exceptions from an adapter (transport or local I/O).
  for (const form of forms) {
    f.runner.engine.sync = async () => { throw new Error([url, stateDir, form].join(' ')); };
    assert.equal((await f.runner.round()).state, 'error');
    for (const text of Object.values(await f.outputs())) {
      assert.match(text, /认证凭据/);
      for (const value of [url, stateDir, ...forms]) assert.ok(!text.includes(value));
    }
  }
  // Exercise CLI stderr separately: init fails with EEXIST on a data path
  // containing the encoded password, after the CLI has loaded its config.
  const badDir = path.join(path.dirname(f.file), forms[1]);
  fs.writeFileSync(badDir, '');
  fs.writeFileSync(f.file, JSON.stringify({ ...f.settings, dataDir: badDir }));
  const errors = [];
  assert.equal(await main(['init', '--config', f.file], { env: {}, stderr: s => errors.push(s) }), 1);
  assert.match(errors.join('\n'), /认证凭据/);
  for (const value of [url, stateDir, ...forms]) assert.ok(!errors.join('\n').includes(value));
});

test('J19: exceptions mask the endpoint and state directory without altering words containing username u', async t => {
  const f = await setup(t, { username: 'u' });
  assert.equal((await f.runner.round()).state, 'ok');
  f.runner.engine.sync = async () => { throw new Error(`simulated crash ${f.config.url} ${f.config.stateDir}/child.json`); };
  assert.equal((await f.runner.round()).state, 'error');
  for (const text of Object.values(await f.outputs())) {
    assert.ok(text.includes('simulated crash')); assert.ok(text.includes('/child.json'));
    assert.ok(!text.includes(f.config.url)); assert.ok(!text.includes(f.config.stateDir));
  }
});

test('J19: a name-check reason redacts credentials inside note paths on every surface', async t => {
  const f = await setup(t), { password, username } = f.config;
  const forms = [password, encodeURIComponent(password), Buffer.from(username + ':' + password).toString('base64')];
  for (const [index, form] of forms.entries()) f.put('notes/' + index + '-' + form + '?.md');
  const paused = await f.runner.round();
  assert.equal(paused.state, 'paused');
  for (const text of Object.values(await f.outputs())) {
    for (const [index, form] of forms.entries()) {
      assert.ok(text.includes('notes/' + index + '-[已隐藏]?.md'));
      assert.ok(!text.includes(form));
    }
  }
});
