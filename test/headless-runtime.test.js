'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../headless/config');
const { init, createRunner, run, readStatus, checkHealth } = require('../headless/runtime');
const { acquireLock } = require('../headless/lock');
const { probeMount, publicText } = require('../headless/io');
const { main, parseArgs } = require('../headless/cli');
const { fakeDav } = require('./helpers/headless-dav');
const NODE = process.execPath;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'hr-'));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'config.json');
  const raw = { url: 'http://127.0.0.1:1/', username: 'local-user', password: 'runtime-secret-特征', dataDir: root, allowInsecureLoopback: true, intervalSeconds: 0.01, settleSeconds: 0.001 };
  fs.writeFileSync(file, JSON.stringify(raw));
  return { root, file, raw, cleanup, config: loadConfig(file, { env: {} }), write(value) { fs.writeFileSync(file, JSON.stringify(value)); } };
}
const result = () => ({ uploaded: 0, downloaded: 0, deleted: 0, conflictPaths: [], confirmations: { staleCopies: [], deletionConflicts: [] } });
const instant = async () => {};

test('H22 H23: init rejects notes and repeat init; run requires initialized instance', async t => {
  const f = fixture(t);
  await assert.rejects(createRunner(f.config), /init/);
  fs.mkdirSync(f.config.vaultDir); fs.writeFileSync(path.join(f.config.vaultDir, 'note.md'), 'keep');
  await assert.rejects(init(f.config), /已有笔记/);
  assert.equal(fs.readFileSync(path.join(f.config.vaultDir, 'note.md'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(f.config.vaultDir, 'note.md'));
  await init(f.config);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.config.stateDir, 'instance.json'))).id);
  await assert.rejects(init(f.config), /已有实例或同步记录/);
});

test('H24: startup executes both hardlink and rename and cleans probes after either failure', async t => {
  const f = fixture(t); fs.mkdirSync(f.config.vaultDir); fs.mkdirSync(f.config.stateDir);
  for (const method of ['linkSync', 'renameSync']) {
    const io = Object.create(fs); io[method] = () => { throw Object.assign(new Error('injected'), { code: 'EXDEV' }); };
    assert.throws(() => probeMount(f.config.vaultDir, f.config.stateDir, io), /同一个数据挂载/);
    assert.deepEqual(fs.readdirSync(f.config.vaultDir), []); assert.deepEqual(fs.readdirSync(f.config.stateDir), []);
  }
  probeMount(f.config.vaultDir, f.config.stateDir);
  assert.deepEqual(fs.readdirSync(f.config.vaultDir), []); assert.deepEqual(fs.readdirSync(f.config.stateDir), []);
});

test('H25: second instance refuses and SIGKILL releases ownership without manual lock cleanup', async t => {
  const f = fixture(t); fs.mkdirSync(f.config.stateDir);
  const module = path.resolve(__dirname, '../headless/lock.js');
  const child = spawn(NODE, ['-e', `require(${JSON.stringify(module)}).acquireLock(process.argv[1]).then(()=>{console.log('ready');setInterval(()=>{},1000)})`, f.config.stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error('child exited ' + code))); });
  await assert.rejects(acquireLock(f.config.stateDir), /已有同步实例/);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  const release = await acquireLock(f.config.stateDir); await release();
  const releaseAgain = await acquireLock(f.config.stateDir); await releaseAgain();
});

test('H25: simultaneous stale-lock contenders have exactly one owner', async t => {
  const f = fixture(t); fs.mkdirSync(f.config.stateDir);
  const release = await acquireLock(f.config.stateDir); await release();
  const retired = fs.readdirSync(f.config.stateDir).find(name => name.startsWith('.lock-retired-'));
  fs.renameSync(path.join(f.config.stateDir, retired), path.join(f.config.stateDir, '.run-lock'));
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(f.config.stateDir)));
  const winners = attempts.filter(r => r.status === 'fulfilled');
  assert.equal(winners.length, 1);
  await winners[0].value();
});

