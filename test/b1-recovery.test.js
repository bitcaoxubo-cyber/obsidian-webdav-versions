'use strict';
// Copy into test/b1-recovery.test.js for integration. While kept in /tmp, run with
// OBSIDIAN_PERF_REPO=/absolute/repository node --test this-file.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const repo = process.env.OBSIDIAN_PERF_REPO || path.resolve(__dirname, '..');
const { bytes, text, digest } = require(path.join(repo, 'src/bytes'));
const { makeRevision, project } = require(path.join(repo, 'src/protocol'));
const { SyncEngine } = require(path.join(repo, 'src/engine'));
const { MobileVault, MobileState } = require(path.join(repo, 'src/mobile'));
const { Adapter } = require(path.join(repo, 'test/helpers/adapter'));
const KILLED = 'B1 injected process exit';

function remote() {
  return {
    blobs: new Map(), revs: new Map(),
    async listRevisions() { return structuredClone([...this.revs.values()]); },
    async getBlob(hash) { return this.blobs.get(hash).slice(); },
    async putBlob(hash, data) { assert.equal(digest(data), hash); this.blobs.set(hash, bytes(data).slice()); },
    async putRevision(rev) { this.revs.set(rev.id, structuredClone(rev)); },
  };
}
function client(r, device, adapter = new Adapter()) {
  const local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test/vault/', 'test');
  return { adapter, local, state, device, engine: new SyncEngine({ remote: r, local, state, device }) };
}
function put(adapter, name, content) {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) adapter.folders.add(parts.slice(0, i).join('/'));
  adapter.put(name, content);
}
function assertPendingAPI(c) {
  for (const name of ['loadPending', 'savePending', 'clearPending']) assert.equal(typeof c.state[name], 'function', name);
}
function replace(object, name, wrap, cleanup) {
  const original = object[name];
  object[name] = wrap(original.bind(object));
  cleanup.push(() => { object[name] = original; });
}

// Hooks target externally observable durability boundaries. They do not depend on
// SyncEngine private method names or exact save counts.
function inject(c, r, phase, direction) {
  assertPendingAPI(c);
  const cleanup = [];
  let fired = false, completed = 0, insideCheckpoint = false;
  const kill = () => { fired = true; throw new Error(KILLED); };
  replace(c.state, 'clearPending', original => async (...args) => {
    const result = await original(...args); completed++; return result;
  }, cleanup);
  if (phase === 'pending') {
    replace(c.state, 'savePending', original => async entry => {
      await original(entry);
      if (!fired && entry.kind === (direction === 'upload' ? 'push' : 'apply')) kill();
    }, cleanup);
  } else if (phase === 'blob') {
    replace(r, 'putBlob', original => async (...args) => { await original(...args); if (!fired) kill(); }, cleanup);
  } else if (phase === 'revision') {
    replace(r, 'putRevision', original => async (...args) => { await original(...args); if (!fired) kill(); }, cleanup);
  } else if (phase === 'local') {
    replace(c.local, 'compareAndSet', original => async (name, ...args) => {
      const applied = await original(name, ...args);
      if (!fired && applied && name === 'edit.md') kill();
      return applied;
    }, cleanup);
  } else if (phase === 'checkpoint-before' || phase === 'checkpoint-partial') {
    replace(c.state, 'save', original => async value => {
      // An independent pending entry has already been cleared. This exercises
      // lost bindings after the latest durable checkpoint, rather than replaying
      // an operation which still has its own pending log.
      const eligible = completed > 0 && !value.pending;
      if (!fired && eligible && phase === 'checkpoint-before') kill();
      insideCheckpoint = eligible;
      try { return await original(value); } finally { insideCheckpoint = false; }
    }, cleanup);
    if (phase === 'checkpoint-partial') {
      const priorHook = c.adapter.hook;
      c.adapter.hook = async (op, name, when) => {
        await priorHook(op, name, when);
        if (!fired && insideCheckpoint && op === 'write' && when === 'before' &&
            name.startsWith(c.state.directory + '/writing-')) {
          // A native write can leave a truncated temporary file when killed.
          // Neither committed alternating slot is deliberately corrupted.
          c.adapter.put(name, '{"sequence":');
          kill();
        }
      };
      cleanup.push(() => { c.adapter.hook = priorHook; });
    }
  } else throw new Error('Unknown injection phase');
  return { get fired() { return fired; }, restore() { for (const undo of cleanup.reverse()) undo(); } };
}

