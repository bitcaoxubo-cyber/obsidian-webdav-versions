'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncEngine } = require('../src/engine');
const { digest, headsFor, project } = require('../src/protocol');

// Models storage that accepts every write, even if another client wrote the same key.
// No client locks, conditional writes, or server-side comparison are involved.
function store() {
  return {
    blobs: new Map(), revisions: new Map(),
    async listRevisions() { return [...this.revisions.values()].map(r => structuredClone(r)); },
    async putBlob(hash, bytes) { this.blobs.set(hash, Buffer.from(bytes)); },
    async putRevision(r) { this.revisions.set(r.id, structuredClone(r)); },
    async getBlob(hash) { return Buffer.from(this.blobs.get(hash)); },
  };
}
function client(remote, device) {
  const local = {
    data: new Map(),
    async list() { return [...this.data.keys()]; },
    async read(path) { return this.data.get(path) ?? null; },
    async compareAndSet(path, expected, bytes) {
      const present = this.data.get(path);
      if ((present ? digest(present) : null) !== expected) return false;
      if (bytes === null) this.data.delete(path);
      else this.data.set(path, Buffer.from(bytes));
      return true;
    },
  };
  const state = { disk: null, async load() { return structuredClone(this.disk); },
    async save(v) { this.disk = structuredClone(v); } };
  const c = { local, state, restart() { c.e = new SyncEngine({ remote, local, state, device }); },
    write(path, bytes) { local.data.set(path, Buffer.from(bytes)); },
    text(path) { return local.data.get(path)?.toString(); } };
  c.restart();
  return c;
}
const sortedContent = c => [...c.local.data.values()].map(v => v.toString()).sort();
const materialized = r => [...project(r.revisions.values()).entries()];

test('offline edits survive blind simultaneous writes, converge, and explicitly resolve an edited main', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.write('化学/观察.md', 'base'); await a.e.sync(); await b.e.sync();
  a.write('化学/观察.md', 'A edits'); b.write('化学/观察.md', 'B edits');
  await Promise.all([a.e.sync(), b.e.sync()]);
  for (const c of [a,b]) {
    const result = await c.e.sync();
    assert.equal(result.conflicts, 1);
    assert.deepEqual(result.conflictPaths, ['化学/观察.md']);
    assert.deepEqual(sortedContent(c), ['A edits', 'B edits']);
    assert.deepEqual([...c.local.data.keys()].sort(), materialized(r).map(([path]) => path).sort());
  }
  a.write('化学/观察.md', 'merged A and B');
  assert.equal((await a.e.resolve('化学/观察.md')).conflicts, 0);
  await b.e.sync();
  assert.deepEqual(sortedContent(b), ['merged A and B']);
  assert.deepEqual(sortedContent(a), ['merged A and B']);
  assert.equal(r.revisions.size, 4);
});

test('different pre-existing files, equal mtimes, preserve both; aliases can win resolution', async () => {
  const r = store(), a = client(r, 'one'), b = client(r, 'two');
  a.write('note.md', 'remote'); b.write('note.md', 'local');
  await a.e.sync(); await b.e.sync();
  assert.deepEqual(sortedContent(b), ['local', 'remote']);
  const alias = [...b.local.data.keys()].find(n => n !== 'note.md');
  const chosen = b.text(alias);
  await b.e.resolve(alias); await a.e.sync();
  assert.equal(b.text('note.md'), chosen); assert.equal(a.text('note.md'), chosen);
  assert.equal(b.local.data.size, 1);
});

test('binary / empty attachments preserve bytes; deleting one side while editing the other keeps surviving work', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  const bytes = Buffer.from([0,255,128,1,21,0]);
  a.write('图/样品.png', bytes); a.write('empty.md', '');
  await a.e.sync(); await b.e.sync();
  assert.deepEqual(b.local.data.get('图/样品.png'), bytes);
  assert.deepEqual(b.local.data.get('empty.md'), Buffer.alloc(0));
  a.local.data.delete('图/样品.png'); b.write('图/样品.png', [0,13,255]);
  await a.e.sync(); await b.e.sync(); assert.equal((await a.e.sync()).conflicts, 1);
  assert.deepEqual(a.local.data.get('图/样品.png'), Buffer.from([0,13,255]));
  await a.e.resolve('图/样品.png'); await b.e.sync();
  assert.deepEqual(a.local.data.get('图/样品.png'), b.local.data.get('图/样品.png'));
  b.local.data.delete('empty.md'); await b.e.sync(); await a.e.sync();
  assert.equal(a.local.data.has('empty.md'), false);
});

