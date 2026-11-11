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
  constructor(adapter) { this.adapter = adapter; }
  async hashOf(value) {
    if (value === null) return null;
    if (this.stats) this.stats.hashBytes += bytes(value).length;
    return sha256(value);
  }
  async mkdir(dir) {
    let prefix = '';
    for (const part of dir.split('/')) {
      prefix = prefix ? prefix + '/' + part : part;
      const stat = await this.adapter.stat(prefix);
      if (!stat) await this.adapter.mkdir(prefix);
      else if (stat.type !== 'folder') throw new Error('同步工作目录被文件占用：' + prefix);
    }
  }
  async read(path, limit = MOBILE_LIMIT) {
    const stat = await this.adapter.stat(path);
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

// Two alternating, checksummed snapshots: a killed write cannot destroy the last
// complete snapshot. Mobile state is intentionally independent from desktop state.
class MobileState extends AdapterIO {
  constructor(adapter, directory, url, user) {
    super(adapter);
    this.directory = directory + '/mobile-state-' + digest(JSON.stringify([new URL(url).href.replace(/\/+$/, ''), user]));
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
  async load() { return (await this.snapshots())[0]?.state ?? null; }
  async save(value) {
    await this.mkdir(this.directory);
    const latest = (await this.snapshots())[0];
    const slot = latest ? 1 - latest.slot : 0;
    const payload = JSON.stringify(value);
    const encoded = JSON.stringify({ sequence: (latest?.sequence || 0) + 1, payload, hash: await this.hashOf(payload) });
    const target = this.directory + '/state-' + slot + '.json';
    const tmp = this.directory + '/writing-' + randomUUID();
    await this.writeFresh(tmp, encoded);
    if (await this.adapter.exists(target)) await this.adapter.remove(target);
    await this.adapter.rename(tmp, target);
    if (text(await this.read(target)) !== encoded) throw new Error('手机同步状态写入校验失败。');
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
  async hash(name) { return await this.hashOf(await this.read(name)); }
  async list() {
    this.checkActive();
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
