'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncEngine } = require('../src/engine');
const { DiskVault, DiskState } = require('../src/local');
const { MobileVault, MobileState } = require('../src/mobile');
const { Adapter } = require('./helpers/adapter');
const { bytes, text, digest } = require('../src/bytes');
const { headsFor } = require('../src/protocol');
const ENDPOINT = 'https://example.test/empty-directory-tests/';

// A native adapter must reject nonrecursive removal atomically, including hidden
// files and child directories. The general fixture historically ignored false.
class StrictAdapter extends Adapter {
  constructor() { super(); this.directoryRemovals = []; }
  requireParent(name) {
    const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    if (!this.folders.has(parent)) throw Object.assign(new Error('Missing parent directory: ' + parent), { code: 'ENOENT' });
  }
  async writeBinary(name, value) { this.requireParent(name); return super.writeBinary(name, value); }
  async copy(from, to) {
    await this.hook('copy', to, 'before');
    this.requireParent(to);
    if (await this.exists(to)) throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' });
    this.files.set(to, this.files.get(from).slice()); this.touch(to);
    await this.hook('copy', to, 'after');
  }
  async rmdir(name, recursive = false) {
    this.directoryRemovals.push({ name, recursive });
    if (recursive) {
      assert.ok(name.startsWith('.obsidian/'), 'ordinary vault directory cleanup must never be recursive');
      return super.rmdir(name, true);
    }
    assert.notEqual(name, '', 'never remove the vault root');
    await this.hook('rmdir', name, 'before');
    if (!this.folders.has(name)) throw Object.assign(new Error('Directory absent'), { code: 'ENOENT' });
    if ([...this.files.keys(), ...this.folders].some(child => child.startsWith(name + '/'))) {
      throw Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
    }
    this.folders.delete(name);
    await this.hook('rmdir', name, 'after');
  }
}
function remote() {
  return { blobs: new Map(), revisions: new Map(),
    async listRevisions() { return [...this.revisions.values()]; },
    async putBlob(hash, value) { assert.equal(digest(value), hash); this.blobs.set(hash, bytes(value).slice()); },
    async getBlob(hash) { return this.blobs.get(hash).slice(); },
    async getBlobSize(hash) { return this.blobs.get(hash).length; },
    async putRevision(revision) { this.revisions.set(revision.id, revision); },
  };
}
function disk(t, r) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-empty-dirs-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'vault'); fs.mkdirSync(root);
  const local = new DiskVault(root), state = new DiskState(local.privateDir, ENDPOINT, 'test');
  return { temp, root, local, state, engine: new SyncEngine({ remote: r, local, state, device: 'Mac' }),
    write(name, content) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); },
    remove(name) { fs.unlinkSync(path.join(root, name)); },
  };
}
function mobile(r, adapter = new StrictAdapter()) {
  const local = new MobileVault(adapter), state = new MobileState(adapter, local.privateDir, ENDPOINT, 'test');
  return { adapter, local, state, engine: new SyncEngine({ remote: r, local, state, device: 'iPhone' }) };
}
function mobileDirectory(c, name) {
  const parts = name.split('/');
  for (let i = 1; i <= parts.length; i++) c.adapter.folders.add(parts.slice(0, i).join('/'));
}
function mobileFile(c, name, value) {
  if (name.includes('/')) mobileDirectory(c, name.slice(0, name.lastIndexOf('/')));
  c.adapter.put(name, value);
}
async function seeded(t, names) {
  const r = remote(), mac = disk(t, r), phone = mobile(r);
  for (const name of names) mac.write(name, 'content: ' + name);
  await mac.engine.sync(); await phone.engine.sync();
  return { r, mac, phone };
}
const visibleRemovals = phone => phone.adapter.directoryRemovals.filter(row => !row.name.startsWith('.obsidian/'));
function pureDeletion(r, name) {
  const ids = headsFor(r.revisions.values(), name);
  assert.ok(ids.length > 0); assert.ok(ids.every(id => r.revisions.get(id).blob === null));
}

for (const operation of ['delete', 'move out', 'rename folder']) test(`Empty directories: Disk to Mobile ${operation} removes only obsolete empty parents`, async t => {
  const old = '文献与组会/旧目录/文献.pdf';
  const { r, mac, phone } = await seeded(t, [old]);
  mobileDirectory(phone, 'unrelated-empty');
  if (operation === 'delete') mac.remove(old);
  else if (operation === 'move out') fs.renameSync(path.join(mac.root, old), path.join(mac.temp, 'outside-vault.pdf'));
  else fs.renameSync(path.join(mac.root, '文献与组会/旧目录'), path.join(mac.root, '文献与组会/新目录'));
  await mac.engine.sync({ full: true });
  const result = await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(result.deleted, 1); assert.equal(result.conflicts, 0); assert.equal(result.deferred, 0);
  assert.equal(result.cleanedDirectories, operation === 'rename folder' ? 1 : 2);
  pureDeletion(r, old);
  assert.equal(phone.adapter.files.has(old), false);
  assert.equal(phone.adapter.folders.has('文献与组会/旧目录'), false);
  if (operation === 'rename folder') {
    const next = '文献与组会/新目录/文献.pdf';
    assert.equal(text(phone.adapter.files.get(next)), 'content: ' + old);
    assert.equal(phone.adapter.folders.has('文献与组会'), true);
  } else assert.equal(phone.adapter.folders.has('文献与组会'), false);
  assert.equal(phone.adapter.folders.has('unrelated-empty'), true);
  assert.ok(visibleRemovals(phone).length > 0);
  assert.ok(visibleRemovals(phone).every(row => row.recursive === false));
});