test('lost response after commit reuses original staged bytes and revision across restart', async () => {
  const r = store(), a = client(r, 'A');
  const put = r.putRevision.bind(r);
  r.putRevision = async row => { await put(row); r.putRevision = put; throw new Error('lost response'); };
  a.write('note.md', 'first'); await assert.rejects(a.e.sync(), /lost response/);
  a.write('note.md', 'edited before restarting'); a.restart(); await a.e.sync();
  assert.equal(r.revisions.size, 2);
  const revisions = [...r.revisions.values()];
  assert.equal(revisions[1].parents[0], revisions[0].id);
  assert.equal(r.blobs.get(revisions[0].blob).toString(), 'first');
  assert.equal(r.blobs.get(revisions[1].blob).toString(), 'edited before restarting');
});

test('pull defers changes written in editor during download, captures them as concurrent work next sync', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.write('x.md', 'base'); await a.e.sync(); await b.e.sync();
  a.write('x.md', 'remote edit'); await a.e.sync();
  const get = r.getBlob.bind(r);
  r.getBlob = async hash => { b.write('x.md', 'mid-pull edit'); r.getBlob = get; return get(hash); };
  assert.equal((await b.e.sync()).deferred, 1);
  assert.equal(b.text('x.md'), 'mid-pull edit');
  assert.equal((await b.e.sync()).conflicts, 1);
  assert.deepEqual(sortedContent(b), ['mid-pull edit', 'remote edit']);
});

test('crash after local CAS before journal acknowledgement does not republish the downloaded revision', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.write('x.md', 'first'); await a.e.sync(); await b.e.sync();
  a.write('x.md', 'second'); await a.e.sync();
  const cas = b.local.compareAndSet.bind(b.local);
  b.local.compareAndSet = async (...args) => {
    await cas(...args); b.local.compareAndSet = cas; throw new Error('process exited');
  };
  await assert.rejects(b.e.sync(), /process exited/); b.restart();
  assert.equal((await b.e.sync()).uploaded, 0);
  assert.equal(b.text('x.md'), 'second'); assert.equal(r.revisions.size, 2);
  assert.equal(headsFor(r.revisions.values(), 'x.md').length, 1);
});

test('missing previously listed history fails closed after restart; corrupt incoming blobs leave local file intact', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.write('x.md', 'first'); await a.e.sync(); await b.e.sync();
  const revs = r.revisions; r.revisions = new Map(); b.restart(); b.write('x.md', 'offline');
  await assert.rejects(b.e.sync(), /previously seen revision missing/);
  assert.equal(r.revisions.size, 0); assert.equal(b.text('x.md'), 'offline');
  r.revisions = revs; b.write('x.md', 'first'); a.write('x.md', 'second'); await a.e.sync();
  r.getBlob = async () => Buffer.from('substituted');
  await assert.rejects(b.e.sync(), /checksum/); assert.equal(b.text('x.md'), 'first');
});

test('resolution refuses unpublished sibling edits and rejects unreviewed remote content', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B'), c = client(r, 'C');
  a.write('x.md', '1'); b.write('x.md', '2'); await a.e.sync(); await b.e.sync();
  const alias = [...b.local.data.keys()].find(n => n !== 'x.md');
  const original = b.text(alias);
  b.write(alias, 'unread local changes');
  await assert.rejects(b.e.resolve('x.md'), /copy was edited/);
  b.write(alias, original); c.write('x.md', '3'); await c.e.sync();
  await assert.rejects(b.e.resolve('x.md'), /sync and review/);
  await b.e.sync(); assert.deepEqual(sortedContent(b), ['1','2','3']);
});

test('equal independent heads are captured together after being displayed as a single file', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.write('note.md', 'same'); b.write('note.md', 'same');
  await Promise.all([a.e.sync(), b.e.sync()]); await a.e.sync();
  assert.equal(headsFor(r.revisions.values(), 'note.md').length, 2);
  a.write('note.md', 'child'); await a.e.sync();
  assert.equal(headsFor(r.revisions.values(), 'note.md').length, 1);
  assert.equal([...r.revisions.values()].find(v => v.blob === digest('child')).parents.length, 2);
});

test('foreign conflict-like filenames survive without accidental publication', async () => {
  const r = store(), a = client(r, 'A');
  a.write('a (sync-conflict old copy).md', 'manual');
  const result = await a.e.sync();
  assert.equal(result.deferred, 1); assert.deepEqual(result.deferredPaths, ['a (sync-conflict old copy).md']);
  assert.equal(r.revisions.size, 0);
  assert.deepEqual(sortedContent(a), ['manual']);
});

