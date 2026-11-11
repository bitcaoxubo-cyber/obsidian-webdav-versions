'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncScheduler } = require('../src/scheduler');
const STARTUP = 1200, WRITING_START = 10000, OFFLINE_START = 100000;
const DRAFT = 'draft.md', ORPHAN = 'note (sync-conflict Mac abc).md';

function fakeClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    at(at, fn) { assert.ok(at >= now); return clock.setTimeout(fn, at - now); },
    async runTo(target) {
      assert.ok(target >= now);
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; await next[1].fn();
      }
      now = target;
    },
  };
  return clock;
}
function fixture(t, mobile, { deferred = false, firstDownload = false } = {}) {
  const clock = fakeClock(), runs = [];
  let offline = false;
  const scheduler = new SyncScheduler({ mobile, ...clock, enabled: () => true, active: () => true,
    run: async () => {
      const ticket = scheduler.begin();
      const uploaded = !offline && ticket.dirty.includes(DRAFT) ? 1 : 0;
      const run = { at: clock.now(), dirty: ticket.dirty, full: ticket.full, failed: offline, uploaded };
      runs.push(run);
      if (offline) scheduler.fail(ticket);
      else scheduler.complete(ticket, { uploaded, downloaded: firstDownload && runs.length === 1 ? 1 : 0,
        deleted: 0, deferredPaths: deferred ? [ORPHAN] : [] });
      run.poll = scheduler.pollIntervalMs;
    } });
  scheduler.resetPoll(); scheduler.schedule(STARTUP);
  t.after(() => scheduler.stop());
  return { clock, scheduler, runs, setOffline: value => { offline = value; } };
}
function editing(f, every, start, end) {
  for (let at = start; at <= end; at += every) f.clock.at(at, () => f.scheduler.change([DRAFT]));
}
const gaps = rows => rows.slice(1).map((row, i) => row.at - rows[i].at);
function measurement(t, scenario, mobile, rows, extra = {}) {
  t.diagnostic('D1-measurement ' + JSON.stringify({ scenario, platform: mobile ? 'mobile' : 'desktop',
    count: rows.length, at: rows.map(row => row.at), gaps: gaps(rows), ...extra }));
}
async function offlineSession(t, mobile, every) {
  const f = fixture(t, mobile);
  f.clock.at(OFFLINE_START, () => f.setOffline(true));
  if (every) editing(f, every, OFFLINE_START, OFFLINE_START + 600000);
  await f.clock.runTo(OFFLINE_START + 600000);
  return { ...f, failures: f.runs.filter(run => run.failed && run.at >= OFFLINE_START) };
}