async function prepare(direction) {
  const r = remote(), a = client(r, 'Mac'), b = client(r, 'iPhone');
  for (const [name, content] of Object.entries({
    'edit.md': 'base edit', 'remove.md': 'base remove', 'shared.md': 'base shared', 'keep.md': 'unchanged',
  })) put(a.adapter, name, content);
  await a.engine.sync(); await b.engine.sync();
  // Both devices change shared.md from the same acknowledged parent. Recovery
  // must retain both branches even when its checkpoint has lost several binds.
  put(a.adapter, 'shared.md', 'Mac concurrent edit');
  put(b.adapter, 'shared.md', 'iPhone concurrent edit');
  put(a.adapter, 'edit.md', 'Mac updated edit');
  await a.adapter.remove('remove.md');
  put(a.adapter, 'new.md', 'Mac created note');
  if (direction === 'upload') await b.engine.sync();
  else await a.engine.sync();
  return { r, a, b, target: direction === 'upload' ? a : b };
}
async function converge(run) {
  // Exactly two full rounds on each restarted/peer client, as required by B1.
  for (let i = 0; i < 2; i++) { await run.a.engine.sync(); await run.b.engine.sync(); }
  const view = project(run.r.revs.values());
  for (const c of [run.a, run.b]) {
    assert.deepEqual((await c.local.list()).sort(), [...view.keys()].sort());
    for (const [name, value] of view) assert.equal(digest(await c.local.read(name)), value.blob, name);
    assert.equal(await c.state.loadPending(), null);
    assert.equal((await c.state.load()).pending ?? null, null);
  }
  for (const rev of run.r.revs.values()) {
    if (rev.blob !== null) assert.equal(digest(run.r.blobs.get(rev.blob)), rev.blob);
    for (const parent of rev.parents) assert.ok(run.r.revs.has(parent), 'all ancestors remain available');
  }
  // Compare history content rather than random IDs/conflict filenames.
  const history = [...run.r.revs.values()].map(rev => JSON.stringify([
    rev.path, rev.blob === null ? null : text(run.r.blobs.get(rev.blob)),
    rev.parents.map(id => run.r.revs.get(id).blob).sort(),
  ])).sort();
  const leaves = [...view.values()].map(value => JSON.stringify([
    value.path, text(run.r.blobs.get(value.blob)),
  ])).sort();
  assert.ok(leaves.includes(JSON.stringify(['shared.md', 'Mac concurrent edit'])));
  assert.ok(leaves.includes(JSON.stringify(['shared.md', 'iPhone concurrent edit'])));
  assert.equal([...view.values()].some(value => value.path === 'remove.md'), false);
  return { revisionCount: run.r.revs.size, history, leaves };
}
async function scenario(direction, phase) {
  const run = await prepare(direction);
  if (phase) {
    const fault = inject(run.target, run.r, phase, direction);
    try { await assert.rejects(run.target.engine.sync(), new RegExp(KILLED)); }
    finally { fault.restore(); }
    assert.equal(fault.fired, true, 'requested durability boundary was reached');
    const restarted = client(run.r, run.target.device, run.target.adapter);
    if (direction === 'upload') run.a = restarted;
    else run.b = restarted;
  } else await run.target.engine.sync();
  return converge(run);
}

for (const direction of ['upload', 'download']) {
  const phases = direction === 'upload'
    ? ['pending', 'blob', 'revision', 'checkpoint-before', 'checkpoint-partial']
    : ['pending', 'local', 'checkpoint-before', 'checkpoint-partial'];
  for (const phase of phases) test(`B1: ${direction} restart after ${phase} preserves both branches without extra revisions`, async () => {
    const control = await scenario(direction);
    const interrupted = await scenario(direction, phase);
    assert.deepEqual(interrupted, control);
  });
}

