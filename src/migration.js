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