test('recreate after a witnessed deletion descends from its tombstone; an unseen deletion stays concurrent', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B'), fresh = client(r, 'fresh');
  a.write('note.md', 'old'); await a.e.sync(); await b.e.sync();
  a.local.data.delete('note.md'); await a.e.sync(); await b.e.sync();
  const [deletion] = headsFor(r.revisions.values(), 'note.md');
  b.write('note.md', 'deliberate recreation');
  assert.equal((await b.e.sync()).conflicts, 0);
  assert.deepEqual(r.revisions.get(headsFor(r.revisions.values(), 'note.md')[0]).parents, [deletion]);
  b.local.data.delete('note.md'); await b.e.sync();
  fresh.write('note.md', 'independent offline work');
  assert.equal((await fresh.e.sync()).conflicts, 1);
  assert.equal(fresh.text('note.md'), 'independent offline work');
});

test('unchanged vault uses stat-backed hash hint without reading attachment bodies', async () => {
  const r = store(), c = client(r, 'A'); c.write('attachment.pdf', 'large fixture'); await c.e.sync();
  c.local.hash = async path => c.local.data.has(path) ? digest(c.local.data.get(path)) : null;
  c.local.read = async () => { throw new Error('needless read'); };
  const result = await c.e.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.downloaded, 0);
});

test('remote deletion defers a local edit during local compare-and-set', async () => {
  const r = store(), a = client(r, 'A'), b = client(r, 'B');
  a.write('note.md', 'base'); await a.e.sync(); await b.e.sync(); a.local.data.delete('note.md'); await a.e.sync();
  const cas = b.local.compareAndSet.bind(b.local);
  b.local.compareAndSet = async (...args) => {
    b.write('note.md', 'still editing'); b.local.compareAndSet = cas; return cas(...args);
  };
  assert.equal((await b.e.sync()).deferred, 1); assert.equal(b.text('note.md'), 'still editing');
  assert.equal((await b.e.sync()).conflicts, 1); assert.equal(b.text('note.md'), 'still editing');
});

test('disk staging keeps binary bodies out of journal JSON, survives offline edits, clears only after acknowledgement', async () => {
  const r = store(), a = client(r, 'A'); const staged = new Map();
  a.state.stageBlob = async (hash, bytes) => { staged.set(hash, Buffer.from(bytes)); };
  a.state.readStaged = async hash => staged.get(hash);
  a.state.clearStaged = async hash => { assert.equal(a.state.disk.pending, null); staged.delete(hash); };
  const put = r.putRevision.bind(r);
  r.putRevision = async () => { r.putRevision = put; throw new Error('offline'); };
  a.write('bytes.png', [0,255]); await assert.rejects(a.e.sync(), /offline/);
  assert.equal(a.state.disk.pending.staged, true); assert.equal('bytes' in a.state.disk.pending, false);
  assert.equal(staged.size, 1); a.write('bytes.png', [0,99]); a.restart(); await a.e.sync();
  assert.equal(staged.size, 0); assert.equal(r.revisions.size, 2);
  assert.deepEqual(r.blobs.get(digest(Buffer.from([0,255]))), Buffer.from([0,255]));
  assert.deepEqual(r.blobs.get(digest(Buffer.from([0,99]))), Buffer.from([0,99]));
});

test('oversized file is rejected before hashing, writing a journal or publishing', async () => {
  const r = store(), a = client(r, 'A'); a.write('large.pdf', 'placeholder');
  const oversized = Object.defineProperty(Buffer.alloc(1), 'byteLength', { value: 512 * 1024 * 1024 + 1 });
  a.local.read = async () => oversized;
  await assert.rejects(a.e.sync(), /512 MiB.*large\.pdf/); assert.equal(r.revisions.size, 0);
  assert.equal(a.state.disk, null);
});


test('A0: sync returns numeric per-round runtime statistics', async () => {
  const r = store(), c = client(r, 'stats'); c.write('note.md', 'hello');
  const first = await c.e.sync();
  for (const key of ['durationMs', 'vaultReads', 'hashBytes', 'httpRequests', 'full']) {
    assert.equal(typeof first.stats[key], 'number', key);
    assert.ok(first.stats[key] >= 0, key);
  }
  assert.equal(first.stats.full, 1);
  assert.ok(first.stats.vaultReads > 0);
  assert.ok(first.stats.hashBytes >= 5);
});