test('Empty directories: full rounds repair historical remnants while incremental rounds prune only newly confirmed deletions', async t => {
  const old = 'historical/nested/old.md', next = 'recent/nested/new.md';
  const { r, mac, phone } = await seeded(t, [old, next]);
  phone.local.pruneEmptyDirectories = async () => {}; // Simulate the previous release retaining directories.
  mac.remove(old); await mac.engine.sync(); await phone.engine.sync();
  assert.equal(phone.adapter.files.has(old), false); assert.equal(phone.adapter.folders.has('historical/nested'), true);
  const upgraded = mobile(r, phone.adapter), count = r.revisions.size;
  await upgraded.engine.sync({ full: false, dirty: [] });
  assert.equal(upgraded.adapter.folders.has('historical/nested'), true, 'idle incremental rounds must not traverse historical deletions');
  mac.remove(next); await mac.engine.sync(); await upgraded.engine.sync({ full: false, dirty: [] });
  assert.equal(upgraded.adapter.folders.has('recent'), false);
  assert.equal(upgraded.adapter.folders.has('historical/nested'), true);
  const afterNewDeletion = r.revisions.size;
  assert.equal(afterNewDeletion, count + 1);
  const result = await upgraded.engine.sync({ full: true });
  assert.equal(result.uploaded + result.downloaded + result.deleted, 0);
  assert.equal(upgraded.adapter.folders.has('historical'), false);
  assert.equal(r.revisions.size, afterNewDeletion, 'directory cleanup never republishes file revisions');
});

test('Empty directories: hidden files, unreported local content, unrelated empty children and similar prefixes survive', async t => {
  const names = ['hidden/old.md', 'local/old.md', 'parent/old.md', 'prefix/old.md', 'top.md'];
  const { r, mac, phone } = await seeded(t, names);
  mobileFile(phone, 'hidden/.keep', 'hidden bytes');
  mobileFile(phone, 'local/not-yet-reported.md', 'local bytes');
  mobileDirectory(phone, 'parent/user-created-empty');
  mobileDirectory(phone, 'prefix-other');
  mobileDirectory(phone, 'unrelated');
  for (const name of names) mac.remove(name);
  await mac.engine.sync();
  const result = await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(result.deleted, names.length); assert.equal(result.uploaded, 0);
  assert.equal(text(phone.adapter.files.get('hidden/.keep')), 'hidden bytes');
  assert.equal(text(phone.adapter.files.get('local/not-yet-reported.md')), 'local bytes');
  for (const dir of ['hidden', 'local', 'parent', 'parent/user-created-empty', 'prefix-other', 'unrelated', '', '.obsidian']) {
    assert.equal(phone.adapter.folders.has(dir), true, dir);
  }
  assert.equal(phone.adapter.folders.has('prefix'), false, 'prefix-other must not be treated as a descendant of prefix');
  assert.ok(visibleRemovals(phone).every(row => row.recursive === false && row.name !== ''));
});

test('Empty directories: a live bound descendant protects its empty directory after a concurrent local removal', async t => {
  const { mac, phone } = await seeded(t, ['protected/dead.md', 'protected/live.md', 'eligible/dead.md']);
  mac.remove('protected/dead.md'); mac.remove('eligible/dead.md'); await mac.engine.sync();
  const cas = phone.local.compareAndSet.bind(phone.local);
  phone.local.compareAndSet = async (name, expected, next) => {
    const result = await cas(name, expected, next);
    if (name === 'protected/dead.md' && result) await phone.adapter.remove('protected/live.md');
    return result;
  };
  await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(phone.adapter.folders.has('eligible'), false);
  assert.equal(phone.adapter.folders.has('protected'), true);
  assert.equal(visibleRemovals(phone).some(row => row.name === 'protected'), false);
  assert.ok(new Map((await phone.state.load()).files).has('protected/live.md'));
});

