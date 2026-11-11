'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = (bytes, stats) => {
  if (stats) stats.hashBytes += typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
  return createHash('sha256').update(bytes).digest('hex');
};

function validateRelative(name) {
  if (typeof name !== 'string' || name.includes('\\') || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f]/.test(name) ||
      name.split('/').some(p => !p || p.startsWith('.'))) {
    throw new Error('拒绝不安全的笔记路径');
  }
}

function safeDir(dir, create = false) {
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('路径不是普通文件夹：' + path.basename(dir));
}

function statMaybe(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(file, bytes) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + randomUUID() + '.tmp');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); syncDir(dir); }
  finally { fs.rmSync(tmp, { force: true }); }
}

function readBytes(file, limit = Infinity) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('目标不是普通文件：' + path.basename(file));
    if (stat.size > limit) throw new Error('文件超过 512 MiB：' + path.basename(file));
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}


function receiptSequence(name) {
  const match = /^receipt-(\d{16})\.json$/.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) throw new Error('完成日志文件名无效；已停止同步。');
  return Number(match[1]);
}
function checkReceiptWatermark(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('完成日志检查点水位无效；已停止同步。');
}

class DiskState {
  constructor(directory, url, user) {
    // Bind sync ancestry to both the collection and the account.
    const key = hash(JSON.stringify([new URL(url).href.replace(/\/+$/, ''), user]));
    this.file = path.join(directory, 'state-' + key + '.json');
    this.pendingFile = path.join(directory, 'pending-' + key + '.json');
    this.receiptDirectory = path.join(directory, 'completed-' + key);
    this.receiptSequence = undefined;
    this.receiptFloor = 0;
    this.staging = path.join(directory, 'outbox-' + key);
  }
  async load() {
    const data = readBytes(this.file);
    return data === null ? null : JSON.parse(data.toString('utf8'));
  }
  async save(value) { atomicWrite(this.file, JSON.stringify(value)); }
  async loadPending() {
    const data = readBytes(this.pendingFile);
    if (data === null) return null;
    try {
      const row = JSON.parse(data.toString('utf8'));
      if (row.version !== 1 || typeof row.payload !== 'string' || hash(row.payload, this.stats) !== row.hash) throw new Error('checksum');
      const pending = JSON.parse(row.payload);
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('payload');
      return pending;
    } catch { throw new Error('同步待处理日志损坏；已停止同步。'); }
  }
  async savePending(value) {
    const previous = await this.loadPending();
    const payload = JSON.stringify(value);
    if (previous !== null) {
      if (JSON.stringify(previous) !== payload) throw new Error('仍有未完成的同步日志；请先恢复。');
      return;
    }
    atomicWrite(this.pendingFile, JSON.stringify({ version: 1, payload, hash: hash(payload, this.stats) }));
  }
  async clearPending() {
    fs.rmSync(this.pendingFile, { force: true });
    syncDir(path.dirname(this.pendingFile));
  }
  receiptFiles() {
    if (!statMaybe(this.receiptDirectory)) return [];
    safeDir(this.receiptDirectory);
    const files = [];
    for (const item of fs.readdirSync(this.receiptDirectory, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue; // Interrupted atomicWrite temporary files are not committed.
      if (!item.isFile()) throw new Error('完成日志不是普通文件；已停止同步。');
      files.push({ file: path.join(this.receiptDirectory, item.name), sequence: receiptSequence(item.name) });
    }
    return files.sort((a,b) => a.sequence - b.sequence);
  }
  async loadReceipts(afterSequence = 0) {
    checkReceiptWatermark(afterSequence);
    this.receiptFloor = Math.max(this.receiptFloor, afterSequence);
    this.receiptSequence = undefined;
    const files = this.receiptFiles(), entries = [];
    let expected = afterSequence + 1;
    for (const { file, sequence } of files) {
      if (sequence <= afterSequence) continue;
      if (sequence !== expected++) throw new Error('完成日志序号不连续；请保留现场。');
      try {
        const data = readBytes(file);
        if (data === null) throw new Error('missing');
        const row = JSON.parse(data.toString('utf8'));
        if (row.version !== 1 || row.sequence !== sequence || typeof row.payload !== 'string' ||
            hash(JSON.stringify([sequence, row.payload]), this.stats) !== row.hash) throw new Error('checksum');
        const entry = JSON.parse(row.payload);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('payload');
        entries.push({ sequence, entry });
      } catch { throw new Error('同步完成日志损坏或校验失败；已停止同步。'); }
    }
    this.receiptSequence = Math.max(this.receiptFloor, files.at(-1)?.sequence || 0);
    return entries;
  }
  async saveReceipt(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('完成日志内容无效。');
    const directoryExisted = statMaybe(this.receiptDirectory) !== null;
    safeDir(this.receiptDirectory, true);
    if (!directoryExisted) syncDir(path.dirname(this.receiptDirectory));
    if (this.receiptSequence === undefined) await this.loadReceipts(this.receiptFloor);
    const sequence = this.receiptSequence + 1;
    checkReceiptWatermark(sequence);
    const payload = JSON.stringify(entry);
    const encoded = JSON.stringify({ version: 1, sequence, payload, hash: hash(JSON.stringify([sequence, payload]), this.stats) });
    const target = path.join(this.receiptDirectory, 'receipt-' + String(sequence).padStart(16, '0') + '.json');
    if (statMaybe(target)) throw new Error('完成日志序号已存在；请重新读取同步状态。');
    try { atomicWrite(target, encoded); this.receiptSequence = sequence; return sequence; }
    catch (error) { this.receiptSequence = undefined; throw error; }
  }
  async clearReceipts(throughSequence) {
    checkReceiptWatermark(throughSequence);
    this.receiptFloor = Math.max(this.receiptFloor, throughSequence);
    if (this.receiptSequence !== undefined) this.receiptSequence = Math.max(this.receiptSequence, throughSequence);
    const files = this.receiptFiles();
    for (const { file, sequence } of files) if (sequence <= throughSequence) fs.rmSync(file, { force: true });
    if (files.length) syncDir(this.receiptDirectory);
  }
  stagedPath(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的待上传内容编号');
    return path.join(this.staging, id);
  }
  async stageBlob(id, bytes) {
    safeDir(this.staging, true);
    if (hash(bytes, this.stats) !== id) throw new Error('待上传内容校验失败');
    atomicWrite(this.stagedPath(id), bytes);
  }
  async readStaged(id) {
    safeDir(this.staging);
    const bytes = readBytes(this.stagedPath(id));
    if (bytes === null || hash(bytes, this.stats) !== id) throw new Error('待上传内容缺失或损坏；已停止同步');
    return bytes;
  }
  async clearStaged(id) {
    safeDir(this.staging);
    fs.rmSync(this.stagedPath(id), { force: true });
  }
}

class DiskVault {
  constructor(root, configDir = '.obsidian', guard = () => true) {
    this.root = fs.realpathSync(root);
    this.configDir = configDir;
    this.guard = guard;
    this.hashCache = new Map();
    this.tracksStats = true;
    if (!configDir || /[\/\\]/.test(configDir) || configDir === '.' || configDir === '..') {
      throw new Error('不支持这个 Obsidian 配置目录');
    }
    let dir = this.root;
    for (const part of [configDir, 'plugins', 'obsidian-webdav-versions', 'local-state']) {
      dir = path.join(dir, part);
      safeDir(dir, true);
    }
    this.privateDir = dir;
    this.transaction = path.join(dir, 'file-transaction');
  }

