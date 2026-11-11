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