for (const mobile of [true, false]) {
  const platform = mobile ? 'mobile' : 'desktop';
  const debounce = mobile ? 15000 : 5000;

  // Section 4.1: these six scenarios must fail on fd67f26.
  for (const [scenario, every] of [['two-second writing', 2000], ['writing just inside debounce', mobile ? 14000 : 4000]]) {
    test(`D1: ${platform} ${scenario} uploads within sixty-one seconds throughout twenty minutes`, async t => {
      const f = fixture(t, mobile), end = WRITING_START + 1200000;
      editing(f, every, WRITING_START, end);
      await f.clock.runTo(end + 120000);
      const during = f.runs.filter(run => run.at > WRITING_START && run.at <= end);
      // Only a completed round that actually carried the edited path counts as an upload.
      const uploads = during.filter(run => run.uploaded && run.dirty.includes(DRAFT));
      const firstUpload = uploads[0]?.at - WRITING_START;
      measurement(t, scenario, mobile, during, { firstUpload, uploadCount: uploads.length });
      assert.ok(uploads.length > 0, 'editing must eventually reach a completed upload');
      assert.ok(firstUpload <= 61000, `first upload after ${firstUpload} ms`);
      assert.ok(during.length >= 19 && during.length <= 21, `${during.length} writing rounds`);
      assert.equal(uploads.length, during.length, 'idle rounds must not stand in for uploaded edits');
      assert.ok(gaps(during).every(ms => ms <= 61000), JSON.stringify(gaps(during)));
    });
  }

  test(`D1: ${platform} three-second writing with persistent deferred work keeps sixty-second cadence`, async t => {
    const f = fixture(t, mobile, { deferred: true }), end = WRITING_START + 600000;
    editing(f, 3000, WRITING_START, end);
    await f.clock.runTo(end);
    const during = f.runs.filter(run => run.at > WRITING_START && run.at <= end);
    measurement(t, 'writing with deferred work', mobile, during);
    assert.ok(during.length >= 10 && during.length <= 11, `${during.length} writing rounds`);
    assert.ok(gaps(during).every(ms => ms >= 60000), JSON.stringify(gaps(during)));
    assert.ok(during.every(run => run.dirty.includes(DRAFT) && run.dirty.includes(ORPHAN) && run.uploaded === 1));
  });

  for (const every of [2000, 20000]) test(`D1: ${platform} offline events every ${every / 1000} seconds cannot bypass retry waiting`, async t => {
    const f = await offlineSession(t, mobile, every);
    measurement(t, `offline with ${every / 1000}-second events`, mobile, f.failures, { firstAttempt: f.failures[0]?.at - OFFLINE_START });
    assert.ok(f.failures.length > 0 && f.failures.length <= 11, `${f.failures.length} failed attempts`);
    assert.ok(gaps(f.failures).every(ms => ms >= 60000), JSON.stringify(gaps(f.failures)));
  });

  test(`D1: ${platform} an event after failure cannot retry before the full sixty-second wait`, async t => {
    const f = fixture(t, mobile);
    f.clock.at(OFFLINE_START, () => f.setOffline(true));
    await f.clock.runTo(121200);
    const first = f.runs.filter(run => run.failed);
    assert.equal(first.length, 1);
    const failedAt = first[0].at;
    await f.clock.runTo(failedAt + 1000); f.scheduler.change([DRAFT]);
    await f.clock.runTo(failedAt + 59999);
    const beforeDeadline = f.runs.filter(run => run.failed);
    measurement(t, 'one event during retry wait', mobile, beforeDeadline, { retryDeadline: failedAt + 60000 });
    assert.equal(beforeDeadline.length, 1, 'a file event must not cancel retryAt');
    await f.clock.runTo(failedAt + 60000);
    assert.equal(f.runs.filter(run => run.failed).length, 2);
    assert.equal(f.runs.at(-1).at, failedAt + 60000);
    assert.ok(f.runs.at(-1).dirty.includes(DRAFT));
  });

  // Section 4.2: these six scenarios must already pass on fd67f26.
  test(`D1: ${platform} one edit after idle backoff keeps debounce and then a sixty-second poll`, async t => {
    const f = fixture(t, mobile);
    await f.clock.runTo(400000);
    assert.equal(f.scheduler.pollIntervalMs, 300000);
    const eventAt = f.clock.now(); f.scheduler.change([DRAFT]);
    await f.clock.runTo(eventAt + debounce - 1);
    assert.equal(f.runs.filter(run => run.uploaded).length, 0);
    await f.clock.runTo(eventAt + debounce);
    const upload = f.runs.at(-1);
    assert.equal(upload.uploaded, 1); assert.ok(upload.dirty.includes(DRAFT));
    assert.equal(upload.at, eventAt + debounce);
    const count = f.runs.length;
    await f.clock.runTo(upload.at + 59999); assert.equal(f.runs.length, count);
    await f.clock.runTo(upload.at + 60000); assert.equal(f.runs.length, count + 1);
    assert.equal(f.runs.at(-1).at, upload.at + 60000);
    measurement(t, 'one edit after idle backoff', mobile, f.runs.filter(run => run.at >= eventAt));
  });

  test(`D1: ${platform} thirty seconds of editing followed by silence uploads once after debounce`, async t => {
    const f = fixture(t, mobile), lastEdit = WRITING_START + 30000;
    editing(f, 2000, WRITING_START, lastEdit);
    await f.clock.runTo(lastEdit + debounce - 1);
    assert.equal(f.runs.filter(run => run.uploaded).length, 0);
    await f.clock.runTo(lastEdit + debounce);
    let uploads = f.runs.filter(run => run.uploaded);
    assert.equal(uploads.length, 1); assert.ok(uploads[0].dirty.includes(DRAFT));
    assert.equal(uploads[0].at, lastEdit + debounce);
    await f.clock.runTo(lastEdit + debounce + 60000);
    uploads = f.runs.filter(run => run.uploaded);
    assert.equal(uploads.length, 1);
    measurement(t, 'thirty-second editing burst', mobile, uploads);
  });

  test(`D1: ${platform} offline without events retries exactly ten times sixty seconds apart`, async t => {
    const f = await offlineSession(t, mobile, 0);
    measurement(t, 'offline without events', mobile, f.failures);
    assert.equal(f.failures.length, 10);
    assert.ok(gaps(f.failures).every(ms => ms === 60000), JSON.stringify(gaps(f.failures)));
  });

  test(`D1: ${platform} online and foreground recovery remain exempt from the failed-round wait`, async t => {
    for (const trigger of ['online', 'foreground']) {
      const f = fixture(t, mobile);
      f.clock.at(OFFLINE_START, () => f.setOffline(true));
      await f.clock.runTo(121200);
      assert.equal(f.runs.filter(run => run.failed).length, 1);
      await f.clock.runTo(122200); f.setOffline(false);
      const recoveryAt = f.clock.now(), before = f.runs.length;
      if (trigger === 'online') { f.scheduler.resetPoll(); f.scheduler.schedule(1000); }
      else f.scheduler.foreground();
      await f.clock.runTo(recoveryAt + 1000);
      assert.equal(f.runs.length, before + 1);
      assert.equal(f.runs.at(-1).failed, false);
      assert.ok(f.runs.at(-1).at <= recoveryAt + 1000);
      measurement(t, trigger + ' recovery', mobile, f.runs.slice(before));
    }
  });

  test(`D1: ${platform} no-event idle backoff remains sixty one-twenty two-forty three-hundred seconds`, async t => {
    // A startup download establishes the 60-second active interval, then no work remains.
    const f = fixture(t, mobile, { firstDownload: true });
    await f.clock.runTo(600000);
    assert.deepEqual(f.runs.map(run => run.poll), [60000, 120000, 240000, 300000]);
    assert.deepEqual(gaps(f.runs), [60000, 120000, 240000]);
    assert.ok(f.runs.every(run => run.uploaded === 0 && !run.dirty.includes(DRAFT)));
    measurement(t, 'no-event idle backoff', mobile, f.runs);
  });

  test(`D1: ${platform} persistent deferred idle work retains C1 polling backoff`, async t => {
    const f = fixture(t, mobile, { deferred: true });
    await f.clock.runTo(600000);
    measurement(t, 'persistent deferred idle work', mobile, f.runs);
    assert.ok(f.runs.length >= 4 && f.runs.length <= 5, `${f.runs.length} deferred rounds`);
    assert.deepEqual(gaps(f.runs).slice(0, 3), [60000, 120000, 240000]);
    assert.ok(f.runs.slice(1).every(run => run.dirty.includes(ORPHAN)));
    assert.ok(f.runs.every(run => run.uploaded === 0));
  });
}