for (const phase of ['pending', 'revision']) test(`B1: later editor change survives upload ${phase} recovery`, async () => {
  const r = remote(), c = client(r, 'iPhone');
  put(c.adapter, 'edit.md', 'base'); await c.engine.sync();
  put(c.adapter, 'edit.md', 'staged edit');
  const fault = inject(c, r, phase, 'upload');
  try { await assert.rejects(c.engine.sync(), new RegExp(KILLED)); }
  finally { fault.restore(); }
  assert.equal(fault.fired, true);
  put(c.adapter, 'edit.md', 'typed after interruption');
  const restarted = client(r, 'iPhone', c.adapter);
  await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(r.revs.size, 3, 'base, original staged revision, and later editor revision only');
  assert.equal(text(await restarted.local.read('edit.md')), 'typed after interruption');
  assert.deepEqual([...r.blobs.values()].map(text).sort(), ['base', 'staged edit', 'typed after interruption']);
  assert.equal(await restarted.state.loadPending(), null);
});

test('B1: edit after applied download remains concurrent with the downloaded revision', async () => {
  const r = remote(), a = client(r, 'Mac'), b = client(r, 'iPhone');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  put(a.adapter, 'edit.md', 'remote edit'); await a.engine.sync();
  const fault = inject(b, r, 'local', 'download');
  try { await assert.rejects(b.engine.sync(), new RegExp(KILLED)); }
  finally { fault.restore(); }
  assert.equal(fault.fired, true);
  put(b.adapter, 'edit.md', 'typed after interrupted download');
  const restarted = client(r, 'iPhone', b.adapter);
  for (let i = 0; i < 2; i++) { await restarted.engine.sync(); await a.engine.sync(); }
  assert.equal(r.revs.size, 3);
  const expected = ['remote edit', 'typed after interrupted download'].sort();
  for (const c of [a, restarted]) {
    assert.deepEqual((await c.local.list()).map(name => text(c.adapter.files.get(name))).sort(), expected);
  }
});

function legacySnapshot(c, value, sequence = 7) {
  const payload = JSON.stringify(value);
  put(c.adapter, c.state.directory + '/state-1.json', JSON.stringify({ sequence, payload, hash: digest(payload) }));
}
function insert(r, rev, content) {
  r.revs.set(rev.id, rev);
  if (rev.blob !== null) r.blobs.set(rev.blob, bytes(content));
}
const binding = rev => ({ path: rev.path, blob: rev.blob, parents: [rev.id] });

for (const allParents of [true, false]) test(`B1: checkpoint recovery ${allParents ? 'accepts' : 'rejects'} a leaf descending from ${allParents ? 'all' : 'only one'} old parents`, async () => {
  const r = remote(), c = client(r, 'iPhone');
  const roots = ['A', 'B'].map(device => makeRevision({ path: 'edit.md', blob: digest('base'), device }));
  for (const rev of roots) insert(r, rev, 'base');
  const parents = roots.map(rev => rev.id).sort();
  const child = makeRevision({ path: 'edit.md', parents: allParents ? parents : [parents[0]], blob: digest('updated'), device: 'prior process' });
  insert(r, child, 'updated');
  put(c.adapter, 'edit.md', 'updated');
  legacySnapshot(c, { version: 1, known: parents, files: [['edit.md', { path: 'edit.md', blob: digest('base'), parents }]], reviewed: [], absent: [], pending: null });
  const result = await c.engine.sync(); await c.engine.sync();
  assert.equal(result.uploaded, allParents ? 0 : 1);
  assert.equal(r.revs.size, allParents ? 3 : 4);
  if (!allParents) {
    const published = [...r.revs.values()].find(rev => rev.device === 'iPhone');
    assert.deepEqual(published.parents, parents, 'recovery must not silently forget an independent acknowledged parent');
  }
});

test('B1: upgrade resumes an embedded 0.3.0-beta.1 push pending before using independent pending', async () => {
  const r = remote(), c = client(r, 'iPhone'); assertPendingAPI(c);
  const base = makeRevision({ path: 'edit.md', blob: digest('base'), device: 'Mac' }); insert(r, base, 'base');
  const planned = makeRevision({ path: 'edit.md', parents: [base.id], blob: digest('staged before upgrade'), device: 'iPhone' });
  put(c.adapter, c.state.directory + '/outbox-' + planned.blob, 'staged before upgrade');
  put(c.adapter, 'edit.md', 'edited after old process exited');
  legacySnapshot(c, { version: 1, known: [base.id], files: [['edit.md', binding(base)]], reviewed: [], absent: [],
    pending: { kind: 'push', physical: 'edit.md', rev: planned, staged: true } });
  let independentSaves = 0;
  const original = c.state.savePending.bind(c.state);
  c.state.savePending = async entry => { independentSaves++; return original(entry); };
  await c.engine.sync(); await c.engine.sync();
  assert.equal(r.revs.size, 3);
  assert.ok(r.revs.has(planned.id), 'original pending revision ID must be retried exactly');
  assert.equal(text(r.blobs.get(planned.blob)), 'staged before upgrade');
  assert.equal(text(await c.local.read('edit.md')), 'edited after old process exited');
  assert.ok(independentSaves > 0, 'later operations use the new pending interface');
  assert.equal(await c.state.loadPending(), null);
  assert.equal((await c.state.load()).pending ?? null, null);
  assert.equal(c.adapter.files.has(c.state.directory + '/outbox-' + planned.blob), false);
});

