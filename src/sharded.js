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
    if (this.created) return;
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
  async inventory({ syncing = false } = {}) {
    const root=await this.propfind(this.folder,1);
    // Maintenance also calls inventory while these markers are being moved.
    // Apply the sync gate here only for ordinary polling, using this same listing.
    if (syncing && root.has('rollback.json')) throw new Error('远端正在回退存储布局；已暂停。');
    if (syncing && !root.has('format.json')) throw new Error('远端分目录存储尚未完成迁移。');
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
    const objects=await this.inventory({ syncing: true });
    const leftovers=await this.legacy.propfind(this.legacy.folder,1,true);
    if(leftovers && [...leftovers].some(([name,dir])=>name!==MARKER || dir)) {
      throw new Error('旧目录仍有同步对象；请暂停旧客户端并完成迁移，避免遗漏旧端写入。');
    }
    const ids=[...objects.keys()].filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5));
    for(const id of this.revisions.keys()) if(!objects.has(id+'.json')) throw new Error('远端缺少以前确认的版本；已停止同步。');
    await parallel(ids.filter(id=>!this.revisions.has(id)),async id=>{
      this.revisions.set(id,checkedRevision(await this.read(objects.get(id+'.json'),REV_LIMIT),id));
    });
    const result=ids.map(id=>this.revisions.get(id));
    for(const rev of result) if(rev.blob!==null&&!objects.has(rev.blob+'.blob')) throw new Error('远端版本引用的附件缺失；已停止同步。');
    return result;
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
    if (this.selected) return this.selected;
    const r=this.legacy, folder=this.sharded.folder;
    if(await r.read(new URL('rollback.json',folder),REV_LIMIT,true)!==null) throw new Error('远端正在回退存储布局；已暂停。');
    const format=await r.read(new URL('format.json',folder),REV_LIMIT,true);
    if(format!==null) {
      if(!validFormat(format)) throw new Error('不支持的远端存储格式。');
      this.sharded.created=true;
      this.selected=this.sharded;return this.selected;
    }
    if(await r.propfind(folder,0,true)!==null) throw new Error('远端分目录存储迁移未完成；请完成迁移或回退。');
    this.selected=this.legacy;return this.selected;
  }
  probe() {return this.legacy.probe();}
  async listRevisions() {
    try {
      // A v1 selection must still notice another device beginning migration.
      // A missing v2 collection implies both metadata GETs would be 404.
      if (this.selected === this.legacy && await this.legacy.propfind(this.sharded.folder,0,true) !== null) {
        this.selected = null;
      }
      return await (await this.select()).listRevisions();
    } catch (error) {
      this.selected = null;
      this.sharded.created = false;
      throw error;
    }
  }
  async getBlob(id) {return (this.selected||await this.select()).getBlob(id);}
  async putBlob(id,data) {return (this.selected||await this.select()).putBlob(id,data);}
  async putRevision(rev) {return (this.selected||await this.select()).putRevision(rev);}
}

module.exports={AdaptiveDavRemote,ShardedStore,V2_NAMESPACE,FORMAT,FORMAT_TEXT,MARKER,HASH_NAME,REV_LIMIT,parallel,validFormat,mkdir};
