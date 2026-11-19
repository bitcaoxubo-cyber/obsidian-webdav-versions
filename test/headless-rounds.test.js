'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeDav } = require('./helpers/headless-dav');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');
const { createRunner, init } = require('../headless/runtime');
const { Recovery } = require('../headless/recovery');

function mobile(dav, device) {
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, dav.url, dav.username);
  const engine = new SyncEngine({ remote: dav.remote(), local, state, device });
  return {
    put: (name, value) => adapter.put(name, value),
    remove: name => adapter.remove(name),
    move: (from, to) => adapter.rename(from, to),
    files: () => new Map([...adapter.files].filter(([name]) => !name.startsWith('.'))
      .map(([name, value]) => [name, Buffer.from(value).toString()])),
    sync: () => engine.sync(),
    resolve: name => engine.resolve(name),
  };
}

async function setup(t, deletionLimit) {
  const dav = await fakeDav(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-round-'));
  const vaultDir = path.join(dataDir, 'vault');
  const config = { url: dav.url, username: dav.username, password: dav.password,
    device: 'NAS', allowInsecureLoopback: true, dataDir, vaultDir, stateDir: path.join(dataDir, 'state'),
    deletionLimit, intervalSeconds: 30, settleSeconds: 5 };
  let runner;
  t.after(async () => { if (runner) await runner.close(); fs.rmSync(dataDir, { force: true, recursive: true }); });
  await init(config);
  const mac = mobile(dav, 'Mac'), phone = mobile(dav, 'iPhone');
  const restart = async () => {
    if (runner) await runner.close();
    runner = await createRunner(config, { logger: () => {}, sleep: async () => {} });
  };
  await restart();
  const nas = {
    put: (name, value) => fs.writeFileSync(path.join(vaultDir, name), value),
    remove: name => fs.unlinkSync(path.join(vaultDir, name)),
    move: (from, to) => fs.renameSync(path.join(vaultDir, from), path.join(vaultDir, to)),
    files: () => new Map(fs.readdirSync(vaultDir).filter(name => !name.startsWith('.'))
      .map(name => [name, fs.readFileSync(path.join(vaultDir, name), 'utf8')])),
    sync: async () => {
      const outcome = await runner.round();
      assert.equal(outcome.state, 'ok', outcome.reason);
      return outcome;
    },
  };
  return { config, dav, mac, phone, nas, restart, round: () => runner.round(), get gates() { return runner.gates; }, approve: n => runner.gates.approve(n) };
}

function revision(request) {
  if (request.method === 'PUT' && request.path.endsWith('.json')) return JSON.parse(request.data);
}

for (const received of [false, true]) {
  for (const restored of [null, 'original plan.md', 'restored offline']) {
    test(`pending deletion: received=${received}, restored=${restored ?? 'absent'}; retry respects this round and immutable history`, async t => {
      const f = await setup(t, 1);
      for (const name of ['plan.md', 'second.md', 'keep.md']) f.mac.put(name, 'original ' + name);
      await f.mac.sync(); await f.phone.sync(); await f.nas.sync();
      f.nas.remove('plan.md');
      let interrupted;
      f.dav.intercept = req => {
        const row = revision(req);
        if (row?.path !== 'plan.md' || row.blob !== null) return;
        interrupted = row;
        if (received) {
          f.dav.entries.set(req.path, req.data);
          req.res.destroy(); // Commit reached disk; the HTTP response never reaches the NAS.
        } else req.send(503);
        return true;
      };
      assert.equal((await f.round()).state, 'error');
      assert.equal((await new Recovery(f.config).read()).pending.rev.id, interrupted.id);
      const tombstones = async () => (await f.dav.remote().listRevisions())
        .filter(row => row.path === 'plan.md' && row.blob === null).map(row => row.id);
      assert.deepEqual(await tombstones(), received ? [interrupted.id] : []);
      if (restored) f.nas.put('plan.md', restored);
      else f.nas.remove('second.md'); // The old one-file authorization cannot admit this larger batch.
      let retryWrites = 0;
      f.dav.intercept = req => { if (revision(req)?.id === interrupted.id) retryWrites++; };
      await f.restart();
      if (!restored) {
        const status = await f.round();
        assert.equal(status.state, 'paused');
        assert.equal(status.pendingDeletions.count, 2);
        assert.deepEqual(status.pendingDeletions.paths, ['plan.md', 'second.md']);
        assert.equal(retryWrites, 0);
        await assert.rejects(f.approve(1), /数量不匹配/);
        await f.approve(2);
      }
      await f.nas.sync();
      assert.equal(retryWrites, Number(!received && !restored));
      assert.deepEqual(await tombstones(), received || !restored ? [interrupted.id] : []);
      assert.equal((await new Recovery(f.config).read()).pending, null);
      for (const device of [f.mac, f.phone]) {
        await device.sync();
        if (restored) assert.equal(device.files().get('plan.md'), restored);
        else {
          assert.ok(!device.files().has('plan.md'));
          assert.ok(!device.files().has('second.md'));
        }
      }
      await f.nas.sync();
      assert.equal(retryWrites, Number(!received && !restored));
    });
  }
}

test('missing pending content upload participates in the first gate after restart', async t => {
  const f = await setup(t, 1);
  for (const name of ['keep.md', 'old.md']) f.mac.put(name, name);
  await f.mac.sync(); await f.nas.sync();
  f.nas.put('new.md', 'pending upload');
  f.dav.intercept = req => {
    if (revision(req)?.path === 'new.md') { req.send(503); return true; }
  };
  assert.equal((await f.round()).state, 'error');
  f.dav.intercept = null;
  const pending = (await new Recovery(f.config).read()).pending;
  assert.equal(pending.kind, 'push');
  assert.ok(pending.rev.blob);
  f.nas.remove('new.md'); f.nas.remove('old.md');
  await f.restart();
  const status = await f.round();
  assert.equal(status.state, 'paused');
  assert.deepEqual(status.pendingDeletions.paths, ['new.md', 'old.md']);
  assert.equal((await f.dav.remote().listRevisions()).some(r => r.path === 'new.md' || r.blob === null), false);
  f.nas.put('new.md', 'pending upload'); f.nas.put('old.md', 'old.md');
  await f.nas.sync(); await f.mac.sync();
  assert.equal(f.mac.files().get('new.md'), 'pending upload');
  assert.equal(f.mac.files().get('old.md'), 'old.md');
});

test('conflict cleanup survives a restart between engine checkpoint and protection checkpoint', async t => {
  const f = await setup(t, 0);
  f.mac.put('plan.md', 'original'); await f.mac.sync();
  await f.nas.sync(); await f.phone.sync();
  f.phone.put('plan.md', 'phone changed'); f.mac.put('plan.md', 'Mac changed');
  await f.phone.sync(); await f.mac.sync(); await f.nas.sync();
  const copy = [...f.nas.files().keys()].find(name => name.includes(' (sync-conflict '));
  assert.ok(copy);
  await f.mac.resolve('plan.md');
  t.mock.method(f.gates, 'saveBaselineAfterSuccess', async () => { throw new Error('interrupt before gate checkpoint'); });
  assert.equal((await f.round()).state, 'error');
  assert.ok(!f.nas.files().has(copy));
  assert.ok(f.gates.readBaseline().files.some(file => file.path === copy));
  await f.restart();
  await f.nas.sync(); await f.phone.sync();
  assert.deepEqual(f.nas.files(), f.mac.files());
  assert.deepEqual(f.nas.files(), f.phone.files());
});

test('an inconclusive remote listing preserves a pending deletion and a restored note', async t => {
  const f = await setup(t, 1);
  f.mac.put('plan.md', 'original'); f.mac.put('keep.md', 'keep'); await f.mac.sync(); await f.nas.sync();
  f.nas.remove('plan.md');
  f.dav.intercept = req => {
    if (revision(req)?.blob === null) { req.send(503); return true; }
  };
  assert.equal((await f.round()).state, 'error');
  const recovery = new Recovery(f.config), before = (await recovery.read()).pending;
  f.nas.put('plan.md', 'restored'); await f.restart();
  f.dav.intercept = req => { req.send(503); return true; };
  assert.equal((await f.round()).state, 'error');
  assert.deepEqual((await recovery.read()).pending, before);
  assert.equal(f.nas.files().get('plan.md'), 'restored');
  f.dav.intercept = null;
  await f.nas.sync(); await f.mac.sync();
  assert.equal(f.mac.files().get('plan.md'), 'restored');
  assert.ok(!(await f.dav.remote().listRevisions()).some(row => row.blob === null));
});

function random(seed) {
  let state = seed >>> 0;
  return limit => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return Math.floor((state >>> 0) / 0x100000000 * limit);
  };
}