test('H28: failed rounds back off to five minutes and success resets interval; errors do not edit notes', async t => {
  const f = fixture(t); f.config.intervalSeconds = 100; await init(f.config);
  fs.writeFileSync(path.join(f.config.vaultDir, 'keep.md'), 'untouched');
  const proc = new EventEmitter(), delays = [], logs = []; let rounds = 0;
  await run(f.config, { process: proc, logger: line => logs.push(line), sleep: async ms => {
    if (ms === f.config.settleSeconds * 1000) return;
    delays.push(ms); if (delays.length === 6) proc.emit('SIGTERM');
  }, engineFactory: () => ({ async sync() { rounds++; if (rounds <= 4 || rounds === 6) throw new Error('网络暂不可达'); return result(); } }) });
  assert.deepEqual(delays, [100000, 200000, 300000, 300000, 100000, 100000]);
  assert.equal(fs.readFileSync(path.join(f.config.vaultDir, 'keep.md'), 'utf8'), 'untouched');
  assert.equal(readStatus(f.config).state, 'error');
  assert.ok(logs.some(line => line.includes('同步已恢复')));
});

test('H29: status, mirror and logs redact password, endpoint, username and state path', async t => {
  const f = fixture(t); await init(f.config); const logs = [];
  const runner = await createRunner(f.config, { sleep: instant, logger: line => logs.push(line), engineFactory: () => ({ async sync() { throw new Error(f.config.password + ' ' + f.config.url + ' ' + f.config.username + ' ' + f.config.stateDir); } }) });
  f.cleanup.push(() => runner.close());
  await runner.round();
  const status = fs.readFileSync(path.join(f.config.stateDir, 'status.json'), 'utf8');
  const mirror = fs.readFileSync(path.join(f.config.vaultDir, '.sync-status.json'), 'utf8');
  for (const secret of [f.config.password, f.config.url, f.config.username, f.config.stateDir]) {
    assert.ok(!status.includes(secret)); assert.ok(!mirror.includes(secret)); assert.ok(!logs.join('\n').includes(secret));
  }
  assert.ok(!publicText(Buffer.from(f.config.username + ':' + f.config.password).toString('base64'), f.config).includes(f.config.password));
});

test('H30: strict config rejects HTTP off loopback, unknown fields and wrong types without echoing values', t => {
  const f = fixture(t);
  for (const change of [{ url: 'http://192.0.2.1/' }, { extra: 'not printed' }, { intervalSeconds: '30' }, { settleSeconds: 0 }, { deletionLimit: -1 }, { allowInsecureLoopback: 1 }, { device: '\n' }]) {
    f.write({ ...f.raw, ...change }); assert.throws(() => loadConfig(f.file, { env: {} }));
  }
  f.write({ ...f.raw, url: 'https://example.invalid/' }); assert.equal(loadConfig(f.file, { env: {} }).url, 'https://example.invalid/');
});

test('password precedence is environment then file then JSON; relative files resolve beside config', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'secret'), 'from-file\n');
  f.write({ ...f.raw, passwordFile: 'secret' });
  assert.equal(loadConfig(f.file, { env: {} }).password, 'from-file');
  assert.equal(loadConfig(f.file, { env: { HEADLESS_PASSWORD: 'from-env' } }).password, 'from-env');
  assert.throws(() => loadConfig(f.file, { env: { HEADLESS_PASSWORD: '' } }), /缺少密码/);
});

test('status health fails paused, error, old success and malformed timestamps; --check stays silent', async t => {
  const f = fixture(t), now = Date.now();
  assert.ok(checkHealth({ state: 'ok', lastSuccess: new Date(now - 600000).toISOString() }, now));
  for (const state of ['paused', 'error']) assert.ok(!checkHealth({ state, lastSuccess: new Date(now).toISOString() }, now));
  assert.ok(!checkHealth({ state: 'ok', lastSuccess: new Date(now - 600001).toISOString() }, now));
  assert.ok(!checkHealth({ state: 'ok', lastSuccess: null }, now));
  const out = [];
  assert.equal(await main(['status', '--check', '--config', f.file], { env: {}, stdout: x => out.push(x), stderr: x => out.push(x) }), 1);
  assert.deepEqual(out, []);
});

test('H31: run --once returns 0 success, 2 paused, 1 error and always releases lock', async t => {
  const f = fixture(t); await init(f.config);
  assert.equal(await run(f.config, { once: true, sleep: instant, logger() {}, engineFactory: () => ({ sync: async () => result() }) }), 0);
  fs.writeFileSync(path.join(f.config.vaultDir, 'bad?.md'), 'x');
  assert.equal(await run(f.config, { once: true, sleep: instant, logger() {} }), 2);
  fs.unlinkSync(path.join(f.config.vaultDir, 'bad?.md'));
  assert.equal(await run(f.config, { once: true, sleep: instant, logger() {}, engineFactory: () => ({ sync: async () => { throw new Error('unavailable'); } }) }), 1);
  const release = await acquireLock(f.config.stateDir); await release();
});

