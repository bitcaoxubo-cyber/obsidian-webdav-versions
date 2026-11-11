'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncScheduler } = require('../src/scheduler');
function clock() {
  let now = 0, next = 0;
  const tasks = new Map();
  return { now: () => now, setTimeout: (fn, delay) => { const id = ++next; tasks.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: id => tasks.delete(id), async tick(ms) {
      const target = now + ms;
      while (true) {
        const entry = [...tasks].filter(([, job]) => job.at <= target).sort((a,b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        now = entry[1].at; tasks.delete(entry[0]); await entry[1].fn();
      }
      now = target;
    }, pending: () => tasks.size };
}
function fixture(mobile = true) {
  const time = clock(), calls = [];
  let active = true, enabled = true;
  const scheduler = new SyncScheduler({ mobile, ...time, active: () => active, enabled: () => enabled,
    run: async () => { const ticket = scheduler.begin(); calls.push({ now: time.now(), full: ticket.full, dirty: ticket.dirty }); scheduler.complete(ticket, calls.length === 1 ? { uploaded: 1 } : {}); } });
  return { scheduler, time, calls, setActive: v => { active = v; }, setEnabled: v => { enabled = v; } };
}

test('A5: mobile and desktop debounce use 15 and 5 seconds and record both rename paths', async () => {
  for (const [mobile, delay] of [[true,15000],[false,5000]]) {
    const f = fixture(mobile), s = f.scheduler;
    s.change(['old.md', 'new.md']);
    await f.time.tick(delay - 1); assert.equal(f.calls.length, 0);
    await f.time.tick(1); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].dirty, ['old.md', 'new.md']);
    s.stop();
  }
});

test('A5: successful rounds retain newer events and deferred paths; failure retains every dirty path', () => {
  const { scheduler: s } = fixture();
  s.change(['a.md', 'b.md']);
  const first = s.begin();
  s.change(['a.md', 'new.md']);
  s.complete(first, { deferredPaths: ['b.md'] });
  const next = s.begin();
  assert.deepEqual(next.dirty, ['a.md', 'b.md', 'new.md']);
  s.fail(next);
  const retry = s.begin();
  assert.equal(retry.full, true);
  assert.deepEqual(retry.dirty, next.dirty);
  s.complete(retry, {});
  assert.deepEqual(s.begin().dirty, []);
  s.stop();
});

test('A5: first, manual, deep, resolve, foreground, error and ten-minute rounds are full', async () => {
  const f = fixture(), s = f.scheduler;
  let ticket = s.begin(); assert.equal(ticket.full, true); s.complete(ticket, {});
  ticket = s.begin(); assert.equal(ticket.full, false); s.complete(ticket, {});
  for (const reason of [{ manual: true }, { deep: true }, { resolve: true }]) {
    ticket = s.begin(reason); assert.equal(ticket.full, true); assert.equal(ticket.deep, !!reason.deep); s.complete(ticket, {});
  }
  s.foreground(); ticket = s.begin(); assert.equal(ticket.full, true); s.complete(ticket, {});
  ticket = s.begin(); s.fail(ticket); ticket = s.begin(); assert.equal(ticket.full, true); s.complete(ticket, {});
  f.setEnabled(false); s.pause(); await f.time.tick(600000);
  ticket = s.begin(); assert.equal(ticket.full, true); s.complete(ticket, {}); s.stop();
});

test('A5: fake-clock idle polling backs off 60,120,240,300 seconds with at most two full rounds in ten minutes', async () => {
  const f = fixture(), s = f.scheduler;
  s.schedule(0); await f.time.tick(0);
  const intervals = [s.pollIntervalMs];
  await f.time.tick(60000); intervals.push(s.pollIntervalMs);
  await f.time.tick(120000); intervals.push(s.pollIntervalMs);
  await f.time.tick(240000); intervals.push(s.pollIntervalMs);
  assert.deepEqual(intervals, [60000,120000,240000,300000]);
  await f.time.tick(180000);
  assert.equal(f.time.now(), 600000);
  assert.equal(f.calls.filter(c => c.full).length, 2);
  assert.deepEqual(f.calls.map(c => c.now), [0,60000,180000,420000,600000]);
  s.stop(); assert.equal(f.time.pending(), 0);
});

test('A5: events reset polling and a foreground request arriving during sync is not acknowledged early', () => {
  const f = fixture(), s = f.scheduler;
  s.complete(s.begin(), {}); s.complete(s.begin(), {}); assert.equal(s.pollIntervalMs, 240000);
  const ticket = s.begin(); s.change(['a.md']); assert.equal(s.pollIntervalMs, 60000);
  s.foreground(); s.complete(ticket, {}); assert.equal(s.pollIntervalMs, 60000);
  const next = s.begin(); assert.equal(next.full, true); assert.deepEqual(next.dirty, ['a.md']); s.stop();
});

test('A5: background pauses timers and foreground schedules a full sync within one second', async () => {
  const f = fixture(), s = f.scheduler;
  s.change(['a.md']); f.setActive(false); s.pause();
  await f.time.tick(600000); assert.equal(f.calls.length, 0);
  f.setActive(true); s.foreground(); await f.time.tick(1000);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].full, true);
  s.stop();
});

