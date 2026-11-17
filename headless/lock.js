'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
// A live Unix socket works across PID namespaces. An atomic directory rename
// installs a fully prepared owner; there is no half-written owner to recover.
// Retired, nonempty token directories are never reused or deleted: they make
// concurrent stale-lock recovery a compare-and-swap (rename cannot replace one).
function address(directory) {
  if (process.platform === 'linux') {
    const fd = fs.openSync(directory, 'r');
    return { path: '/proc/self/fd/' + fd + '/s', close: () => fs.closeSync(fd) };
  }
  const socket = path.join(directory, 's');
  if (Buffer.byteLength(socket) > 102) throw new Error('状态目录路径过长，无法建立实例锁；请改用较短的数据目录路径。');
  return { path: socket, close() {} };
}
async function alive(directory) {
  const addr = address(directory);
  try {
    return await new Promise(resolve => {
      const socket = net.createConnection(addr.path);
      const finish = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => finish(true));
      socket.once('error', e => finish(!['ECONNREFUSED', 'ENOENT'].includes(e.code)));
      socket.setTimeout(750, () => finish(true)); // uncertain owner: fail closed
    });
  } finally { addr.close(); }
}
async function acquireLock(stateDir) {
  const root = fs.realpathSync(stateDir), lock = path.join(root, '.run-lock');
  const token = randomUUID(), candidate = fs.mkdtempSync(path.join(root, '.l-'));
  fs.writeFileSync(path.join(candidate, 'owner.json'), JSON.stringify({ token }), { flag: 'wx', mode: 0o600 });
  let addr, server, installed = false;
  try {
    addr = address(candidate); server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(addr.path, resolve); });
    // Keep the Linux fd alive until release: Node also uses this spelling when
    // it closes the listening handle. Socket identity is the filesystem inode.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.renameSync(candidate, lock); installed = true; break; }
      catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') continue; throw new Error('实例锁记录损坏，已拒绝运行。'); }
      if (!/^[0-9a-f-]{36}$/.test(owner.token)) throw new Error('实例锁记录损坏，已拒绝运行。');
      let live;
      try { live = await alive(lock); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (live) throw new Error('同一 state/ 已有同步实例在运行。');
      const retired = path.join(root, '.lock-retired-' + owner.token);
      try { fs.renameSync(lock, retired); }
      catch (e) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
    }
    if (!installed) throw new Error('实例锁正在变更，请稍后重试。');
    let released = false;
    return async () => {
      if (released) return; released = true;
      // Move the still-live owner before closing; preserve its tombstone so a
      // slow contender can never retire a subsequently installed owner.
      const retired = path.join(root, '.lock-retired-' + token);
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        if (owner.token === token) fs.renameSync(lock, retired);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      finally { await new Promise(resolve => server.close(resolve)); addr.close(); }
      try { fs.unlinkSync(path.join(retired, 's')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    };
  } catch (e) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    addr?.close(); fs.rmSync(candidate, { recursive: true, force: true });
    if (e.message.startsWith('同一') || e.message.startsWith('实例') || e.message.startsWith('状态')) throw e;
    throw new Error('无法建立实例锁，请检查 state/ 的权限和文件系统是否支持 Unix socket。');
  }
}
module.exports = { acquireLock };