test('B1: upgrade binds an embedded 0.3.0-beta.1 apply pending whose CAS already completed', async () => {
  const r = remote(), c = client(r, 'iPhone'); assertPendingAPI(c);
  const base = makeRevision({ path: 'edit.md', blob: digest('base'), device: 'Mac' }); insert(r, base, 'base');
  const next = makeRevision({ path: 'edit.md', parents: [base.id], blob: digest('downloaded before upgrade'), device: 'Mac' }); insert(r, next, 'downloaded before upgrade');
  put(c.adapter, 'edit.md', 'downloaded before upgrade');
  legacySnapshot(c, { version: 1, known: [base.id, next.id], files: [['edit.md', binding(base)]], reviewed: [], absent: [],
    pending: { kind: 'apply', physical: 'edit.md', next: binding(next) } });
  const first = await c.engine.sync(); const second = await c.engine.sync();
  assert.equal(first.uploaded + second.uploaded, 0);
  assert.equal(r.revs.size, 2);
  assert.equal(text(await c.local.read('edit.md')), 'downloaded before upgrade');
  assert.equal(await c.state.loadPending(), null);
  assert.equal((await c.state.load()).pending ?? null, null);
});

test('B1: main checkpoints are bounded by completed operations and idle rounds never save state', async () => {
  const r = remote(), c = client(r, 'iPhone'); assertPendingAPI(c);
  for (let i = 0; i < 405; i++) put(c.adapter, `note-${i}.md`, 'body ' + i);
  let checkpoints = 0;
  const save = c.state.save.bind(c.state);
  c.state.save = async value => { checkpoints++; assert.equal(value.pending, null); return save(value); };
  await c.engine.sync();
  assert.ok(checkpoints >= 3 && checkpoints <= 6, '200/400/end checkpoints, plus any changed phase boundaries');
  checkpoints = 0;
  let writes = 0;
  const write = c.adapter.writeBinary.bind(c.adapter);
  c.adapter.writeBinary = async (...args) => { writes++; return write(...args); };
  await c.engine.sync(); await c.engine.sync({ full: false, dirty: [] });
  assert.equal(checkpoints, 0);
  assert.equal(writes, 0, 'neither checkpoints nor hash hints are rewritten when unchanged');
});

test('B1: a five-second operation interval triggers an intermediate checkpoint', async () => {
  const r = remote(), c = client(r, 'iPhone'); assertPendingAPI(c);
  const clock = Date.now; let now = clock(), published = 0; Date.now = () => now;
  const save = c.state.save.bind(c.state); const checkpointCounts = [];
  c.state.save = async value => { checkpointCounts.push(published); return save(value); };
  const putRevision = r.putRevision.bind(r);
  r.putRevision = async rev => { await putRevision(rev); published++; now += 5100; };
  try {
    put(c.adapter, 'one.md', 'first'); put(c.adapter, 'two.md', 'second');
    await c.engine.sync();
    assert.ok(checkpointCounts.includes(1), 'first completed operation exceeded the time bound');
    assert.ok(checkpointCounts.includes(2));
  } finally { Date.now = clock; }
});

test('B1: reordered remote listings do not rewrite semantically unchanged checkpoints', async () => {
  const r = remote(), c = client(r, 'iPhone');
  for (const name of ['a.md', 'b.md']) {
    for (const device of ['Mac', 'phone']) {
      const content = name + ' from ' + device;
      insert(r, makeRevision({ path: name, blob: digest(content), device }), content);
    }
  }
  await c.engine.sync();
  let reverse = false, writes = 0, saves = 0;
  r.listRevisions = async () => { const rows = [...r.revs.values()]; reverse = !reverse; return structuredClone(reverse ? rows.reverse() : rows); };
  const write = c.adapter.writeBinary.bind(c.adapter), save = c.state.save.bind(c.state);
  c.adapter.writeBinary = async (...args) => { writes++; return write(...args); };
  c.state.save = async (...args) => { saves++; return save(...args); };
  await c.engine.sync(); await c.engine.sync();
  assert.equal(saves, 0); assert.equal(writes, 0);
});