test('A5: a failed overdue full round waits before retrying instead of spinning at the full deadline', async () => {
  const f = fixture(), s = f.scheduler;
  s.complete(s.begin(), {});
  f.setEnabled(false); s.pause(); await f.time.tick(600000);
  f.setEnabled(true); s.fail(s.begin());
  await f.time.tick(59999); assert.equal(f.calls.length, 0);
  await f.time.tick(1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].full, true);
  s.stop();
});

test('A5: plugin routes file events, deep/manual commands, foreground and failures through the scheduler', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const time = clock(), events = {}, dom = {}, commands = {}, panels = [], calls = [];
  let fail = false;
  const element = () => ({ setText() {}, setAttribute() {}, addEventListener() {} });
  class Plugin {
    async loadData() { return { auto: true }; }
    addStatusBarItem() { return element(); } addRibbonIcon() {} addSettingTab() {}
    addCommand(command) { commands[command.id] = command; }
    registerEvent() {} registerDomEvent(surface, name, handler) { dom[name] = handler; }
  }
  const host = { Plugin, PluginSettingTab: class {}, SecretComponent: class {}, Platform: { isMobile: true, isIosApp: true }, Notice: class {},
    Modal: class { constructor() { this.titleEl = element(); this.contentEl = { createEl: (_, value) => panels.push(value.text) }; } open() {} }, Setting: class { addButton() { return this; } } };
  const document = { visibilityState: 'visible' };
  const context = vm.createContext({ module: { exports: {} }, window: time, document, require(name) {
    if (name === 'obsidian') return host;
    if (name === './scheduler') return { SyncScheduler: class extends SyncScheduler { constructor(options) { super({ ...options, now: time.now }); } } };
    return require(path.join(__dirname, '..', 'src', name));
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/plugin.js'), 'utf8'), context);
  const p = new context.module.exports();
  p.app = { secretStorage: {}, vault: { adapter: {}, configDir: '.obsidian', on: (event, handler) => { events[event] = handler; } },
    workspace: { onLayoutReady: fn => fn(), getLeavesOfType: () => [] } };
  await p.onload();
  p.getEngine = () => ({ sync: async options => { calls.push(JSON.parse(JSON.stringify(options))); if (fail) throw new Error('offline'); return { uploaded: calls.length === 1 ? 1 : 0, deferredPaths: [], stats: {} }; } });
  await time.tick(1200); assert.equal(calls[0].full, true);
  events.rename({ path: 'new.md' }, 'old.md');
  events.modify({ path: 'new.md' }); events.create({ path: '.obsidian/hidden' }); events.delete({ path: 'removed.md' });
  await time.tick(15000);
  assert.equal(calls[1].full, false); assert.deepEqual(calls[1].dirty, ['new.md', 'old.md', 'removed.md']);
  await commands['sync-deep'].callback(); assert.equal(calls.at(-1).full, true); assert.equal(calls.at(-1).deep, true);
  await commands['sync-now'].callback(); assert.equal(calls.at(-1).full, true);
  fail = true; events.modify({ path: 'retry.md' }); await time.tick(15000); assert.equal(p.lastError, 'offline');
  fail = false; await time.tick(60000); assert.equal(calls.at(-1).full, true); assert.deepEqual(calls.at(-1).dirty, ['retry.md']);
  document.visibilityState = 'hidden'; dom.visibilitychange(); const before = calls.length; await time.tick(600000); assert.equal(calls.length, before);
  document.visibilityState = 'visible'; dom.visibilitychange(); await time.tick(1000); assert.equal(calls.at(-1).full, true);
  events.rename({ path: 'moved-folder', children: [] }, 'old-folder'); await time.tick(15000);
  assert.equal(calls.at(-1).full, true); assert.deepEqual(calls.at(-1).dirty, []);
  p.openStatus(); assert.ok(panels.some(text => text.includes('当前轮询间隔') && text.includes(String(p.scheduler.pollIntervalMs / 1000))));
  p.onunload(); assert.equal(time.pending(), 0);
});

const orphanPath = 'note (sync-conflict Mac abc).md';
function deferredFixture(mobile = true, resultFor = () => ({ deferredPaths: [orphanPath] })) {
  const time = clock(), calls = [];
  const scheduler = new SyncScheduler({ mobile, ...time, active: () => true, enabled: () => true,
    run: async () => {
      const ticket = scheduler.begin(), call = { now: time.now(), full: ticket.full, dirty: ticket.dirty };
      calls.push(call); scheduler.complete(ticket, resultFor(calls.length)); call.poll = scheduler.pollIntervalMs;
    } });
  scheduler.resetPoll(); scheduler.schedule(1200);
  return { scheduler, time, calls };
}

for (const mobile of [true, false]) test(`C1: ${mobile ? 'mobile' : 'desktop'} persistent deferred work takes at most five rounds in ten idle minutes`, async () => {
  const { scheduler, time, calls } = deferredFixture(mobile);
  try { await time.tick(600000); assert.ok(calls.length <= 5, `${calls.length} rounds`); }
  finally { scheduler.stop(); }
});

test('C1: persistent deferred retries are at least sixty seconds apart and back off to three hundred', async () => {
  for (const mobile of [true, false]) {
    const { scheduler, time, calls } = deferredFixture(mobile);
    try {
      await time.tick(600000);
      const gaps = calls.slice(1).map((call, i) => call.now - calls[i].now);
      assert.ok(gaps.every(ms => ms >= 60000), JSON.stringify(gaps));
      assert.deepEqual(calls.map(call => call.poll), [60000,120000,240000,300000]);
      await time.tick(301200); // The ten-minute full deadline precedes the next 300-second poll.
      assert.equal(calls.at(-1).now - calls.at(-2).now, 300000);
    } finally { scheduler.stop(); }
  }
});

test('C1: deferred paths remain visible to the next polling ticket', async () => {
  const { scheduler, time, calls } = deferredFixture();
  try {
    await time.tick(1200);
    scheduler.pause(); scheduler.armPoll();
    await time.tick(scheduler.pollIntervalMs);
    assert.equal(calls.length, 2); assert.deepEqual(calls[1].dirty, [orphanPath]);
  } finally { scheduler.stop(); }
});

test('C1: a file event promotes deferred work and keeps the platform debounce deadline', async () => {
  for (const [mobile, delay] of [[true,15000],[false,5000]]) {
    const { scheduler, time, calls } = deferredFixture(mobile);
    try {
      await time.tick(1200); await time.tick(2000);
      scheduler.change([orphanPath]);
      await time.tick(delay - 1); assert.equal(calls.length, 1);
      await time.tick(1); assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].dirty, [orphanPath]);
    } finally { scheduler.stop(); }
  }
});

