'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { fakeDav } = require('./helpers/headless-dav');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');
const { digest, isConflictPath } = require('../src/protocol');
const { init, createRunner, approve } = require('../headless/runtime');

const names = (count, prefix = 'n') =>
  Array.from({ length: count }, (_, i) => prefix + String(i).padStart(2, '0') + '.md');
const options = { logger: () => {}, sleep: async () => {} };
function device(dav, name) {
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, dav.url, dav.username);
  const engine = new SyncEngine({ local, state, remote: dav.remote(), device: name });
  return {
    engine, put: (file, body) => adapter.put(file, body), sync: () => engine.sync({ full: true }),
    contents: () => Object.fromEntries([...adapter.files].filter(([file]) => !file.startsWith('.'))
      .map(([file, bytes]) => [file, Buffer.from(bytes).toString()])),
  };
}
async function fixture(t, count) {
  const dav = await fakeDav(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const config = { dataDir: root, vaultDir: path.join(root, 'vault'), stateDir: path.join(root, 'state'),
    url: dav.url, username: dav.username, password: dav.password, device: 'NAS',
    intervalSeconds: 30, settleSeconds: 5, deletionLimit: 20, allowInsecureLoopback: true };
  let runner;
  t.after(async () => {
    if (runner) await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await init(config);
  const mac = device(dav, 'Mac'), phone = device(dav, 'iPhone');
  const expected = Object.fromEntries(names(count).map(name => [name, 'original ' + name]));
  for (const [name, text] of Object.entries(expected)) mac.put(name, text);
  await mac.sync(); await phone.sync();
  return {
    dav, config, mac, phone, expected,
    async round() {
      runner ||= await createRunner(config, options);
      return runner.round();
    },
    async restart() { if (runner) await runner.close(); runner = null; },
    list: () => fs.readdirSync(config.vaultDir).filter(name => !name.startsWith('.')).sort(),
    write: (name, text) => fs.writeFileSync(path.join(config.vaultDir, name), text),
    remove: files => { for (const file of files) fs.unlinkSync(path.join(config.vaultDir, file)); },
    tombstones: () => [...dav.entries].filter(([p]) => p.endsWith('.json'))
      .map(([, data]) => JSON.parse(data)).filter(rev => rev.blob === null).map(rev => rev.path).sort(),
  };
}
async function expectOk(f) {
  const status = await f.round();
  assert.equal(status.state, 'ok', status.reason);
}
async function checkPeers(f) {
  for (const peer of [f.mac, f.phone]) {
    await peer.sync();
    assert.deepEqual(peer.contents(), f.expected);
  }
}

// All injections run on a protocol event, never on an elapsed-time estimate.
async function duringRequest(f, match, act) {
  let fired = false;
  f.dav.intercept = req => {
    if (!fired && match(req)) { fired = true; act(); }
  };
  try {
    const result = await f.round();
    assert.ok(fired, 'round reached the requested DAV operation');
    return result;
  } finally { f.dav.intercept = null; }
}
async function uploadRace(f, count) {
  // Edit an existing note so wiping the folder removes exactly 60 synced notes.
  const edited = 'n59.md';
  f.expected[edited] = 'changed on NAS';
  f.write(edited, f.expected[edited]);
  const removed = names(count);
  const result = await duringRequest(f, req => req.method === 'PUT' && req.path.endsWith('.json') &&
    JSON.parse(req.data).path === edited, () => f.remove(removed));
  return { result, removed };
}

async function failedFirstDownload(t, f, kill) {
  let removed, child;
  // The fake DAV has no HEAD support; the engine downloads each unknown-sized
  // file in its own batch. The next GET is after the 50th durable receipt.
  f.dav.intercept = req => {
    if (req.method !== 'GET' || !req.path.endsWith('.blob') || f.list().length !== 50) return;
    removed = f.list();
    if (kill) child.kill('SIGKILL');
    else req.send(503);
    return true;
  };
  try {
    if (kill) {
      // Run the production runner in a separate process with the same gate
      // settings. The server kills it while its next blob request is in flight.
      const entry = `
        const { createRunner } = require('./headless/runtime');
        (async () => {
          const runner = await createRunner(JSON.parse(process.argv[1]), { sleep: async () => {} });
          try { await runner.round(); } finally { await runner.close(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });`;
      child = spawn(process.execPath, ['-e', entry, JSON.stringify(f.config)], {
        cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      const [code, signal] = await once(child, 'exit');
      assert.equal(signal, 'SIGKILL', 'child exit ' + code + ': ' + errors);
    } else {
      const status = await f.round();
      assert.equal(status.state, 'error', status.reason);
      await f.restart();
    }
  } finally { f.dav.intercept = null; }
  assert.equal(removed?.length, 50);
  f.remove(removed);
  return removed;
}

async function interruptedRound(t, f, scenario) {
  if (scenario.startsWith('D5')) return failedFirstDownload(t, f, scenario === 'D5 SIGKILL');
  await expectOk(f);
  if (scenario === 'D1' || scenario === 'D3') {
    const { result, removed } = await uploadRace(f, scenario === 'D1' ? 60 : 45);
    assert.ok(['ok', 'paused'].includes(result.state), result.reason);
    return removed;
  }
  if (scenario === 'D4') {
    const removed = names(60);
    const result = await duringRequest(f, req => req.method === 'PROPFIND', () => f.remove(removed));
    assert.equal(result.state, 'paused', result.reason);
    assert.match(result.reason, /检查之后又有文件消失/);
    return removed;
  }
  // D2 deletes the old files during download of a new note. D6 deletes the
  // new files only after they arrived, before downloading the final note.
  const removed = scenario === 'D2' ? names(60) : names(30, 'new');
  if (scenario === 'D6') {
    for (const name of removed) { f.expected[name] = 'new ' + name; f.mac.put(name, f.expected[name]); }
  }
  const last = 'zz-last.md';
  f.expected[last] = 'last note from Mac';
  f.mac.put(last, f.expected[last]);
  await f.mac.sync(); await f.phone.sync();
  const result = await duringRequest(f,
    req => req.method === 'GET' && req.path.endsWith('/' + digest(f.expected[last]) + '.blob'),
    () => { f.remove(removed); });
  assert.ok(['ok', 'paused'].includes(result.state), result.reason);
  return removed;
}

for (const [j, scenario] of [
  ['J5', 'D1'], ['J6', 'D2'], ['J7', 'D3'], ['J8', 'D4'],
  ['J9', 'D5 network'], ['J9', 'D5 SIGKILL'], ['J10', 'D6'],
]) {
  for (const resolution of ['restore', 'approve']) {
    test(j + ' ' + scenario + ' / ' + (resolution === 'restore' ? 'J11 restore' : 'J12 approve'), { timeout: 90000 }, async t => {
      const f = await fixture(t, scenario === 'D6' ? 5 : 60);
      const removed = (await interruptedRound(t, f, scenario)).sort();
      assert.deepEqual(f.tombstones(), []);
      const paused = await f.round();
      assert.equal(paused.state, 'paused', paused.reason);
      assert.equal(paused.pendingDeletions?.count, removed.length);
      const paths = paused.pendingDeletions.allPaths ?? paused.pendingDeletions.paths;
      assert.deepEqual(paths, removed);
      const persisted = JSON.parse(fs.readFileSync(path.join(f.config.stateDir, 'status.json'), 'utf8'));
      assert.deepEqual(persisted.pendingDeletions, paused.pendingDeletions);
      assert.deepEqual(f.tombstones(), []);
      await checkPeers(f);

      if (resolution === 'restore') {
        for (const file of removed) f.write(file, f.expected[file]);
      } else {
        await assert.rejects(approve(f.config, removed.length + 1, options), /数量不匹配/);
        assert.equal((await f.round()).state, 'paused');
        assert.deepEqual(f.tombstones(), []);
        const granted = await approve(f.config, removed.length, options);
        assert.equal(granted.count, removed.length);
        for (const file of removed) delete f.expected[file];
      }
      await expectOk(f);
      await checkPeers(f);
      await expectOk(f);
      assert.deepEqual(f.tombstones(), resolution === 'restore' ? [] : removed);
    });
  }
}

test('J13: 15 mid-upload deletions are counted next round and published exactly once', async t => {
  const f = await fixture(t, 60);
  await expectOk(f);
  const { result, removed } = await uploadRace(f, 15);
  assert.equal(result.state, 'ok', result.reason);
  assert.deepEqual(f.tombstones(), []);
  await assert.rejects(approve(f.config, removed.length, options), /无需批准/);
  await assert.rejects(approve(f.config, removed.length + 1, options), /当前消失 15/);
  await expectOk(f);
  assert.deepEqual(f.tombstones(), removed);
  for (const file of removed) delete f.expected[file];
  await checkPeers(f);
  await expectOk(f);
  assert.deepEqual(f.tombstones(), removed);
});

test('J3: NAS removes the physical conflict copy after Mac resolves the conflict', async t => {
  const f = await fixture(t, 2);
  await expectOk(f);
  const name = 'n00.md';
  f.mac.put(name, 'edited on Mac'); await f.mac.sync();
  f.write(name, 'edited on NAS'); await expectOk(f);
  const copy = f.list().find(isConflictPath);
  assert.ok(copy);
  await f.mac.sync();
  await f.mac.engine.resolve(name);
  const selected = f.mac.contents()[name];
  await expectOk(f);
  assert.ok(!f.list().includes(copy));
  await expectOk(f);
  f.expected[name] = selected;
  await checkPeers(f);
  assert.deepEqual(f.tombstones(), []);
});

test('I1: external removal of a conflict copy counts its physical path', async t => {
  const f = await fixture(t, 2);
  // An ordinary single-file deletion now needs approval, so the exemption for
  // the engine's own conflict cleanup cannot conceal an external deletion.
  f.config.deletionLimit = 0;
  await expectOk(f);
  const name = 'n00.md';
  f.mac.put(name, 'Mac branch'); await f.mac.sync();
  f.write(name, 'NAS branch'); await expectOk(f);
  const copy = f.list().find(isConflictPath);
  assert.ok(copy);
  const kept = fs.readFileSync(path.join(f.config.vaultDir, name), 'utf8');
  f.remove([copy]);
  const status = await f.round();
  assert.equal(status.state, 'paused', status.reason);
  assert.equal(status.pendingDeletions.count, 1);
  assert.deepEqual(status.pendingDeletions.paths, [copy]);
  assert.deepEqual(f.tombstones(), []);
  await approve(f.config, 1, options);
  await expectOk(f);
  f.expected[name] = kept;
  await checkPeers(f);
  assert.deepEqual(f.tombstones(), [name]);
});

// Derive a request index from the complete fault-free trace for each workload.
// This includes DAV discovery, upload verification, and remote download stages.
const fuzzSeed = 0xb6172026;
function random(seed) {
  return max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x100000000) * max);
  };
}
async function prepareTrials(t, count, mode) {
  const f = await fixture(t, count);
  f.config.deletionLimit = 2;
  await expectOk(f);
  if (mode !== 'download') {
    f.write('n00.md', 'NAS edit one');
    f.write('n01.md', 'NAS edit two');
  }
  if (mode !== 'upload') {
    for (const name of names(3, 'incoming')) f.mac.put(name, 'remote ' + name);
    await f.mac.sync();
  }
  // Start every independent trial from the same synchronized disk and remote
  // state. This also resets receipts, caches, immutable objects and the lock.
  await f.restart();
  const entries = new Map(f.dav.entries), dirs = new Set(f.dav.dirs);
  const snapshot = path.join(f.config.dataDir, 'snapshot');
  const copy = (from, to) => fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  fs.mkdirSync(snapshot);
  for (const dir of ['state', 'vault']) copy(path.join(f.config.dataDir, dir), path.join(snapshot, dir));
  async function reset() {
    await f.restart();
    for (const dir of ['state', 'vault']) {
      const dest = path.join(f.config.dataDir, dir);
      fs.rmSync(dest, { recursive: true, force: true });
      copy(path.join(snapshot, dir), dest);
    }
    f.dav.entries = new Map(entries);
    f.dav.dirs = new Set(dirs);
    f.dav.calls.length = 0;
    f.dav.intercept = null;
  }
  await reset();
  await expectOk(f);
  return { f, reset, requests: f.dav.calls.length };
}
test('J14: 200 seeded mid-request deletions never exceed the per-round gate', async t => {
  const templates = new Map();
  for (const count of [2, 6]) for (const mode of ['upload', 'download', 'mixed']) {
    templates.set(count + '/' + mode, await prepareTrials(t, count, mode));
  }
  let wipes = 0, overLimit = 0, smallPartial = 0;
  for (let trial = 0; trial < 200; trial++) {
    const trialSeed = (fuzzSeed + Math.imul(trial + 1, 0x9e3779b1)) >>> 0;
    const draw = random(trialSeed);
    const count = [2, 6][draw(2)], mode = ['upload', 'download', 'mixed'][draw(3)];
    const { f, reset, requests } = templates.get(count + '/' + mode);
    const index = draw(requests);
    await t.test('seed ' + trialSeed.toString(16) + ', trial ' + trial + ', ' + mode +
      ', ' + count + ' notes, request ' + (index + 1) + '/' + requests, async t => {
      await reset();
      let seen = 0, removed, wiped;
      f.dav.intercept = () => {
        if (seen++ !== index) return;
        const candidates = f.list();
        const number = 1 + draw(candidates.length);
        wiped = number === candidates.length;
        // Generate a sample without replacement from every note currently on
        // disk, including any new downloads completed before this request.
        removed = [];
        while (removed.length < number) removed.push(candidates.splice(draw(candidates.length), 1)[0]);
        f.remove(removed);
      };
      const first = await f.round();
      f.dav.intercept = null;
      assert.ok(removed, 'reached selected request');
      assert.ok(['ok', 'paused'].includes(first.state), first.reason);
      assert.deepEqual(f.tombstones(), [], 'nothing was missing at the first gate');
      let status = first, previous = [];
      for (let followup = 0; followup < 3; followup++) {
        status = await f.round();
        assert.ok(['ok', 'paused'].includes(status.state), status.reason);
        const published = f.tombstones();
        assert.ok(published.length - previous.length <= f.config.deletionLimit, 'per-round deletion limit');
        assert.ok(published.every(name => removed.includes(name)), 'every deletion is part of the disappearance');
        previous = published;
      }
      if (wiped || removed.length > f.config.deletionLimit) {
        if (wiped) wipes++;
        if (removed.length > f.config.deletionLimit) overLimit++;
        assert.equal(status.state, 'paused', status.reason);
        assert.equal(status.pendingDeletions?.count, removed.length);
        assert.deepEqual(status.pendingDeletions.paths, removed.sort());
        assert.deepEqual(previous, [], 'nothing published without approval');
      } else {
        smallPartial++;
        assert.equal(status.state, 'ok', status.reason);
        assert.deepEqual(previous, removed.sort(), 'each permitted deletion published exactly once');
      }
    });
  }
  assert.ok(wipes && overLimit && smallPartial, 'seed covers all outcomes');
});
