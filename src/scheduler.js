'use strict';
const BASE_POLL = 60_000, MAX_POLL = 300_000, FULL_INTERVAL = 600_000;

// Scheduling and dirty generations are separate from the sync engine. An event
// arriving after begin() must remain queued even when it names the same file.
class SyncScheduler {
  constructor({ mobile, now = () => Date.now(), setTimeout, clearTimeout, run, enabled, active }) {
    this.now = now; this.setTimeout = setTimeout; this.clearTimeout = clearTimeout;
    this.retryAt = null;
    this.run = run; this.enabled = enabled; this.active = active;
    this.debounceMs = mobile ? 15_000 : 5_000;
    this.pollIntervalMs = BASE_POLL;
    this.dirty = new Map(); this.eventDirty = new Set(); this.deferredPaths = new Set();
    this.generation = 0; this.activity = 0;
    this.fullRequested = 1; this.fullCompleted = 0; this.lastFullAt = null;
    this.running = false; this.stopped = false;
  }
  allowed() { return !this.stopped && this.enabled() && this.active(); }
  pause() {
    this.clearTimeout(this.changeTimer); this.clearTimeout(this.pollTimer);
    this.changeTimer = null; this.pollTimer = null;
  }
  stop() { this.stopped = true; this.pause(); }
  reset() {
    this.pause(); this.fullRequested++; this.lastFullAt = null;
    this.pollIntervalMs = BASE_POLL; this.activity++;
  }
  resetPoll() { this.retryAt = null; this.pollIntervalMs = BASE_POLL; this.armPoll(); }
  change(paths, { full = false } = {}) {
    if (full) this.fullRequested++;
    for (const path of paths) { this.dirty.set(path, ++this.generation); this.eventDirty.add(path); }
    this.activity++; this.pollIntervalMs = BASE_POLL;
    // An event may pull an armed poll forward to 60 s, but must never push it back.
    if (this.pollTimer == null || this.pollDueAt > this.now() + BASE_POLL) this.armPoll();
    this.schedule();
  }
  foreground() {
    this.fullRequested++; this.activity++; this.resetPoll(); this.schedule(1000);
  }
  schedule(delay = this.debounceMs) {
    this.clearTimeout(this.changeTimer); this.changeTimer = null;
    delay = Math.max(delay, (this.retryAt ?? 0) - this.now());
    this.dirtyDeadline = this.now() + delay;
    if (!this.allowed() || this.running) return;
    this.changeTimer = this.setTimeout(async () => {
      this.changeTimer = null;
      await this.dispatch();
    }, delay);
  }
  armPoll() {
    this.clearTimeout(this.pollTimer); this.pollTimer = null;
    if (!this.allowed() || this.running) return;
    const untilFull = this.lastFullAt === null ? this.pollIntervalMs : Math.max(0, this.lastFullAt + FULL_INTERVAL - this.now());
    const delay = Math.max(1000, Math.min(this.pollIntervalMs, untilFull), (this.retryAt ?? this.now()) - this.now());
    this.pollDueAt = this.now() + delay;
    this.pollTimer = this.setTimeout(async () => {
      this.pollTimer = null;
      await this.dispatch();
    }, delay);
  }
  async dispatch() {
    if (!this.allowed()) return;
    try { await this.run(); }
    finally { if (!this.running) this.armPoll(); }
  }
  begin({ manual = false, deep = false, resolve = false } = {}) {
    this.pause(); this.running = true; this.retryAt = null;
    return { full: manual || deep || resolve || this.lastFullAt === null || this.fullRequested > this.fullCompleted || this.now() - this.lastFullAt >= FULL_INTERVAL,
      dirty: [...this.dirty.keys()], deep, entries: new Map(this.dirty), fullRequested: this.fullRequested, activity: this.activity };
  }
  complete(ticket, result) {
    const deferred = new Set(result.deferredPaths || []);
    for (const [path, generation] of ticket.entries) {
      if (this.dirty.get(path) === generation) {
        // This event was observed by the completed round. A deferred result keeps
        // the path for polling, but only a newer event may request a debounce.
        this.eventDirty.delete(path);
        if (!deferred.has(path)) this.dirty.delete(path);
      }
    }
    for (const path of deferred) if (!this.dirty.has(path)) this.dirty.set(path, ++this.generation);
    if (ticket.full) { this.lastFullAt = this.now(); this.fullCompleted = Math.max(this.fullCompleted, ticket.fullRequested); }
    const newerActivity = this.activity !== ticket.activity;
    const deferredChanged = deferred.size !== this.deferredPaths.size || [...deferred].some(path => !this.deferredPaths.has(path));
    this.deferredPaths = deferred;
    this.pollIntervalMs = result.uploaded || result.downloaded || result.deleted || newerActivity || deferredChanged ? BASE_POLL : Math.min(MAX_POLL, this.pollIntervalMs * 2);
    this.running = false;
    this.armPoll();
    if (this.fullRequested > this.fullCompleted) this.schedule(1000);
    else if (this.eventDirty.size) this.schedule(newerActivity ? Math.max(0, (this.dirtyDeadline ?? this.now() + this.debounceMs) - this.now()) : this.debounceMs);
  }
  fail() {
    this.running = false; this.fullRequested++; this.pollIntervalMs = BASE_POLL; this.retryAt = this.now() + BASE_POLL;
    this.pause(); this.armPoll();
  }
}
module.exports = { SyncScheduler };