test('C1: a newly reported deferred path is retried within sixty seconds', async () => {
  const { scheduler, time, calls } = deferredFixture(true, n => ({ deferredPaths: n === 1 ? [] : [orphanPath] }));
  try {
    await time.tick(121200); assert.equal(calls.length, 2);
    await time.tick(60000);
    assert.ok(calls.length >= 3); assert.ok(calls[2].now - calls[1].now <= 60000);
    assert.deepEqual(calls[2].dirty, [orphanPath]);
  } finally { scheduler.stop(); }
});

test('C1: no-deferred idle polling still follows sixty, one-twenty, two-forty and three-hundred seconds', async () => {
  const { scheduler, time, calls } = deferredFixture(true, n => ({ uploaded: n === 1 ? 1 : 0, deferredPaths: [] }));
  try {
    await time.tick(600000);
    assert.deepEqual(calls.map(call => call.now), [1200,61200,181200,421200]);
    assert.deepEqual(calls.map(call => call.poll), [60000,120000,240000,300000]);
  } finally { scheduler.stop(); }
});

test('C1: deferred set changes reset polling, while order changes alone preserve backoff', () => {
  const { scheduler: s } = deferredFixture();
  try {
    s.complete(s.begin(), { deferredPaths: ['a.md'] }); assert.equal(s.pollIntervalMs, 60000);
    s.complete(s.begin(), { deferredPaths: ['a.md'] }); assert.equal(s.pollIntervalMs, 120000);
    s.complete(s.begin(), { deferredPaths: ['a.md','b.md'] }); assert.equal(s.pollIntervalMs, 60000);
    s.complete(s.begin(), { deferredPaths: ['b.md','a.md'] }); assert.equal(s.pollIntervalMs, 120000);
    s.complete(s.begin(), { deferredPaths: [] }); assert.equal(s.pollIntervalMs, 60000);
  } finally { s.stop(); }
});