test('idle rounds produce no logs; identical paused mirror is not rewritten; attention is reported', async t => {
  const f = fixture(t); await init(f.config); const logs = [];
  const runner = await createRunner(f.config, { sleep: instant, logger: line => logs.push(line), engineFactory: () => ({ sync: async () => ({ ...result(), conflictPaths: ['a.md'], confirmations: { staleCopies: ['a'], deletionConflicts: [] } }) }) });
  f.cleanup.push(() => runner.close());
  await runner.round(); assert.equal(logs.length, 0); assert.deepEqual(runner.status.needsAttention, { staleCopies: 1, deletionConflicts: 0 });
  assert.match(runner.status.reason, /插件里处理/);
  fs.writeFileSync(path.join(f.config.vaultDir, 'bad?.md'), 'x'); await runner.round();
  const mirror = path.join(f.config.vaultDir, '.sync-status.json'); fs.utimesSync(mirror, 1000, 1000); await runner.round();
  assert.equal(fs.statSync(mirror).mtimeMs, 1000000);
});

test('CLI supports config before and after commands and rejects incompatible flags', () => {
  assert.equal(parseArgs(['--config', 'a', 'run', '--once']).file, 'a');
  assert.equal(parseArgs(['run', '--config', 'b']).file, 'b');
  assert.throws(() => parseArgs(['init', '--check'])); assert.throws(() => parseArgs(['approve-deletions']));
});

