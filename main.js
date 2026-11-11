// Generated from src/ by scripts/build.js
const factories = {
"bytes":function(module,exports,require){
'use strict';

// Portable byte operations. No Buffer, Node or Electron globals on mobile.
const encoder = new TextEncoder();
function bytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected text or bytes');
}
const byteLength = text => encoder.encode(text).length;
const text = value => new TextDecoder('utf-8', { fatal: true }).decode(value);
function arrayBuffer(value) { const b = bytes(value); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function base64(value) {
  const b = bytes(value); let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(out);
}
function fromBase64(value) { return Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); }
function randomUUID() {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('此环境缺少安全随机数；请更新 Obsidian。');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// SHA-256 (FIPS 180-4), incremental compression without duplicating an attachment.
// Synchronous so revision IDs and the existing v1 protocol remain byte-for-byte compatible.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function digest(value) {
  const data = bytes(value);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  function block(b, offset) {
    for (let i = 0; i < 16; i++) { const p = offset + i * 4; w[i] = (b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3]; }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      w[i] = (w[i-16] + (rotr(x,7)^rotr(x,18)^(x>>>3)) + w[i-7] + (rotr(y,17)^rotr(y,19)^(y>>>10))) >>> 0;
    }
    let [a,b0,c,d,e,f,g,h0] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (h0 + (rotr(e,6)^rotr(e,11)^rotr(e,25)) + ((e&f)^(~e&g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a,2)^rotr(a,13)^rotr(a,22)) + ((a&b0)^(a&c)^(b0&c))) >>> 0;
      h0=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b0; b0=a; a=(t1+t2)>>>0;
    }
    for (const [i, n] of [a,b0,c,d,e,f,g,h0].entries()) h[i] = (h[i] + n) >>> 0;
  }
  const full = data.length - data.length % 64;
  for (let i = 0; i < full; i += 64) block(data, i);
  const tail = new Uint8Array(data.length % 64 < 56 ? 64 : 128);
  tail.set(data.subarray(full)); tail[data.length % 64] = 128;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length-8, Math.floor(data.length / 0x20000000));
  view.setUint32(tail.length-4, (data.length * 8) >>> 0);
  block(tail,0); if (tail.length === 128) block(tail,64);
  return [...h].map(n => n.toString(16).padStart(8,'0')).join('');
}
module.exports = { bytes, text, byteLength, arrayBuffer, base64, fromBase64, randomUUID, digest };

},
"dav":function(module,exports,require){
// Adapted from the Basic authentication and Depth:0/1 PROPFIND workflow in
// leopard530/obsidian-sync-webdav. Immutable storage, integrity checks, strict
// multistatus handling and the non-redirecting HTTPS transport are new.
'use strict';
const { bytes, base64 } = require('./bytes');
const sax = require('./vendor/sax');
const { digest, validateRevision } = require('./protocol');

const NAMESPACE = 'obsidian-webdav-versions-v1';
const HASH = /^[0-9a-f]{64}$/;
const DAV = 'DAV:';
const XML_LIMIT = 32 * 1024 * 1024;
const REV_LIMIT = 1024 * 1024;
const BLOB_LIMIT = 512 * 1024 * 1024;
const PROPFIND = bytes('<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>');
const utf8 = data => new TextDecoder('utf-8', { fatal: true }).decode(data);
const xmlError = () => new Error('WebDAV 返回了无效或不完整的目录清单；已停止同步。');
const integrity = () => new Error('WebDAV 对象内容与版本标识不符；已停止同步。');
function checkHash(id) {
  if (typeof id !== 'string' || !HASH.test(id)) throw integrity();
}
function httpError(method, status) {
  return new Error(`WebDAV ${method}：HTTP ${status}。`);
}

// Loaded only on desktop / in Node-based acceptance tools.
const nodeRequest = args => require('./node-request').nodeRequest(args);

function decodedPath(url) {
  const parts = url.pathname.split('/');
  for (let i = 0; i < parts.length; i++) {
    parts[i] = decodeURIComponent(parts[i]);
    if (/[\\/\x00-\x1f\x7f]/u.test(parts[i]) || parts[i] === '..' || parts[i] === '.') throw xmlError();
  }
  return parts.join('/').replace(/\/$/, '');
}
const named = (node, local) => node.uri === DAV && node.local === local;
const children = (node, local) => node.children.filter(it => named(it, local));
function one(node, local) {
  const items = children(node, local);
  if (items.length !== 1) throw xmlError();
  return items[0];
}
function checkStatus(node) {
  if (!/^HTTP\/\d+(?:\.\d+)?\s+200(?:\s|$)/i.test(node.text.trim()) || node.children.length) throw xmlError();
}
function entry(node, base, target) {
  const hrefNode = one(node, 'href');
  const href = hrefNode.text.trim();
  if (!href || hrefNode.children.length || /[\\\x00-\x1f\x7f]/u.test(href)) throw xmlError();
  const listed = new URL(href, target);
  if (listed.origin !== target.origin || listed.username || listed.password || listed.search || listed.hash) throw xmlError();
  const path = decodedPath(listed);
  const self = path === base;
  if (!self && (!path.startsWith(base + '/') || path.slice(base.length + 1).includes('/'))) throw xmlError();
  const direct = children(node, 'status');
  if (direct.length) throw xmlError(); // a PROPFIND response must actually supply our property
  const stats = children(node, 'propstat');
  if (!stats.length || children(node, 'error').length) throw xmlError();
  const types = [];
  for (const stat of stats) {
    checkStatus(one(stat, 'status'));
    if (children(stat, 'error').length) throw xmlError();
    types.push(...children(one(stat, 'prop'), 'resourcetype'));
  }
  if (types.length !== 1) throw xmlError();
  const collection = children(types[0], 'collection').length > 0;
  if (self && !collection) throw xmlError();
  return { name: self ? '' : path.slice(base.length + 1), collection };
}

// Retain one parsed response at a time. No regex parsing, external entities,
// DTDs, partial results, silently skipped child errors, or infinite Depth.
function readListing(bytes, target, depth) {
  try {
    const parser = sax.parser(true, { xmlns: true, strictEntities: true });
    const stack = [];
    const base = decodedPath(target);
    const found = new Map();
    let seenRoot = false;
    parser.onerror = () => { throw xmlError(); };
    parser.ondoctype = parser.onsgmldeclaration = () => { throw xmlError(); };
    parser.onopentag = tag => {
      if (stack.length > 32) throw xmlError();
      const node = { uri: tag.uri, local: tag.local, children: [], text: '' };
      if (!stack.length) {
        if (seenRoot || !named(node, 'multistatus')) throw xmlError();
        seenRoot = true;
      } else if (stack.length > 1) stack[stack.length - 1].children.push(node);
      stack.push(node);
    };
    parser.ontext = parser.oncdata = str => {
      if (stack.length > 1) stack[stack.length - 1].text += str;
      else if (str.trim()) throw xmlError();
    };
    parser.onclosetag = () => {
      const node = stack.pop();
      if (stack.length !== 1) return;
      if (named(node, 'response')) {
        const value = entry(node, base, target);
        if (found.has(value.name) || (depth === 0 && value.name !== '')) throw xmlError();
        found.set(value.name, value.collection);
      } else if (!named(node, 'responsedescription') || node.text.trim()) {
        // Includes server-reported limits, errors, and partially namespaced
        // "response" records that would otherwise look like missing files.
        throw xmlError();
      }
    };
    parser.write(utf8(bytes)).close();
    if (!seenRoot || stack.length || !found.has('')) throw xmlError();
    found.delete('');
    return found;
  } catch {
    throw xmlError();
  }
}
function checkedRevision(data, id) {
  try {
    const rev = JSON.parse(utf8(data));
    if (rev.id !== id || validateRevision(rev) === false) throw integrity();
    return rev;
  } catch {
    throw integrity();
  }
}

class DavRemote {
  constructor({ url, username = '', password = '', request = nodeRequest, allowInsecureLoopback = false }) {
    let base;
    try {
      base = new URL(url);
      decodedPath(base);
    } catch { throw new Error('WebDAV 文件夹 URL 无效。'); }
    const loopback = ['127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(allowInsecureLoopback && loopback && base.protocol === 'http:')) {
      throw new Error('WebDAV 必须使用可信 HTTPS。');
    }
    if (base.username || base.password || base.search || base.hash) throw new Error('WebDAV URL 不可含凭据、查询或片段。');
    if (typeof username !== 'string' || typeof password !== 'string' || /[:\x00-\x1f\x7f]/u.test(username)) throw new Error('WebDAV 账号格式无效。');
    base.pathname = base.pathname.replace(/\/*$/, '/');
    this.base = base;
    this.folder = new URL(NAMESPACE + '/', base);
    this.request = request;
    this.auth = username || password ? 'Basic ' + base64(username + ':' + password) : '';
    this.revisions = new Map();
    this.verifiedBlobs = new Set();
    this.created = false;
  }

  hashOf(value) {
    if (this.stats) this.stats.hashBytes += bytes(value).length;
    return digest(value);
  }

  async call(method, url, headers, body, limit) {
    if (url.origin !== this.base.origin) throw new Error('已阻止跨站 WebDAV 请求。');
    headers = { 'Accept-Encoding': 'identity', ...headers };
    if (this.auth) headers.Authorization = this.auth;
    if (body !== undefined) headers['Content-Length'] = String(body.length);
    let result;
    try {
      if (this.request.tracksStats) this.request.stats = this.stats;
      else if (this.stats) this.stats.httpRequests++;
      result = await this.request({ method, url, headers, body, limit });
    } catch (err) {
      // TLS and transport exceptions may contain user information or signed URLs.
      const mobileMessages = {
        MOBILE_PAUSED: '应用已暂停；返回 Obsidian 前台后重试。',
        MOBILE_TOO_LARGE: '手机单个文件或响应超过 128 MiB；已暂停同步，未将文件当作删除。',
        MOBILE_RANGE_INVALID: '附件分段下载响应不完整或范围不符；请重试。',
        MOBILE_HEAD_REQUIRED: '手机同步需要服务器支持 HEAD 并返回 Content-Length；请检查 WebDAV 直连地址。'
      };
      if (Object.hasOwn(mobileMessages, err?.code)) throw new Error(mobileMessages[err.code]);
      throw new Error(`WebDAV ${method} 传输失败；请检查网络、TLS 证书及响应大小限制。`);
    }
    if (!result || !Number.isInteger(result.status) || !(result.body instanceof Uint8Array) || result.body.length > limit) {
      throw new Error('WebDAV 响应无效或超过大小限制。');
    }
    return result;
  }
  async propfind(url, depth, missingOK = false) {
    const r = await this.call('PROPFIND', url, { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, PROPFIND, XML_LIMIT);
    if (missingOK && r.status === 404) return null;
    if (r.status !== 207) throw httpError('PROPFIND', r.status);
    if (r.headers?.link && /rel\s*=\s*["']?next/i.test(String(r.headers.link))) throw xmlError();
    return readListing(r.body, url, depth);
  }
  async probe() {
    await this.propfind(this.base, 0);
    return true;
  }
  async ensureFolder() {
    if (this.created) return;
    await this.probe();
    if (await this.propfind(this.folder, 0, true) === null) {
      const r = await this.call('MKCOL', this.folder, {}, undefined, REV_LIMIT);
      if (![200, 201, 204, 405].includes(r.status)) throw httpError('MKCOL', r.status);
      // 405 can mean "exists" OR "operation not supported".
      await this.propfind(this.folder, 0);
    }
    this.created = true;
  }
  objectURL(id, suffix) {
    checkHash(id);
    return new URL(id + suffix, this.folder);
  }
  async read(url, limit, missingOK = false) {
    const r = await this.call('GET', url, {}, undefined, limit);
    if (missingOK && r.status === 404) return null;
    if (r.status !== 200) throw httpError('GET', r.status);
    return r.body;
  }
  async immutable(url, data, type, limit, verify) {
    await this.ensureFolder();
    const previous = await this.read(url, limit, true);
    if (previous !== null) { verify(previous); return; }
    const r = await this.call('PUT', url, { 'If-None-Match': '*', 'Content-Type': type }, data, REV_LIMIT);
    if (![200, 201, 204, 412].includes(r.status)) throw httpError('PUT', r.status);
    // Even 412 can be another honest client writing the same hash. A weak DAV
    // can ignore the precondition. All honest writers use the same content ID.
    verify(await this.read(url, limit));
  }
  async getBlob(id) {
    const bytes = await this.read(this.objectURL(id, '.blob'), BLOB_LIMIT);
    if (this.hashOf(bytes) !== id) throw integrity();
    this.verifiedBlobs.add(id);
    return bytes;
  }
  async putBlob(id, data) {
    checkHash(id);
    const dataBytes = bytes(data);
    if (dataBytes.length > BLOB_LIMIT) throw new Error('单个附件超过 WebDAV 的 512 MiB 限制。');
    if (this.hashOf(dataBytes) !== id) throw integrity();
    await this.immutable(this.objectURL(id, '.blob'), dataBytes, 'application/octet-stream', BLOB_LIMIT, got => {
      if (this.hashOf(got) !== id) throw integrity();
    });
    this.verifiedBlobs.add(id);
  }
  async putRevision(rev) {
    const data = bytes(JSON.stringify(rev));
    checkHash(rev.id);
    if (data.length > REV_LIMIT) throw new Error('版本记录过大。');
    const snapshot = checkedRevision(data, rev.id);
    if (snapshot.blob !== null && !this.verifiedBlobs.has(snapshot.blob)) await this.getBlob(snapshot.blob);
    await this.immutable(this.objectURL(snapshot.id, '.json'), data, 'application/json', REV_LIMIT, got => {
      checkedRevision(got, snapshot.id);
    });
    this.revisions.set(snapshot.id, snapshot);
  }
  async listRevisions() {
    const listing = await this.propfind(this.folder, 1, true);
    if (listing === null) {
      if (this.revisions.size || this.created) throw new Error('远端版本目录消失；已停止同步。');
      await this.probe(); // do not mistake an incorrect URL/inaccessible parent for an empty store
      return [];
    }
    this.created = true;
    if (listing.size >= 10000) throw new Error('WebDAV 单目录清单达到 10000 项，可能被服务器截断；请升级为分目录存储。未清空同步历史。');
    const ids = [];
    for (const [name, collection] of listing) {
      const match = /^([a-f0-9]{64})\.(json|blob)$/.exec(name);
      if (collection || !match) throw new Error('专用 WebDAV 版本目录内存在未知条目；已停止同步。');
      if (match[2] === 'json') ids.push(match[1]);
    }
    for (const id of this.revisions.keys()) {
      if (!listing.has(id + '.json')) throw new Error('远端缺少以前确认的版本；已停止同步。');
    }
    const missing = ids.filter(id => !this.revisions.has(id));
    let next = 0;
    // Verify only new revisions on subsequent polls, with bounded parallel GETs.
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (next < missing.length) {
        const id = missing[next++];
        const data = await this.read(this.objectURL(id, '.json'), REV_LIMIT);
        this.revisions.set(id, checkedRevision(data, id));
      }
    }));
    const revisions = ids.map(id => this.revisions.get(id));
    for (const rev of revisions) {
      if (rev.blob !== null && !listing.has(rev.blob + '.blob')) throw new Error('远端版本引用的附件缺失；已停止同步。');
    }
    return structuredClone(revisions);
  }
}

module.exports = { DavRemote, NAMESPACE, checkedRevision };

},
"engine":function(module,exports,require){
'use strict';

const { digest, headsFor, isConflictPath, makeRevision, project, safePath, validateRevision } = require('./protocol');

const { base64, fromBase64 } = require('./bytes');

const hashOf = bytes => bytes === null ? null : digest(bytes);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const MAX_BYTES = 512 * 1024 * 1024;
const counts = () => ({ uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferred: 0,
  conflictPaths: [], deferredPaths: [],
  stats: { durationMs: 0, vaultReads: 0, hashBytes: 0, httpRequests: 0, full: 1 } });

// Conflict names are valid physical paths, but are never valid logical note names.
function checkPhysical(path) {
  if (typeof path !== 'string') throw new Error('Invalid physical path');
  safePath(path.replace(/ \(sync-conflict /giu, ' (reserved '));
}

function checkSize(data, physical) {
  if (data !== null && data.byteLength > MAX_BYTES) {
    throw new Error('File exceeds the 512 MiB per-file sync limit: ' + physical);
  }
}

function snapshot(revisions) {
  const rows = [...revisions.values()];
  const view = project(rows); // Also validates parent links and filename collisions.
  const byPath = new Map();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const tips = new Map();
  const versions = new Map();
  for (const [path, history] of byPath) {
    const ids = headsFor(history, path);
    tips.set(path, ids);
    const grouped = new Map();
    for (const id of ids) {
      const blob = revisions.get(id).blob;
      if (!grouped.has(blob)) grouped.set(blob, []);
      grouped.get(blob).push(id);
    }
    versions.set(path, grouped);
  }
  const files = new Map();
  for (const [physical, v] of view) {
    files.set(physical, { path: v.path, blob: v.blob, parents: versions.get(v.path).get(v.blob) });
  }
  return { files, tips, versions, byPath };
}

class SyncEngine {
  constructor({ remote, local, state, device }) {
    this.remote = remote;
    this.local = local;
    this.state = state;
    this.device = device;
    this.queue = Promise.resolve();
  }

  sync() { return this._enqueue(() => this._run()); }
  resolve(physicalPath) { return this._enqueue(() => this._run(physicalPath)); }

  _enqueue(run) {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _save(s) {
    await this.state.save({ version: 1, known: [...s.known], files: [...s.files],
      reviewed: [...s.reviewed], absent: [...s.absent], pending: s.pending });
  }

  async _open() {
    const disk = await this.state.load();
    if (disk !== null && (!disk || disk.version !== 1 || !Array.isArray(disk.known) ||
        !Array.isArray(disk.files) || !Array.isArray(disk.reviewed))) {
      throw new Error('Invalid sync state; the vault has not been changed');
    }
    const s = { known: new Set(disk?.known), files: new Map(disk?.files),
      reviewed: new Map(disk?.reviewed), absent: new Map(disk?.absent), pending: disk?.pending ?? null, revs: new Map() };
    for (const r of await this.remote.listRevisions()) {
      validateRevision(r);
      s.revs.set(r.id, r);
    }
    for (const id of s.known) {
      if (!s.revs.has(id)) throw new Error('Remote history is incomplete: previously seen revision missing: ' + id);
    }
    project(s.revs.values());
    for (const [physical, binding] of s.files) {
      checkPhysical(physical);
      safePath(binding.path);
      if (!Array.isArray(binding.parents) || !binding.parents.length || !binding.parents.every(id => {
        const rev = s.revs.get(id);
        return rev && rev.path === binding.path && rev.blob === binding.blob;
      })) throw new Error('Invalid file baseline for ' + physical);
    }
    for (const [path, ids] of s.absent) {
      safePath(path);
      if (!Array.isArray(ids) || !ids.length || !ids.every(id => {
        const r = s.revs.get(id);
        return r && r.path === path && r.blob === null;
      })) throw new Error('Invalid deletion baseline for ' + path);
    }
    const discovered = s.revs.size !== s.known.size;
    s.known = new Set(s.revs.keys());
    if (discovered) await this._save(s);
    return s;
  }

  _bind(s, physical, binding) {
    if (binding) s.files.set(physical, binding);
    else s.files.delete(physical);
  }

  _hash(value) {
    if (value !== null) this.stats.hashBytes += typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength;
    return hashOf(value);
  }

  async _read(physical) {
    const data = await this.local.read(physical);
    if (data !== null && !this.local.tracksStats) this.stats.vaultReads++;
    return data;
  }

  async _localHash(physical) {
    return this.local.hash ? this.local.hash(physical) : this._hash(await this._read(physical));
  }

  async _ackPush(s, result) {
    const { rev, physical, bytes, staged } = s.pending;
    validateRevision(rev);
    checkPhysical(physical);
    if (rev.blob !== null) {
      if (!staged && typeof bytes !== 'string') throw new Error('Missing staged content for ' + physical);
      const data = staged ? await this.state.readStaged(rev.blob) : fromBase64(bytes);
      if (!data || data.byteLength > MAX_BYTES) throw new Error('Missing or oversized staged content for ' + physical);
      if (this._hash(data) !== rev.blob) throw new Error('Staged content checksum mismatch: ' + physical);
      await this.remote.putBlob(rev.blob, data);
    }
    // A retry always publishes the exact same document and identifier.
    await this.remote.putRevision(rev);
    s.revs.set(rev.id, rev);
    s.known.add(rev.id);
    this._bind(s, physical, rev.blob === null ? null : { path: rev.path, blob: rev.blob, parents: [rev.id] });
    if (physical === rev.path && rev.blob === null) s.absent.set(physical, [rev.id]);
    s.pending = null;
    await this._save(s);
    if (staged) await this.state.clearStaged(rev.blob);
    result.uploaded++;
  }

  async _push(s, physical, path, parents, data, result) {
    checkSize(data, physical);
    const rev = makeRevision({ path, parents, blob: this._hash(data), device: this.device });
    // Check that a new conflict, including its generated filename, is representable before publication.
    project([...s.revs.values()].filter(r => r.path === path).concat(rev));
    s.reviewed.delete(path);
    s.pending = { kind: 'push', physical, rev };
    if (data !== null && this.state.stageBlob && this.state.readStaged && this.state.clearStaged) {
      // Write bytes first. Once the journal is durable, retry needs neither the open editor nor its file.
      await this.state.stageBlob(rev.blob, data);
      s.pending.staged = true;
    } else if (data !== null) {
      s.pending.bytes = base64(data);
    }
    await this._save(s);
    await this._ackPush(s, result);
  }

  async _recover(s, result) {
    if (!s.pending) return;
    if (s.pending.kind === 'push') return this._ackPush(s, result);
    if (s.pending.kind !== 'apply') throw new Error('Unknown sync journal entry');
    const { physical, next } = s.pending;
    checkPhysical(physical);
    const actual = await this._localHash(physical);
    // The local CAS may have completed immediately before the crash. A subsequent user edit
    // does not match the staged result; keep its earlier baseline for conservative capture.
    if (actual === (next?.blob ?? null)) this._bind(s, physical, next);
    s.pending = null;
    await this._save(s);
  }

  async _resolve(s, selected, before, result) {
    checkPhysical(selected);
    const binding = s.files.get(selected);
    if (!binding) throw new Error('Select a synchronized member of a conflict and sync first');
    const path = binding.path;
    const reviewed = s.reviewed.get(path);
    const tips = before.tips.get(path) || [];
    if (!reviewed || !sameIds(reviewed, tips)) throw new Error('Conflict changed; sync and review all versions first');
    if (before.versions.get(path)?.size < 2) throw new Error('No unresolved conflict for ' + path);
    for (const [physical, v] of before.files) {
      if (v.path !== path || physical === selected) continue;
      if (this._hash(await this._read(physical)) !== v.blob) {
        throw new Error('Another conflict copy was edited or removed; sync and review it first: ' + physical);
      }
    }
    const data = await this._read(selected);
    if (data === null) throw new Error('Selected conflict file is missing: ' + selected);
    await this._push(s, selected, path, tips, data, result);
  }

  async _capture(s, before, result, deferred) {
    const listed = await this.local.list();
    const paths = new Set([...listed, ...s.files.keys()]);
    // Detect file/folder, case and Unicode collisions before publishing new filenames.
    const provisional = [];
    for (const name of listed) {
      checkPhysical(name);
      if (!isConflictPath(name) && !before.files.has(name)) {
        provisional.push(makeRevision({ path: name, parents: [], blob: '0'.repeat(64), device: this.device }));
      }
    }
    if (provisional.length) project([...s.revs.values(), ...provisional]);
    for (const physical of paths) {
      const base = s.files.get(physical);
      if (base && this.local.hash && await this._localHash(physical) === base.blob) continue;
      const data = await this._read(physical);
      checkSize(data, physical);
      const hash = this._hash(data);
      if (base) {
        if (hash !== base.blob) await this._push(s, physical, base.path, base.parents, data, result);
        continue;
      }
      if (data === null) continue;
      const remote = before.files.get(physical);
      if (remote && hash === remote.blob) {
        this._bind(s, physical, remote); // Fresh device with identical content.
      } else if (isConflictPath(physical)) {
        // A generated copy without a recorded owner cannot safely become a new logical note.
        deferred.add(physical);
      } else {
        // Independent roots preserve different pre-existing files on the first sync.
        await this._push(s, physical, physical, s.absent.get(physical) || [], data, result);
      }
    }
    await this._save(s);
  }

  async _apply(s, nextView, result, deferred) {
    const paths = new Set([...nextView.files.keys(), ...s.files.keys()]);
    for (const physical of paths) {
      if (deferred.has(physical)) continue;
      const old = s.files.get(physical);
      const next = nextView.files.get(physical) || null;
      const expected = old?.blob ?? null;
      const wanted = next?.blob ?? null;
      const actual = await this._localHash(physical);
      if (actual === wanted) {
        this._bind(s, physical, next);
        continue;
      }
      if (actual !== expected) {
        deferred.add(physical);
        continue;
      }
      const data = next ? await this.remote.getBlob(wanted) : null;
      if (this._hash(data) !== wanted) throw new Error('Downloaded content checksum mismatch for ' + physical);
      s.pending = { kind: 'apply', physical, next };
      await this._save(s);
      const applied = await this.local.compareAndSet(physical, expected, data);
      if (applied) {
        this._bind(s, physical, next);
        if (next) result.downloaded++;
        else result.deleted++;
      } else {
        deferred.add(physical); // The editor changed it after the scan. Capture on next sync.
      }
      s.pending = null;
      await this._save(s);
    }
  }

  async _run(selected) {
    const result = counts();
    const started = Date.now();
    this.stats = result.stats;
    this.local.stats = this.state.stats = result.stats;
    if (this.remote.setStats) this.remote.setStats(result.stats);
    else {
      this.remote.stats = result.stats;
      if (this.remote.request) this.remote.request.stats = result.stats;
    }
    await this.local.recover?.();
    const s = await this._open();
    await this._recover(s, result);
    const before = snapshot(s.revs);
    if (selected !== undefined) {
      await this._resolve(s, selected, before, result);
    }
    const deferred = new Set();
    await this._capture(s, selected === undefined ? before : snapshot(s.revs), result, deferred);
    const after = snapshot(s.revs);
    await this._apply(s, after, result, deferred);
    s.reviewed.clear();
    for (const [path, versions] of after.versions) {
      if (!deferred.has(path)) {
        if (versions.size === 1 && versions.has(null)) {
          // A later local recreation acknowledges only deletions already observed here.
          if (await this._localHash(path) === null) s.absent.set(path, versions.get(null));
        } else if (s.files.has(path)) {
          s.absent.delete(path);
        }
      }
      if (versions.size > 1) {
        result.conflictPaths.push(path);
        s.reviewed.set(path, after.tips.get(path));
      }
    }
    for (const physical of deferred) {
      const path = after.files.get(physical)?.path ?? s.files.get(physical)?.path ?? physical;
      s.reviewed.delete(path);
    }
    result.conflictPaths.sort();
    result.conflicts = result.conflictPaths.length;
    result.deferredPaths = [...deferred].sort();
    result.deferred = result.deferredPaths.length;
    await this._save(s);
    result.stats.durationMs = Date.now() - started;
    return result;
  }
}

module.exports = { SyncEngine };

},
"local":function(module,exports,require){
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

class DiskState {
  constructor(directory, url, user) {
    // Bind sync ancestry to both the collection and the account.
    const key = hash(JSON.stringify([new URL(url).href.replace(/\/+$/, ''), user]));
    this.file = path.join(directory, 'state-' + key + '.json');
    this.staging = path.join(directory, 'outbox-' + key);
  }
  async load() {
    const data = readBytes(this.file);
    return data === null ? null : JSON.parse(data.toString('utf8'));
  }
  async save(value) { atomicWrite(this.file, JSON.stringify(value)); }
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

},
"migration":function(module,exports,require){
'use strict';
const { DavRemote, checkedRevision } = require('./dav');
const { bytes, digest, randomUUID } = require('./bytes');
const { project } = require('./protocol');
const { ShardedStore, FORMAT_TEXT, MARKER, HASH_NAME, REV_LIMIT, parallel, validFormat, mkdir } = require('./sharded');
const BLOB_LIMIT = 512 * 1024 * 1024;
const PROGRESS_TEXT = JSON.stringify({version:2,state:'migration',layout:'sha256-prefix-1'});

async function putMarker(remote,url,content) {
  await remote.immutable(url,bytes(content),'application/json',REV_LIMIT,data=>{
    if(digest(data)!==digest(content)) throw new Error('迁移标记与预期不符。');
  });
}
function verifyObject(name,data) {
  const match=HASH_NAME.exec(name);
  if(!match) throw new Error('无效的同步对象名称。');
  if(match[2]==='json') return checkedRevision(data,match[1]);
  if(digest(data)!==match[1]) throw new Error('迁移对象的内容校验失败；对象仍保留在远端。');
  return null;
}
async function move(remote,source,destination) {
  if(source.origin!==remote.base.origin || destination.origin!==remote.base.origin) throw new Error('拒绝跨站迁移。');
  const result=await remote.call('MOVE',source,{Destination:destination.href,Overwrite:'F'},undefined,REV_LIMIT);
  if(![201,204].includes(result.status)) throw new Error('远端移动未确认：HTTP '+result.status+'；保留迁移记录后重试。');
}

// Explicit maintenance operation. Call only after all clients have paused sync.
// No DELETE is issued: each original object is moved intact; duplicate copies
// are archived. Record identities, parent links, payload bytes and local state stay unchanged.
async function migrateStorage(options,{knownIds=[],saveRevision,checkpoint=async()=>{},progress=()=>{}}={}) {
  if(typeof saveRevision!=='function') throw new Error('必须先准备版本记录的本地备份回调。');
  const legacy=new DavRemote(options), target=new ShardedStore(options,legacy);
  await legacy.probe();
  if(await legacy.propfind(legacy.folder,0,true)===null) throw new Error('旧版本目录不存在，不能推测迁移来源。');
  const existing=await legacy.read(new URL('format.json',target.folder),REV_LIMIT,true);
  if(existing!==null) {
    if(!validFormat(existing)) throw new Error('远端已有不支持的格式。');
    const rows=await target.listRevisions();
    return {alreadyComplete:true,revisions:rows.length,moved:0};
  }
  if(await legacy.read(new URL('rollback.json',target.folder),REV_LIMIT,true)!==null) throw new Error('远端回退未完成。');
  await mkdir(legacy,target.folder);
  await putMarker(legacy,new URL('migration.json',target.folder),PROGRESS_TEXT);
  await putMarker(legacy,new URL(MARKER,legacy.folder),PROGRESS_TEXT);
  let moved=0,duplicates=0,passes=0;
  const verified=new Set();
  const created=new Map();
  const ensureBucket=bucket=>{
    if(!created.has(bucket)) created.set(bucket,mkdir(legacy,new URL(bucket+'/',target.folder)));
    return created.get(bucket);
  };
  const duplicateFolder=new URL('obsidian-webdav-versions-v1-duplicates/',legacy.base);
  for (;;) {
    if(++passes>10000) throw new Error('旧客户端持续写入，迁移已暂停。');
    const listing=await legacy.propfind(legacy.folder,1);
    const names=[];
    for(const [name,dir] of listing) {
      if(name===MARKER&&!dir) continue;
      if(dir||!HASH_NAME.test(name)) throw new Error('旧目录有未知条目；未移动该条目。');
      names.push(name);
    }
    if(!names.length) break;
    // Drain a bounded batch. The next listing exposes entries hidden behind the cap.
    await parallel(names.slice(0,256),async name=>{
      const match=HASH_NAME.exec(name),limit=match[2]==='json'?REV_LIMIT:BLOB_LIMIT;
      const source=new URL(name,legacy.folder), destination=target.objectURL(match[1],'.'+match[2]);
      await ensureBucket(match[1][0]);
      if(match[2]==='json') {
        const data=await legacy.read(source,limit);verifyObject(name,data);await saveRevision(name,data);
      }
      const prior=await legacy.read(destination,limit,true);
      if(prior!==null) {
        verifyObject(name,prior);
        // Preserve a duplicate left by an old in-flight writer, without deleting it.
        const original=await legacy.read(source,limit);verifyObject(name,original);
        if(digest(original)!==digest(prior)) throw new Error('同名迁移对象存在内容差异。');
        await mkdir(legacy,duplicateFolder);
        const archivedName=randomUUID()+'-'+name;
        await move(legacy,source,new URL(archivedName,duplicateFolder));
        const archived=await legacy.read(new URL(archivedName,duplicateFolder),limit);
        if(digest(archived)!==digest(original)) throw new Error('重复对象归档校验失败。');
        duplicates++;
        await checkpoint({name,archive:archivedName,verified:true});
      } else {
        await move(legacy,source,destination);
        verifyObject(name,await legacy.read(destination,limit));
        await checkpoint({name,verified:true});
      }
      verified.add(name);moved++;progress({phase:'moving',moved,duplicates,passes});
    },2);
  }
  const objects=await target.inventory();
  // After an interrupted MOVE the source may already be absent. Reverify every
  // destination not verified in this process before declaring migration complete.
  await parallel([...objects.keys()].filter(n=>n.endsWith('.blob')&&!verified.has(n)),async name=>{
    verifyObject(name,await legacy.read(objects.get(name),BLOB_LIMIT));
  },2);
  const rows=[];
  await parallel([...objects.keys()].filter(n=>n.endsWith('.json')),async name=>{
    const data=await legacy.read(objects.get(name),REV_LIMIT);
    rows.push(verifyObject(name,data));await saveRevision(name,data);
  });
  const ids=new Set(rows.map(r=>r.id));
  if(knownIds.some(id=>!ids.has(id))) throw new Error('迁移后仍缺少本机已确认的版本；未发布新格式。');
  project(rows); // Parent closure, path collisions and revision hashes must all hold.
  for(const row of rows) if(row.blob!==null&&!objects.has(row.blob+'.blob')) throw new Error('迁移后附件不完整；未发布新格式。');
  const finalLegacy=await legacy.propfind(legacy.folder,1);
  if([...finalLegacy.keys()].some(name=>name!==MARKER)) throw new Error('旧客户端仍在写入；请暂停后重试迁移。');
  await putMarker(legacy,new URL('format.json',target.folder),FORMAT_TEXT);
  const result={version:2,moved,duplicates,revisions:rows.length,objects:objects.size,passes};
  await checkpoint({complete:true,...result});progress({phase:'complete',...result});
  return result;
}

async function rollbackStorage(options,{checkpoint=async()=>{},progress=()=>{}}={}) {
  const legacy=new DavRemote(options), target=new ShardedStore(options,legacy);
  if(await legacy.propfind(target.folder,0,true)===null) return {alreadyRolledBack:true};
  await mkdir(legacy,legacy.folder);
  await putMarker(legacy,new URL('rollback.json',target.folder),JSON.stringify({version:2,state:'rollback'}));
  const objects=await target.inventory();let moved=0;
  const archive=new URL('obsidian-webdav-layout-backup-'+randomUUID()+'/',legacy.base);
  // All objects are enumerated from small buckets; the flat destination may be capped.
  await parallel([...objects],async([name,source])=>{
    const limit=name.endsWith('.json')?REV_LIMIT:BLOB_LIMIT;
    const data=await legacy.read(source,limit);verifyObject(name,data);
    const destination=new URL(name,legacy.folder);
    const existing=await legacy.read(destination,limit,true);
    if(existing!==null) {
      if(digest(existing)!==digest(data)) throw new Error('旧路径已有不同内容，回退已暂停。');
      // Keep the duplicate in the layout archive when that directory is moved below.
    } else {
      await move(legacy,source,destination);
      if(digest(await legacy.read(destination,limit))!==digest(data)) throw new Error('回退对象校验失败。');
    }
    moved++;await checkpoint({name,restored:true});progress({phase:'rollback',moved});
  },2);
  // Archive metadata and empty directories, never recursively delete remote data.
  await move(legacy,target.folder,archive);
  if(await legacy.read(new URL(MARKER,legacy.folder),REV_LIMIT,true)!==null) {
    await move(legacy,new URL(MARKER,legacy.folder),new URL('v1-marker.json',archive));
  }
  return {restored:moved,archivedLayout:true};
}

module.exports={migrateStorage,rollbackStorage,verifyObject};

},
"mobile":function(module,exports,require){
'use strict';
const { bytes, text, arrayBuffer, digest, randomUUID } = require('./bytes');

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
  hashOf(value) {
    if (value === null) return null;
    if (this.stats) this.stats.hashBytes += bytes(value).length;
    return digest(value);
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
    if (this.hashOf(await AdapterIO.prototype.read.call(this, path)) !== this.hashOf(b)) throw new Error('本地暂存写入校验失败。');
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
        if (Number.isSafeInteger(row.sequence) && row.sequence > 0 && typeof row.payload === 'string' && this.hashOf(row.payload) === row.hash) {
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
    const encoded = JSON.stringify({ sequence: (latest?.sequence || 0) + 1, payload, hash: this.hashOf(payload) });
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
    if (this.hashOf(value) !== id) throw new Error('待上传内容校验失败。');
    await this.mkdir(this.directory);
    const target = this.blobPath(id);
    const present = await this.read(target);
    if (present !== null) {
      if (this.hashOf(present) !== id) throw new Error('待上传内容损坏；保留现场。');
      return;
    }
    const tmp = this.directory + '/writing-' + randomUUID();
    await this.writeFresh(tmp, value);
    await this.adapter.rename(tmp, target);
  }
  async readStaged(id) {
    const value = await this.read(this.blobPath(id));
    if (value === null || this.hashOf(value) !== id) throw new Error('待上传内容缺失或损坏；已停止同步。');
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
  async hash(name) { return this.hashOf(await this.read(name)); }
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
    if (previous !== null && this.hashOf(previous) !== tx.expected) {
      if (actual === null) await this.copyAbsent(this.transaction + '/previous', tx.name);
      if (await this.hash(tx.name) !== this.hashOf(previous)) throw new Error('检测到并发写入；另一份内容保存在 ' + this.transaction + '/previous');
      await this.finish(); return;
    }
    // With no moved original, an interrupted update was never applied. Keep any
    // user deletion or new contents. For a new file, exclusive copy is safe.
    if (actual === null && (previous !== null || tx.expected === null) && tx.next !== null) {
      const staged = await super.read(this.transaction + '/next');
      if (this.hashOf(staged) !== tx.next) throw new Error('本地待恢复内容校验失败。');
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
    if (this.hashOf(before) !== expected || !this.guard(name, before)) return false;
    if (this.hashOf(next) === expected) return true;
    await this.mkdir(this.privateDir);
    await this.adapter.mkdir(this.transaction);
    if (next !== null) await this.writeFresh(this.transaction + '/next', next);
    await this.writeFresh(this.transaction + '/intent.json', JSON.stringify({ name, expected, next: this.hashOf(next) }));
    this.checkActive();
    const checked = await this.read(name);
    if (this.hashOf(checked) !== expected || !this.guard(name, checked)) { await this.finish(); return false; }
    if (before !== null) {
      await this.adapter.rename(name, this.transaction + '/previous');
      if (this.hashOf(await super.read(this.transaction + '/previous')) !== expected) { await this.recover(); return false; }
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

},
"node-request":function(module,exports,require){
'use strict';
const http = require('node:http');
const https = require('node:https');
// No automatic redirect (including same-host redirects). Never send a Basic
// credential to a location returned in a response or use a server href for GET.
function nodeRequest({ url, method, headers, body, limit }) {
  return new Promise((resolve, reject) => {
    let timer;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers, rejectUnauthorized: true }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > limit) req.destroy(new Error('response size'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (!res.complete) return reject(new Error('incomplete response'));
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    timer = setTimeout(() => req.destroy(new Error('deadline')), 10 * 60_000);
    req.setTimeout(60_000, () => req.destroy(new Error('idle timeout')));
    req.end(body);
  });
}

module.exports = { nodeRequest };

},
"plugin":function(module,exports,require){
'use strict';
// Adapted from leopard530/obsidian-sync-webdav: onload commands, ribbon,
// status bar and debounced vault events. Every trigger now uses the same engine.
const { Plugin, PluginSettingTab, Setting, SecretComponent, Notice, Modal, Platform, requestUrl } = require('obsidian');
const { text } = require('./bytes');
const { MobileVault, MobileState, mobileRequest } = require('./mobile');
const { SyncEngine } = require('./engine');
const { AdaptiveDavRemote: DavRemote } = require('./sharded');

const defaults = { url: '', username: '', secret: '', device: Platform.isMobile ? (Platform.isIosApp ? 'iPhone' : 'Android') : require('node:os').hostname().split('.')[0], auto: false };
const activeVaults = Symbol.for('obsidian-webdav-versions.active');

class ResolveModal extends Modal {
  constructor(app, file, resolve) { super(app); this.file = file; this.resolve = resolve; }
  onOpen() {
    this.titleEl.setText('采用当前版本');
    this.contentEl.createEl('p', { text: '各设备将以「' + this.file + '」的已保存内容作为正文，其他已知冲突副本将从笔记列表收起。原版本仍保存在飞牛上。' });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('取消').onClick(() => this.close()))
      .addButton(b => b.setCta().setButtonText('采用此版本').onClick(() => { this.close(); void this.resolve(); }));
  }
}

class ConflictsModal extends Modal {
  constructor(app, result) { super(app); this.result = result; }
  onOpen() {
    this.titleEl.setText('同步冲突');
    if (!this.result) { this.contentEl.createEl('p', { text: '先运行一次同步以读取当前冲突。' }); return; }
    const conflicts = this.result.conflictPaths || [];
    const deferred = this.result.deferredPaths || [];
    if (!conflicts.length && !deferred.length) this.contentEl.createEl('p', { text: '最近一次同步没有待处理的文件。' });
    else this.contentEl.createEl('p', { text: '先比较正文与同目录的 sync-conflict 副本。打开要保留的版本后，运行「采用当前文件解决冲突」。若冲突来自另一台设备的删除，列表中只有仍有内容的版本。' });
    for (const name of conflicts) {
      new Setting(this.contentEl).setName(name).addButton(b => b.setButtonText('打开正文').onClick(async () => {
        const file = this.app.vault.getAbstractFileByPath(name);
        if (file) { this.close(); await this.app.workspace.getLeaf(false).openFile(file); }
      }));
    }
    for (const name of deferred) this.contentEl.createEl('p', { text: '等待同步：' + name });
  }
}

class SyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    const p = this.plugin;
    const draft = { ...p.settings };
    new Setting(el).setName('飞牛 WebDAV 版本同步').setHeading();
    new Setting(el).setName('同步状态').setDesc(p.lastError || p.statusMessage || '就绪')
      .addButton(b => b.setButtonText('立即同步').onClick(async () => { await p.run('sync', true); this.display(); }))
      .addButton(b => b.setButtonText('查看详情').onClick(() => p.openStatus()));
    if (Platform.isMobile) el.createEl('p', { text: '手机测试版：单个文件最多 128 MiB；首次接入先使用独立测试库，保持应用在前台。' });
    new Setting(el).setName('WebDAV 文件夹地址').setDesc('填写各设备共用的专用文件夹的完整 HTTPS 地址。请先在飞牛中建好该文件夹。')
      .addText(t => t.setPlaceholder('https://nas.example/笔记同步/').setValue(draft.url).onChange(v => { draft.url = v.trim(); }));
    new Setting(el).setName('用户名').addText(t => t.setValue(draft.username).onChange(v => { draft.username = v.trim(); }));
    new Setting(el).setName('WebDAV 密码').setDesc('在本机 Obsidian 的密钥存储中选择或新建一个密码。')
      .addComponent(container => new SecretComponent(this.app, container).setValue(draft.secret).onChange(v => { draft.secret = v; }));
    new Setting(el).setName('设备名称').setDesc('用于辨认冲突副本，例如 iPhone、MacBook 或 Mac mini。')
      .addText(t => t.setValue(draft.device).onChange(v => { draft.device = v.trim(); }));
    new Setting(el).setName('自动同步').setDesc('在前台打开笔记库后、文件变更约 5 秒后，以及每隔 60 秒同步。首次配置先手动同步，手机请等到已同步再离开。')
      .addToggle(t => t.setValue(draft.auto).onChange(v => { draft.auto = v; }));
    new Setting(el).addButton(b => b.setButtonText('测试连接').onClick(async () => {
      try { await p.remoteFor(draft).probe(); new Notice('已确认可读取 WebDAV 文件夹'); }
      catch (err) { new Notice('连接测试失败：' + err.message, 10000); }
    })).addButton(b => b.setButtonText('保存设置').setCta().onClick(async () => {
      try { await p.configure(draft); new Notice('已保存同步设置'); }
      catch (err) { new Notice(err.message, 10000); }
    }));
  }
}

module.exports = class WebDAVVersionsPlugin extends Plugin {
  async onload() {
    if (!this.app.secretStorage || !SecretComponent) throw new Error('请更新到 Obsidian 1.11.4 或更高版本。');
    this.settings = Object.assign({}, defaults, await this.loadData());
    this.stopped = false;
    this.ready = false;
    this.status = this.addStatusBarItem();
    this.showStatus('就绪');
    this.status.addEventListener('click', () => this.run('sync', true));
    this.addRibbonIcon('refresh-cw', '飞牛 WebDAV：立即同步', () => this.run('sync', true));
    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => this.run('sync', true) });
    this.addCommand({ id: 'sync-status', name: '查看同步状态', callback: () => this.openStatus() });
    this.addCommand({ id: 'show-conflicts', name: '查看同步冲突', callback: () => new ConflictsModal(this.app, this.result).open() });
    this.addCommand({ id: 'resolve-current', name: '采用当前文件解决冲突', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return false;
      if (!checking) new ResolveModal(this.app, file.path, () => this.run('resolve', true, file.path)).open();
      return true;
    } });
    this.addSettingTab(new SyncSettings(this.app, this));

    for (const event of ['create', 'modify', 'rename', 'delete']) {
      this.registerEvent(this.app.vault.on(event, (file, previous) => {
        if (this.visible(file.path) || (previous && this.visible(previous))) this.schedule();
      }));
    }
    this.registerDomEvent(window, 'online', () => this.schedule(1000));
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (this.isActive()) this.schedule(1000);
      else window.clearTimeout(this.timer);
    });
    this.registerInterval(window.setInterval(() => this.autoSync(), 60_000));
    this.app.workspace.onLayoutReady(() => { this.ready = true; this.schedule(1200); });
  }
  visible(name) {
    const parts = name.split('/');
    return parts[0] !== this.app.vault.configDir && parts.every(p => p && !p.startsWith('.'));
  }
  remoteFor(s) {
    if (!s.url || !s.username || !s.secret || !s.device) throw new Error('请先填写地址、用户名、密钥和设备名称。');
    if (s.device.length > 64 || /[\u0000-\u001f]/.test(s.device)) throw new Error('请使用简短的设备名称。');
    const password = this.app.secretStorage.getSecret(s.secret);
    if (!password) throw new Error('本机尚未配置所选 WebDAV 密码。');
    return new DavRemote({ url: s.url, username: s.username, password, ...(Platform.isMobile ? { request: mobileRequest(requestUrl, () => this.isActive()) } : {}) });
  }
  async configure(draft) {
    if (this.busy || this.configuring) throw new Error('请等当前操作完成再保存设置。');
    this.configuring = true;
    try {
      this.remoteFor(draft);
      await this.saveData({ ...draft });
      this.settings = { ...draft };
      this.engine = null;
      this.result = null;
      this.lastError = '';
      this.showStatus('就绪');
      this.schedule();
    } finally { this.configuring = false; }
  }
  editorMatches(name, bytes) {
    if (this.stopped) return false;
    // A buffer with unsaved typing may be newer than the filesystem snapshot.
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view.file?.path === name && view.getMode?.() === 'source' && view.editor) {
        if (!bytes || view.editor.getValue() !== text(bytes).replace(/\r\n/g, '\n')) return false;
      }
    }
    return true;
  }
  getEngine() {
    if (this.engine) return this.engine;
    const s = this.settings;
    const remote = this.remoteFor(s);
    const guard = (p, b) => this.editorMatches(p, b);
    let local, state;
    if (Platform.isMobile) {
      local = new MobileVault(this.app.vault.adapter, this.app.vault.configDir, guard, () => this.isActive());
      state = new MobileState(this.app.vault.adapter, local.privateDir, s.url, s.username);
    } else {
      const { DiskVault, DiskState } = require('./local');
      local = new DiskVault(this.app.vault.adapter.getBasePath(), this.app.vault.configDir, guard);
      state = new DiskState(local.privateDir, s.url, s.username);
    }
    this.engine = new SyncEngine({ remote, local, state, device: s.device });
    return this.engine;
  }
  schedule(delay = 5000) {
    window.clearTimeout(this.timer);
    if (this.ready && this.settings.auto && !this.stopped) this.timer = window.setTimeout(() => this.autoSync(), delay);
  }
  autoSync() { if (this.ready && this.settings.auto && this.isActive() && !this.busy) void this.run('sync', false); }
  isActive() { return !this.stopped && (!Platform.isMobile || document.visibilityState !== 'hidden'); }
  openStatus() {
    const modal = new Modal(this.app);
    modal.titleEl.setText('飞牛同步状态');
    modal.contentEl.createEl('p', { text: this.statusMessage || '就绪' });
    if (this.lastError) modal.contentEl.createEl('p', { text: this.lastError });
    if (this.result) {
      const r = this.result;
      modal.contentEl.createEl('p', { text: `最近一轮：上传 ${r.uploaded}，下载 ${r.downloaded}，删除 ${r.deleted}，冲突 ${r.conflicts}，待处理 ${r.deferred}。` });
    }
    if (this.result?.stats) {
      const s = this.result.stats;
      modal.contentEl.createEl('p', { text: `${s.full ? '全量' : '增量'}同步：耗时 ${s.durationMs} 毫秒，读取库内文件 ${s.vaultReads} 次，内容及状态哈希 ${s.hashBytes} 字节，HTTP 请求 ${s.httpRequests} 次。` });
    }
    new Setting(modal.contentEl).addButton(b => b.setButtonText('立即同步').onClick(async () => { modal.close(); await this.run('sync', true); this.openStatus(); }));
    modal.open();
  }
  showStatus(message) {
    this.statusMessage = message;
    this.status.setText('WebDAV · ' + message);
    this.status.setAttribute('aria-label', this.lastError || message);
  }
  async run(mode, notify, file) {
    if (!this.isActive() || !this.ready || this.configuring) return;
    const lock = globalThis[activeVaults] ||= new Set();
    const key = this.app.vault.adapter;
    if (lock.has(key)) { if (notify) new Notice('正在同步，请等待完成'); return; }
    lock.add(key);
    this.busy = true;
    try {
      this.showStatus('同步中');
      if (this.app.plugins?.enabledPlugins?.has('obsidian-sync-webdav')) throw new Error('请先停用旧版 WebDAV Sync，再运行版本同步。');
      const engine = this.getEngine();
      if (mode === 'resolve' && !this.editorMatches(file, await engine.local.read(file))) {
        throw new Error('这篇笔记还有正在保存的修改，请稍后再采用此版本。');
      }
      const r = mode === 'resolve' ? await engine.resolve(file) : await engine.sync();
      this.result = r;
      this.lastError = '';
      const message = r.deferred ? '有更改待下轮同步' : r.conflicts ? '有 ' + r.conflicts + ' 组冲突' : '已同步';
      if (!this.stopped) this.showStatus(message);
      if (notify && !this.stopped) new Notice(message);
    } catch (err) {
      if (this.stopped) return;
      const message = String(err.message || err);
      if (notify || this.lastError !== message) new Notice('WebDAV：' + message, 10000);
      this.lastError = message;
      this.showStatus('同步暂停');
    } finally { this.busy = false; lock.delete(key); }
  }
  onunload() {
    this.stopped = true;
    window.clearTimeout(this.timer);
  }
};

},
"protocol":function(module,exports,require){
'use strict';

const { digest, randomUUID, byteLength } = require('./bytes');

const HASH = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SURROGATE = /[\uD800-\uDFFF]/u; // With /u, valid pairs are a single non-surrogate code point.
const CONFLICT = / \(sync-conflict /iu;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function isConflictPath(path) {
  return typeof path === 'string' && CONFLICT.test(path);
}

function safePath(path) {
  if (typeof path !== 'string' || !path || CONTROL.test(path) || SURROGATE.test(path) ||
      path.includes('\\') || /^[A-Za-z]:/u.test(path) || isConflictPath(path) || byteLength(path) > 4095) {
    throw new Error('Unsafe or reserved vault path: ' + JSON.stringify(path));
  }
  for (const part of path.split('/')) {
    if (!part || part.startsWith('.') || /[. ]$/u.test(part) || byteLength(part) > 255) {
      throw new Error('Unsafe vault path segment: ' + JSON.stringify(path));
    }
  }
  return path;
}

function checkText(value, name, maxBytes) {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value) ||
      SURROGATE.test(value) || byteLength(value) > maxBytes) {
    throw new Error('Invalid revision ' + name);
  }
}

function revisionId({ path, parents, blob, device, nonce }) {
  return digest(JSON.stringify(['obsidian-webdav-versions/v1', path, parents, blob, device, nonce]));
}

function validateRevision(rev) {
  if (!rev || typeof rev !== 'object' || Array.isArray(rev) ||
      Object.keys(rev).sort().join(',') !== 'blob,device,id,nonce,parents,path') {
    throw new Error('Invalid revision fields');
  }
  safePath(rev.path);
  checkText(rev.device, 'device', 256);
  checkText(rev.nonce, 'nonce', 256);
  if (!(rev.blob === null || (typeof rev.blob === 'string' && HASH.test(rev.blob)))) {
    throw new Error('Invalid revision blob digest');
  }
  if (!Array.isArray(rev.parents)) throw new Error('Invalid revision parents');
  for (let i = 0; i < rev.parents.length; i++) {
    const p = rev.parents[i];
    if (typeof p !== 'string' || !HASH.test(p) || (i > 0 && p <= rev.parents[i - 1])) {
      throw new Error('Invalid revision parent digest or ordering');
    }
  }
  if (rev.id !== revisionId(rev)) throw new Error('Revision checksum mismatch');
  return rev;
}

function makeRevision({ path, parents = [], blob, device, nonce = randomUUID() }) {
  if (!Array.isArray(parents)) throw new Error('Invalid revision parents');
  const rev = { path, parents: [...new Set(parents)].sort(compare), blob, device, nonce };
  rev.id = revisionId(rev);
  return validateRevision(rev);
}

function indexRevisions(revisions) {
  const byId = new Map();
  const leaves = new Map();
  for (const rev of revisions) {
    validateRevision(rev);
    if (byId.has(rev.id)) continue;
    byId.set(rev.id, rev);
    if (!leaves.has(rev.path)) leaves.set(rev.path, new Set());
    leaves.get(rev.path).add(rev.id);
  }
  for (const rev of byId.values()) {
    for (const parent of rev.parents) {
      const base = byId.get(parent);
      if (!base) throw new Error('Missing parent revision: ' + parent);
      if (base.path !== rev.path) throw new Error('Parent belongs to a different logical path');
      leaves.get(rev.path).delete(parent);
    }
  }
  return { byId, leaves };
}

function headsFor(revisions, path) {
  safePath(path);
  // Filter before hashing: callers often ask about each locally modified file.
  const samePath = [];
  for (const rev of revisions) if (rev.path === path) samePath.push(rev);
  const { leaves } = indexRevisions(samePath);
  return [...(leaves.get(path) || [])].sort(compare);
}

function truncate(text, maxBytes) {
  let bytes = 0;
  let result = '';
  for (const ch of text) {
    bytes += byteLength(ch);
    if (bytes > maxBytes) break;
    result += ch;
  }
  return result;
}

function conflictName(path, rev) {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const label = truncate(rev.device.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-'), 28) || 'device';
  const suffix = ' (sync-conflict ' + label + ' ' + rev.id + ')' + extension;
  const budget = 255 - byteLength(suffix);
  const shortStem = truncate(stem, budget);
  if (!shortStem) throw new Error('Cannot represent a conflict filename for ' + path);
  const sibling = path.slice(0, slash + 1) + shortStem + suffix;
  if (byteLength(sibling) > 4095) throw new Error('Conflict path exceeds the supported length: ' + path);
  return sibling;
}

function folded(part) {
  // Conservative comparison for case-insensitive macOS volumes and decomposed Unicode.
  return part.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
}

function registerPath(used, path) {
  let spelling = '';
  let key = '';
  const pieces = path.split('/');
  for (const [i, part] of pieces.entries()) {
    spelling += '/' + part;
    key += '/' + folded(part);
    const directory = i + 1 < pieces.length;
    const prior = used.get(key);
    if (prior && (!directory || !prior.directory || prior.spelling !== spelling)) {
      throw new Error('Vault path collision: ' + prior.spelling.slice(1) + ' / ' + path);
    }
    used.set(key, { spelling, directory });
  }
}

function project(revisions) {
  const { byId, leaves } = indexRevisions(revisions);
  const used = new Map();
  const result = new Map();
  for (const path of [...leaves.keys()].sort(compare)) {
    const displayed = new Set();
    for (const id of [...leaves.get(path)].sort(compare)) {
      const rev = byId.get(id);
      // Keep tombstones and equal-content branches in the DAG, not as extra files.
      if (rev.blob === null || displayed.has(rev.blob)) continue;
      const conflict = displayed.size > 0;
      const physical = conflict ? conflictName(path, rev) : path;
      registerPath(used, physical);
      result.set(physical, { path, id, blob: rev.blob, conflict });
      displayed.add(rev.blob);
    }
  }
  return result;
}

module.exports = { makeRevision, validateRevision, digest, project, headsFor, safePath, isConflictPath };

},
"sharded":function(module,exports,require){
'use strict';
const { DavRemote, checkedRevision } = require('./dav');
const { bytes, text, digest } = require('./bytes');
const V2_NAMESPACE = 'obsidian-webdav-versions-v2';
const FORMAT = { version: 2, layout: 'sha256-prefix-1' };
const FORMAT_TEXT = JSON.stringify(FORMAT);
const MARKER = 'storage-v2.json';
const REV_LIMIT = 1024 * 1024;
const HASH_NAME = /^([a-f0-9]{64})\.(json|blob)$/;
const HEX = /^[a-f0-9]$/;

async function parallel(items, action, count = 4) {
  let next = 0, error;
  await Promise.all(Array.from({length:Math.min(count,items.length)},async()=>{
    while (!error && next < items.length) {
      const item=items[next++];
      try { await action(item); } catch(e) { error ||= e; }
    }
  }));
  if (error) throw error;
}
function validFormat(data) {
  try { const f=JSON.parse(text(data)); return f.version===2 && f.layout==='sha256-prefix-1' && Object.keys(f).length===2; }
  catch { return false; }
}
async function mkdir(remote, url) {
  if (await remote.propfind(url,0,true)!==null) return;
  const r=await remote.call('MKCOL',url,{},undefined,REV_LIMIT);
  if (![200,201,204,405].includes(r.status)) throw new Error('无法创建分目录存储：HTTP '+r.status);
  await remote.propfind(url,0);
}

class ShardedStore extends DavRemote {
  constructor(options, legacy) {
    super(options); this.folder=new URL(V2_NAMESPACE+'/',this.base); this.legacy=legacy;
    this.buckets=new Set();
  }
  objectURL(id,suffix) {
    if (!/^[a-f0-9]{64}$/.test(id) || !['.json','.blob'].includes(suffix)) throw new Error('无效的对象标识。');
    return new URL(id[0]+'/'+id+suffix,this.folder);
  }
  async ensureFolder() {
    const format=await this.read(new URL('format.json',this.folder),REV_LIMIT,true);
    if (!format || !validFormat(format)) throw new Error('远端分目录存储尚未完成迁移。');
    this.created=true;
  }
  async immutable(url,data,type,limit,verify) {
    const name=url.pathname.slice(this.folder.pathname.length).split('/')[0];
    if (!HEX.test(name)) throw new Error('无效的分目录对象路径。');
    if (!this.buckets.has(name)) {await mkdir(this,new URL(name+'/',this.folder));this.buckets.add(name);}
    return super.immutable(url,data,type,limit,verify);
  }
  async inventory() {
    const root=await this.propfind(this.folder,1);
    const buckets=[];
    for(const [name,dir] of root) {
      if(dir && HEX.test(name)) buckets.push(name);
      else if(!dir && ['format.json','migration.json','rollback.json'].includes(name)) continue;
      else throw new Error('分目录存储存在未知条目；已暂停。');
    }
    const objects=new Map();
    await parallel(buckets,async bucket=>{
      const listed=await this.propfind(new URL(bucket+'/',this.folder),1);
      if(listed.size>=10000) throw new Error('分目录清单达到 10000 项；请扩展分桶后继续。');
      for(const [name,dir] of listed) {
        const m=HASH_NAME.exec(name);
        if(dir || !m || m[1][0]!==bucket || objects.has(name)) throw new Error('分目录对象路径无效或重复。');
        objects.set(name,new URL(bucket+'/'+name,this.folder));
      }
      this.buckets.add(bucket);
    });
    return objects;
  }
  async listRevisions() {
    const rollback=await this.read(new URL('rollback.json',this.folder),REV_LIMIT,true);
    if(rollback!==null) throw new Error('远端正在回退存储布局；已暂停。');
    const leftovers=await this.legacy.propfind(this.legacy.folder,1,true);
    if(leftovers && [...leftovers].some(([name,dir])=>name!==MARKER || dir)) {
      throw new Error('旧目录仍有同步对象；请暂停旧客户端并完成迁移，避免遗漏旧端写入。');
    }
    const objects=await this.inventory();
    const ids=[...objects.keys()].filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5));
    for(const id of this.revisions.keys()) if(!objects.has(id+'.json')) throw new Error('远端缺少以前确认的版本；已停止同步。');
    await parallel(ids.filter(id=>!this.revisions.has(id)),async id=>{
      this.revisions.set(id,checkedRevision(await this.read(objects.get(id+'.json'),REV_LIMIT),id));
    });
    const result=ids.map(id=>this.revisions.get(id));
    for(const rev of result) if(rev.blob!==null&&!objects.has(rev.blob+'.blob')) throw new Error('远端版本引用的附件缺失；已停止同步。');
    return structuredClone(result);
  }
}

class AdaptiveDavRemote {
  constructor(options) {
    this.options=options;this.legacy=new DavRemote(options);this.sharded=new ShardedStore(options,this.legacy);
    this.selected=null;
  }
  setStats(stats) {
    for (const remote of [this.legacy, this.sharded]) {
      remote.stats = stats;
      remote.request.stats = stats;
    }
  }
  async select() {
    const r=this.legacy, folder=this.sharded.folder;
    if(await r.read(new URL('rollback.json',folder),REV_LIMIT,true)!==null) throw new Error('远端正在回退存储布局；已暂停。');
    const format=await r.read(new URL('format.json',folder),REV_LIMIT,true);
    if(format!==null) {
      if(!validFormat(format)) throw new Error('不支持的远端存储格式。');
      this.selected=this.sharded;return this.selected;
    }
    if(await r.propfind(folder,0,true)!==null) throw new Error('远端分目录存储迁移未完成；请完成迁移或回退。');
    this.selected=this.legacy;return this.selected;
  }
  probe() {return this.legacy.probe();}
  async listRevisions() {return (await this.select()).listRevisions();}
  async getBlob(id) {return (this.selected||await this.select()).getBlob(id);}
  async putBlob(id,data) {return (this.selected||await this.select()).putBlob(id,data);}
  async putRevision(rev) {return (this.selected||await this.select()).putRevision(rev);}
}

module.exports={AdaptiveDavRemote,ShardedStore,V2_NAMESPACE,FORMAT,FORMAT_TEXT,MARKER,HASH_NAME,REV_LIMIT,parallel,validFormat,mkdir};

},
"vendor/sax":function(module,exports,require){
;(function (sax) {
  // wrapper for non-node envs
  sax.parser = function (strict, opt) {
    return new SAXParser(strict, opt)
  }
  sax.SAXParser = SAXParser
  sax.SAXStream = SAXStream
  sax.createStream = createStream

  // When we pass the MAX_BUFFER_LENGTH position, start checking for buffer overruns.
  // When we check, schedule the next check for MAX_BUFFER_LENGTH - (max(buffer lengths)),
  // since that's the earliest that a buffer overrun could occur.  This way, checks are
  // as rare as required, but as often as necessary to ensure never crossing this bound.
  // Furthermore, buffers are only tested at most once per write(), so passing a very
  // large string into write() might have undesirable effects, but this is manageable by
  // the caller, so it is assumed to be safe.  Thus, a call to write() may, in the extreme
  // edge case, result in creating at most one complete copy of the string passed in.
  // Set to Infinity to have unlimited buffers.
  sax.MAX_BUFFER_LENGTH = 64 * 1024

  var buffers = [
    'comment',
    'sgmlDecl',
    'textNode',
    'tagName',
    'doctype',
    'procInstName',
    'procInstBody',
    'entity',
    'attribName',
    'attribValue',
    'cdata',
    'script',
  ]

  sax.EVENTS = [
    'text',
    'processinginstruction',
    'sgmldeclaration',
    'doctype',
    'comment',
    'opentagstart',
    'attribute',
    'opentag',
    'closetag',
    'opencdata',
    'cdata',
    'closecdata',
    'error',
    'end',
    'ready',
    'script',
    'opennamespace',
    'closenamespace',
  ]

  function SAXParser(strict, opt) {
    if (!(this instanceof SAXParser)) {
      return new SAXParser(strict, opt)
    }

    var parser = this
    clearBuffers(parser)
    parser.q = parser.c = ''
    parser.bufferCheckPosition = sax.MAX_BUFFER_LENGTH
    parser.encoding = null;
    parser.opt = opt || {}
    parser.opt.lowercase = parser.opt.lowercase || parser.opt.lowercasetags
    parser.looseCase = parser.opt.lowercase ? 'toLowerCase' : 'toUpperCase'
    parser.opt.maxEntityCount = parser.opt.maxEntityCount || 512
    parser.opt.maxEntityDepth = parser.opt.maxEntityDepth || 4
    parser.entityCount = parser.entityDepth = 0
    parser.tags = []
    parser.closed = parser.closedRoot = parser.sawRoot = false
    parser.tag = parser.error = null
    parser.strict = !!strict
    parser.noscript = !!(strict || parser.opt.noscript)
    parser.state = S.BEGIN
    parser.strictEntities = parser.opt.strictEntities
    parser.ENTITIES =
      parser.strictEntities ?
        Object.create(sax.XML_ENTITIES)
      : Object.create(sax.ENTITIES)
    parser.attribList = []

    // namespaces form a prototype chain.
    // it always points at the current tag,
    // which protos to its parent tag.
    if (parser.opt.xmlns) {
      parser.ns = Object.create(rootNS)
    }

    // disallow unquoted attribute values if not otherwise configured
    // and strict mode is true
    if (parser.opt.unquotedAttributeValues === undefined) {
      parser.opt.unquotedAttributeValues = !strict
    }

    // mostly just for error reporting
    parser.trackPosition = parser.opt.position !== false
    if (parser.trackPosition) {
      parser.position = parser.line = parser.column = 0
    }
    emit(parser, 'onready')
  }

  if (!Object.create) {
    Object.create = function (o) {
      function F() {}
      F.prototype = o
      var newf = new F()
      return newf
    }
  }

  if (!Object.keys) {
    Object.keys = function (o) {
      var a = []
      for (var i in o) if (o.hasOwnProperty(i)) a.push(i)
      return a
    }
  }

  function checkBufferLength(parser) {
    var maxAllowed = Math.max(sax.MAX_BUFFER_LENGTH, 10)
    var maxActual = 0
    for (var i = 0, l = buffers.length; i < l; i++) {
      var len = parser[buffers[i]].length
      if (len > maxAllowed) {
        // Text/cdata nodes can get big, and since they're buffered,
        // we can get here under normal conditions.
        // Avoid issues by emitting the text node now,
        // so at least it won't get any bigger.
        switch (buffers[i]) {
          case 'textNode':
            closeText(parser)
            break

          case 'cdata':
            emitNode(parser, 'oncdata', parser.cdata)
            parser.cdata = ''
            break

          case 'script':
            emitNode(parser, 'onscript', parser.script)
            parser.script = ''
            break

          default:
            error(parser, 'Max buffer length exceeded: ' + buffers[i])
        }
      }
      maxActual = Math.max(maxActual, len)
    }
    // schedule the next check for the earliest possible buffer overrun.
    var m = sax.MAX_BUFFER_LENGTH - maxActual
    parser.bufferCheckPosition = m + parser.position
  }

  function clearBuffers(parser) {
    for (var i = 0, l = buffers.length; i < l; i++) {
      parser[buffers[i]] = ''
    }
  }

  function flushBuffers(parser) {
    closeText(parser)
    if (parser.cdata !== '') {
      emitNode(parser, 'oncdata', parser.cdata)
      parser.cdata = ''
    }
    if (parser.script !== '') {
      emitNode(parser, 'onscript', parser.script)
      parser.script = ''
    }
  }

  SAXParser.prototype = {
    end: function () {
      end(this)
    },
    write: write,
    resume: function () {
      this.error = null
      return this
    },
    close: function () {
      return this.write(null)
    },
    flush: function () {
      flushBuffers(this)
    },
  }

  var Stream
  try {
    Stream = require('stream').Stream
  } catch (ex) {
    Stream = function () {}
  }
  if (!Stream) Stream = function () {}

  var streamWraps = sax.EVENTS.filter(function (ev) {
    return ev !== 'error' && ev !== 'end'
  })

  function createStream(strict, opt) {
    return new SAXStream(strict, opt)
  }

  function determineBufferEncoding(data, isEnd) {
    // BOM-based detection is the most reliable signal when present.
    if (data.length >= 2) {
      if (data[0] === 0xff && data[1] === 0xfe) {
        return 'utf-16le'
      }

      if (data[0] === 0xfe && data[1] === 0xff) {
        return 'utf-16be'
      }
    }

    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
      return 'utf8'
    }

    if (data.length >= 4) {
      // XML documents without a BOM still start with "<?xml", which is enough
      // to distinguish UTF-16LE/BE from UTF-8 by looking at the zero bytes.
      if (data[0] === 0x3c && data[1] === 0x00 && data[2] === 0x3f && data[3] === 0x00) {
        return 'utf-16le'
      }

      if (data[0] === 0x00 && data[1] === 0x3c && data[2] === 0x00 && data[3] === 0x3f) {
        return 'utf-16be'
      }

      return 'utf8'
    }

    return isEnd ? 'utf8' : null
  }

  function SAXStream(strict, opt) {
    if (!(this instanceof SAXStream)) {
      return new SAXStream(strict, opt)
    }

    Stream.apply(this)

    this._parser = new SAXParser(strict, opt)
    this.writable = true
    this.readable = true

    var me = this

    this._parser.onend = function () {
      me.emit('end')
    }

    this._parser.onerror = function (er) {
      me.emit('error', er)

      // if didn't throw, then means error was handled.
      // go ahead and clear error, so we can write again.
      me._parser.error = null
    }

    this._decoder = null
    this._decoderBuffer = null
    streamWraps.forEach(function (ev) {
      Object.defineProperty(me, 'on' + ev, {
        get: function () {
          return me._parser['on' + ev]
        },
        set: function (h) {
          if (!h) {
            me.removeAllListeners(ev)
            me._parser['on' + ev] = h
            return h
          }
          me.on(ev, h)
        },
        enumerable: true,
        configurable: false,
      })
    })
  }

  SAXStream.prototype = Object.create(Stream.prototype, {
    constructor: {
      value: SAXStream,
    },
  })

  SAXStream.prototype._decodeBuffer = function (data, isEnd) {
    if (this._decoderBuffer) {
      // Keep incomplete leading bytes until we have enough data to infer the
      // stream encoding, then decode the buffered prefix together with the next chunk.
      data = Buffer.concat([this._decoderBuffer, data])
      this._decoderBuffer = null
    }

    if (!this._decoder) {
      var encoding = determineBufferEncoding(data, isEnd)
      if (!encoding) {
        // A very short first chunk may not contain enough bytes to detect the
        // encoding yet, so defer decoding until the next write/end call.
        this._decoderBuffer = data
        return ''
      }

      // Store the detected transport encoding so strict mode can compare it
      // with the optional encoding declared in the XML prolog later on.
      this._parser.encoding = encoding
      this._decoder = new TextDecoder(encoding)
    }

    return this._decoder.decode(data, { stream: !isEnd })
  }

  SAXStream.prototype.write = function (data) {
    if (
      typeof Buffer === 'function' &&
      typeof Buffer.isBuffer === 'function' &&
      Buffer.isBuffer(data)
    ) {
      data = this._decodeBuffer(data, false)
    } else if (this._decoderBuffer) {
      // Flush any buffered binary prefix before handling a string chunk.
      // This only matters if the caller mixes Buffer and string writes (used in test).
      var remaining = this._decodeBuffer(Buffer.alloc(0), true)
      if (remaining) {
        this._parser.write(remaining)
        this.emit('data', remaining)
      }
    }

    this._parser.write(data.toString())
    this.emit('data', data)
    return true
  }

  SAXStream.prototype.end = function (chunk) {
    if (chunk && chunk.length) {
      this.write(chunk)
    }
    // Flush any remaining decoded data from the TextDecoder
    if (this._decoderBuffer) {
      var finalChunk = this._decodeBuffer(Buffer.alloc(0), true)
      if (finalChunk) {
        this._parser.write(finalChunk)
        this.emit('data', finalChunk)
      }
    } else if (this._decoder) {
      var remaining = this._decoder.decode()
      if (remaining) {
        this._parser.write(remaining)
        this.emit('data', remaining)
      }
    }
    this._parser.end()
    return true
  }

  SAXStream.prototype.on = function (ev, handler) {
    var me = this
    if (!me._parser['on' + ev] && streamWraps.indexOf(ev) !== -1) {
      me._parser['on' + ev] = function () {
        var args =
          arguments.length === 1 ?
            [arguments[0]]
          : Array.apply(null, arguments)
        args.splice(0, 0, ev)
        me.emit.apply(me, args)
      }
    }

    return Stream.prototype.on.call(me, ev, handler)
  }

  // this really needs to be replaced with character classes.
  // XML allows all manner of ridiculous numbers and digits.
  var CDATAre = /^\[CDATA\[$/i
  var DOCTYPEre = /^DOCTYPE$/i
  var XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
  var XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
  var rootNS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE }

  // http://www.w3.org/TR/REC-xml/#NT-NameStartChar
  // This implementation works on strings, a single character at a time
  // as such, it cannot ever support astral-plane characters (10000-EFFFF)
  // without a significant breaking change to either this  parser, or the
  // JavaScript language.  Implementation of an emoji-capable xml parser
  // is left as an exercise for the reader.
  var nameStart =
    /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/

  var nameBody =
    /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/

  var entityStart =
    /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/
  var entityBody =
    /[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/

  function isWhitespace(c) {
    return c === ' ' || c === '\n' || c === '\r' || c === '\t'
  }

  function isQuote(c) {
    return c === '"' || c === "'"
  }

  function isAttribEnd(c) {
    return c === '>' || isWhitespace(c)
  }

  function isMatch(regex, c) {
    return regex.test(c)
  }

  function notMatch(regex, c) {
    return !isMatch(regex, c)
  }

  var S = 0
  sax.STATE = {
    BEGIN: S++, // leading byte order mark or whitespace
    BEGIN_WHITESPACE: S++, // leading whitespace
    TEXT: S++, // general stuff
    TEXT_ENTITY: S++, // &amp and such.
    OPEN_WAKA: S++, // <
    SGML_DECL: S++, // <!BLARG
    SGML_DECL_QUOTED: S++, // <!BLARG foo "bar
    DOCTYPE: S++, // <!DOCTYPE
    DOCTYPE_QUOTED: S++, // <!DOCTYPE "//blah
    DOCTYPE_DTD: S++, // <!DOCTYPE "//blah" [ ...
    DOCTYPE_DTD_QUOTED: S++, // <!DOCTYPE "//blah" [ "foo
    COMMENT_STARTING: S++, // <!-
    COMMENT: S++, // <!--
    COMMENT_ENDING: S++, // <!-- blah -
    COMMENT_ENDED: S++, // <!-- blah --
    CDATA: S++, // <![CDATA[ something
    CDATA_ENDING: S++, // ]
    CDATA_ENDING_2: S++, // ]]
    PROC_INST: S++, // <?hi
    PROC_INST_BODY: S++, // <?hi there
    PROC_INST_ENDING: S++, // <?hi "there" ?
    OPEN_TAG: S++, // <strong
    OPEN_TAG_SLASH: S++, // <strong /
    ATTRIB: S++, // <a
    ATTRIB_NAME: S++, // <a foo
    ATTRIB_NAME_SAW_WHITE: S++, // <a foo _
    ATTRIB_VALUE: S++, // <a foo=
    ATTRIB_VALUE_QUOTED: S++, // <a foo="bar
    ATTRIB_VALUE_CLOSED: S++, // <a foo="bar"
    ATTRIB_VALUE_UNQUOTED: S++, // <a foo=bar
    ATTRIB_VALUE_ENTITY_Q: S++, // <foo bar="&quot;"
    ATTRIB_VALUE_ENTITY_U: S++, // <foo bar=&quot
    CLOSE_TAG: S++, // </a
    CLOSE_TAG_SAW_WHITE: S++, // </a   >
    SCRIPT: S++, // <script> ...
    SCRIPT_ENDING: S++, // <script> ... <
  }

  sax.XML_ENTITIES = Object.assign(Object.create(null), {
    amp: '&',
    gt: '>',
    lt: '<',
    quot: '"',
    apos: "'",
  })

  sax.ENTITIES = Object.assign(Object.create(null), {
    amp: '&',
    gt: '>',
    lt: '<',
    quot: '"',
    apos: "'",
    AElig: 198,
    Aacute: 193,
    Acirc: 194,
    Agrave: 192,
    Aring: 197,
    Atilde: 195,
    Auml: 196,
    Ccedil: 199,
    ETH: 208,
    Eacute: 201,
    Ecirc: 202,
    Egrave: 200,
    Euml: 203,
    Iacute: 205,
    Icirc: 206,
    Igrave: 204,
    Iuml: 207,
    Ntilde: 209,
    Oacute: 211,
    Ocirc: 212,
    Ograve: 210,
    Oslash: 216,
    Otilde: 213,
    Ouml: 214,
    THORN: 222,
    Uacute: 218,
    Ucirc: 219,
    Ugrave: 217,
    Uuml: 220,
    Yacute: 221,
    aacute: 225,
    acirc: 226,
    aelig: 230,
    agrave: 224,
    aring: 229,
    atilde: 227,
    auml: 228,
    ccedil: 231,
    eacute: 233,
    ecirc: 234,
    egrave: 232,
    eth: 240,
    euml: 235,
    iacute: 237,
    icirc: 238,
    igrave: 236,
    iuml: 239,
    ntilde: 241,
    oacute: 243,
    ocirc: 244,
    ograve: 242,
    oslash: 248,
    otilde: 245,
    ouml: 246,
    szlig: 223,
    thorn: 254,
    uacute: 250,
    ucirc: 251,
    ugrave: 249,
    uuml: 252,
    yacute: 253,
    yuml: 255,
    copy: 169,
    reg: 174,
    nbsp: 160,
    iexcl: 161,
    cent: 162,
    pound: 163,
    curren: 164,
    yen: 165,
    brvbar: 166,
    sect: 167,
    uml: 168,
    ordf: 170,
    laquo: 171,
    not: 172,
    shy: 173,
    macr: 175,
    deg: 176,
    plusmn: 177,
    sup1: 185,
    sup2: 178,
    sup3: 179,
    acute: 180,
    micro: 181,
    para: 182,
    middot: 183,
    cedil: 184,
    ordm: 186,
    raquo: 187,
    frac14: 188,
    frac12: 189,
    frac34: 190,
    iquest: 191,
    times: 215,
    divide: 247,
    OElig: 338,
    oelig: 339,
    Scaron: 352,
    scaron: 353,
    Yuml: 376,
    fnof: 402,
    circ: 710,
    tilde: 732,
    Alpha: 913,
    Beta: 914,
    Gamma: 915,
    Delta: 916,
    Epsilon: 917,
    Zeta: 918,
    Eta: 919,
    Theta: 920,
    Iota: 921,
    Kappa: 922,
    Lambda: 923,
    Mu: 924,
    Nu: 925,
    Xi: 926,
    Omicron: 927,
    Pi: 928,
    Rho: 929,
    Sigma: 931,
    Tau: 932,
    Upsilon: 933,
    Phi: 934,
    Chi: 935,
    Psi: 936,
    Omega: 937,
    alpha: 945,
    beta: 946,
    gamma: 947,
    delta: 948,
    epsilon: 949,
    zeta: 950,
    eta: 951,
    theta: 952,
    iota: 953,
    kappa: 954,
    lambda: 955,
    mu: 956,
    nu: 957,
    xi: 958,
    omicron: 959,
    pi: 960,
    rho: 961,
    sigmaf: 962,
    sigma: 963,
    tau: 964,
    upsilon: 965,
    phi: 966,
    chi: 967,
    psi: 968,
    omega: 969,
    thetasym: 977,
    upsih: 978,
    piv: 982,
    ensp: 8194,
    emsp: 8195,
    thinsp: 8201,
    zwnj: 8204,
    zwj: 8205,
    lrm: 8206,
    rlm: 8207,
    ndash: 8211,
    mdash: 8212,
    lsquo: 8216,
    rsquo: 8217,
    sbquo: 8218,
    ldquo: 8220,
    rdquo: 8221,
    bdquo: 8222,
    dagger: 8224,
    Dagger: 8225,
    bull: 8226,
    hellip: 8230,
    permil: 8240,
    prime: 8242,
    Prime: 8243,
    lsaquo: 8249,
    rsaquo: 8250,
    oline: 8254,
    frasl: 8260,
    euro: 8364,
    image: 8465,
    weierp: 8472,
    real: 8476,
    trade: 8482,
    alefsym: 8501,
    larr: 8592,
    uarr: 8593,
    rarr: 8594,
    darr: 8595,
    harr: 8596,
    crarr: 8629,
    lArr: 8656,
    uArr: 8657,
    rArr: 8658,
    dArr: 8659,
    hArr: 8660,
    forall: 8704,
    part: 8706,
    exist: 8707,
    empty: 8709,
    nabla: 8711,
    isin: 8712,
    notin: 8713,
    ni: 8715,
    prod: 8719,
    sum: 8721,
    minus: 8722,
    lowast: 8727,
    radic: 8730,
    prop: 8733,
    infin: 8734,
    ang: 8736,
    and: 8743,
    or: 8744,
    cap: 8745,
    cup: 8746,
    int: 8747,
    there4: 8756,
    sim: 8764,
    cong: 8773,
    asymp: 8776,
    ne: 8800,
    equiv: 8801,
    le: 8804,
    ge: 8805,
    sub: 8834,
    sup: 8835,
    nsub: 8836,
    sube: 8838,
    supe: 8839,
    oplus: 8853,
    otimes: 8855,
    perp: 8869,
    sdot: 8901,
    lceil: 8968,
    rceil: 8969,
    lfloor: 8970,
    rfloor: 8971,
    lang: 9001,
    rang: 9002,
    loz: 9674,
    spades: 9824,
    clubs: 9827,
    hearts: 9829,
    diams: 9830,
  })

  Object.keys(sax.ENTITIES).forEach(function (key) {
    var e = sax.ENTITIES[key]
    var s = typeof e === 'number' ? String.fromCharCode(e) : e
    sax.ENTITIES[key] = s
  })

  for (var s in sax.STATE) {
    sax.STATE[sax.STATE[s]] = s
  }

  // shorthand
  S = sax.STATE

  function emit(parser, event, data) {
    parser[event] && parser[event](data)
  }

  function getDeclaredEncoding(body) {
    var match = body && body.match(/(?:^|\s)encoding\s*=\s*(['"])([^'"]+)\1/i)
    return match ? match[2] : null
  }

  function normalizeEncodingName(encoding) {
    if (!encoding) {
      return null
    }

    return encoding.toLowerCase().replace(/[^a-z0-9]/g, '')
  }

  function encodingsMatch(detectedEncoding, declaredEncoding) {
    const detected = normalizeEncodingName(detectedEncoding)
    const declared = normalizeEncodingName(declaredEncoding)

    if (!detected || !declared) {
      return true
    }

    if (declared === 'utf16') {
      return detected === 'utf16le' || detected === 'utf16be'
    }

    return detected === declared
  }

  function validateXmlDeclarationEncoding(parser, data) {
    if (
      !parser.strict ||
      !parser.encoding ||
      !data ||
      data.name !== 'xml'
    ) {
      return
    }

    var declaredEncoding = getDeclaredEncoding(data.body)
    if (
      declaredEncoding &&
      !encodingsMatch(parser.encoding, declaredEncoding)
    ) {
      strictFail(
        parser,
        'XML declaration encoding ' +
          declaredEncoding +
          ' does not match detected stream encoding ' +
          parser.encoding.toUpperCase()
      )
    }
  }

  function emitNode(parser, nodeType, data) {
    if (parser.textNode) closeText(parser)
    emit(parser, nodeType, data)
  }

  function closeText(parser) {
    parser.textNode = textopts(parser.opt, parser.textNode)
    if (parser.textNode) emit(parser, 'ontext', parser.textNode)
    parser.textNode = ''
  }

  function textopts(opt, text) {
    if (opt.trim) text = text.trim()
    if (opt.normalize) text = text.replace(/\s+/g, ' ')
    return text
  }

  function error(parser, er) {
    closeText(parser)
    if (parser.trackPosition) {
      er +=
        '\nLine: ' +
        parser.line +
        '\nColumn: ' +
        parser.column +
        '\nChar: ' +
        parser.c
    }
    er = new Error(er)
    parser.error = er
    emit(parser, 'onerror', er)
    return parser
  }

  function end(parser) {
    if (parser.sawRoot && !parser.closedRoot)
      strictFail(parser, 'Unclosed root tag')
    if (
      parser.state !== S.BEGIN &&
      parser.state !== S.BEGIN_WHITESPACE &&
      parser.state !== S.TEXT
    ) {
      error(parser, 'Unexpected end')
    }
    closeText(parser)
    parser.c = ''
    parser.closed = true
    emit(parser, 'onend')
    SAXParser.call(parser, parser.strict, parser.opt)
    return parser
  }

  function strictFail(parser, message) {
    if (typeof parser !== 'object' || !(parser instanceof SAXParser)) {
      throw new Error('bad call to strictFail')
    }
    if (parser.strict) {
      error(parser, message)
    }
  }

  function newTag(parser) {
    if (!parser.strict) parser.tagName = parser.tagName[parser.looseCase]()
    var parent = parser.tags[parser.tags.length - 1] || parser
    var tag = (parser.tag = { name: parser.tagName, attributes: {} })

    // will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
    if (parser.opt.xmlns) {
      tag.ns = parent.ns
    }
    parser.attribList.length = 0
    emitNode(parser, 'onopentagstart', tag)
  }

  function qname(name, attribute) {
    var i = name.indexOf(':')
    var qualName = i < 0 ? ['', name] : name.split(':')
    var prefix = qualName[0]
    var local = qualName[1]

    // <x "xmlns"="http://foo">
    if (attribute && name === 'xmlns') {
      prefix = 'xmlns'
      local = ''
    }

    return { prefix: prefix, local: local }
  }

  function attrib(parser) {
    if (!parser.strict) {
      parser.attribName = parser.attribName[parser.looseCase]()
    }

    if (
      parser.attribList.indexOf(parser.attribName) !== -1 ||
      parser.tag.attributes.hasOwnProperty(parser.attribName)
    ) {
      parser.attribName = parser.attribValue = ''
      return
    }

    if (parser.opt.xmlns) {
      var qn = qname(parser.attribName, true)
      var prefix = qn.prefix
      var local = qn.local

      if (prefix === 'xmlns') {
        // namespace binding attribute. push the binding into scope
        if (local === 'xml' && parser.attribValue !== XML_NAMESPACE) {
          strictFail(
            parser,
            'xml: prefix must be bound to ' +
              XML_NAMESPACE +
              '\n' +
              'Actual: ' +
              parser.attribValue
          )
        } else if (
          local === 'xmlns' &&
          parser.attribValue !== XMLNS_NAMESPACE
        ) {
          strictFail(
            parser,
            'xmlns: prefix must be bound to ' +
              XMLNS_NAMESPACE +
              '\n' +
              'Actual: ' +
              parser.attribValue
          )
        } else {
          var tag = parser.tag
          var parent = parser.tags[parser.tags.length - 1] || parser
          if (tag.ns === parent.ns) {
            tag.ns = Object.create(parent.ns)
          }
          tag.ns[local] = parser.attribValue
        }
      }

      // defer onattribute events until all attributes have been seen
      // so any new bindings can take effect. preserve attribute order
      // so deferred events can be emitted in document order
      parser.attribList.push([parser.attribName, parser.attribValue])
    } else {
      // in non-xmlns mode, we can emit the event right away
      parser.tag.attributes[parser.attribName] = parser.attribValue
      emitNode(parser, 'onattribute', {
        name: parser.attribName,
        value: parser.attribValue,
      })
    }

    parser.attribName = parser.attribValue = ''
  }

  function openTag(parser, selfClosing) {
    if (parser.opt.xmlns) {
      // emit namespace binding events
      var tag = parser.tag

      // add namespace info to tag
      var qn = qname(parser.tagName)
      tag.prefix = qn.prefix
      tag.local = qn.local
      tag.uri = tag.ns[qn.prefix] || ''

      if (tag.prefix && !tag.uri) {
        strictFail(
          parser,
          'Unbound namespace prefix: ' + JSON.stringify(parser.tagName)
        )
        tag.uri = qn.prefix
      }

      var parent = parser.tags[parser.tags.length - 1] || parser
      if (tag.ns && parent.ns !== tag.ns) {
        Object.keys(tag.ns).forEach(function (p) {
          emitNode(parser, 'onopennamespace', {
            prefix: p,
            uri: tag.ns[p],
          })
        })
      }

      // handle deferred onattribute events
      // Note: do not apply default ns to attributes:
      //   http://www.w3.org/TR/REC-xml-names/#defaulting
      for (var i = 0, l = parser.attribList.length; i < l; i++) {
        var nv = parser.attribList[i]
        var name = nv[0]
        var value = nv[1]
        var qualName = qname(name, true)
        var prefix = qualName.prefix
        var local = qualName.local
        var uri = prefix === '' ? '' : tag.ns[prefix] || ''
        var a = {
          name: name,
          value: value,
          prefix: prefix,
          local: local,
          uri: uri,
        }

        // if there's any attributes with an undefined namespace,
        // then fail on them now.
        if (prefix && prefix !== 'xmlns' && !uri) {
          strictFail(
            parser,
            'Unbound namespace prefix: ' + JSON.stringify(prefix)
          )
          a.uri = prefix
        }
        parser.tag.attributes[name] = a
        emitNode(parser, 'onattribute', a)
      }
      parser.attribList.length = 0
    }

    parser.tag.isSelfClosing = !!selfClosing

    // process the tag
    parser.sawRoot = true
    parser.tags.push(parser.tag)
    emitNode(parser, 'onopentag', parser.tag)
    if (!selfClosing) {
      // special case for <script> in non-strict mode.
      if (!parser.noscript && parser.tagName.toLowerCase() === 'script') {
        parser.state = S.SCRIPT
      } else {
        parser.state = S.TEXT
      }
      parser.tag = null
      parser.tagName = ''
    }
    parser.attribName = parser.attribValue = ''
    parser.attribList.length = 0
  }

  function closeTag(parser) {
    if (!parser.tagName) {
      strictFail(parser, 'Weird empty close tag.')
      parser.textNode += '</>'
      parser.state = S.TEXT
      return
    }

    if (parser.script) {
      if (parser.tagName !== 'script') {
        parser.script += '</' + parser.tagName + '>'
        parser.tagName = ''
        parser.state = S.SCRIPT
        return
      }
      emitNode(parser, 'onscript', parser.script)
      parser.script = ''
    }

    // first make sure that the closing tag actually exists.
    // <a><b></c></b></a> will close everything, otherwise.
    var t = parser.tags.length
    var tagName = parser.tagName
    if (!parser.strict) {
      tagName = tagName[parser.looseCase]()
    }
    var closeTo = tagName
    while (t--) {
      var close = parser.tags[t]
      if (close.name !== closeTo) {
        // fail the first time in strict mode
        strictFail(parser, 'Unexpected close tag')
      } else {
        break
      }
    }

    // didn't find it.  we already failed for strict, so just abort.
    if (t < 0) {
      strictFail(parser, 'Unmatched closing tag: ' + parser.tagName)
      parser.textNode += '</' + parser.tagName + '>'
      parser.state = S.TEXT
      return
    }
    parser.tagName = tagName
    var s = parser.tags.length
    while (s-- > t) {
      var tag = (parser.tag = parser.tags.pop())
      parser.tagName = parser.tag.name
      emitNode(parser, 'onclosetag', parser.tagName)

      var x = {}
      for (var i in tag.ns) {
        x[i] = tag.ns[i]
      }

      var parent = parser.tags[parser.tags.length - 1] || parser
      if (parser.opt.xmlns && tag.ns !== parent.ns) {
        // remove namespace bindings introduced by tag
        Object.keys(tag.ns).forEach(function (p) {
          var n = tag.ns[p]
          emitNode(parser, 'onclosenamespace', { prefix: p, uri: n })
        })
      }
    }
    if (t === 0) parser.closedRoot = true
    parser.tagName = parser.attribValue = parser.attribName = ''
    parser.attribList.length = 0
    parser.state = S.TEXT
  }

  function parseEntity(parser) {
    var entity = parser.entity
    var entityLC = entity.toLowerCase()
    var num
    var numStr = ''

    if (parser.ENTITIES[entity]) {
      return parser.ENTITIES[entity]
    }
    if (parser.ENTITIES[entityLC]) {
      return parser.ENTITIES[entityLC]
    }
    entity = entityLC
    if (entity.charAt(0) === '#') {
      if (entity.charAt(1) === 'x') {
        entity = entity.slice(2)
        num = parseInt(entity, 16)
        numStr = num.toString(16)
      } else {
        entity = entity.slice(1)
        num = parseInt(entity, 10)
        numStr = num.toString(10)
      }
    }
    entity = entity.replace(/^0+/, '')
    if (
      isNaN(num) ||
      numStr.toLowerCase() !== entity ||
      num < 0 ||
      num > 0x10ffff ||
      !isXmlChar(num)
    ) {
      strictFail(parser, 'Invalid character entity')
      return '&' + parser.entity + ';'
    }

    return String.fromCodePoint(num)
  }

  // Returns true if `num` is a code point that matches the XML `Char`
  // production, false otherwise. Character references that resolve to a
  // character outside this range (e.g. surrogates or restricted control
  // characters) are not well-formed.
  // https://www.w3.org/TR/REC-xml/#NT-Char
  // https://www.w3.org/TR/REC-xml/#wf-Legalchar
  function isXmlChar(num) {
    return (
      num === 0x9 ||
      num === 0xa ||
      num === 0xd ||
      (num >= 0x20 && num <= 0xd7ff) ||
      (num >= 0xe000 && num <= 0xfffd) ||
      (num >= 0x10000 && num <= 0x10ffff)
    )
  }

  function beginWhiteSpace(parser, c) {
    if (c === '<') {
      parser.state = S.OPEN_WAKA
      parser.startTagPosition = parser.position
    } else if (!isWhitespace(c)) {
      // have to process this as a text node.
      // weird, but happens.
      strictFail(parser, 'Non-whitespace before first tag.')
      parser.textNode = c
      parser.state = S.TEXT
    }
  }

  function charAt(chunk, i) {
    var result = ''
    if (i < chunk.length) {
      result = chunk.charAt(i)
    }
    return result
  }

  function write(chunk) {
    var parser = this
    if (this.error) {
      throw this.error
    }
    if (parser.closed) {
      return error(
        parser,
        'Cannot write after close. Assign an onready handler.'
      )
    }
    if (chunk === null) {
      return end(parser)
    }
    if (typeof chunk === 'object') {
      chunk = chunk.toString()
    }
    var i = 0
    var c = ''
    while (true) {
      c = charAt(chunk, i++)
      parser.c = c

      if (!c) {
        break
      }

      if (parser.trackPosition) {
        parser.position++
        if (c === '\n') {
          parser.line++
          parser.column = 0
        } else {
          parser.column++
        }
      }

      switch (parser.state) {
        case S.BEGIN:
          parser.state = S.BEGIN_WHITESPACE
          if (c === '\uFEFF') {
            continue
          }
          beginWhiteSpace(parser, c)
          continue

        case S.BEGIN_WHITESPACE:
          beginWhiteSpace(parser, c)
          continue

        case S.TEXT:
          if (parser.sawRoot && !parser.closedRoot) {
            var starti = i - 1
            while (c && c !== '<' && c !== '&') {
              c = charAt(chunk, i++)
              if (c && parser.trackPosition) {
                parser.position++
                if (c === '\n') {
                  parser.line++
                  parser.column = 0
                } else {
                  parser.column++
                }
              }
            }
            parser.textNode += chunk.substring(starti, i - 1)
          }
          if (
            c === '<' &&
            !(parser.sawRoot && parser.closedRoot && !parser.strict)
          ) {
            parser.state = S.OPEN_WAKA
            parser.startTagPosition = parser.position
          } else {
            if (
              !isWhitespace(c) &&
              (!parser.sawRoot || parser.closedRoot)
            ) {
              strictFail(parser, 'Text data outside of root node.')
            }
            if (c === '&') {
              parser.state = S.TEXT_ENTITY
            } else {
              parser.textNode += c
            }
          }
          continue

        case S.SCRIPT:
          // only non-strict
          if (c === '<') {
            parser.state = S.SCRIPT_ENDING
          } else {
            parser.script += c
          }
          continue

        case S.SCRIPT_ENDING:
          if (c === '/') {
            parser.state = S.CLOSE_TAG
          } else {
            parser.script += '<' + c
            parser.state = S.SCRIPT
          }
          continue

        case S.OPEN_WAKA:
          // either a /, ?, !, or text is coming next.
          if (c === '!') {
            parser.state = S.SGML_DECL
            parser.sgmlDecl = ''
          } else if (isWhitespace(c)) {
            // wait for it...
          } else if (isMatch(nameStart, c)) {
            parser.state = S.OPEN_TAG
            parser.tagName = c
          } else if (c === '/') {
            parser.state = S.CLOSE_TAG
            parser.tagName = ''
          } else if (c === '?') {
            parser.state = S.PROC_INST
            parser.procInstName = parser.procInstBody = ''
          } else {
            strictFail(parser, 'Unencoded <')
            // if there was some whitespace, then add that in.
            if (parser.startTagPosition + 1 < parser.position) {
              var pad = parser.position - parser.startTagPosition
              c = new Array(pad).join(' ') + c
            }
            parser.textNode += '<' + c
            parser.state = S.TEXT
          }
          continue

        case S.SGML_DECL:
          if (parser.sgmlDecl + c === '--') {
            parser.state = S.COMMENT
            parser.comment = ''
            parser.sgmlDecl = ''
            continue
          }

          if (
            parser.doctype &&
            parser.doctype !== true &&
            parser.sgmlDecl
          ) {
            parser.state = S.DOCTYPE_DTD
            parser.doctype += '<!' + parser.sgmlDecl + c
            parser.sgmlDecl = ''
          } else if (CDATAre.test(parser.sgmlDecl + c)) {
            emitNode(parser, 'onopencdata')
            parser.state = S.CDATA
            parser.sgmlDecl = ''
            parser.cdata = ''
          } else if (DOCTYPEre.test(parser.sgmlDecl + c)) {
            parser.state = S.DOCTYPE
            if (parser.doctype || parser.sawRoot) {
              strictFail(
                parser,
                'Inappropriately located doctype declaration'
              )
            }
            parser.doctype = ''
            parser.sgmlDecl = ''
          } else if (c === '>') {
            emitNode(parser, 'onsgmldeclaration', parser.sgmlDecl)
            parser.sgmlDecl = ''
            parser.state = S.TEXT
          } else if (isQuote(c)) {
            parser.state = S.SGML_DECL_QUOTED
            parser.sgmlDecl += c
          } else {
            parser.sgmlDecl += c
          }
          continue

        case S.SGML_DECL_QUOTED:
          if (c === parser.q) {
            parser.state = S.SGML_DECL
            parser.q = ''
          }
          parser.sgmlDecl += c
          continue

        case S.DOCTYPE:
          if (c === '>') {
            parser.state = S.TEXT
            emitNode(parser, 'ondoctype', parser.doctype)
            parser.doctype = true // just remember that we saw it.
          } else {
            parser.doctype += c
            if (c === '[') {
              parser.state = S.DOCTYPE_DTD
            } else if (isQuote(c)) {
              parser.state = S.DOCTYPE_QUOTED
              parser.q = c
            }
          }
          continue

        case S.DOCTYPE_QUOTED:
          parser.doctype += c
          if (c === parser.q) {
            parser.q = ''
            parser.state = S.DOCTYPE
          }
          continue

        case S.DOCTYPE_DTD:
          if (c === ']') {
            parser.doctype += c
            parser.state = S.DOCTYPE
          } else if (c === '<') {
            parser.state = S.OPEN_WAKA
            parser.startTagPosition = parser.position
          } else if (isQuote(c)) {
            parser.doctype += c
            parser.state = S.DOCTYPE_DTD_QUOTED
            parser.q = c
          } else {
            parser.doctype += c
          }
          continue

        case S.DOCTYPE_DTD_QUOTED:
          parser.doctype += c
          if (c === parser.q) {
            parser.state = S.DOCTYPE_DTD
            parser.q = ''
          }
          continue

        case S.COMMENT:
          if (c === '-') {
            parser.state = S.COMMENT_ENDING
          } else {
            parser.comment += c
          }
          continue

        case S.COMMENT_ENDING:
          if (c === '-') {
            parser.state = S.COMMENT_ENDED
            parser.comment = textopts(parser.opt, parser.comment)
            if (parser.comment) {
              emitNode(parser, 'oncomment', parser.comment)
            }
            parser.comment = ''
          } else {
            parser.comment += '-' + c
            parser.state = S.COMMENT
          }
          continue

        case S.COMMENT_ENDED:
          if (c !== '>') {
            strictFail(parser, 'Malformed comment')
            // allow <!-- blah -- bloo --> in non-strict mode,
            // which is a comment of " blah -- bloo "
            parser.comment += '--' + c
            parser.state = S.COMMENT
          } else if (parser.doctype && parser.doctype !== true) {
            parser.state = S.DOCTYPE_DTD
          } else {
            parser.state = S.TEXT
          }
          continue

        case S.CDATA:
          var starti = i - 1
          while (c && c !== ']') {
            c = charAt(chunk, i++)
            if (c && parser.trackPosition) {
              parser.position++
              if (c === '\n') {
                parser.line++
                parser.column = 0
              } else {
                parser.column++
              }
            }
          }
          parser.cdata += chunk.substring(starti, i - 1)
          if (c === ']') {
            parser.state = S.CDATA_ENDING
          }
          continue

        case S.CDATA_ENDING:
          if (c === ']') {
            parser.state = S.CDATA_ENDING_2
          } else {
            parser.cdata += ']' + c
            parser.state = S.CDATA
          }
          continue

        case S.CDATA_ENDING_2:
          if (c === '>') {
            if (parser.cdata) {
              emitNode(parser, 'oncdata', parser.cdata)
            }
            emitNode(parser, 'onclosecdata')
            parser.cdata = ''
            parser.state = S.TEXT
          } else if (c === ']') {
            parser.cdata += ']'
          } else {
            parser.cdata += ']]' + c
            parser.state = S.CDATA
          }
          continue

        case S.PROC_INST:
          if (c === '?') {
            parser.state = S.PROC_INST_ENDING
          } else if (isWhitespace(c)) {
            parser.state = S.PROC_INST_BODY
          } else {
            parser.procInstName += c
          }
          continue

        case S.PROC_INST_BODY:
          if (!parser.procInstBody && isWhitespace(c)) {
            continue
          } else if (c === '?') {
            parser.state = S.PROC_INST_ENDING
          } else {
            parser.procInstBody += c
          }
          continue

        case S.PROC_INST_ENDING:
          if (c === '>') {
            const procInstEndData = {
              name: parser.procInstName,
              body: parser.procInstBody,
            }
            validateXmlDeclarationEncoding(parser, procInstEndData)
            emitNode(parser, 'onprocessinginstruction', procInstEndData)
            parser.procInstName = parser.procInstBody = ''
            parser.state = S.TEXT
          } else {
            parser.procInstBody += '?' + c
            parser.state = S.PROC_INST_BODY
          }
          continue

        case S.OPEN_TAG:
          if (isMatch(nameBody, c)) {
            parser.tagName += c
          } else {
            newTag(parser)
            if (c === '>') {
              openTag(parser)
            } else if (c === '/') {
              parser.state = S.OPEN_TAG_SLASH
            } else {
              if (!isWhitespace(c)) {
                strictFail(parser, 'Invalid character in tag name')
              }
              parser.state = S.ATTRIB
            }
          }
          continue

        case S.OPEN_TAG_SLASH:
          if (c === '>') {
            openTag(parser, true)
            closeTag(parser)
          } else {
            strictFail(
              parser,
              'Forward-slash in opening tag not followed by >'
            )
            parser.state = S.ATTRIB
          }
          continue

        case S.ATTRIB:
          // haven't read the attribute name yet.
          if (isWhitespace(c)) {
            continue
          } else if (c === '>') {
            openTag(parser)
          } else if (c === '/') {
            parser.state = S.OPEN_TAG_SLASH
          } else if (isMatch(nameStart, c)) {
            parser.attribName = c
            parser.attribValue = ''
            parser.state = S.ATTRIB_NAME
          } else {
            strictFail(parser, 'Invalid attribute name')
          }
          continue

        case S.ATTRIB_NAME:
          if (c === '=') {
            parser.state = S.ATTRIB_VALUE
          } else if (c === '>') {
            strictFail(parser, 'Attribute without value')
            parser.attribValue = parser.attribName
            attrib(parser)
            openTag(parser)
          } else if (isWhitespace(c)) {
            parser.state = S.ATTRIB_NAME_SAW_WHITE
          } else if (isMatch(nameBody, c)) {
            parser.attribName += c
          } else {
            strictFail(parser, 'Invalid attribute name')
          }
          continue

        case S.ATTRIB_NAME_SAW_WHITE:
          if (c === '=') {
            parser.state = S.ATTRIB_VALUE
          } else if (isWhitespace(c)) {
            continue
          } else {
            strictFail(parser, 'Attribute without value')
            parser.tag.attributes[parser.attribName] = ''
            parser.attribValue = ''
            emitNode(parser, 'onattribute', {
              name: parser.attribName,
              value: '',
            })
            parser.attribName = ''
            if (c === '>') {
              openTag(parser)
            } else if (isMatch(nameStart, c)) {
              parser.attribName = c
              parser.state = S.ATTRIB_NAME
            } else {
              strictFail(parser, 'Invalid attribute name')
              parser.state = S.ATTRIB
            }
          }
          continue

        case S.ATTRIB_VALUE:
          if (isWhitespace(c)) {
            continue
          } else if (isQuote(c)) {
            parser.q = c
            parser.state = S.ATTRIB_VALUE_QUOTED
          } else {
            if (!parser.opt.unquotedAttributeValues) {
              error(parser, 'Unquoted attribute value')
            }
            parser.state = S.ATTRIB_VALUE_UNQUOTED
            parser.attribValue = c
          }
          continue

        case S.ATTRIB_VALUE_QUOTED:
          if (c !== parser.q) {
            if (c === '&') {
              parser.state = S.ATTRIB_VALUE_ENTITY_Q
            } else {
              parser.attribValue += c
            }
            continue
          }
          attrib(parser)
          parser.q = ''
          parser.state = S.ATTRIB_VALUE_CLOSED
          continue

        case S.ATTRIB_VALUE_CLOSED:
          if (isWhitespace(c)) {
            parser.state = S.ATTRIB
          } else if (c === '>') {
            openTag(parser)
          } else if (c === '/') {
            parser.state = S.OPEN_TAG_SLASH
          } else if (isMatch(nameStart, c)) {
            strictFail(parser, 'No whitespace between attributes')
            parser.attribName = c
            parser.attribValue = ''
            parser.state = S.ATTRIB_NAME
          } else {
            strictFail(parser, 'Invalid attribute name')
          }
          continue

        case S.ATTRIB_VALUE_UNQUOTED:
          if (!isAttribEnd(c)) {
            if (c === '&') {
              parser.state = S.ATTRIB_VALUE_ENTITY_U
            } else {
              parser.attribValue += c
            }
            continue
          }
          attrib(parser)
          if (c === '>') {
            openTag(parser)
          } else {
            parser.state = S.ATTRIB
          }
          continue

        case S.CLOSE_TAG:
          if (!parser.tagName) {
            if (isWhitespace(c)) {
              continue
            } else if (notMatch(nameStart, c)) {
              if (parser.script) {
                parser.script += '</' + c
                parser.state = S.SCRIPT
              } else {
                strictFail(parser, 'Invalid tagname in closing tag.')
              }
            } else {
              parser.tagName = c
            }
          } else if (c === '>') {
            closeTag(parser)
          } else if (isMatch(nameBody, c)) {
            parser.tagName += c
          } else if (parser.script) {
            parser.script += '</' + parser.tagName + c
            parser.tagName = ''
            parser.state = S.SCRIPT
          } else {
            if (!isWhitespace(c)) {
              strictFail(parser, 'Invalid tagname in closing tag')
            }
            parser.state = S.CLOSE_TAG_SAW_WHITE
          }
          continue

        case S.CLOSE_TAG_SAW_WHITE:
          if (isWhitespace(c)) {
            continue
          }
          if (c === '>') {
            closeTag(parser)
          } else {
            strictFail(parser, 'Invalid characters in closing tag')
          }
          continue

        case S.TEXT_ENTITY:
        case S.ATTRIB_VALUE_ENTITY_Q:
        case S.ATTRIB_VALUE_ENTITY_U:
          var returnState
          var buffer
          switch (parser.state) {
            case S.TEXT_ENTITY:
              returnState = S.TEXT
              buffer = 'textNode'
              break

            case S.ATTRIB_VALUE_ENTITY_Q:
              returnState = S.ATTRIB_VALUE_QUOTED
              buffer = 'attribValue'
              break

            case S.ATTRIB_VALUE_ENTITY_U:
              returnState = S.ATTRIB_VALUE_UNQUOTED
              buffer = 'attribValue'
              break
          }

          if (c === ';') {
            var parsedEntity = parseEntity(parser)
            if (
              parser.opt.unparsedEntities &&
              !Object.values(sax.XML_ENTITIES).includes(parsedEntity)
            ) {
              if ((parser.entityCount += 1) > parser.opt.maxEntityCount) {
                error(
                  parser,
                  'Parsed entity count exceeds max entity count'
                )
              }

              if ((parser.entityDepth += 1) > parser.opt.maxEntityDepth) {
                error(
                  parser,
                  'Parsed entity depth exceeds max entity depth'
                )
              }

              parser.entity = ''
              parser.state = returnState
              parser.write(parsedEntity)
              parser.entityDepth -= 1
            } else {
              parser[buffer] += parsedEntity
              parser.entity = ''
              parser.state = returnState
            }
          } else if (
            isMatch(parser.entity.length ? entityBody : entityStart, c)
          ) {
            parser.entity += c
          } else {
            strictFail(parser, 'Invalid character in entity name')
            parser[buffer] += '&' + parser.entity + c
            parser.entity = ''
            parser.state = returnState
          }

          continue

        default: /* istanbul ignore next */ {
          throw new Error(parser, 'Unknown state: ' + parser.state)
        }
      }
    } // while

    if (parser.position >= parser.bufferCheckPosition) {
      checkBufferLength(parser)
    }
    return parser
  }

  /*! http://mths.be/fromcodepoint v0.1.0 by @mathias */
  /* istanbul ignore next */
  if (!String.fromCodePoint) {
    ;(function () {
      var stringFromCharCode = String.fromCharCode
      var floor = Math.floor
      var fromCodePoint = function () {
        var MAX_SIZE = 0x4000
        var codeUnits = []
        var highSurrogate
        var lowSurrogate
        var index = -1
        var length = arguments.length
        if (!length) {
          return ''
        }
        var result = ''
        while (++index < length) {
          var codePoint = Number(arguments[index])
          if (
            !isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
            codePoint < 0 || // not a valid Unicode code point
            codePoint > 0x10ffff || // not a valid Unicode code point
            floor(codePoint) !== codePoint // not an integer
          ) {
            throw RangeError('Invalid code point: ' + codePoint)
          }
          if (codePoint <= 0xffff) {
            // BMP code point
            codeUnits.push(codePoint)
          } else {
            // Astral code point; split in surrogate halves
            // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            codePoint -= 0x10000
            highSurrogate = (codePoint >> 10) + 0xd800
            lowSurrogate = (codePoint % 0x400) + 0xdc00
            codeUnits.push(highSurrogate, lowSurrogate)
          }
          if (index + 1 === length || codeUnits.length > MAX_SIZE) {
            result += stringFromCharCode.apply(null, codeUnits)
            codeUnits.length = 0
          }
        }
        return result
      }
      /* istanbul ignore next */
      if (Object.defineProperty) {
        Object.defineProperty(String, 'fromCodePoint', {
          value: fromCodePoint,
          configurable: true,
          writable: true,
        })
      } else {
        String.fromCodePoint = fromCodePoint
      }
    })()
  }
})(typeof exports === 'undefined' ? (this.sax = {}) : exports)

}
};

const nativeRequire = require;
const cache = Object.create(null);
function load(id) {
  if (cache[id]) return cache[id].exports;
  if (!Object.hasOwn(factories, id)) throw new Error('Unknown local module: ' + id);
  const mod = cache[id] = { exports: {} };
  const dir = id.split('/').slice(0,-1);
  factories[id](mod, mod.exports, name => name.startsWith('./') ? load([...dir, name.slice(2)].join('/')) : nativeRequire(name));
  return mod.exports;
}
module.exports = load('plugin');
