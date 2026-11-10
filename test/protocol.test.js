'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { digest, makeRevision, validateRevision, project, headsFor, safePath, isConflictPath } = require('../src/protocol');

const note = '研究笔记/传热.md';
function write(nonce, contents, from = [], device = 'Mac mini', path = note) {
  return makeRevision({ path, parents: from.map(r => r.id), blob: contents === null ? null : digest(contents), nonce, device });
}

test('cold clients materialize divergent edits deterministically, then resolve both heads', () => {
  const a = write('a', 'baseline');
  const b = write('b', 'left', [a]);
  const c = write('c', 'right', [a], 'MacBook/Pro');
  const copies = project([b, a, c]);
  assert.deepEqual([...copies], [...project([c, b, b, a])]);
  assert.equal(copies.size, 2);
  assert.equal(copies.get(note).conflict, false);
  const sibling = [...copies.keys()].find(isConflictPath);
  assert.ok(sibling.startsWith('研究笔记/传热 (sync-conflict '));
  assert.ok(sibling.endsWith(').md'));
  assert.equal(copies.get(sibling).path, note);
  assert.deepEqual(new Set([...copies.values()].map(r => r.blob)), new Set([b.blob, c.blob]));
  assert.deepEqual(headsFor([a, b, c], note), [b.id, c.id].sort());
  const merged = write('m', 'reviewed', [c, b]);
  assert.deepEqual([...project([merged, c, b, a])], [[note, { path: note, id: merged.id, blob: merged.blob, conflict: false }]]);
});

test('a concurrent edit survives a deletion; an explicit delete of both removes the local view', () => {
  const original = write('1', 'first');
  const edit = write('2', 'unseen edit', [original]);
  const tombstone = write('3', null, [original]);
  const revisions = [original, edit, tombstone];
  assert.equal(project(revisions).get(note).id, edit.id);
  assert.deepEqual(headsFor(revisions, note), [edit.id, tombstone.id].sort());
  const remove = write('4', null, [edit, tombstone]);
  assert.equal(project([...revisions, remove]).size, 0);
  assert.equal(project([...revisions, remove, write('5', 'restored', [remove])]).size, 1);
});

test('equal-content heads share one visible file without losing either causal parent', () => {
  const a = write('a', 'baseline');
  const b = write('b', 'same', [a]);
  const c = write('c', 'same', [a]);
  assert.equal(project([b, a, c]).size, 1);
  assert.deepEqual(headsFor([a, b, c], note), [b.id, c.id].sort());
  const d = write('d', 'new', [b, c]);
  assert.deepEqual(headsFor([d, c, a, b], note), [d.id]);
});

test('identical retries reuse an id, with sorted parents, while independent operations get new ids', () => {
  const a = write('a', 'initial');
  const b = write('b', 'another');
  assert.deepEqual(write('same op', 'merge', [a, b]), write('same op', 'merge', [b, a]));
  const opts = { path: note, parents: [], blob: a.blob, device: 'Mac' };
  assert.notEqual(makeRevision(opts).id, makeRevision(opts).id);
});

test('validates bytes, hashes and parent dependencies before projecting anything', () => {
  const a = write('a', 'old');
  const b = write('b', 'new', [a]);
  assert.equal(validateRevision(JSON.parse(JSON.stringify(a))).id, a.id);
  assert.throws(() => validateRevision({ ...a, blob: b.blob }), /checksum/);
  assert.throws(() => validateRevision({ ...a, foo: 3 }), /fields/);
  assert.throws(() => validateRevision({ ...a, parents: ['bogus'] }), /parent/);
  assert.throws(() => project([b]), /Missing parent/);
  const unrelated = write('alien', 'cross-path', [a], 'Mac', 'other.md');
  assert.throws(() => project([a, unrelated]), /different logical path/);
  assert.throws(() => project([a, { ...b, parents: [] }]), /checksum/);
});

test('preserves attachment bytes and extension on conflicts', () => {
  const path = 'files/图 1.最终.PNG';
  const bytes = Uint8Array.of(0xff, 0x80, 0xf0, 0x00);
  const a = write('a', bytes, [], '电脑甲', path);
  const b = write('b', Buffer.from([0, 1, 2]), [], '电脑乙', path);
  assert.equal(digest(bytes.buffer), a.blob);
  const visible = project([b, a]);
  assert.equal(visible.size, 2);
  for (const file of visible.keys()) assert.ok(file.endsWith('.PNG'));
});

test('rejects hidden/reserved paths, traversal and ambiguous macOS names', () => {
  for (const path of ['../outside', '/absolute', 'x/../y', 'x/.obsidian/plugins/a', 'x//y', 'x/./y',
    'x\\a', 'X:a', 'abc/', 'bad\u0000', 'a (SYNC-CONFLICT Mac id).pdf']) {
    assert.throws(() => safePath(path), /[Uu]nsafe|reserved/);
  }
  assert.equal(safePath('folder/手稿.final.md'), 'folder/手稿.final.md');
  const title = '文献/Step-emulsification: Dynamics/表面张力: Fig. 1.md';
  const revision = write('colon', 'title', [], 'Mac', title);
  assert.equal(project([revision]).get(title).id, revision.id);
  for (const drive of ['C:/local/note.md', 'd:relative.md']) assert.throws(() => safePath(drive));
  const named = (path, nonce = path) => write(nonce, 'abc', [], 'Mac', path);
  for (const [p, q] of [['a.md', 'A.md'], ['Café.md', 'Cafe\u0301.md'], ['img', 'img/x.png'],
    ['A/b.md', 'a/x.pdf']]) {
    assert.throws(() => project([named(p), named(q)]), /collision/);
  }
});

test('long multibyte stems are shortened only on conflict copies', () => {
  const path = '文'.repeat(80) + '.md';
  const result = project([write('a', 'a', [], 'Mac', path), write('b', 'b', [], 'Mac', path)]);
  assert.ok(result.has(path));
  for (const key of result.keys()) assert.ok(Buffer.byteLength(key) <= 255);
});