  filePath(name, createParents = false) {
    validateRelative(name);
    const parts = name.split('/');
    if (parts[0].normalize('NFC').toLowerCase() === this.configDir.normalize('NFC').toLowerCase()) throw new Error('跳过 Obsidian 配置目录');
    const filename = parts.pop();
    let dir = this.root;
    for (const part of parts) {
      dir = path.join(dir, part);
      if (createParents || statMaybe(dir)) safeDir(dir, createParents);
    }
    const file = path.join(dir, filename);
    // A linked note (including a dangling link) is never a missing note.
    if (statMaybe(file)?.isSymbolicLink()) throw new Error('笔记路径是符号链接，已停止同步：' + name);
    return file;
  }

  async list() {
    this.recover();
    const files = [];
    const visit = async (base, prefix) => {
      for (const e of await fsp.readdir(base, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name.startsWith('.') || (!prefix && e.name.toLowerCase() === this.configDir.toLowerCase())) continue;
        const rel = prefix + e.name.normalize('NFC');
        if (e.isDirectory()) await visit(this.filePath(rel), rel + '/');
        else if (e.isFile()) files.push(rel);
        else throw new Error('笔记库包含特殊文件，请移出同步范围：' + rel);
      }
    };
    await visit(this.root, '');
    return files;
  }

