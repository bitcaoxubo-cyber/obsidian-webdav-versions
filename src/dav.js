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
