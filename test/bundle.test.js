'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { Adapter } = require('./helpers/adapter');
const { arrayBuffer, bytes, text, digest } = require('../src/bytes');

function fakeDAV() {
  const objects = new Map(), dirs = new Set(['/vault/']);
  const response = (p,dir) => `<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype>${dir?'<d:collection/>':''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  return { objects, async requestUrl({url,method,headers,body}) {
    assert.equal(headers.Authorization, 'Basic dGVzdDp0ZXN0');
    const p = new URL(url).pathname;
    const send = (status,data='',extra={}) => ({status,headers:extra,arrayBuffer:arrayBuffer(data)});
    if(method==='PROPFIND') {
      if(!dirs.has(p)) return send(404);
      const children = headers.Depth==='1'?[...objects.keys()].filter(k=>k.startsWith(p)).map(k=>response(k,false)).join(''):'';
      return send(207,'<d:multistatus xmlns:d="DAV:">'+response(p,true)+children+'</d:multistatus>');
    }
    if(method==='MKCOL'){dirs.add(p);return send(201);}
    if(method==='HEAD')return objects.has(p)?send(200,'',{'content-length':String(objects.get(p).length)}):send(404);
    if(method==='GET')return objects.has(p)?send(200,objects.get(p)):send(404);
    if(method==='PUT'){objects.set(p,bytes(body).slice());return send(201);}
    return send(405);
  }};
}

test('built plugin loads and completes native-API sync without Node, Buffer, process or filesystem paths',async()=>{
  const dav=fakeDAV(), notices=[], nativeCalls=[], panels=[];
  const element=()=>({setText(){},setAttribute(){},addEventListener(){}});
  class Plugin {
    async loadData(){return null;} async saveData(v){this.saved=v;}
    addStatusBarItem(){return element();} addRibbonIcon(){return element();}
    addCommand(){} addSettingTab(){} registerEvent(){} registerDomEvent(){} registerInterval(){}
  }
  const document={visibilityState:'visible'};
  const host={ Plugin, PluginSettingTab:class{}, Modal:class{constructor(){this.titleEl={setText(){}};this.contentEl={createEl:(tag,{text})=>panels.push(text)};}open(){}}, Setting:class{addButton(){return this;}}, SecretComponent:class{},
    Notice:class{constructor(m){notices.push(m);}}, Platform:{isMobile:true,isIosApp:true}, requestUrl:dav.requestUrl };
  const context=vm.createContext({module:{exports:{}},require:name=>{nativeCalls.push(name);if(name==='obsidian')return host;throw new Error('Unavailable on mobile: '+name);},
    crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,Uint32Array,ArrayBuffer,DataView,URL,structuredClone,btoa,atob,
    window:{setTimeout:()=>0,clearTimeout(){},setInterval:()=>0},document});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),context);
  const make=async()=>{
    const adapter=new Adapter(), p=new context.module.exports();
    p.app={secretStorage:{getSecret:()=> 'test'},vault:{adapter,configDir:'.obsidian',on:()=>({})},
      workspace:{onLayoutReady:f=>f(),getLeavesOfType:()=>[]},plugins:{enabledPlugins:new Set()}};
    await p.onload(); await p.configure({url:'https://example.test/vault/',username:'test',secret:'local',device:'iPhone',auto:false});
    return {p,adapter};
  };
  const a=await make(); a.adapter.put('测试.md','from iPhone'); await a.p.run('sync',true);
  assert.equal(a.p.lastError,''); assert.equal(a.p.statusMessage,'已同步');
  const b=await make(); await b.p.run('sync',true);
  assert.equal(b.p.lastError,''); assert.equal(text(b.adapter.files.get('测试.md')),'from iPhone');
  for (const key of ['durationMs','vaultReads','hashBytes','httpRequests','full']) assert.equal(typeof a.p.result.stats[key], 'number');
  assert.ok(a.p.result.stats.httpRequests > 0);
  a.p.openStatus();
  assert.ok(panels.some(t=>t.includes('读取库内文件') && t.includes(String(a.p.result.stats.vaultReads))));
  assert.equal(a.p.saved.secret,'local'); assert.equal(Object.values(a.p.saved).includes('test:test'),false);
  a.adapter.folders.add('旧目录'); a.adapter.put('旧目录/已删除.md','old');
  await a.p.run('sync',true); await b.p.run('sync',true);
  assert.equal(b.adapter.folders.has('旧目录'),true);
  await a.adapter.remove('旧目录/已删除.md');
  await a.p.run('sync',true); await b.p.run('sync',true);
  assert.equal(b.p.lastError,'');
  assert.equal(b.adapter.folders.has('旧目录'),false);
  assert.equal(b.p.result.cleanedDirectories,1);
  b.p.openStatus();
  assert.ok(panels.includes('已清理空文件夹 1 个。'));
  assert.equal(nativeCalls.some(n=>n.startsWith('node:')),false);
  assert.ok(nativeCalls.every(n=>n==='obsidian'||n==='stream')); // SAX's optional stream support is caught.
  const count=dav.objects.size; document.visibilityState='hidden'; a.adapter.put('测试.md','offline'); await a.p.run('sync',true);
  assert.equal(dav.objects.size,count); document.visibilityState='visible'; await a.p.run('sync',true);
  assert.ok(dav.objects.size>count); a.p.onunload(); b.p.onunload();
});

test('v1 revision IDs remain compatible with fixed desktop 0.1.1 fixtures',()=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/v011.json'),'utf8'));
  const { makeRevision, validateRevision, project }=require('../src/protocol');
  for(const r of fixture.revisions){assert.deepEqual(makeRevision(r),r);assert.equal(validateRevision(r),r);}
  assert.deepEqual([...project(fixture.revisions)],fixture.projection);
  assert.equal(digest(fixture.content),fixture.contentHash);
});

for (const mobile of [false, true]) test(`E3: ${mobile ? 'mobile' : 'desktop'} settings show manifest version and preservation-aware update guidance`, async () => {
  const { host } = require('./helpers/plugin-host');
  const manifest = require('../manifest.json');
  const h = await host({ mobile });
  h.settingTabs[0].display();
  const heading = h.settingTabs[0].containerEl.settings[0];
  assert.equal(heading.name, '飞牛 WebDAV 版本同步 · ' + manifest.version);
  assert.equal(heading.desc, '更新请用 BRAT 或覆盖 main.js 与 manifest.json，不要卸载重装');
});
