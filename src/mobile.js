'use strict';
const { bytes, text, arrayBuffer, digest, sha256, randomUUID } = require('./bytes');

// Native requestUrl buffers responses; keep mobile files below a conservative cap.
const MOBILE_LIMIT = 128 * 1024 * 1024;
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
const mobileError = code => Object.assign(new Error(code), { code });

function mobileRequest(requestUrl, active = () => true) {
  const send = args => {
    if (request.stats) request.stats.httpRequests++;
    return requestUrl(args);
  };
  const request = async ({ url, method, headers, body, limit }) => {
    if (!active()) throw mobileError('MOBILE_PAUSED');
    const nativeHeaders = { ...headers };
    delete nativeHeaders['Content-Length']; delete nativeHeaders['Accept-Encoding'];
    // requestUrl has no streaming reader. Check size before allocating a blob.
    if (method === 'GET' && url.pathname.endsWith('.blob')) {
      const head = await send({ url: url.href, method: 'HEAD', headers: nativeHeaders, throw: false });
      const h = Object.fromEntries(Object.entries(head.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
      if (head.status !== 404) {
        if (head.status !== 200 || !/^\d+$/.test(h['content-length'] || '')) throw mobileError('MOBILE_HEAD_REQUIRED');
        if (Number(h['content-length']) > Math.min(limit, MOBILE_LIMIT)) throw mobileError('MOBILE_TOO_LARGE');
        const size = Number(h['content-length']);
        if (size > DOWNLOAD_CHUNK) {
          const assembled = new Uint8Array(size);
          for (let start = 0; start < size; start += DOWNLOAD_CHUNK) {
            if (!active()) throw mobileError('MOBILE_PAUSED');
            const end = Math.min(start + DOWNLOAD_CHUNK, size) - 1;
            const part = await send({ url: url.href, method: 'GET',
              headers: { ...nativeHeaders, Range: `bytes=${start}-${end}` }, throw: false });
            if (!active()) throw mobileError('MOBILE_PAUSED');
            const ph = Object.fromEntries(Object.entries(part.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
            if (!(part.arrayBuffer instanceof ArrayBuffer)) throw mobileError('MOBILE_RANGE_INVALID');
            // Some DAV servers ignore Range. Accept one complete, bounded body.
            if (start === 0 && part.status === 200 && part.arrayBuffer.byteLength === size) {
              return { status: 200, headers: ph, body: bytes(part.arrayBuffer) };
            }
            if (part.status !== 206 || ph['content-range'] !== `bytes ${start}-${end}/${size}` || part.arrayBuffer.byteLength !== end-start+1) {
              throw mobileError('MOBILE_RANGE_INVALID');
            }
            assembled.set(bytes(part.arrayBuffer), start);
          }
          return { status: 200, headers: h, body: assembled };
        }
      }
      if (!active()) throw mobileError('MOBILE_PAUSED');
    }
    const response = await send({ url: url.href, method, headers: nativeHeaders,
      ...(body === undefined ? {} : { body: arrayBuffer(body) }), throw: false });
    if (!active()) throw mobileError('MOBILE_PAUSED');
    if (!(response.arrayBuffer instanceof ArrayBuffer) || response.arrayBuffer.byteLength > Math.min(limit, MOBILE_LIMIT)) {
      throw mobileError('MOBILE_TOO_LARGE');
    }
    return { status: response.status, body: bytes(response.arrayBuffer),
      headers: Object.fromEntries(Object.entries(response.headers || {}).map(([k,v]) => [k.toLowerCase(),v])) };
  };
  request.tracksStats = true;
  return request;
}

class AdapterIO {
  constructor(adapter) { this.adapter = adapter; this.confirmedDirectories = new Set(); }
  async hashOf(value) {
    if (value === null) return null;
    if (this.stats) this.stats.hashBytes += bytes(value).length;
    return sha256(value);
  }
  async mkdir(dir) {
    let prefix = '';
    for (const part of dir.split('/')) {
      prefix = prefix ? prefix + '/' + part : part;
      if (this.confirmedDirectories.has(prefix)) continue;
      const stat = await this.adapter.stat(prefix);
      if (!stat) await this.adapter.mkdir(prefix);
      else if (stat.type !== 'folder') throw new Error('同步工作目录被文件占用：' + prefix);
      this.confirmedDirectories.add(prefix);
    }
  }
  async read(path, limit = MOBILE_LIMIT, knownStat) {
    const stat = knownStat === undefined ? await this.adapter.stat(path) : knownStat;
    if (!stat) return null;
    if (stat.type !== 'file') throw new Error('文件路径被目录占用：' + path);
    if (stat.size > limit) throw new Error('手机单个文件上限为 128 MiB：' + path);
    const value = bytes(await this.adapter.readBinary(path));
    if (this.stats && this.privateDir && !path.startsWith(this.privateDir + '/')) this.stats.vaultReads++;
    if (value.length > limit) throw new Error('手机单个文件上限为 128 MiB：' + path);
    return value;
  }
  // The destination must be absent. Adapter.copy is documented to fail on existing files.
  async copyAbsent(from, to) {
    if (await this.adapter.exists(to)) return false;
    try { await this.adapter.copy(from, to); return true; }
    catch (err) { if (await this.adapter.exists(to)) return false; throw err; }
  }
  async writeFresh(path, value) {
    const b = bytes(value);
    if (await this.adapter.exists(path)) throw new Error('暂存路径已经存在。');
    await this.adapter.writeBinary(path, arrayBuffer(b));
    if (await this.hashOf(await AdapterIO.prototype.read.call(this, path)) !== await this.hashOf(b)) throw new Error('本地暂存写入校验失败。');
  }
}


function receiptSequence(name) {
  const match = /^receipt-(\d{16})\.json$/.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) throw new Error('完成日志文件名无效；已停止同步。');
  return Number(match[1]);
}
function checkReceiptWatermark(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('完成日志检查点水位无效；已停止同步。');
}

// Two alternating, checksummed snapshots: a killed write cannot destroy the last
// complete snapshot. Mobile state is intentionally independent from desktop state.
class MobileState extends AdapterIO {
  constructor(adapter, directory, url, user) {
    super(adapter);
    this.directory = directory + '/mobile-state-' + digest(JSON.stringify([new URL(url).href.replace(/\/+$/, ''), user]));
    this.pendingFile = this.directory + '/pending.json';
    this.latest = undefined;
    this.receiptSequence = undefined;
    this.receiptFloor = 0;
  }
  async snapshots() {
    const valid = []; let present = 0;
    for (const slot of [0,1]) {
      const b = await this.read(this.directory + '/state-' + slot + '.json');
      if (b === null) continue;
      present++;
      try {
        const row = JSON.parse(text(b));
        if (Number.isSafeInteger(row.sequence) && row.sequence > 0 && typeof row.payload === 'string' && await this.hashOf(row.payload) === row.hash) {
          valid.push({ ...row, slot, state: JSON.parse(row.payload) });
        }
      } catch { /* Validation below stops on corruption of a committed slot. */ }
    }
    if (valid.length !== present) throw new Error('手机同步状态损坏；保留现场并停止同步。');
    return valid.sort((a,b) => b.sequence - a.sequence);
  }
  async load() {
    const latest = (await this.snapshots())[0];
    this.latest = latest ? { slot: latest.slot, sequence: latest.sequence } : null;
    return latest?.state ?? null;
  }
  async save(value) {
    await this.mkdir(this.directory);
    if (this.latest === undefined) await this.load();
    const latest = this.latest;
    const slot = latest ? 1 - latest.slot : 0;
    const payload = JSON.stringify(value);
    const encoded = JSON.stringify({ sequence: (latest?.sequence || 0) + 1, payload, hash: await this.hashOf(payload) });
    const target = this.directory + '/state-' + slot + '.json';
    const tmp = this.directory + '/writing-' + randomUUID();
    try {
      await this.writeFresh(tmp, encoded);
      if (await this.adapter.exists(target)) await this.adapter.remove(target);
      await this.adapter.rename(tmp, target);
      this.latest = { slot, sequence: (latest?.sequence || 0) + 1 };
    } catch (err) {
      // A failed rename may have completed before its response was lost.
      this.latest = undefined;
      throw err;
    }
  }
  async loadPending() {
    const data = await this.read(this.pendingFile);
    if (data === null) return null;
    try {
      const row = JSON.parse(text(data));
      if (row.version !== 1 || typeof row.payload !== 'string' || await this.hashOf(row.payload) !== row.hash) throw new Error('checksum');
      const pending = JSON.parse(row.payload);
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('payload');
      return pending;
    } catch { throw new Error('手机同步待处理日志损坏；已停止同步。'); }
  }
  async savePending(value) {
    await this.mkdir(this.directory);
    const previous = await this.loadPending();
    const payload = JSON.stringify(value);
    if (previous !== null) {
      if (JSON.stringify(previous) !== payload) throw new Error('仍有未完成的同步日志；请先恢复。');
      return;
    }
    const encoded = JSON.stringify({ version: 1, payload, hash: await this.hashOf(payload) });
    const tmp = this.directory + '/pending-writing-' + randomUUID();
    await this.writeFresh(tmp, encoded);
    await this.adapter.rename(tmp, this.pendingFile);
  }
  async clearPending() {
    if (await this.adapter.exists(this.pendingFile)) await this.adapter.remove(this.pendingFile);
  }
  async receiptFiles() {
    const stat = await this.adapter.stat(this.directory);
    if (!stat) return [];
    if (stat.type !== 'folder') throw new Error('同步工作目录被文件占用：' + this.directory);
    const listing = await this.adapter.list(this.directory), files = [];
    for (const file of [...listing.files, ...listing.folders]) {
      if (!file.startsWith(this.directory + '/') || file.slice(this.directory.length + 1).includes('/')) throw new Error('完成日志目录清单无效。');
      const name = file.slice(this.directory.length + 1);
      if (!name.startsWith('receipt-') || name.startsWith('receipt-writing-')) continue;
      if (listing.folders.includes(file)) throw new Error('完成日志被目录占用。');
      files.push({ file, sequence: receiptSequence(name) });
    }
    return files.sort((a,b) => a.sequence - b.sequence);
  }
  async loadReceipts(afterSequence = 0) {
    checkReceiptWatermark(afterSequence);
    this.receiptFloor = Math.max(this.receiptFloor, afterSequence);
    this.receiptSequence = undefined;
    const files = await this.receiptFiles(), entries = [];
    let expected = afterSequence + 1;
    for (const { file, sequence } of files) {
      if (sequence <= afterSequence) continue; // Durable checkpoint supersedes any leftover cleanup bytes.
      if (sequence !== expected++) throw new Error('完成日志序号不连续；请保留现场。');
      try {
        const data = await this.read(file);
        if (data === null) throw new Error('missing');
        const row = JSON.parse(text(data));
        if (row.version !== 1 || row.sequence !== sequence || typeof row.payload !== 'string' ||
            await this.hashOf(JSON.stringify([sequence, row.payload])) !== row.hash) throw new Error('checksum');
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
    await this.mkdir(this.directory);
    if (this.receiptSequence === undefined) await this.loadReceipts(this.receiptFloor);
    const sequence = this.receiptSequence + 1;
    checkReceiptWatermark(sequence);
    const payload = JSON.stringify(entry);
    const encoded = JSON.stringify({ version: 1, sequence, payload, hash: await this.hashOf(JSON.stringify([sequence, payload])) });
    const target = this.directory + '/receipt-' + String(sequence).padStart(16, '0') + '.json';
    const tmp = this.directory + '/receipt-writing-' + randomUUID();
    try {
      await this.writeFresh(tmp, encoded);
      await this.adapter.rename(tmp, target);
      this.receiptSequence = sequence;
      return sequence;
    } catch (error) { this.receiptSequence = undefined; throw error; }
  }
  async clearReceipts(throughSequence) {
    checkReceiptWatermark(throughSequence);
    this.receiptFloor = Math.max(this.receiptFloor, throughSequence);
    if (this.receiptSequence !== undefined) this.receiptSequence = Math.max(this.receiptSequence, throughSequence);
    for (const { file, sequence } of await this.receiptFiles()) {
      if (sequence <= throughSequence) await this.adapter.remove(file);
    }
  }
  blobPath(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的待上传内容编号。');
    return this.directory + '/outbox-' + id;
  }
  async stageBlob(id, value) {
    if (await this.hashOf(value) !== id) throw new Error('待上传内容校验失败。');
    await this.mkdir(this.directory);
    const target = this.blobPath(id);
    const present = await this.read(target);
    if (present !== null) {
      if (await this.hashOf(present) !== id) throw new Error('待上传内容损坏；保留现场。');
      return;
    }
    const tmp = this.directory + '/writing-' + randomUUID();
    await this.writeFresh(tmp, value);
    await this.adapter.rename(tmp, target);
  }
  async readStaged(id) {
    const value = await this.read(this.blobPath(id));
    if (value === null || await this.hashOf(value) !== id) throw new Error('待上传内容缺失或损坏；已停止同步。');
    return value;
  }
  async clearStaged(id) { const p = this.blobPath(id); if (await this.adapter.exists(p)) await this.adapter.remove(p); }
}

class MobileVault extends AdapterIO {
  constructor(adapter, configDir = '.obsidian', guard = () => true, active = () => true) {
    super(adapter);
    if (!configDir || /[\/\\]/.test(configDir) || configDir === '.' || configDir === '..') throw new Error('不支持这个 Obsidian 配置目录。');
    this.tracksStats = true;
    this.configDir = configDir; this.guard = guard; this.active = active;
    this.privateDir = configDir + '/plugins/obsidian-webdav-versions/local-state';
    this.transaction = this.privateDir + '/mobile-transaction';
    this.cacheFile = this.privateDir + '/mobile-hash-cache.json';
    this.hashCache = new Map();
    this.statHints = new Map();
    this.cacheWarm = new Set();
    this.cacheLoaded = false;
    this.cacheDirty = false;
    this.deep = false;
  }
  path(name) {
    if (typeof name !== 'string' || !name || /[\\\x00-\x1f]/.test(name) || /^[A-Za-z]:/.test(name) ||
        name.split('/').some(p => !p || p.startsWith('.')) || name.split('/')[0].toLowerCase() === this.configDir.toLowerCase()) {
      throw new Error('拒绝不安全的笔记路径。');
    }
    return name;
  }
  checkActive() { if (!this.active()) throw new Error('同步已暂停；请返回 Obsidian 前台。'); }
  async read(name) { this.checkActive(); return super.read(this.path(name)); }
  beginRound({ deep = false } = {}) {
    this.statHints.clear();
    this.deep = deep;
  }
  async loadCache() {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      const data = await super.read(this.cacheFile);
      if (data === null) return;
      const row = JSON.parse(text(data));
      if (row.version !== 1 || !Array.isArray(row.entries)) throw new Error('Invalid hash cache');
      const entries = new Map();
      for (const [name, value] of row.entries) {
        this.path(name);
        if (!value || !Number.isFinite(value.mtime) || !Number.isSafeInteger(value.size) || value.size < 0 ||
            !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error('Invalid hash cache entry');
        entries.set(name, { mtime: value.mtime, size: value.size, hash: value.hash });
      }
      this.hashCache = entries;
    } catch { this.hashCache.clear(); } // A cache is a hint; missing/corrupt hints must never stop sync.
  }
  invalidate(name) {
    if (this.hashCache.delete(name)) this.cacheDirty = true;
    this.statHints.delete(name);
    this.cacheWarm.add(name);
  }
  async hash(name) {
    this.checkActive(); this.path(name); await this.loadCache();
    const stat = this.statHints.has(name) ? this.statHints.get(name) : await this.adapter.stat(name);
    this.statHints.delete(name); // A listing stamp belongs to exactly one scan, never a later round.
    if (!stat) {
      if (this.hashCache.delete(name)) this.cacheDirty = true;
      return null;
    }
    if (stat.type !== 'file') throw new Error('文件路径被目录占用：' + name);
    if (stat.size > MOBILE_LIMIT) throw new Error('手机单个文件上限为 128 MiB：' + name);
    const cached = this.hashCache.get(name);
    const oldEnough = Number.isFinite(stat.mtime) && Date.now() - stat.mtime >= 2000;
    if (!this.deep && !this.cacheWarm.has(name) && oldEnough && cached?.mtime === stat.mtime && cached.size === stat.size) return cached.hash;
    const value = await super.read(name, MOBILE_LIMIT, stat);
    const hash = await this.hashOf(value);
    if (Number.isFinite(stat.mtime) && stat.size === value.length) {
      const next = { mtime: stat.mtime, size: stat.size, hash };
      if (!cached || cached.mtime !== next.mtime || cached.size !== next.size || cached.hash !== hash) {
        this.hashCache.set(name, next); this.cacheDirty = true;
      }
    } else if (this.hashCache.delete(name)) this.cacheDirty = true;
    return hash;
  }
  async flush() {
    await this.loadCache();
    // CAS invalidates the old signature. Read the actual saved file once, including
    // any edit that followed CAS, so a later idle scan need not warm the whole vault.
    for (const name of [...this.cacheWarm]) {
      await this.hash(name);
      this.cacheWarm.delete(name);
    }
    if (!this.cacheDirty) return;
    await this.mkdir(this.privateDir);
    const tmp = this.cacheFile + '.writing-' + randomUUID();
    await this.adapter.writeBinary(tmp, arrayBuffer(JSON.stringify({ version: 1, entries: [...this.hashCache] })));
    if (await this.adapter.exists(this.cacheFile)) await this.adapter.remove(this.cacheFile);
    await this.adapter.rename(tmp, this.cacheFile);
    this.cacheDirty = false;
  }
  async list() {
    this.checkActive();
    this.statHints.clear();
    const files = [];
    const visit = async dir => {
      const listed = await this.adapter.list(dir);
      for (const p of [...listed.files, ...listed.folders]) {
        // Validate adapter output rather than accidentally scanning beyond the vault.
        if ((dir ? !p.startsWith(dir + '/') : p.startsWith('/')) || p.slice(dir ? dir.length + 1 : 0).includes('/')) throw new Error('本地目录清单无效。');
        if (p.split('/').some(v => v.startsWith('.')) || p.split('/')[0].toLowerCase() === this.configDir.toLowerCase()) continue;
        this.path(p);
        if (listed.folders.includes(p)) await visit(p);
        else {
          const st = await this.adapter.stat(p);
          if (!st || st.type !== 'file') throw new Error('扫描期间文件发生变化，请重试。');
          if (st.size > MOBILE_LIMIT) throw new Error('手机单个文件上限为 128 MiB：' + p);
          this.statHints.set(p, st);
          files.push(p);
        }
      }
    };
    await visit(''); return files;
  }
  async finish() {
    if (!await this.adapter.exists(this.transaction)) return;
    const done = this.transaction + '-done-' + randomUUID();
    await this.adapter.rename(this.transaction, done);
    await this.adapter.rmdir(done, true);
  }
  async recover() {
    this.checkActive();
    if (!await this.adapter.exists(this.transaction)) return;
    const meta = await super.read(this.transaction + '/intent.json');
    const previous = await super.read(this.transaction + '/previous');
    if (meta === null) {
      if (previous !== null) throw new Error('本地恢复记录不完整；请保留 local-state。');
      await this.finish(); return;
    }
    const tx = JSON.parse(text(meta)); this.path(tx.name);
    this.invalidate(tx.name);
    for (const h of [tx.expected, tx.next]) if (h !== null && !/^[a-f0-9]{64}$/.test(h)) throw new Error('恢复记录校验失败。');
    const actual = await this.read(tx.name);
    if (previous !== null && await this.hashOf(previous) !== tx.expected) {
      if (actual === null) await this.copyAbsent(this.transaction + '/previous', tx.name);
      if (await this.hash(tx.name) !== await this.hashOf(previous)) throw new Error('检测到并发写入；另一份内容保存在 ' + this.transaction + '/previous');
      await this.finish(); return;
    }
    // With no moved original, an interrupted update was never applied. Keep any
    // user deletion or new contents. For a new file, exclusive copy is safe.
    if (actual === null && (previous !== null || tx.expected === null) && tx.next !== null) {
      const staged = await super.read(this.transaction + '/next');
      if (await this.hashOf(staged) !== tx.next) throw new Error('本地待恢复内容校验失败。');
      const slash = tx.name.lastIndexOf('/'); if (slash >= 0) await this.mkdir(tx.name.slice(0, slash));
      if (this.guard(tx.name, previous)) await this.copyAbsent(this.transaction + '/next', tx.name);
      else if (previous !== null) await this.copyAbsent(this.transaction + '/previous', tx.name);
    }
    await this.finish();
  }
  async compareAndSet(name, expected, next) {
    this.path(name);
    this.invalidate(name);
    try { return await this.applyFile(name, expected, next); }
    finally { this.invalidate(name); }
  }
  async applyFile(name, expected, next) {
    this.path(name); this.checkActive(); await this.recover();
    if (next !== null && bytes(next).length > MOBILE_LIMIT) throw new Error('手机单个文件上限为 128 MiB。');
    const before = await this.read(name);
    if (await this.hashOf(before) !== expected || !this.guard(name, before)) return false;
    if (await this.hashOf(next) === expected) return true;
    await this.mkdir(this.privateDir);
    await this.adapter.mkdir(this.transaction);
    if (next !== null) await this.writeFresh(this.transaction + '/next', next);
    await this.writeFresh(this.transaction + '/intent.json', JSON.stringify({ name, expected, next: await this.hashOf(next) }));
    this.checkActive();
    const checked = await this.read(name);
    if (await this.hashOf(checked) !== expected || !this.guard(name, checked)) { await this.finish(); return false; }
    if (before !== null) {
      await this.adapter.rename(name, this.transaction + '/previous');
      if (await this.hashOf(await super.read(this.transaction + '/previous')) !== expected) { await this.recover(); return false; }
    }
    if (next !== null) {
      const slash = name.lastIndexOf('/'); if (slash >= 0) await this.mkdir(name.slice(0, slash));
      if (!await this.copyAbsent(this.transaction + '/next', name)) { await this.recover(); return false; }
    }
    await this.finish();
    return true;
  }
}
module.exports = { MOBILE_LIMIT, DOWNLOAD_CHUNK, mobileRequest, MobileVault, MobileState };
