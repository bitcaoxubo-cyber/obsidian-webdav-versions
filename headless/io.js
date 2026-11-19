'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function atomicJson(file, value, unchanged = false) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (unchanged) { try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const temp = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temp, { force: true }); }
  return true;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safeDirectory(dir, create = false) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('数据路径不是普通目录。');
}
function redact(value, secrets) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏]');
  return text.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');
}
function credentials({ username, password }) {
  if (!password) return [];
  const encoded = encodeURIComponent(password.toWellFormed());
  const form = new URLSearchParams([['', password]]).toString().slice(1);
  const auth = Buffer.from((typeof username === 'string' ? username : '') + ':' + password).toString('base64');
  return [...new Set([password, encoded, form, auth])];
}
function publicText(value, config = {}) { return redact(value, credentials(config)); }
function publicError(value, config = {}) {
  // An exception containing credentials may also contain other authentication
  // context. Omit that diagnostic in full. Ordinary errors retain their detail.
  if (credentials(config).some(secret => String(value).includes(secret))) return '异常信息含认证凭据，已隐藏。';
  return redact(value, [config.url, config.stateDir]);
}
// Preserve the status schema and machine-readable values. A username such as
// "ok" or "1" must never corrupt the state enum, timestamp, or numeric counts.
function publicValue(value, config) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const paths = rows => Array.isArray(rows) ? rows.map(row => publicText(row, config)) : [];
  const attention = {};
  for (const key of ['staleCopies', 'deletionConflicts', 'staleConflicts']) {
    if (Object.hasOwn(value.needsAttention || {}, key)) attention[key] = count(value.needsAttention[key]);
  }
  return {
    state: ['ok', 'paused', 'error'].includes(value.state) ? value.state : 'error',
    reason: (value.state === 'error' ? publicError : publicText)(value.reason || '', config),
    lastSuccess: typeof value.lastSuccess === 'string' && Number.isFinite(Date.parse(value.lastSuccess)) ? value.lastSuccess : null,
    lastResult: value.lastResult ? { uploaded: count(value.lastResult.uploaded), downloaded: count(value.lastResult.downloaded), deleted: count(value.lastResult.deleted) } : null,
    conflicts: paths(value.conflicts), needsAttention: attention,
    pendingDeletions: value.pendingDeletions ? {
      count: count(value.pendingDeletions.count), paths: paths(value.pendingDeletions.paths).slice(0, 20),
      ...(Array.isArray(value.pendingDeletions.allPaths) && { allPaths: paths(value.pendingDeletions.allPaths) }),
    } : null,
  };
}
function probeMount(vaultDir, stateDir, io = fs) {
  const token = '.mount-probe-' + randomUUID();
  const source = path.join(stateDir, token), linked = path.join(vaultDir, token), returned = path.join(stateDir, token + '-returned');
  try {
    io.writeFileSync(source, 'probe', { flag: 'wx', mode: 0o600 });
    io.linkSync(source, linked); io.renameSync(linked, returned);
  } catch (e) { throw new Error('state/ 与 vault/ 无法硬链接或重命名；请使用同一个数据挂载，并检查运行用户权限。'); }
  finally { let failed = false; for (const file of [linked, returned, source]) { try { io.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') failed = true; } } if (failed) throw new Error('挂载探测临时文件清理失败，请检查目录权限。'); }
}
module.exports = { atomicJson, readJson, safeDirectory, publicText, publicError, publicValue, probeMount };