for (const completed of ['upload', 'download', 'first-download', 'delete']) test(`B1: ${completed} completion survives a later remote descendant before checkpoint recovery`, async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync();
  if (completed !== 'first-download') await b.engine.sync();
  const target = completed === 'upload' || completed === 'delete' ? a : b;
  const peer = target === a ? b : a;
  if (completed === 'upload') put(a.adapter, 'edit.md', 'completed upload');
  else if (completed === 'delete') await a.adapter.remove('edit.md');
  else if (completed === 'download') { put(a.adapter, 'edit.md', 'completed download'); await a.engine.sync(); }
  const clear = target.state.clearPending.bind(target.state);
  target.state.clearPending = async () => { await clear(); throw new Error(KILLED); };
  await assert.rejects(target.engine.sync(), new RegExp(KILLED));
  await peer.engine.sync();
  put(peer.adapter, 'edit.md', 'peer descendant'); await peer.engine.sync();
  const count = r.revs.size;
  const restarted = client(r, target.device, target.adapter);
  const result = await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(result.uploaded, 0, 'an acknowledged completed version must not be republished');
  assert.equal(result.conflicts, 0, 'a later descendant is not a concurrent edit');
  assert.equal(r.revs.size, count, 'remote history gains no duplicate revision');
  assert.equal(text(await restarted.local.read('edit.md')), 'peer descendant');
  assert.equal(await restarted.state.loadPending(), null);
});

test('B1: completed downloaded deletion survives remote recreation before checkpoint recovery', async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  await a.adapter.remove('edit.md'); await a.engine.sync();
  const clear = b.state.clearPending.bind(b.state);
  b.state.clearPending = async () => { await clear(); throw new Error(KILLED); };
  await assert.rejects(b.engine.sync(), new RegExp(KILLED));
  put(a.adapter, 'edit.md', 'deliberate recreation'); await a.engine.sync();
  const count = r.revs.size, restarted = client(r, 'B', b.adapter);
  const result = await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 0);
  assert.equal(r.revs.size, count); assert.equal(text(await restarted.local.read('edit.md')), 'deliberate recreation');
});

for (const completed of ['upload', 'download']) test(`B1: ${completed} receipt with uncleared pending preserves later editor ancestry`, async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  put(a.adapter, 'edit.md', 'completed version');
  if (completed === 'download') await a.engine.sync();
  const target = completed === 'upload' ? a : b, peer = target === a ? b : a;
  target.state.clearPending = async () => { throw new Error(KILLED); };
  await assert.rejects(target.engine.sync(), new RegExp(KILLED));
  const committed = [...r.revs.values()].find(rev => rev.blob === digest('completed version'));
  put(target.adapter, 'edit.md', 'typed after completed receipt');
  await peer.engine.sync(); put(peer.adapter, 'edit.md', 'remote descendant'); await peer.engine.sync();
  const count = r.revs.size, restarted = client(r, target.device, target.adapter);
  await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(r.revs.size, count + 1);
  const typed = [...r.revs.values()].find(rev => rev.blob === digest('typed after completed receipt'));
  assert.deepEqual(typed.parents, [committed.id], 'completed receipt, not the stale snapshot, defines the edited baseline');
  const leaves = [...project(r.revs.values()).values()].map(row => text(r.blobs.get(row.blob))).sort();
  assert.deepEqual(leaves, ['remote descendant', 'typed after completed receipt']);
  assert.equal(await restarted.state.loadPending(), null);
});