async function childExit(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }
function launch(f, args) {
  return spawn(NODE, [path.resolve(__dirname, '../headless/cli.js'), '--config', f.file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('H27: SIGTERM interrupts idle wait immediately and a hung sync exits within 10 seconds', { timeout: 20000 }, async t => {
  for (const hang of [false, true]) {
    const f = fixture(t); let observed;
    const requestSeen = new Promise(resolve => { observed = resolve; });
    const dav = await fakeDav(t, { intercept({ method, res }) { if (hang && method === 'GET') { observed(); return true; } } });
    f.write({ ...f.raw, url: dav.url, username: dav.username, password: dav.password, intervalSeconds: 60 });
    const config = loadConfig(f.file, { env: {} }); await init(config);
    const child = launch(f, ['run']); t.after(() => child.kill('SIGKILL'));
    const exited = childExit(child);
    if (hang) await requestSeen;
    else {
      for (let i = 0; i < 500; i++) { if (readStatus(config).state === 'ok') break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(readStatus(config).state, 'ok');
    }
    const started = Date.now(); child.kill('SIGTERM'); await exited;
    assert.ok(Date.now() - started < 10000);
    if (!hang) assert.ok(Date.now() - started < 1000);
  }
});

test('H28: real loopback DAV errors recover automatically and leave existing note contents intact', async t => {
  const f = fixture(t), dav = await fakeDav(t); Object.assign(f.config, { url: dav.url, username: dav.username, password: dav.password });
  await init(f.config); fs.writeFileSync(path.join(f.config.vaultDir, 'note.md'), 'unchanged');
  const runner = await createRunner(f.config, { sleep: instant, logger() {} });
  try {
    dav.failStatus = 503;
    assert.equal((await runner.round()).state, 'error');
    assert.equal(fs.readFileSync(path.join(f.config.vaultDir, 'note.md'), 'utf8'), 'unchanged');
    dav.failStatus = 0;
    assert.equal((await runner.round()).state, 'ok');
  } finally { await runner.close(); }
});

test('H22 CLI missing init explains init and never prints a stack trace', async t => {
  const f = fixture(t), errors = [];
  assert.equal(await main(['run', '--once', '--config', f.file], { env: {}, stderr: value => errors.push(value) }), 1);
  assert.match(errors.join(''), /init/); assert.ok(!errors.join('').includes('at '));
});

test('credential redaction preserves machine status, timestamps and counts even for short usernames', async t => {
  const f = fixture(t); f.config.username = 'ok'; await init(f.config);
  const runner = await createRunner(f.config, { sleep: instant, logger() {}, engineFactory: () => ({ sync: async () => result() }) });
  try {
    const status = await runner.round(); assert.equal(status.state, 'ok'); assert.ok(checkHealth(status));
    f.config.username = '1';
    const again = await runner.round(); assert.ok(checkHealth(again)); assert.ok(Number.isFinite(Date.parse(again.lastSuccess)));
  } finally { await runner.close(); }
});

test('H29: config validation redacts unknown field names containing JSON, file or environment passwords', async t => {
  const f = fixture(t), secret = 'UniqueSecretCopiedAsField';
  for (const mode of ['json', 'file', 'env']) {
    const raw = { ...f.raw, [secret]: true };
    const env = {};
    if (mode === 'json') raw.password = secret;
    if (mode === 'file') { fs.writeFileSync(path.join(f.root, 'secret'), secret); raw.passwordFile = 'secret'; }
    if (mode === 'env') env.HEADLESS_PASSWORD = secret;
    f.write(raw); const errors = [];
    assert.equal(await main(['run', '--once', '--config', f.file], { env, stderr: value => errors.push(value) }), 1);
    assert.ok(!errors.join('').includes(secret)); assert.match(errors.join(''), /未知字段/);
  }
});

test('H24: a vault restored after missing-at-startup must pass the mount probe before engine creation', async t => {
  const f = fixture(t); await init(f.config);
  const backup = path.join(f.root, 'moved-vault'); fs.renameSync(f.config.vaultDir, backup);
  let probes = 0, engineCalls = 0;
  const io = Object.create(fs); io.linkSync = () => { probes++; throw Object.assign(new Error('cross mount'), { code: 'EXDEV' }); };
  const runner = await createRunner(f.config, { probeIO: io, sleep: instant, logger() {}, engineFactory: () => ({ async sync() { engineCalls++; return result(); } }) });
  try {
    assert.equal((await runner.round()).state, 'paused'); assert.equal(probes, 0);
    fs.renameSync(backup, f.config.vaultDir);
    const status = await runner.round(); assert.equal(status.state, 'error'); assert.match(status.reason, /同一个数据挂载/);
    assert.equal(probes, 1); assert.equal(engineCalls, 0);
    assert.equal(fs.readdirSync(f.config.vaultDir).filter(name => name.startsWith('.mount-probe')).length, 0);
    assert.equal(fs.readdirSync(f.config.stateDir).filter(name => name.startsWith('.mount-probe')).length, 0);
  } finally { await runner.close(); }
});

test('H17: approve-deletions CLI works while the daemon holds its instance lock', { timeout: 15000 }, async t => {
  const f = fixture(t), dav = await fakeDav(t);
  f.write({ ...f.raw, url: dav.url, username: dav.username, password: dav.password, intervalSeconds: 0.02 });
  const config = loadConfig(f.file, { env: {} }); await init(config);
  for (const note of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(config.vaultDir, note), 'base ' + note);
  const daemon = launch(f, ['run']); let output = '';
  daemon.stdout.on('data', data => { output += data.toString(); }); daemon.stderr.on('data', data => { output += data.toString(); });
  const stopped = childExit(daemon);
  f.cleanup.push(async () => { daemon.kill('SIGTERM'); await stopped; assert.ok(!output.includes(dav.password)); });
  const waitFor = async expected => {
    for (let i = 0; i < 500; i++) { const state = readStatus(config); if (state.state === expected) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('daemon did not reach ' + expected);
  };
  await waitFor('ok');
  for (const note of ['a.md', 'b.md', 'c.md']) fs.unlinkSync(path.join(config.vaultDir, note));
  assert.equal((await waitFor('paused')).pendingDeletions.count, 3);
  const wrong = launch(f, ['approve-deletions', '--count', '2']);
  assert.equal((await childExit(wrong)).code, 1);
  assert.equal(readStatus(config).state, 'paused');
  const correct = launch(f, ['approve-deletions', '--count', '3']);
  assert.equal((await childExit(correct)).code, 0);
  await waitFor('ok');
  const deleted = [...dav.entries].filter(([name]) => name.endsWith('.json')).map(([, bytes]) => JSON.parse(bytes)).filter(row => row.path && row.blob === null);
  assert.equal(deleted.length, 3);
});
