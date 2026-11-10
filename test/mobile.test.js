'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { bytes, text, arrayBuffer, digest, base64, fromBase64, randomUUID } = require('../src/bytes');
const { MobileVault, MobileState, mobileRequest, MOBILE_LIMIT, DOWNLOAD_CHUNK } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');
const { DavRemote } = require('../src/dav');

const { Adapter } = require('./helpers/adapter');

function remote() {
  return { blobs:new Map(), revs:new Map(),
    async listRevisions(){return structuredClone([...this.revs.values()]);},
    async getBlob(h){return this.blobs.get(h).slice();},
    async putBlob(h,b){this.blobs.set(h,bytes(b).slice());},
    async putRevision(r){this.revs.set(r.id,structuredClone(r));}
  };
}
function client(r,device,adapter=new Adapter()) {
  const local=new MobileVault(adapter); const state=new MobileState(adapter,local.privateDir,'https://example.test/vault/', 'test');
  return {adapter,local,state,engine:new SyncEngine({remote:r,local,state,device})};
}

test('portable SHA-256 and encoding match native crypto at block boundaries and large binary inputs', () => {
  for(const n of [0,1,2,3,55,56,57,63,64,65,119,120,127,128,129,1024,1048576]) {
    const b=randomBytes(n); assert.equal(digest(b),createHash('sha256').update(b).digest('hex'));
    assert.deepEqual(fromBase64(base64(b)),new Uint8Array(b));
  }
  const s='液膜😀\r\n'; assert.equal(text(bytes(s)),s); assert.equal(digest(s),createHash('sha256').update(s).digest('hex'));
  const b=randomBytes(200); assert.equal(digest(b.subarray(7,137)),createHash('sha256').update(b.subarray(7,137)).digest('hex'));
  assert.match(randomUUID(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('mobile clients restore into an empty vault, preserve offline conflicts and binary attachments, then resolve', async()=>{
  const r=remote(), a=client(r,'Mac'), b=client(r,'iPhone');
  a.adapter.put('note.md','base'); a.adapter.put('sample.pdf',new Uint8Array([0,255,128,13]));
  await a.engine.sync(); await b.engine.sync();
  assert.equal(text(await b.local.read('note.md')),'base');
  assert.deepEqual(await b.local.read('sample.pdf'),new Uint8Array([0,255,128,13]));
  a.adapter.put('note.md','Mac edit'); b.adapter.put('note.md','phone edit');
  await Promise.all([a.engine.sync(),b.engine.sync()]); await a.engine.sync(); await b.engine.sync();
  for(const c of [a,b]) assert.deepEqual((await c.local.list()).filter(n=>n.endsWith('.md')).map(n=>text(c.adapter.files.get(n))).sort(),['Mac edit','phone edit']);
  b.adapter.put('note.md','merged'); await b.engine.resolve('note.md'); await a.engine.sync();
  assert.equal(text(await a.local.read('note.md')),'merged');
  assert.equal((await a.local.list()).filter(n=>n.endsWith('.md')).length,1);
});

test('interrupted upload retries exact staged bytes after phone restart and later edit',async()=>{
  const r=remote(), a=client(r,'iPhone'); a.adapter.put('x.md','before');
  const put=r.putRevision.bind(r); r.putRevision=async row=>{await put(row);r.putRevision=put;throw new Error('lost response');};
  await assert.rejects(a.engine.sync(),/lost response/); a.adapter.put('x.md','later');
  const restarted=client(r,'iPhone',a.adapter); await restarted.engine.sync();
  assert.equal(r.revs.size,2); assert.deepEqual([...r.blobs.values()].map(text).sort(),['before','later']);
  assert.equal((await restarted.state.load()).pending,null);
});

for(const phase of ['staging','intent','moved','copied','cleanup']) test('mobile restart recovery at '+phase,async()=>{
  const a=new Adapter(), local=new MobileVault(a); a.put('x.md','old'); let fired=false;
  a.hook=async(op,p,when)=>{
    const match=phase==='staging'?op==='write'&&p.endsWith('/next')&&when==='after':
      phase==='intent'?op==='write'&&p.endsWith('/intent.json')&&when==='after':
      phase==='moved'?op==='rename'&&p==='x.md'&&when==='after':
      phase==='copied'?op==='copy'&&p==='x.md'&&when==='after':op==='rename'&&p.endsWith('/mobile-transaction')&&when==='after';
    if(match&&!fired){fired=true;throw new Error('killed');}
  };
  if (phase === 'copied') assert.equal(await local.compareAndSet('x.md',digest('old'),bytes('new')), false);
  else await assert.rejects(local.compareAndSet('x.md',digest('old'),bytes('new')),/killed/);
  a.hook=async()=>{};
  const restart=new MobileVault(a); await restart.recover();
  assert.equal(text(await restart.read('x.md')),['staging','intent'].includes(phase)?'old':'new');
});

test('a concurrent saved edit moved with the original is restored instead of overwritten',async()=>{
  const a=new Adapter(), v=new MobileVault(a); a.put('x.md','old');
  a.hook=async(op,p,when)=>{if(op==='rename'&&p==='x.md'&&when==='before'){a.put('x.md','typing');a.hook=async()=>{};}};
  assert.equal(await v.compareAndSet('x.md',digest('old'),bytes('remote')),false);
  assert.equal(text(await v.read('x.md')),'typing');
});

test('exclusive copy preserves a new destination created while applying remote content',async()=>{
  const a=new Adapter(), v=new MobileVault(a); a.put('x.md','old');
  a.hook=async(op,p,when)=>{if(op==='copy'&&p==='x.md'&&when==='before'){a.put('x.md','raced');a.hook=async()=>{};}};
  assert.equal(await v.compareAndSet('x.md',digest('old'),bytes('remote')),false);
  assert.equal(text(await v.read('x.md')),'raced');
});

test('unsaved editor, background state, oversized files and hidden paths fail without overwriting notes',async()=>{
  const a=new Adapter(); a.put('x.md','old'); const v=new MobileVault(a,'.obsidian',()=>false);
  assert.equal(await v.compareAndSet('x.md',digest('old'),bytes('remote')),false);
  await assert.rejects(new MobileVault(a,'.obsidian',()=>true,()=>false).list(),/暂停/);
  for(const p of ['../outside','a/../b','.obsidian/secret','a\\b','/x']) await assert.rejects(v.read(p),/不安全/);
  await assert.rejects(v.compareAndSet('new.pdf',null,new Uint8Array(MOBILE_LIMIT+1)),/128 MiB/);
  assert.equal(text(await v.read('x.md')),'old');
});

test('state alternation survives an interrupted inactive write and isolates accounts',async()=>{
  const a=new Adapter(), s=new MobileState(a,'.obsidian/state','https://example.test/vault','one');
  await s.save({n:1}); await s.save({n:2});
  a.hook=async(op,p,when)=>{if(op==='rename'&&p.includes('/writing-')&&when==='before')throw new Error('killed');};
  await assert.rejects(s.save({n:3}),/killed/); a.hook=async()=>{};
  assert.deepEqual(await new MobileState(a,'.obsidian/state','https://example.test/vault','one').load(),{n:2});
  assert.equal(await new MobileState(a,'.obsidian/state','https://example.test/vault','two').load(),null);
});

test('native HTTP uses ArrayBuffer, preserves DAV error statuses, lowercases headers and preflights large blobs',async()=>{
  const calls=[]; const native=async args=>{calls.push(args);return {status:207,headers:{LINK:'next'},arrayBuffer:arrayBuffer('xml')};};
  const req=mobileRequest(native); const result=await req({url:new URL('https://example.test/'),method:'PROPFIND',headers:{'Content-Length':'3'},body:bytes('abc'),limit:100});
  assert.equal(result.status,207); assert.equal(result.headers.link,'next'); assert.equal(calls[0].throw,false);
  assert.equal(text(calls[0].body),'abc'); assert.equal(calls[0].headers['Content-Length'],undefined);
  let gets=0; const large=mobileRequest(async args=>{if(args.method==='GET')gets++;return {status:200,headers:{'Content-Length':String(MOBILE_LIMIT+1)},arrayBuffer:new ArrayBuffer(0)};});
  await assert.rejects(large({url:new URL('https://example.test/a.blob'),method:'GET',headers:{},limit:MOBILE_LIMIT}),/MOBILE_TOO_LARGE/);assert.equal(gets,0);
});

test('native HTTP never writes credentials into surfaced transport errors',async()=>{
  const remote=new DavRemote({url:'https://example.test/vault/',username:'user',password:'secret-value',request:mobileRequest(async()=>{throw new Error('secret-value');})});
  await assert.rejects(remote.probe(),e=>!e.message.includes('secret-value')&&e.message.includes('传输失败'));
});

test('large mobile downloads assemble verified ranges and reject a truncated segment',async()=>{
  const source=randomBytes(DOWNLOAD_CHUNK+17); let broken=false; const ranges=[];
  const native=async({method,headers})=>{
    if(method==='HEAD')return {status:200,headers:{'Content-Length':String(source.length)},arrayBuffer:new ArrayBuffer(0)};
    const [,lo,hi]=/^bytes=(\d+)-(\d+)$/.exec(headers.Range);ranges.push([Number(lo),Number(hi)]);
    const part=source.subarray(Number(lo),Number(hi)+1-(broken?1:0));
    return {status:206,headers:{'Content-Range':`bytes ${lo}-${hi}/${source.length}`},arrayBuffer:arrayBuffer(part)};
  };
  const args={url:new URL('https://example.test/a.blob'),method:'GET',headers:{},limit:MOBILE_LIMIT};
  const result=await mobileRequest(native)(args);assert.equal(result.status,200);assert.equal(digest(result.body),digest(source));
  assert.deepEqual(ranges,[[0,DOWNLOAD_CHUNK-1],[DOWNLOAD_CHUNK,source.length-1]]);
  broken=true;await assert.rejects(mobileRequest(native)(args),/MOBILE_RANGE_INVALID/);
});

test('corruption of a committed mobile state stops instead of silently forgetting its baseline',async()=>{
  const a=new Adapter(), s=new MobileState(a,'.obsidian/state','https://example.test/vault','one');
  await s.save({n:1}); await s.save({n:2}); a.put(s.directory+'/state-1.json','corrupted');
  await assert.rejects(s.load(),/损坏/);
});

module.exports = { Adapter };