test('B1: reverting to historical bytes after completion is captured as a deliberate edit', async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  put(a.adapter, 'edit.md', 'completed version');
  const clear = a.state.clearPending.bind(a.state);
  a.state.clearPending = async () => { await clear(); throw new Error(KILLED); };
  await assert.rejects(a.engine.sync(), new RegExp(KILLED));
  const committed = [...r.revs.values()].find(rev => rev.blob === digest('completed version'));
  await b.engine.sync(); put(b.adapter, 'edit.md', 'remote descendant'); await b.engine.sync();
  put(a.adapter, 'edit.md', 'base');
  const restarted = client(r, 'A', a.adapter), before = r.revs.size;
  await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(r.revs.size, before + 1);
  const deliberate = [...r.revs.values()].find(rev => rev.blob === digest('base') && rev.parents.length);
  assert.deepEqual(deliberate.parents, [committed.id]);
  assert.deepEqual([...project(r.revs.values()).values()].map(row => text(r.blobs.get(row.blob))).sort(), ['base', 'remote descendant']);
});

test('B1: ordered completion receipts for one path replay only above the checkpoint watermark', async () => {
  const r = remote(), c = client(r, 'A');
  const base = makeRevision({ path: 'edit.md', blob: digest('base'), device: 'A' }); insert(r, base, 'base');
  const one = makeRevision({ path: 'edit.md', parents: [base.id], blob: digest('one'), device: 'A' }); insert(r, one, 'one');
  const two = makeRevision({ path: 'edit.md', parents: [one.id], blob: digest('two'), device: 'A' }); insert(r, two, 'two');
  const three = makeRevision({ path: 'edit.md', parents: [two.id], blob: digest('three'), device: 'B' }); insert(r, three, 'three');
  legacySnapshot(c, { version: 1, known: [base.id], files: [['edit.md', binding(base)]], reviewed: [], absent: [], pending: null, receiptSequence: 0 });
  await c.state.loadReceipts(0);
  for (const [i, rev] of [one, two].entries()) {
    const sequence = await c.state.saveReceipt({ operationId: 'ordered-' + i, kind: 'push', physical: 'edit.md', next: binding(rev), absent: null, known: [rev.id] });
    assert.equal(sequence, i + 1);
  }
  put(c.adapter, 'edit.md', 'two');
  const restarted = client(r, 'A', c.adapter);
  const result = await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 0); assert.equal(r.revs.size, 4);
  assert.equal(text(await restarted.local.read('edit.md')), 'three');
  assert.ok((await restarted.state.load()).receiptSequence >= 3);
});

test('B1: a second crash after checkpoint and before receipt cleanup cannot replay stale bindings', async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  put(a.adapter, 'edit.md', 'completed upload');
  const clear = a.state.clearPending.bind(a.state);
  a.state.clearPending = async () => { await clear(); throw new Error(KILLED); };
  await assert.rejects(a.engine.sync(), new RegExp(KILLED));
  await b.engine.sync(); put(b.adapter, 'edit.md', 'remote descendant one'); await b.engine.sync();
  const retry = client(r, 'A', a.adapter); let cleanups = 0;
  retry.state.clearReceipts = async () => { if (++cleanups >= 2) throw new Error(KILLED); };
  await assert.rejects(retry.engine.sync(), new RegExp(KILLED));
  const checkpoint = await retry.state.load(); assert.ok(checkpoint.receiptSequence > 0);
  put(b.adapter, 'edit.md', 'remote descendant two'); await b.engine.sync();
  const count = r.revs.size, restarted = client(r, 'A', a.adapter);
  const result = await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 0); assert.equal(r.revs.size, count);
  assert.equal(text(await restarted.local.read('edit.md')), 'remote descendant two');
  assert.ok((await restarted.state.load()).receiptSequence > checkpoint.receiptSequence);
});

test('B1: receipt validation rejects missing remote ancestry before applying local bindings', async () => {
  const r = remote(), c = client(r, 'A');
  put(c.adapter, 'edit.md', 'base'); await c.engine.sync();
  const base = [...r.revs.values()][0];
  const missing = makeRevision({ path: 'edit.md', parents: [base.id], blob: digest('unavailable'), device: 'A' });
  const water = (await c.state.load()).receiptSequence || 0;
  await c.state.loadReceipts(water);
  await c.state.saveReceipt({ operationId: 'missing', kind: 'push', physical: 'edit.md', next: binding(missing), absent: null, known: [missing.id] });
  put(c.adapter, 'edit.md', 'unavailable');
  await assert.rejects(client(r, 'A', c.adapter).engine.sync(), /receipt|收据|missing|缺失/i);
  assert.equal(text(c.adapter.files.get('edit.md')), 'unavailable'); assert.equal(r.revs.size, 1);
});

