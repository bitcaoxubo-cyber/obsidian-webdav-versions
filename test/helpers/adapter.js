'use strict';
const { bytes, arrayBuffer } = require('../../src/bytes');
// A native adapter contract model: asynchronous calls, exclusive copy, fault points.
class Adapter {
  constructor(now = Date.UTC(2000, 0, 1)) { this.files = new Map(); this.folders = new Set(['']); this.hook = async () => {}; this.clock = now; this.mtimes = new Map(); }
  setTime(now) { if (!Number.isFinite(now) || now < this.clock) throw new Error('clock must be monotonic'); this.clock = now; }
  touch(p) { this.mtimes.set(p, ++this.clock); }
  async stat(p) { return this.files.has(p) ? {type:'file',size:this.files.get(p).length,mtime:this.mtimes.get(p)} : this.folders.has(p) ? {type:'folder',size:0} : null; }
  async exists(p) { return !!await this.stat(p); }
  async mkdir(p) { if (await this.exists(p)) throw new Error('exists'); this.folders.add(p); }
  async readBinary(p) { if (!this.files.has(p)) throw new Error('missing'); return arrayBuffer(this.files.get(p)); }
  async writeBinary(p,b) { await this.hook('write',p,'before'); this.files.set(p,new Uint8Array(b.slice(0))); this.touch(p); await this.hook('write',p,'after'); }
  async remove(p) { this.files.delete(p); this.mtimes.delete(p); }
  async rename(a,b) {
    await this.hook('rename',a,'before');
    if (await this.exists(b)) throw new Error('exists');
    if (this.files.has(a)) { this.files.set(b,this.files.get(a)); this.touch(b); this.files.delete(a); this.mtimes.delete(a); }
    else if (this.folders.has(a)) {
      for (const p of [...this.files.keys()]) if (p.startsWith(a+'/')) { const target=b+p.slice(a.length); this.files.set(target,this.files.get(p)); this.touch(target); this.files.delete(p); this.mtimes.delete(p); }
      for (const p of [...this.folders]) if (p===a||p.startsWith(a+'/')) { this.folders.add(b+p.slice(a.length)); this.folders.delete(p); }
    } else throw new Error('missing');
    await this.hook('rename',a,'after');
  }
  async copy(a,b) { await this.hook('copy',b,'before'); if(await this.exists(b)) throw new Error('exists'); this.files.set(b,this.files.get(a).slice()); this.touch(b); await this.hook('copy',b,'after'); }
  async rmdir(p) { for(const f of [...this.files.keys()]) if(f.startsWith(p+'/')) { this.files.delete(f); this.mtimes.delete(f); } for(const f of [...this.folders]) if(f===p||f.startsWith(p+'/')) this.folders.delete(f); }
  async list(p) {
    const immediate = n => n!==p && n.startsWith(p?p+'/':'') && !n.slice(p?p.length+1:0).includes('/');
    return {files:[...this.files.keys()].filter(immediate), folders:[...this.folders].filter(immediate)};
  }
  put(p,v) { this.files.set(p,bytes(v).slice()); this.touch(p); }
}
module.exports = { Adapter };
