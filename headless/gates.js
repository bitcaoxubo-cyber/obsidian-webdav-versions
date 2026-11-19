'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { safePath } = require('../src/protocol');
const { Recovery, validateCheckpoint } = require('./recovery');

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = name => /\(sync-conflict/iu.test(name);
const folded = name => name.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');

class ScanUnavailable extends Error {}

// This scan observes metadata only. It never creates, renames or deletes notes.
// Keep raw spellings so Unicode-equivalent names can be diagnosed before the
// engine normalizes them. Like DiskVault, do not follow symbolic links.
function scanVault(vaultDir) {
  const files = [], directories = [];
  function visit(base, prefix) {
    const root = fs.lstatSync(base);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('directory');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = prefix + entry.name;
      const absolute = path.join(base, entry.name);
      if (entry.isDirectory()) {
        directories.push(name);
        visit(absolute, name + '/');
      } else if (entry.isFile()) {
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('changed');
        files.push({ path: name, size: stat.size, mtimeMs: stat.mtimeMs });
      } else {
        throw new ScanUnavailable('文件夹中有特殊文件，请先移出同步范围：' + name);
      }
    }
  }
  try { visit(vaultDir, ''); }
  catch (error) {
    if (error instanceof ScanUnavailable) throw error;
    throw new ScanUnavailable('笔记文件夹不存在、不可读或扫描时发生变化；请检查数据挂载和文件权限');
  }
  files.sort((a, b) => compare(a.path, b.path));
  directories.sort(compare);
  return { files, directories };
}

