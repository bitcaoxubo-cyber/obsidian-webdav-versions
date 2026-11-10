'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiskVault, DiskState } = require('../src/local');
const { digest, makeRevision } = require('../src/protocol');
const { SyncEngine } = require('../src/engine');

function setup(t, guard) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dav-disk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'vault');
  fs.mkdirSync(root);
  return { tmp, root, local: new DiskVault(root, '.obsidian', guard) };
}

test('local CAS guards unsaved editor, preserves exact binary and detects equal-size replacements', async t => {
  let saved = true;
  const { root, local } = setup(t, () => saved);
  const name = '实验/文件.pdf', base = Buffer.from([255, 0, 24]), later = Buffer.from([254, 0, 24]);
  assert.equal(await local.compareAndSet(name, null, base), true);
  assert.equal(await local.hash(name), digest(base));
  assert.deepEqual(await local.list(), [name]);
  saved = false;
  assert.equal(await local.compareAndSet(name, digest(base), null), false);
  saved = true;
  fs.writeFileSync(path.join(root, name), later);
  assert.equal(await local.hash(name), digest(later));
  assert.equal(await local.compareAndSet(name, digest(base), Buffer.alloc(0)), false);
  assert.deepEqual(await local.read(name), later);
  assert.equal(await local.compareAndSet(name, digest(later), null), true);
  assert.equal(await local.hash(name), null);
});

test('unfinished disk replacement survives restart without crossing into configuration or symlinks', async t => {
  const { root, tmp, local } = setup(t);
  const body = Buffer.from('原始'), newBody = Buffer.from('新到的版本');
  const name = '笔记.md', file = path.join(root, name);
  fs.writeFileSync(file, body);
  fs.mkdirSync(local.transaction);
  fs.writeFileSync(path.join(local.transaction, 'next'), newBody);
  fs.writeFileSync(path.join(local.transaction, 'intent.json'), JSON.stringify({ name, expected: digest(body), next: digest(newBody) }));
  fs.renameSync(file, path.join(local.transaction, 'previous'));
  assert.deepEqual(await new DiskVault(root).list(), [name]);
  assert.deepEqual(fs.readFileSync(file), newBody);
  fs.symlinkSync(tmp, path.join(root, 'link'));
  await assert.rejects(local.compareAndSet('link/other.md', null, body), /普通文件夹/);
  assert.deepEqual(await local.list(), [name]);
  await assert.rejects(local.compareAndSet('.obsidian/settings.json', null, body), /不安全/);
  assert.equal(fs.existsSync(path.join(tmp, 'other.md')), false);
});

test('lists scientific titles containing colons and skips unbound symlinks, including broken links', async t => {
  const { tmp, root, local } = setup(t);
  const name = 'Dynamics: From a single droplet/Findings: 2 µm.md';
  const bytes = Buffer.from('标题');
  assert.equal(await local.compareAndSet(name, null, bytes), true);
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sample.md'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(outside, 'missing.md'), path.join(root, 'dangling.md'));
  fs.symlinkSync(path.join(outside, 'sample.md'), path.join(root, 'linked.md'));
  assert.deepEqual(await local.list(), [name]);
  assert.equal(await local.hash(name), digest(bytes));
  for (const blocked of ['dangling.md', 'linked.md', 'node_modules/sample.md', 'node_modules/missing.md']) {
    await assert.rejects(local.hash(blocked), /链接|普通文件夹/);
    await assert.rejects(local.read(blocked), /链接|普通文件夹/);
    await assert.rejects(local.compareAndSet(blocked, null, bytes), /链接|普通文件夹/);
    await assert.rejects(local.compareAndSet(blocked, digest(bytes), null), /链接|普通文件夹/);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'sample.md'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(outside, 'missing.md')), false);
});

test('sync preserves remote history when a tracked path or remote download hits a link', async t => {
  const { root, tmp, local } = setup(t);
  const revisions = [], blobs = new Map();
  const remote = {
    listRevisions: async () => revisions.slice(),
    putRevision: async rev => { revisions.push(rev); },
    putBlob: async (id, body) => { blobs.set(id, Buffer.from(body)); },
    getBlob: async id => blobs.get(id)
  };
  const state = new DiskState(local.privateDir, 'https://localhost/vault/', 'test');
  const engine = new SyncEngine({ local, state, remote, device: 'Mac' });
  const name = 'tracked.md';
  const body = Buffer.from('original');
  await local.compareAndSet(name, null, body);
  await engine.sync();
  assert.equal(revisions.length, 1);
  fs.unlinkSync(path.join(root, name));
  fs.symlinkSync(path.join(tmp, 'never-created'), path.join(root, name));
  await assert.rejects(engine.sync(), /链接/);
  assert.deepEqual(revisions.map(r => r.blob), [digest(body)]);
  fs.unlinkSync(path.join(root, name));
  fs.writeFileSync(path.join(root, name), body);
  const dir = path.join(tmp, 'external');
  fs.mkdirSync(dir);
  fs.symlinkSync(dir, path.join(root, 'linked-dir'));
  const added = makeRevision({ path: 'linked-dir/other.md', device: 'Other Mac', blob: digest(body) });
  revisions.push(added);
  await assert.rejects(engine.sync(), /普通文件夹/);
  assert.equal(fs.existsSync(path.join(dir, 'other.md')), false);
  assert.equal(revisions.length, 2);
});

test('mismatched inode captured during recovery is restored, and scoped state survives restart', async t => {
  const { local } = setup(t);
  const name = '竞态.md', userEdit = Buffer.from('用户的新修改');
  fs.mkdirSync(local.transaction);
  fs.writeFileSync(path.join(local.transaction, 'previous'), userEdit);
  fs.writeFileSync(path.join(local.transaction, 'intent.json'), JSON.stringify({ name, expected: digest('旧修改'), next: null }));
  assert.deepEqual(await local.list(), [name]);
  assert.deepEqual(await local.read(name), userEdit);
  const a = new DiskState(local.privateDir, 'https://localhost/vault/', 'user');
  const b = new DiskState(local.privateDir, 'https://localhost/other/', 'user');
  await a.save({ version: 1, files: [name] });
  assert.deepEqual(await a.load(), { version: 1, files: [name] });
  assert.equal(await b.load(), null);
  fs.writeFileSync(a.file, '{');
  await assert.rejects(a.load(), SyntaxError);
});
