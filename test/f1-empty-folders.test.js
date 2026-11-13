'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { seeded, disk } = require('./helpers/empty-folders');

test('F1: remote deletion prunes real nested directories; local deletion survives later full rounds', async t => {
  const { r, a, b } = await seeded(t);
  a.remove('p/q/note.md'); await a.engine.sync();
  assert.ok(a.has('p/q'));
  const count = r.revisions.size, result = await b.engine.sync();
  assert.equal(result.cleanedDirectories, 2); assert.equal(b.has('p'), false);
  await a.engine.sync(); assert.ok(a.has('p/q')); assert.equal(r.revisions.size, count);
});
for (const kind of ['file', 'hidden', 'unrelated empty child', 'DS_Store']) test(`F1: ${kind} blocks its own ancestor chain`, async t => {
  const { a, b } = await seeded(t);
  if (kind === 'unrelated empty child') b.mkdir('p/mine');
  else b.put('p/' + (kind === 'hidden' ? '.hidden' : kind === 'DS_Store' ? '.DS_Store' : 'keep.md'), 'retain');
  a.remove('p/q/note.md'); await a.engine.sync();
  await b.engine.sync(); assert.equal(b.has('p/q'), false); assert.ok(b.has('p'));
  if (kind !== 'unrelated empty child') assert.equal(b.read('p/' + (kind === 'hidden' ? '.hidden' : kind === 'DS_Store' ? '.DS_Store' : 'keep.md')), 'retain');
});
test('F1: remote folder move removes old parents and retains all new files', async t => {
  const { a, b } = await seeded(t, ['old/a.md', 'old/q/b.md']);
  fs.renameSync(path.join(a.root, 'old'), path.join(a.root, 'new'));
  await a.engine.sync(); await b.engine.sync();
  assert.equal(b.has('old'), false);
  assert.equal(b.read('new/a.md'), 'content:old/a.md'); assert.equal(b.read('new/q/b.md'), 'content:old/q/b.md');
});
test('F1: a new file at the OS rmdir boundary survives and stops the ancestor chain', async t => {
  const { a, b } = await seeded(t); a.remove('p/q/note.md'); await a.engine.sync();
  const original = fs.promises.rmdir, calls = [];
  t.after(() => { fs.promises.rmdir = original; });
  fs.promises.rmdir = async (...args) => {
    calls.push(args); if (args[0] === path.join(b.root, 'p/q')) b.put('p/q/new.md', 'new editor content');
    return original(...args);
  };
  const result = await b.engine.sync();
  assert.equal(result.cleanedDirectories, 0); assert.equal(b.read('p/q/new.md'), 'new editor content');
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 1);
});
test('F1: retained directory and descendants survive automatic cleanup', async t => {
  const { a, b } = await seeded(t, ['p/q/note.md'], () => ['p']);
  a.remove('p/q/note.md'); await a.engine.sync(); await b.engine.sync();
  assert.ok(b.has('p/q'));
});
test('F1: expected OS refusal stops ancestors; independent siblings continue; other errors propagate', async t => {
  const b = disk(t); b.mkdir('p/q'); b.mkdir('other');
  const original = fs.promises.rmdir, calls = [];
  t.after(() => { fs.promises.rmdir = original; });
  for (const code of ['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR']) {
    calls.length = 0;
    fs.promises.rmdir = async name => { calls.push(name); if (name.endsWith('/p/q')) throw Object.assign(new Error(code), { code }); };
    assert.equal(await b.local.pruneEmptyDirectories(['p', 'p/q', 'other']), 1);
    assert.equal(calls.some(p => p === path.join(b.root, 'p')), false);
  }
  fs.promises.rmdir = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  await assert.rejects(b.local.pruneEmptyDirectories(['p']), /denied/);
});
test('F1: unsafe paths and symlinks are rejected before any removal', async t => {
  const b = disk(t); b.mkdir('safe'); fs.symlinkSync(path.join(b.root, 'safe'), path.join(b.root, 'link'));
  for (const p of ['', '.', '..', 'safe/../safe', '.trash', '.obsidian', 'link', 'link/child']) {
    await assert.rejects(b.local.pruneEmptyDirectories(['safe', p])); assert.ok(b.has('safe'));
  }
});