test('C1: a newer event during sync gets one debounce retry then returns to polling if still deferred', async () => {
  const { scheduler: s, time, calls } = deferredFixture();
  try {
    s.change([orphanPath]); const ticket = s.begin();
    s.change([orphanPath]); s.complete(ticket, { deferredPaths: [orphanPath] });
    await time.tick(15000); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].dirty, [orphanPath]);
    await time.tick(15000); assert.equal(calls.length, 1, 'the processed event must not stay event-dirty forever');
  } finally { s.stop(); }
});

for (const mobile of [true, false]) test(`C1: real engine keeps an orphan copy safe during ${mobile ? 'mobile' : 'desktop'} polling and uploads after a rename event`, async () => {
  const { Adapter } = require('./helpers/adapter');
  const { MobileVault, MobileState } = require('../src/mobile');
  const { SyncEngine } = require('../src/engine');
  const { bytes } = require('../src/bytes');
  const { EventEmitter } = require('node:events');
  let lists = 0;
  const remote = { blobs: new Map(), revs: new Map(),
    async listRevisions() { lists++; return [...this.revs.values()]; },
    async getBlob(id) { return this.blobs.get(id).slice(); },
    async putBlob(id, value) { this.blobs.set(id, bytes(value).slice()); },
    async putRevision(revision) { this.revs.set(revision.id, revision); } };
  const adapter = new Adapter(), local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test/vault/', 'u');
  const engine = new SyncEngine({ remote, local, state, device: 'test' });
  const original = bytes('orphan copy; keep every byte'); adapter.put(orphanPath, original);
  const time = clock(), calls = [], events = new EventEmitter();
  const s = new SyncScheduler({ mobile, ...time, active: () => true, enabled: () => true,
    run: async () => { const ticket = s.begin(), result = await engine.sync(ticket); calls.push({ now: time.now(), ticket, result }); s.complete(ticket, result); } });
  events.on('rename', (file, previous) => s.change([file.path, previous]));
  s.resetPoll(); s.schedule(1200);
  try {
    await time.tick(600000);
    assert.ok(calls.length <= 5, `${calls.length} rounds`); assert.ok(lists <= 5, `${lists} remote listings`);
    assert.equal(remote.revs.size, 0); assert.equal(remote.blobs.size, 0);
    assert.deepEqual(adapter.files.get(orphanPath), original);
    const previousCalls = calls.length;
    await adapter.rename(orphanPath, 'renamed.md'); events.emit('rename', { path: 'renamed.md' }, orphanPath);
    await time.tick(mobile ? 15000 : 5000);
    assert.ok(calls.length > previousCalls);
    assert.ok(calls[previousCalls].now <= 600000 + (mobile ? 15000 : 5000));
    assert.equal(remote.revs.size, 1); assert.equal([...remote.revs.values()][0].path, 'renamed.md');
    assert.deepEqual([...remote.blobs.values()][0], original);
    assert.deepEqual(calls.at(-1).result.deferredPaths, []);
    assert.equal(adapter.files.has(orphanPath), false); assert.deepEqual(adapter.files.get('renamed.md'), original);
    assert.deepEqual(s.begin().dirty, []);
  } finally { s.stop(); }
});
