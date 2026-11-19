'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DiskVault, DiskState } = require('../src/local');
const { AdaptiveDavRemote } = require('../src/sharded');
const { SyncEngine } = require('../src/engine');
const { Gates } = require('./gates');
const { atomicJson, readJson, safeDirectory, publicText, publicError, publicValue, probeMount } = require('./io');
const { acquireLock } = require('./lock');
const baseStatus = () => ({ state: 'paused', reason: '尚未完成首次同步。', lastSuccess: null, lastResult: null, conflicts: [], needsAttention: {}, pendingDeletions: null });
function requireInstance(config) {
  try {
    safeDirectory(config.stateDir);
    const instance = readJson(path.join(config.stateDir, 'instance.json'));
    if (!/^[0-9a-f-]{36}$/.test(instance.id) || !Number.isFinite(Date.parse(instance.createdAt))) throw new Error();
    return instance;
  } catch { throw new Error('实例未初始化或 instance.json 损坏；首次使用请先运行 init，已有数据请按恢复文档操作。'); }
}
async function init(config, { probeIO = fs } = {}) {
  safeDirectory(config.dataDir, true); safeDirectory(config.stateDir, true); safeDirectory(config.vaultDir, true);
  const release = await acquireLock(config.stateDir);
  try {
    const reserved = n => n === '.run-lock' || n.startsWith('.lock-retired-') || n.startsWith('.l-');
    if (fs.readdirSync(config.stateDir).some(n => !reserved(n))) throw new Error('state/ 已有实例或同步记录；不要重复 init。已有数据请按恢复文档备份后重新初始化。');
    const { scanVault } = require('./gates');
    const snapshot = await scanVault(config.vaultDir);
    if (snapshot.files.length) throw new Error('vault/ 已有笔记；请先移到别处备份，使用空 vault/ 运行 init。');
    probeMount(config.vaultDir, config.stateDir, probeIO);
    const gates = new Gates(config);
    await gates.initializeBaseline();
    atomicJson(path.join(config.stateDir, 'instance.json'), { id: randomUUID(), createdAt: new Date().toISOString() });
  } finally { await release(); }
}
function readStatus(config) {
  try {
    const value = readJson(path.join(config.stateDir, 'status.json'));
    if (!['ok', 'paused', 'error'].includes(value.state)) throw new Error();
    return publicValue(value, config);
  } catch { return { ...baseStatus(), state: 'error', reason: '状态文件尚不存在或已损坏；请检查初始化和运行日志。' }; }
}
function checkHealth(status, now = Date.now()) {
  const last = Date.parse(status.lastSuccess);
  return status.state === 'ok' && Number.isFinite(last) && now >= last && now - last <= 10 * 60 * 1000;
}
class Runner {
  constructor(config, options, release) {
    this.config = config; this.options = options; this.release = release; this.engine = null; this.local = null; this.stopped = false; this.mountIdentity = null;
    this.now = options.now || Date.now; this.logger = options.logger || (line => process.stdout.write(line + '\n'));
    this.status = readStatus(config); this.previousLog = null;
    this.gates = options.gates || new Gates(config, { sleep: options.sleep || (ms => this.wait(ms)), now: this.now });
  }
  stop() { this.stopped = true; this.wake?.(); }
  wait(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => { const timer = setTimeout(done, ms); const self = this; function done() { clearTimeout(timer); self.wake = null; resolve(); } this.wake = done; });
  }
  log(text) { this.logger(new Date(this.now()).toISOString() + ' ' + publicText(text, this.config)); }
  async persist(status) {
    status = publicValue(status, this.config);
    atomicJson(path.join(this.config.stateDir, 'status.json'), status);
    // A missing/unreadable/moved vault must remain untouched. Never recreate it.
    try { safeDirectory(this.config.vaultDir); atomicJson(path.join(this.config.vaultDir, '.sync-status.json'), status, true); }
    catch (e) { if (status.state === 'ok') throw new Error('无法写入 vault/.sync-status.json，请检查挂载和权限。'); }
    const pending = status.pendingDeletions;
    const key = JSON.stringify([status.state, status.reason, pending, status.conflicts]);
    if (status.state !== 'ok') {
      if (key !== this.previousLog) {
        this.log(status.reason);
        if (pending) this.log('待批准删除：' + (pending.allPaths || pending.paths).join('、'));
      }
    }
    else {
      if (this.previousLog && this.status.state !== 'ok') this.log('同步已恢复。');
      const r = status.lastResult;
      const transferred = r && (r.uploaded || r.downloaded || r.deleted);
      if (transferred) this.log(`同步完成：上传 ${r.uploaded}，下载 ${r.downloaded}，删除 ${r.deleted}；冲突 ${status.conflicts.length}。`);
      if (status.conflicts.length && key !== this.previousLog && (transferred || this.previousLog)) this.log('冲突：' + status.conflicts.join('、'));
    }
    this.previousLog = key; this.status = status; return status;
  }
  verifyMount() {
    safeDirectory(this.config.vaultDir);
    const vaultStat = fs.statSync(this.config.vaultDir), stateStat = fs.statSync(this.config.stateDir);
    const identity = JSON.stringify([vaultStat.dev, vaultStat.ino, stateStat.dev, stateStat.ino]);
    if (identity !== this.mountIdentity) {
      probeMount(this.config.vaultDir, this.config.stateDir, this.options.probeIO || fs);
      this.mountIdentity = identity;
    }
  }
  recoverLocalTransaction() {
    if (!fs.existsSync(path.join(this.config.stateDir, 'file-transaction'))) return;
    // Finish only a previously journaled local operation, using DiskVault's
    // unchanged recovery procedure. There is no remote access or new sync here.
    // Otherwise an interrupted replacement of the final note looks like a
    // wiped vault and the deletion gate could prevent recovery indefinitely.
    try { safeDirectory(this.config.vaultDir); fs.accessSync(this.config.vaultDir, fs.constants.R_OK | fs.constants.X_OK); }
    catch { return; } // let the gate report a missing or unreadable vault
    this.verifyMount();
    this.local ||= new DiskVault(this.config.vaultDir, '.obsidian', () => !this.stopped, { privateDir: this.config.stateDir });
    this.local.recover();
  }
  async round() {
    if (this.stopped) return this.status;
    try {
      this.recoverLocalTransaction();
      const gate = await this.gates.check();
      if (this.stopped) return this.status;
      if (!gate.ok) return await this.persist({ ...this.status, state: 'paused', reason: gate.reason, pendingDeletions: gate.pendingDeletions || null });
      this.verifyMount();
      if (!this.engine) {
        // Delay constructing DiskVault until the gates establish a usable vault.
        const local = this.local ||= new DiskVault(this.config.vaultDir, '.obsidian', () => !this.stopped, { privateDir: this.config.stateDir });
        const remote = new AdaptiveDavRemote(this.config);
        const state = new DiskState(this.config.stateDir, this.config.url, this.config.username);
        this.engine = this.options.engineFactory ? this.options.engineFactory({ local, remote, state, device: this.config.device }) : new SyncEngine({ local, remote, state, device: this.config.device });
      }
      const result = await this.engine.sync({ full: true });
      await this.gates.saveBaselineAfterSuccess();
      const needsAttention = Object.fromEntries(Object.entries(result.confirmations || {}).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]));
      return await this.persist({ state: 'ok', reason: Object.values(needsAttention).some(Boolean) ? '有待确认项目，请在 Mac 或手机的插件里处理。' : '', lastSuccess: new Date(this.now()).toISOString(), lastResult: { uploaded: result.uploaded || 0, downloaded: result.downloaded || 0, deleted: result.deleted || 0 }, conflicts: result.conflictPaths || [], needsAttention, pendingDeletions: null });
    } catch (error) {
      return this.persist({ ...this.status, state: 'error', reason: '同步出错：' + publicError(error.message, this.config), pendingDeletions: null });
    }
  }
  async close() { this.stop(); await this.release(); }
}
async function createRunner(config, options = {}) {
  requireInstance(config);
  const release = await acquireLock(config.stateDir);
  try {
    // Missing vaults pause at the gate and may recover without restart. For an
    // existing vault, verify real hardlink/rename support on every startup.
    if (fs.existsSync(config.vaultDir)) { safeDirectory(config.vaultDir); probeMount(config.vaultDir, config.stateDir, options.probeIO || fs); }
    return new Runner(config, options, release);
  } catch (error) { await release(); throw error; }
}
async function run(config, options = {}) {
  const runner = await createRunner(config, options);
  const proc = options.process || process; let killTimer;
  const stop = () => { runner.stop(); if (!killTimer) killTimer = setTimeout(() => proc.exit(1), 8000); };
  proc.on('SIGTERM', stop); proc.on('SIGINT', stop);
  let failures = 0;
  try {
    do {
      const status = await runner.round();
      if (options.once) return status.state === 'ok' ? 0 : status.state === 'paused' ? 2 : 1;
      failures = status.state === 'error' ? failures + 1 : 0;
      const delay = status.state === 'error' ? Math.min(config.intervalSeconds * 1000 * 2 ** Math.min(failures - 1, 20), 300000) : config.intervalSeconds * 1000;
      if (!runner.stopped) await (options.sleep || (ms => runner.wait(ms)))(delay);
    } while (!runner.stopped);
    return 0;
  } finally { try { await runner.close(); } finally { clearTimeout(killTimer); proc.off('SIGTERM', stop); proc.off('SIGINT', stop); } }
}
async function approve(config, count, options = {}) { requireInstance(config); return new Gates(config, options).approve(count); }
module.exports = { init, requireInstance, createRunner, run, readStatus, checkHealth, approve, Runner };