test('J4: 60 seeded three-device histories, 60 steps each, converge byte-for-byte', async t => {
  for (let group = 0; group < 60; group++) {
    const seed = 0xc4a60000 + group;
    await t.test('seed 0x' + seed.toString(16), async t => {
      const choose = random(seed), nonce = random(seed ^ 0x3a099da5);
      t.mock.method(globalThis.crypto, 'getRandomValues', array => {
        for (let i = 0; i < array.length; i++) array[i] = nonce(256);
        return array;
      });
      const { mac, phone, nas, restart } = await setup(t, 10000), devices = [nas, mac, phone];
      const checkAll = async () => {
        await nas.sync(); await mac.sync(); await phone.sync();
        assert.deepEqual(nas.files(), mac.files());
        assert.deepEqual(mac.files(), phone.files());
      };
      mac.put('shared.md', 'initial');
      for (let i = 0; i < 4; i++) mac.put('n' + i + '.md', 'initial ' + i);
      await mac.sync(); await checkAll();
      // Every seed exercises every operation, in a different order. Peers
      // may continue editing before the others have polled their last change.
      const operations = [];
      for (const [name, count] of Object.entries({ create: 15, edit: 17, delete: 10, move: 10, conflict: 4, restart: 4 })) {
        operations.push(...Array(count).fill(name));
      }
      for (let step = 0; operations.length; step++) {
        const op = operations.splice(choose(operations.length), 1)[0];
        const device = devices[choose(3)], value = seed + '/' + step;
        try {
          const notes = [...device.files().keys()].filter(name => name !== 'shared.md' && !name.includes(' (sync-conflict ')).sort();
          const target = notes[choose(notes.length)];
          if (op === 'conflict') {
            // All three know the previous tips. Concurrent changes create a real
            // conflict on a fixed logical note; Mac explicitly resolves a member.
            await nas.sync(); await mac.sync(); await phone.sync();
            const first = choose(3), second = (first + 1 + choose(2)) % 3;
            devices[first].put('shared.md', value + '-A'); devices[second].put('shared.md', value + '-B');
            await devices[first].sync(); await devices[second].sync();
            await mac.sync();
            const members = [...mac.files().keys()].filter(name => name === 'shared.md' || name.startsWith('shared (sync-conflict ')).sort();
            assert.equal(members.length, 2);
            await mac.resolve(members[choose(2)]);
            await nas.sync();
          } else if (op === 'restart') {
            await restart();
            await nas.sync();
          } else {
            const newName = 's' + step + '.md';
            if (op === 'create' || !target) device.put(newName, value);
            else if (op === 'edit') device.put(target, value);
            else if (op === 'delete') await device.remove(target);
            else await device.move(target, newName);
            await device.sync();
          }
          if (step % 8 === 7) { await nas.sync(); await phone.sync(); await mac.sync(); }
        } catch (error) {
          error.message = 'seed=' + seed.toString(16) + ' step=' + step + ' ' + op + ': ' + error.message;
          throw error;
        }
      }
      await nas.sync(); await phone.sync(); await mac.sync();
      await checkAll();
    });
  }
});
