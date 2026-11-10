'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const out = path.join(root,'dist');
fs.mkdirSync(out,{recursive:true});
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'webdav-release-'));
try {
  const plugin = path.join(temp,manifest.id);fs.mkdirSync(plugin);
  for(const name of ['main.js','manifest.json','LICENSE','NOTICE','README.md']) fs.copyFileSync(path.join(root,name),path.join(plugin,name));
  fs.cpSync(path.join(root,'docs'),path.join(plugin,'docs'),{recursive:true});
  for(const name of ['main.js','manifest.json'])fs.copyFileSync(path.join(root,name),path.join(out,name));
  const archive = path.join(out,manifest.id+'-'+manifest.version+'.zip');
  // Create afresh, never append to an existing archive with stale members.
  const tempArchive = path.join(temp,'release.zip');
  execFileSync('zip',['-q','-r',tempArchive,manifest.id],{cwd:temp});
  fs.copyFileSync(tempArchive,archive);
  const names=['main.js','manifest.json',path.basename(archive)];
  fs.writeFileSync(path.join(out,'SHA256SUMS'),names.map(name=>createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex')+'  '+name).join('\n')+'\n');
  console.log('Packaged '+manifest.version+' (plugin files and documentation only)');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