function validateNames(snapshot) {
  const issues = [], used = new Map();
  const paths = [...snapshot.directories, ...snapshot.files.map(file => file.path)].sort(compare);
  // List an NFC name as the reference when two spellings collide, even if
  // its decomposed spelling sorts first on a byte-oriented filesystem.
  for (const name of paths) {
    if (conflict(name) || name !== name.normalize('NFC')) continue;
    const key = folded(name);
    if (!used.has(key)) used.set(key, name);
  }
  for (const name of paths) {
    const problems = [];
    if (name !== name.normalize('NFC')) problems.push('名字不是规范合成形式，请用规范形式重新命名');
    if (conflict(name)) {
      if (problems.length) issues.push({ path: name, problem: problems[0] });
      continue;
    }
    try { safePath(name); }
    catch {
      if (name.includes('\\')) problems.push('名字含反斜杠');
      else if (/^[A-Za-z]:/u.test(name)) problems.push('顶层名字不能以字母加冒号开头');
      else if (name.split('/').some(part => /[. ]$/u.test(part))) problems.push('名字不能以点或空格结尾');
      else problems.push('路径不符合安全规则（控制字符、长度或路径片段）');
    }
    if (/[*"<>:|?]/u.test(name)) problems.push('名字含不兼容的字符：* " < > : | ?');
    const key = folded(name);
    const previous = used.get(key);
    if (previous !== undefined && previous !== name) problems.push('与 ' + previous + ' 仅大小写或 Unicode 组合形式不同');
    else used.set(key, name);
    if (problems.length) issues.push({ path: name, problem: problems.join('；') });
  }
  return issues;
}

// A newly appearing path may offset only one missing path, and only with the
// same size AND modification time. Existing paths cannot act as rename credits.
function missingFiles(previous, current) {
  const before = new Set(previous.map(file => file.path));
  const after = new Set(current.map(file => file.path));
  const credits = new Map();
  const metadata = file => JSON.stringify([file.size, file.mtimeMs]);
  for (const file of current) {
    if (before.has(file.path)) continue;
    const key = metadata(file);
    credits.set(key, (credits.get(key) || 0) + 1);
  }
  const missing = [];
  for (const file of [...previous].sort((a, b) => compare(a.path, b.path))) {
    if (after.has(file.path)) continue;
    // Bindings learned from a receipt have no filesystem metadata to match.
    const key = metadata(file), available = file.size === undefined ? 0 : credits.get(key) || 0;
    if (available) credits.set(key, available - 1);
    else missing.push(file.path);
  }
  return missing;
}

function atomicJson(file, value) {
  const directory = path.dirname(file), temporary = path.join(directory, '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function validFiles(files) {
  return Array.isArray(files) && files.every((file, index) =>
    file && typeof file.path === 'string' && file.path.length &&
    Number.isSafeInteger(file.size) && file.size >= 0 && Number.isFinite(file.mtimeMs) &&
    (index === 0 || compare(files[index - 1].path, file.path) < 0));
}

class Gates {
  constructor(config, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, scanVault: scan = scanVault } = {}) {
    this.config = config;
    this.sleep = sleep;
    this.now = now;
    this.scan = scan;
    this.recovery = config.url && config.username ? new Recovery(config) : null;
    this.baselineFile = path.join(config.stateDir, 'baseline.json');
    this.approvalFile = path.join(config.stateDir, 'deletion-approval.json');
    this.unstableSince = null;
  }

  initializeBaseline() {
    if (fs.existsSync(this.baselineFile)) throw new Error('删除保护清单已经存在；请勿重复初始化');
    this.writeBaseline([]);
  }

  writeBaseline(files, checkpoint = null) {
    atomicJson(this.baselineFile, { version: 1, files, checkpoint, checksum: digest({ files, checkpoint }) });
  }

  readBaseline() {
    try {
      const row = JSON.parse(fs.readFileSync(this.baselineFile, 'utf8'));
      if (row.version !== 1 || !validFiles(row.files) || !Object.hasOwn(row, 'checkpoint') || !validateCheckpoint(row.checkpoint) || row.checksum !== digest({ files: row.files, checkpoint: row.checkpoint })) throw new Error('invalid');
      return row;
    } catch {
      throw new Error('删除保护清单缺失或损坏；请停止容器并按文档恢复同步记录');
    }
  }

  // A rename claims the approval before reading it. A concurrent explicit
  // approve command may create a NEW approval; we never unlink that newer file.
  // A crashed process leaves only an unrecognized private claim, never reusable
  // approval. An approval is spent before invoking the engine, even on failure.
  consumeApproval() {
    const claim = path.join(this.config.stateDir, '.approval-' + randomUUID() + '.claimed');
    try { fs.renameSync(this.approvalFile, claim); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try { return JSON.parse(fs.readFileSync(claim, 'utf8')); }
    catch { return null; }
    finally { fs.rmSync(claim, { force: true }); }
  }

  async stableScan() {
    try {
      const first = this.scan(this.config.vaultDir);
      await this.sleep(this.config.settleSeconds * 1000);
      const second = this.scan(this.config.vaultDir);
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        if (this.unstableSince === null) this.unstableSince = this.now();
        const prolonged = this.now() - this.unstableSince >= 10 * 60 * 1000;
        return { ok: false, reason: prolonged ? '文件夹一直在变化（已超过 10 分钟）；等待操作完成后自动恢复' : '文件夹正在变化；等待文件稳定后自动恢复', pendingDeletions: null };
      }
      this.unstableSince = null;
      return { ok: true, snapshot: second };
    } catch (error) {
      if (!(error instanceof ScanUnavailable)) throw error;
      return { ok: false, reason: error.message, pendingDeletions: null };
    }
  }

  async deletionState(baseline, snapshot) {
    const records = this.recovery ? await this.recovery.read(baseline.checkpoint?.receiptSequence ?? 0) : null;
    const applied = this.recovery ? await this.recovery.deletedSince(baseline.checkpoint, records) : new Set();
    const current = snapshot.files.map(file => ({ ...file, path: file.path.normalize('NFC') }));
    const present = new Set(current.map(file => file.path));
    const expected = new Map();
    for (const file of baseline.files) {
      const name = file.path.normalize('NFC');
      expected.set(name, { ...file, path: name });
    }
    const addBinding = name => { if (!expected.has(name)) expected.set(name, { path: name }); };
    for (const name of records?.bound.keys() || []) addBinding(name);
    const pending = records?.pending;
    if (pending?.kind === 'apply' && pending.next && present.has(pending.physical.normalize('NFC'))) {
      // A download landed before its receipt. Even an exact size/mtime match
      // cannot make its new physical path a credit for an external move.
      addBinding(pending.physical.normalize('NFC'));
    }
    if (pending?.kind === 'push' && !records.completed.has(pending.operationId)) {
      // Recovery will bind a staged content upload before capture. A pending
      // deletion also needs a fresh gate decision for its original physical name.
      const name = pending.physical.normalize('NFC');
      addBinding(name);
      applied.delete(name);
    }
    const protectedFiles = [...expected.values()].filter(file => present.has(file.path) || !applied.has(file.path));
    // Include matched moves in the set of accounted-for missing physical paths.
    // Only their net count is discounted by the existing move rule.
    const allowed = new Set(protectedFiles.filter(file => !present.has(file.path)).map(file => file.path));
    const paths = missingFiles(protectedFiles, current);
    const maskedWipe = pending?.kind === 'apply' && pending.checkMaskedWipe === true && pending.next &&
      !records.completed.has(pending.operationId) && current.length === 1 && current[0].path === pending.physical.normalize('NFC');
    const empty = paths.length > 0 && (current.length === 0 || Boolean(maskedWipe));
    return { paths, allowed, records, empty, maskedWipe, blocked: paths.length > this.config.deletionLimit || empty,
      checksum: digest(paths), baselineChecksum: baseline.checksum };
  }

  async check() {
    const stable = await this.stableScan();
    if (!stable.ok) { this.consumeApproval(); return stable; }
    const baseline = this.readBaseline();
    const deletion = await this.deletionState(baseline, stable.snapshot);
    const approval = this.consumeApproval();
    const issues = validateNames(stable.snapshot);
    if (issues.length) {
      return { ok: false, reason: '文件名需要修改：' + issues.slice(0, 20).map(issue => issue.path + '（' + issue.problem + '）').join('；') + (issues.length > 20 ? '；其余 ' + (issues.length - 20) + ' 项未显示' : ''), pendingDeletions: null, snapshot: stable.snapshot };
    }
    const approved = approval && approval.version === 1 && approval.count === deletion.paths.length &&
      approval.checksum === deletion.checksum && approval.baselineChecksum === deletion.baselineChecksum;
    if (deletion.blocked && !approved) {
      return { ok: false, reason: (deletion.maskedWipe ? '同步中的旧文件已全部消失，当前仅有新下载的文件' : deletion.empty ? '笔记文件夹已全空' : '消失的文件超过删除上限') + '：共 ' + deletion.paths.length + ' 个；请恢复文件，或在 NAS 上批准这组删除',
        pendingDeletions: { count: deletion.paths.length, paths: deletion.paths.slice(0, 20),
          ...(deletion.paths.length > 20 && { allPaths: deletion.paths }) }, snapshot: stable.snapshot };
    }
    return { ok: true, reason: '', pendingDeletions: null, snapshot: stable.snapshot, allowed: deletion.allowed, records: deletion.records };
  }

  async saveBaselineAfterSuccess() {
    const checkpoint = this.recovery ? await this.recovery.checkpoint() : null;
    const snapshot = this.scan(this.config.vaultDir);
    const after = this.recovery ? await this.recovery.checkpoint() : null;
    if (JSON.stringify(checkpoint) !== JSON.stringify(after)) throw new Error('同步恢复记录在保存删除清单时变化；请重试');
    this.writeBaseline(snapshot.files, checkpoint);
    return snapshot;
  }

  async approve(count) {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('批准数量必须是大于零的整数');
    const baseline = this.readBaseline();
    const stable = await this.stableScan();
    if (!stable.ok) throw new Error(stable.reason);
    if (validateNames(stable.snapshot).length) throw new Error('请先修正文件名问题，再批准删除');
    // The running instance may have completed a sync during the settle wait.
    const latest = this.readBaseline();
    if (latest.checksum !== baseline.checksum) throw new Error('同步清单已经变化；请重新检查状态后批准');
    const deletion = await this.deletionState(baseline, stable.snapshot);
    if (count !== deletion.paths.length) throw new Error('批准数量不匹配：当前消失 ' + deletion.paths.length + ' 个文件');
    if (!deletion.blocked) throw new Error('当前删除未触发闸门，无需批准');
    atomicJson(this.approvalFile, { version: 1, count, checksum: deletion.checksum, baselineChecksum: deletion.baselineChecksum, nonce: randomUUID(), createdAt: new Date(this.now()).toISOString() });
    return { count, paths: deletion.paths.slice(0, 20) };
  }
}

module.exports = { Gates, scanVault, validateNames, missingFiles, ScanUnavailable };