test('Empty directories: an unbound deferred path protects its parent even if it disappears during another CAS', async t => {
  const { mac, phone } = await seeded(t, ['protected/dead.md', 'eligible/dead.md']);
  const orphan = 'protected/copy (sync-conflict unknown).md';
  mobileFile(phone, orphan, 'unpublished local copy');
  mac.remove('protected/dead.md'); mac.remove('eligible/dead.md'); await mac.engine.sync();
  const cas = phone.local.compareAndSet.bind(phone.local);
  phone.local.compareAndSet = async (name, expected, next) => {
    const result = await cas(name, expected, next);
    if (name === 'protected/dead.md' && result) await phone.adapter.remove(orphan);
    return result;
  };
  const result = await phone.engine.sync({ full: true });
  assert.deepEqual(result.deferredPaths, [orphan]);
  assert.equal(phone.adapter.folders.has('eligible'), false);
  assert.equal(phone.adapter.folders.has('protected'), true);
  assert.equal(visibleRemovals(phone).some(row => row.name === 'protected'), false);
  assert.equal(new Map((await phone.state.load()).files).has(orphan), false);
});

test('Empty directories: a file created at the removal boundary is preserved by atomic nonrecursive rmdir', async t => {
  const { mac, phone } = await seeded(t, ['race/old.md']);
  mac.remove('race/old.md'); await mac.engine.sync();
  let raced = false;
  phone.adapter.hook = async (operation, name, when) => {
    if (!raced && operation === 'rmdir' && name === 'race' && when === 'before') {
      raced = true; mobileFile(phone, 'race/new-local.md', 'created concurrently');
    }
  };
  await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(raced, true);
  assert.equal(text(phone.adapter.files.get('race/new-local.md')), 'created concurrently');
  assert.equal(phone.adapter.folders.has('race'), true);
  assert.ok(visibleRemovals(phone).every(row => row.recursive === false));
});

test('Empty directories: interrupted cleanup leaves durable tombstones and a full retry finishes without new revisions', async t => {
  const { r, mac, phone } = await seeded(t, ['retry/nested/old.md']);
  mac.remove('retry/nested/old.md'); await mac.engine.sync();
  let interrupted = false;
  phone.adapter.hook = async (operation, name, when) => {
    if (!interrupted && operation === 'rmdir' && name === 'retry/nested' && when === 'before') {
      interrupted = true; throw new Error('injected directory cleanup interruption');
    }
  };
  await assert.rejects(phone.engine.sync({ full: false, dirty: [] }), /文件同步已保存，空目录清理未完成，请重试：retry\/nested/);
  assert.equal(interrupted, true);
  assert.equal(phone.adapter.files.has('retry/nested/old.md'), false);
  assert.equal(await phone.state.loadPending(), null);
  const count = r.revisions.size;
  phone.adapter.hook = async () => {};
  const restart = mobile(r, phone.adapter);
  const result = await restart.engine.sync({ full: true });
  assert.equal(result.uploaded + result.downloaded + result.deleted, 0);
  assert.equal(restart.adapter.folders.has('retry'), false);
  assert.equal(r.revisions.size, count);
});

test('Empty directories: a later download recreates pruned parents in the same MobileVault instance', async t => {
  const old = 'recreate/child/old.md', next = 'recreate/child/new.md';
  const { mac, phone } = await seeded(t, [old]);
  mac.remove(old); await mac.engine.sync(); await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(phone.adapter.folders.has('recreate'), false);
  mac.write(next, 'new download'); await mac.engine.sync();
  const result = await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(result.downloaded, 1);
  assert.equal(text(phone.adapter.files.get(next)), 'new download');
  assert.equal(phone.adapter.folders.has('recreate/child'), true);
  assert.equal(phone.adapter.files.has(old), false);
});

test('Empty directories: successful rmdir interrupted in background still invalidates cached parents before the next download', async t => {
  const old = 'interrupted/child/old.md', next = 'interrupted/child/new.md';
  const { mac, phone } = await seeded(t, [old]);
  let active = true, interrupted = false;
  phone.local.active = () => active;
  assert.ok(phone.local.confirmedDirectories.has('interrupted/child'));
  mac.remove(old); await mac.engine.sync();
  phone.adapter.hook = async (operation, name, when) => {
    if (!interrupted && operation === 'rmdir' && name === 'interrupted/child' && when === 'after') {
      interrupted = true; active = false;
      throw new Error('rmdir completed immediately before background interruption');
    }
  };
  await assert.rejects(phone.engine.sync({ full: false, dirty: [] }), /暂停/);
  assert.equal(interrupted, true);
  assert.equal(phone.adapter.folders.has('interrupted/child'), false, 'directory deletion really completed before the error');
  assert.equal(await phone.state.loadPending(), null);
  mac.write(next, 'download after foreground'); await mac.engine.sync();
  active = true;
  const result = await phone.engine.sync({ full: false, dirty: [] });
  assert.equal(result.downloaded, 1); assert.equal(result.conflicts, 0);
  assert.equal(phone.adapter.folders.has('interrupted/child'), true);
  assert.equal(text(phone.adapter.files.get(next)), 'download after foreground');
  assert.equal(phone.adapter.files.has(old), false);
});