  readFile(file, limit) {
    const data = readBytes(file, limit);
    if (data !== null && this.stats && !file.startsWith(this.privateDir + path.sep)) this.stats.vaultReads++;
    return data;
  }
  hashOf(value) { return hash(value, this.stats); }
  async read(name) { return this.readFile(this.filePath(name), 512 * 1024 * 1024); }

  beginRound({ deep = false } = {}) { if (deep) this.hashCache.clear(); }

  async hash(name) {
    const file = this.filePath(name);
    const stamp = async () => {
      let stat;
      try { stat = await fsp.lstat(file, { bigint: true }); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      if (!stat.isFile()) throw new Error('笔记不是普通文件：' + name);
      if (stat.size > 512n * 1024n * 1024n) throw new Error('文件超过 512 MiB：' + name);
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('/');
    };
    const before = await stamp();
    if (before === null) { this.hashCache.delete(name); return null; }
    const cached = this.hashCache.get(name);
    if (cached?.stamp === before) return cached.hash;
    const hasher = createHash('sha256');
    const stream = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
    if (this.stats) this.stats.vaultReads++;
    for await (const chunk of stream) {
      if (this.stats) this.stats.hashBytes += chunk.byteLength;
      hasher.update(chunk);
    }
    if (before !== await stamp()) throw new Error('笔记正在变动，将在下一轮重试：' + name);
    const value = hasher.digest('hex');
    this.hashCache.set(name, { stamp: before, hash: value });
    return value;
  }

  // An interrupted replacement leaves a journal and the original inode. Recovery never
  // overwrites a newly created destination; a raced version is kept for manual recovery.
  recover() {
    if (!statMaybe(this.transaction)) return;
    safeDir(this.transaction);
    const metadata = this.readFile(path.join(this.transaction, 'intent.json'));
    const old = path.join(this.transaction, 'previous');
    if (!metadata) {
      if (statMaybe(old)) throw new Error('本地恢复记录不完整：' + this.transaction);
      this.finishTransaction();
      return;
    }
    const tx = JSON.parse(metadata);
    const file = this.filePath(tx.name, true);
    const previous = this.readFile(old);
    if (previous !== null) {
      if (this.hashOf(previous) !== tx.expected) {
        if (!statMaybe(file)) fs.linkSync(old, file);
        else if (this.hashOf(this.readFile(file)) !== this.hashOf(previous)) throw new Error('检测到另一程序同时写入，原文保存在 ' + old);
      } else if (!statMaybe(file) && tx.next !== null) {
        const staged = path.join(this.transaction, 'next');
        if (this.hashOf(this.readFile(staged)) !== tx.next) throw new Error('本地暂存校验失败：' + staged);
        fs.linkSync(staged, file);
      }
    }
    syncDir(path.dirname(file));
    this.finishTransaction();
  }

  finishTransaction() {
    // Detach atomically, so a crash midway through cleanup cannot corrupt the journal.
    const garbage = this.transaction + '-done-' + randomUUID();
    fs.renameSync(this.transaction, garbage);
    syncDir(this.privateDir);
    fs.rmSync(garbage, { recursive: true });
  }

  async compareAndSet(name, expected, next) {
    this.recover();
    const file = this.filePath(name, next !== null);
    const before = this.readFile(file, 512 * 1024 * 1024);
    if ((before === null ? null : this.hashOf(before)) !== expected || !this.guard(name, before)) return false;
    if ((next === null && before === null) || (next !== null && before !== null && next.equals(before))) return true;
    fs.mkdirSync(this.transaction, { mode: 0o700 });
    const old = path.join(this.transaction, 'previous');
    const staged = path.join(this.transaction, 'next');
    try {
      if (next !== null) atomicWrite(staged, next);
      atomicWrite(path.join(this.transaction, 'intent.json'), JSON.stringify({ name, expected, next: next === null ? null : this.hashOf(next) }));
      syncDir(this.privateDir);
      if (before !== null) {
        try { fs.renameSync(file, old); }
        catch (err) { if (err.code === 'ENOENT') { this.finishTransaction(); return false; } throw err; }
        if (this.hashOf(this.readFile(old)) !== expected) { this.recover(); return false; }
      }
      if (next !== null) {
        try { fs.linkSync(staged, file); }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          this.recover();
          return false;
        }
      }
      syncDir(path.dirname(file));
      this.finishTransaction();
      return true;
    } catch (err) {
      // Leave the intent and bytes in place for the next scan.
      throw err;
    }
  }
}

module.exports = { DiskState, DiskVault };