test('B1: a rejected apply CAS never writes a receipt for the unperformed replacement', async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  put(a.adapter, 'edit.md', 'remote'); await a.engine.sync();
  let receipts = 0;
  const save = b.state.saveReceipt.bind(b.state);
  b.state.saveReceipt = async entry => { receipts++; return save(entry); };
  b.local.guard = () => false;
  assert.equal((await b.engine.sync()).deferred, 1);
  assert.equal(receipts, 0); assert.equal(text(b.adapter.files.get('edit.md')), 'base');
});

for (const mismatch of ['blob', 'path', 'parents', 'deletion']) test(`B1: completion receipt rejects a ${mismatch} mismatch with remote ancestry`, async () => {
  const r = remote(), c = client(r, 'A'); put(c.adapter, 'edit.md', 'base'); await c.engine.sync();
  const rev = [...r.revs.values()][0], next = binding(rev);
  const entry = { operationId: 'invalid-' + mismatch, kind: 'apply', physical: 'edit.md', next, absent: null, known: [rev.id] };
  if (mismatch === 'blob') next.blob = digest('wrong');
  if (mismatch === 'path') next.path = 'another.md';
  if (mismatch === 'parents') next.parents = ['0'.repeat(64)];
  if (mismatch === 'deletion') { entry.next = null; entry.absent = { path: 'edit.md', parents: [rev.id] }; }
  await c.state.loadReceipts((await c.state.load()).receiptSequence);
  await c.state.saveReceipt(entry);
  await assert.rejects(client(r, 'A', c.adapter).engine.sync(), /receipt.*(match|revision)/i);
  assert.equal(text(c.adapter.files.get('edit.md')), 'base'); assert.equal(r.revs.size, 1);
});

test('B1: a state adapter with pending but no receipt API checkpoints before clearing intent', async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  for (const method of ['loadReceipts', 'saveReceipt', 'clearReceipts']) a.state[method] = undefined;
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  put(a.adapter, 'edit.md', 'completed without receipt API');
  const clear = a.state.clearPending.bind(a.state);
  a.state.clearPending = async () => { await clear(); throw new Error(KILLED); };
  await assert.rejects(a.engine.sync(), new RegExp(KILLED));
  await b.engine.sync(); put(b.adapter, 'edit.md', 'remote descendant'); await b.engine.sync();
  const count = r.revs.size, restarted = client(r, 'A', a.adapter);
  const result = await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(result.uploaded, 0); assert.equal(result.conflicts, 0); assert.equal(r.revs.size, count);
  assert.equal(text(await restarted.local.read('edit.md')), 'remote descendant');
});

for (const direction of ['upload', 'download']) test(`B1: ${direction} receipt cleanup then second crash with pending retained preserves later editing`, async () => {
  const r = remote(), a = client(r, 'A'), b = client(r, 'B');
  put(a.adapter, 'edit.md', 'base'); await a.engine.sync(); await b.engine.sync();
  const target = direction === 'upload' ? a : b, peer = target === a ? b : a;
  if (direction === 'upload') put(target.adapter, 'edit.md', 'completed');
  else { put(peer.adapter, 'edit.md', 'completed'); await peer.engine.sync(); }
  target.state.clearPending = async () => { throw new Error(KILLED); };
  await assert.rejects(target.engine.sync(), new RegExp(KILLED));
  await peer.engine.sync(); put(peer.adapter, 'edit.md', 'peer later'); await peer.engine.sync();
  const retry = client(r, target.device, target.adapter), clear = retry.state.clearReceipts.bind(retry.state);
  retry.state.clearReceipts = async water => { await clear(water); throw new Error(KILLED); };
  await assert.rejects(retry.engine.sync(), new RegExp(KILLED));
  assert.notEqual(await retry.state.loadPending(), null);
  put(target.adapter, 'edit.md', 'user later');
  const restarted = client(r, target.device, target.adapter);
  await restarted.engine.sync(); await restarted.engine.sync();
  assert.equal(r.revs.size, 4);
  const completed = [...r.revs.values()].find(row => row.blob === digest('completed'));
  const edited = [...r.revs.values()].find(row => row.blob === digest('user later'));
  assert.deepEqual(edited.parents, [completed.id]);
  assert.deepEqual([...project(r.revs.values()).values()].map(row => text(r.blobs.get(row.blob))).sort(), ['peer later', 'user later']);
});
