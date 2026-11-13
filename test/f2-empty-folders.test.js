'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { disk, mobile, remote } = require('./helpers/empty-folders');
const { residualDirectories, directoryRecord } = require('../src/directories');

async function remnants(t, names = ['a/b/c/old.md'], phone = false, retained) {
  const r = remote(), a = disk(t, r);
  for (const name of names) a.put(name, 'old');
  await a.engine.sync(); for (const name of names) a.remove(name); await a.engine.sync();
  const b = phone ? mobile(r, undefined, retained) : disk(t, r, retained);
  for (const name of names) b.mkdir(name.slice(0, name.lastIndexOf('/')));
  return { a, b, r };
}
test('F2: first full round finds historical multilevel remnant without repairing it', async t => {
  const { b, r } = await remnants(t); const count = r.revisions.size;
  const result = await b.engine.sync();
  assert.deepEqual(result.emptyDirectories, [{ path: 'a', subdirectoryCount: 2, containsDSStore: false }]);
  assert.ok(b.has('a/b/c')); assert.equal(r.revisions.size, count);
});
test('F2: unrelated empty child blocks only its ancestors; never-used directories are omitted', async t => {
  const { b } = await remnants(t); b.mkdir('a/mine'); b.mkdir('never-used');
  const result = await b.engine.sync();
  assert.deepEqual(result.emptyDirectories, [{ path: 'a/b', subdirectoryCount: 1, containsDSStore: false }]);
});
for (const [label, name, content] of [
  ['new unsynchronized file', 'a/new.md', 'new'], ['hidden file', 'a/.hidden', 'hidden'],
  ['conflict copy waiting next round', 'a/copy (sync-conflict unknown).md', 'conflict'],
  ['stale copy waiting confirmation', 'a/b/c/old.md', 'old']
]) test(`F2: ${label} prevents ancestor classification`, async t => {
  const { b } = await remnants(t); b.put(name, content);
  const result = await b.engine.sync();
  assert.equal(result.emptyDirectories.some(e => e.path === 'a'), false);
  assert.ok(b.has(name));
  if (label.startsWith('stale')) assert.equal(result.staleCopies.length, 1);
  if (label.startsWith('conflict')) assert.deepEqual(result.deferredPaths, [name]);
});
for (const label of ['remote view', 'binding', 'deferred', 'stale', 'unfinished journal']) test(`F2: ${label} path protects an otherwise empty subtree`, () => {
  const records = new Map([['a', directoryRecord()]]);
  assert.deepEqual(residualDirectories(records, { history: ['a/old.md'], protectedPaths: ['a/current.md'] }), []);
});
for (const phone of [false, true]) test(`F2: DS_Store exception is ${phone ? 'disabled on mobile' : 'marked on desktop'}`, async t => {
  const { b } = await remnants(t, ['a/b/old.md'], phone); b.put('a/b/.DS_Store', 'finder');
  const result = await b.engine.sync();
  assert.deepEqual(result.emptyDirectories, phone ? [] : [{ path: 'a', subdirectoryCount: 1, containsDSStore: true }]);
  assert.ok(b.has('a/b/.DS_Store'));
});
test('F2: retained subtree and ancestors excluded while another device remains independent', async t => {
  const { a, b, r } = await remnants(t, ['a/b/old.md'], false, () => ['a/b']);
  assert.deepEqual((await b.engine.sync()).emptyDirectories, []);
  assert.equal((await a.engine.sync()).emptyDirectories[0].path, 'a');
  const c = disk(t, r, () => ['a/b']); c.mkdir('a/b');
  assert.deepEqual((await c.engine.sync()).emptyDirectories, []);
});
test('F2: incremental round reuses last full list without any vault directory enumeration', async t => {
  const { b } = await remnants(t, ['a/b/old.md'], true);
  const previous = (await b.engine.sync()).emptyDirectories;
  b.local.list = () => { throw new Error('extra scan'); };
  const list = b.adapter.list.bind(b.adapter);
  b.adapter.list = p => { assert.ok(p.startsWith('.obsidian/'), 'no vault directory reads'); return list(p); };
  const next = await b.engine.sync({ full: false, dirty: [] });
  assert.strictEqual(next.emptyDirectories, previous);
});
test('F2: hidden directories, config, and symlinks never become candidates', async t => {
  const { b } = await remnants(t); b.mkdir('a/b/.hidden'); b.mkdir('.trash');
  fs.symlinkSync(path.join(b.root, 'a/b/c'), path.join(b.root, 'a/link'));
  const result = await b.engine.sync();
  assert.deepEqual(result.emptyDirectories.map(e => e.path), ['a/b/c']);
});
test('F2: synchronous apply deletion is reflected in the existing directory scan without another traversal', async t => {
  const r = remote(), a = disk(t, r), b = mobile(r);
  a.put('p/q/old.md', 'old'); await a.engine.sync(); await b.engine.sync();
  a.remove('p/q/old.md'); await a.engine.sync();
  const list = b.adapter.list.bind(b.adapter), seen = [];
  b.adapter.list = p => { if (!p.startsWith('.obsidian')) seen.push(p); return list(p); };
  const result = await b.engine.sync();
  assert.deepEqual(seen, ['', 'p', 'p/q']);
  assert.deepEqual(result.emptyDirectories, [{ path: 'p', subdirectoryCount: 1, containsDSStore: false }]);
});
test('F2: a current remote file not yet downloaded protects a physically empty directory', async t => {
  const r = remote(), a = disk(t, r), b = disk(t, r);
  a.put('a/remote.md', 'remote content'); await a.engine.sync(); b.mkdir('a');
  b.local.guard = () => false;
  const result = await b.engine.sync();
  assert.equal(b.has('a/remote.md'), false); assert.deepEqual(result.deferredPaths, ['a/remote.md']);
  assert.deepEqual(result.emptyDirectories, []); assert.ok(b.has('a'));
});
module.exports = { remnants };
