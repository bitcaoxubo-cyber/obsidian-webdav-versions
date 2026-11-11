'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {DavRemote,NAMESPACE}=require('../src/dav');
const {AdaptiveDavRemote,ShardedStore,V2_NAMESPACE,MARKER,FORMAT_TEXT}=require('../src/sharded');
const {migrateStorage,rollbackStorage}=require('../src/migration');
const {makeRevision,digest,project}=require('../src/protocol');
const {bytes}=require('../src/bytes');
const base='/vault/',v1=base+NAMESPACE+'/',v2=base+V2_NAMESPACE+'/';
function fixture(cap=10000) {
  const files=new Map(),dirs=new Set([base,v1]),calls=[];
  const f={files,dirs,calls,cap,hook:async()=>{}};
  const response=(p,dir)=>`<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype>${dir?'<d:collection/>':''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const request=async({url,method,headers,body})=>{
    const p=url.pathname;calls.push({method,path:p});
    const send=(status,b='',headers={})=>({status,body:Buffer.from(b),headers});
    await f.hook({phase:'before',method,p,headers});
    if(method==='PROPFIND') {
      if(!dirs.has(p)) return send(404);
      const immediate=s=>s.startsWith(p)&&s!==p&&!s.slice(p.length).replace(/\/$/,'').includes('/');
      const entries=headers.Depth==='0'?[]:[...files.keys(),...dirs].filter(immediate).slice(0,p===v1?f.cap:Infinity);
      return send(207,'<d:multistatus xmlns:d="DAV:">'+response(p,true)+entries.map(n=>response(n,dirs.has(n))).join('')+'</d:multistatus>');
    }
    if(method==='HEAD') return files.has(p)?send(200,'',{'Content-Length':String(files.get(p).length)}):send(404);
    if(method==='GET') return files.has(p)?send(200,files.get(p)):send(404);
    if(method==='MKCOL'){if(dirs.has(p))return send(405);dirs.add(p);return send(201);}
    if(method==='PUT'){files.set(p,Buffer.from(body));return send(201);}
    if(method==='MOVE') {
      const to=new URL(headers.Destination).pathname;
      if(files.has(to)||dirs.has(to))return send(412);
      if(files.has(p)){files.set(to,files.get(p));files.delete(p);}
      else if(dirs.has(p)){
        for(const k of [...files.keys()])if(k.startsWith(p)){files.set(to+k.slice(p.length),files.get(k));files.delete(k);}
        for(const k of [...dirs])if(k.startsWith(p)){dirs.add(to+k.slice(p.length));dirs.delete(k);}
      }else return send(404);
      await f.hook({phase:'after',method,p,headers});return send(201);
    }
    return send(405);
  };
  f.options={url:'https://example.test'+base,request};return f;
}
function seed(f,count=8) {
  const revisions=[];
  for(let i=0;i<count;i++) {
    const body=Buffer.from('body-'+i),h=digest(body);
    const r=makeRevision({path:'note-'+i+'.md',blob:h,device:'legacy',nonce:'fixed-'+i});
    f.files.set(v1+h+'.blob',body);f.files.set(v1+r.id+'.json',Buffer.from(JSON.stringify(r)));revisions.push(r);
  }
  return revisions;
}
const backups=()=>{const saved=new Map();return{saved,saveRevision:async(n,b)=>saved.set(n,Buffer.from(b))};};

test('a 10000-entry legacy listing stops with an actionable cap error before fetching revisions',async()=>{
  const f=fixture();for(let i=0;i<10000;i++)f.files.set(v1+i.toString(16).padStart(64,'0')+'.blob',Buffer.alloc(0));
  await assert.rejects(new DavRemote(f.options).listRevisions(),/10000/);
  assert.equal(f.calls.filter(x=>x.method==='GET').length,0);
});

test('migration drains capped listings, preserves every object byte and revision identity, then fresh clients read all histories',async()=>{
  const f=fixture(5),rows=seed(f),before=new Map(f.files),backup=backups();
  const result=await migrateStorage(f.options,{knownIds:rows.map(r=>r.id),saveRevision:backup.saveRevision});
  assert.equal(result.objects,16);assert.equal(result.revisions,8);assert.ok(result.passes>1);
  for(const [p,b] of before){const name=p.slice(v1.length);assert.deepEqual(f.files.get(v2+name[0]+'/'+name),b);}
  assert.equal(backup.saved.size,8);assert.ok(f.files.has(v1+MARKER));
  assert.equal([...f.files.keys()].filter(p=>p.startsWith(v1)).length,1);
  assert.ok(!f.calls.some(x=>x.method==='DELETE'));
  const fresh=new AdaptiveDavRemote(f.options);const got=await fresh.listRevisions();
  assert.deepEqual([...project(got)],[...project(rows)]);
  assert.deepEqual(await fresh.getBlob(rows[0].blob),Buffer.from('body-0'));
  const body=bytes('new edit'),h=digest(body);await fresh.putBlob(h,body);
  const r=makeRevision({path:rows[0].path,parents:[rows[0].id],blob:h,device:'iPhone'});await fresh.putRevision(r);
  assert.equal((await new AdaptiveDavRemote(f.options).listRevisions()).length,9);
  await assert.rejects(new DavRemote(f.options).listRevisions(),/未知条目/);
});

test('a crash after MOVE can resume without forgetting the original IDs or republishing revisions',async()=>{
  const f=fixture(5),rows=seed(f),backup=backups();let moved=0;
  f.hook=async({phase,method})=>{if(method==='MOVE'&&phase==='after'&&++moved===3)throw new Error('interrupted');};
  await assert.rejects(migrateStorage(f.options,{knownIds:rows.map(r=>r.id),saveRevision:backup.saveRevision}));
  assert.equal(f.files.has(v2+'format.json'),false);
  await assert.rejects(new AdaptiveDavRemote(f.options).listRevisions(),/迁移未完成/);
  f.hook=async()=>{};await migrateStorage(f.options,{knownIds:rows.map(r=>r.id),saveRevision:backup.saveRevision});
  assert.equal((await new AdaptiveDavRemote(f.options).listRevisions()).length,rows.length);
});

test('resume rechecks a corrupt destination left by an interrupted move before publishing the format',async()=>{
  const f=fixture(5);seed(f);let broken=false;
  f.hook=async({phase,method,p,headers})=>{if(!broken&&method==='MOVE'&&phase==='after'&&p.endsWith('.blob')){broken=true;f.files.set(new URL(headers.Destination).pathname,Buffer.from('bad'));throw new Error('interrupted');}};
  await assert.rejects(migrateStorage(f.options,backups()));f.hook=async()=>{};
  await assert.rejects(migrateStorage(f.options,backups()),/校验失败/);assert.equal(f.files.has(v2+'format.json'),false);
});

test('a real missing known revision prevents format activation and preserves local ancestry',async()=>{
  const f=fixture(5),rows=seed(f);const missing=rows.pop();f.files.delete(v1+missing.id+'.json');
  await assert.rejects(migrateStorage(f.options,{knownIds:[...rows,missing].map(r=>r.id),saveRevision:backups().saveRevision}),/缺少本机/);
  assert.equal(f.files.has(v2+'format.json'),false);
});

test('sharded listing still rejects missing parents, missing blobs and disappeared cached revisions',async()=>{
  const f=fixture(5),rows=seed(f);await migrateStorage(f.options,backups());
  const client=new AdaptiveDavRemote(f.options);await client.listRevisions();
  const p=v2+rows[0].id[0]+'/'+rows[0].id+'.json';const held=f.files.get(p);f.files.delete(p);
  await assert.rejects(client.listRevisions(),/以前确认/);f.files.set(p,held);
  f.files.delete(v2+rows[0].blob[0]+'/'+rows[0].blob+'.blob');
  await assert.rejects(client.listRevisions(),/附件缺失/);
});

test('late writes by an old client stop new clients instead of being silently omitted',async()=>{
  const f=fixture(5);const rows=seed(f);await migrateStorage(f.options,backups());
  f.files.set(v1+rows[0].id+'.json',Buffer.from(JSON.stringify(rows[0])));
  await assert.rejects(new AdaptiveDavRemote(f.options).listRevisions(),/旧目录仍有/);
});

test('rollback restores the original flat objects byte-for-byte and archives metadata without DELETE',async()=>{
  const f=fixture(5);seed(f);const before=new Map(f.files);await migrateStorage(f.options,backups());
  await rollbackStorage(f.options);
  for(const [name,b] of before)assert.deepEqual(f.files.get(name),b);
  assert.equal(f.dirs.has(v2),false);assert.equal(f.files.has(v1+MARKER),false);
  assert.ok(!f.calls.some(x=>x.method==='DELETE'));
  assert.equal([...f.files.keys()].filter(p=>p.startsWith(v1)).length,before.size);
});

test('B3: selected v2 validates format only once while uploading ten files', async () => {
  const f = fixture(); f.dirs.add(v2); f.files.set(v2 + 'format.json', Buffer.from(FORMAT_TEXT));
  const client = new AdaptiveDavRemote(f.options);
  await client.listRevisions();
  for (let i = 0; i < 10; i++) {
    const body = bytes('B3 upload ' + i), hash = digest(body);
    await client.putBlob(hash, body);
    await client.putRevision(makeRevision({ path: 'B3-' + i + '.md', blob: hash, device: 'test' }));
  }
  assert.equal(f.calls.filter(c => c.method === 'GET' && c.path === v2 + 'format.json').length, 1);
});

test('B5: cached v1 idle poll uses two PROPFIND requests and notices completed migration', async () => {
  const f = fixture(); const rows = seed(f, 2); const client = new AdaptiveDavRemote(f.options);
  await client.listRevisions(); f.calls.length = 0;
  assert.equal((await client.listRevisions()).length, rows.length);
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [['PROPFIND', v2], ['PROPFIND', v1]]);
  await migrateStorage(f.options, backups());
  assert.equal((await client.listRevisions()).length, rows.length);
  assert.equal(client.selected, client.sharded);
});

test('B5: cached v1 pauses when another device starts an incomplete migration', async () => {
  const f = fixture(); seed(f, 1); const client = new AdaptiveDavRemote(f.options);
  await client.listRevisions(); f.dirs.add(v2);
  await assert.rejects(client.listRevisions(), /迁移未完成/);
  assert.equal(client.selected, null);
});

test('B5: cached v2 idle poll has at most eighteen requests with no GET and detects rollback from root inventory', async () => {
  const f = fixture(); f.dirs.add(v2); f.files.set(v2 + 'format.json', Buffer.from(FORMAT_TEXT));
  for (const bucket of '0123456789abcdef') f.dirs.add(v2 + bucket + '/');
  const client = new AdaptiveDavRemote(f.options); await client.listRevisions(); f.calls.length = 0;
  await client.listRevisions();
  assert.equal(f.calls.length, 18);
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 0);
  f.files.set(v2 + 'rollback.json', Buffer.from('{}')); f.calls.length = 0;
  await assert.rejects(client.listRevisions(), /回退/);
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 0);
  assert.equal(client.selected, null);
});

test('B5: a failed cached listing clears layout selection and revalidates format on the next round', async () => {
  const f = fixture(); f.dirs.add(v2); f.files.set(v2 + 'format.json', Buffer.from(FORMAT_TEXT));
  const client = new AdaptiveDavRemote(f.options); await client.listRevisions();
  f.hook = async ({ method, p }) => { if (method === 'PROPFIND' && p === v2) throw new Error('offline'); };
  await assert.rejects(client.listRevisions(), /传输失败/);
  assert.equal(client.selected, null);
  f.hook = async () => {}; f.files.set(v2 + 'format.json', Buffer.from('{"version":999}')); f.calls.length = 0;
  await assert.rejects(client.listRevisions(), /不支持/);
  assert.ok(f.calls.some(c => c.method === 'GET' && c.path === v2 + 'format.json'));
});

test('B5: cached v2 still detects old-client writes and a missing format marker', async () => {
  const f = fixture(); const rows = seed(f, 1); await migrateStorage(f.options, backups());
  const client = new AdaptiveDavRemote(f.options); await client.listRevisions();
  f.files.set(v1 + rows[0].id + '.json', Buffer.from(JSON.stringify(rows[0])));
  await assert.rejects(client.listRevisions(), /旧目录仍有/);
  f.files.delete(v1 + rows[0].id + '.json'); await client.listRevisions();
  f.files.delete(v2 + 'format.json');
  await assert.rejects(client.listRevisions(), /迁移/);
});


for (const layout of ['v1', 'v2']) test(`B2: mobile ${layout} uploads use five requests per new file and verified preuploads cost zero`, async () => {
  const { mobileRequest } = require('../src/mobile');
  const { arrayBuffer } = require('../src/bytes');
  const f = fixture();
  if (layout === 'v2') {
    f.dirs.add(v2); f.files.set(v2 + 'format.json', Buffer.from(FORMAT_TEXT));
    for (const bucket of '0123456789abcdef') f.dirs.add(v2 + bucket + '/');
  }
  const client = new AdaptiveDavRemote({ ...f.options, request: mobileRequest(async args => {
    const response = await f.options.request({ ...args, url: new URL(args.url) });
    return { status: response.status, headers: response.headers, arrayBuffer: arrayBuffer(response.body) };
  }) });
  await client.listRevisions(); f.calls.length = 0;
  for (let i = 0; i < 10; i++) {
    const body = bytes('mobile B2 body ' + i), hash = digest(body), before = f.calls.length;
    await client.putBlob(hash, body);
    await client.putRevision(makeRevision({ path: 'B2-' + i + '.md', blob: hash, device: 'phone' }));
    assert.deepEqual(f.calls.slice(before).map(c => c.method), ['PUT', 'HEAD', 'GET', 'PUT', 'GET']);
    const verified = f.calls.length; await client.putBlob(hash, body);
    assert.equal(f.calls.length, verified);
  }
  assert.equal(f.calls.length, 50);
});
