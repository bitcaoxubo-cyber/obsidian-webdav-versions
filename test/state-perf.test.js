'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Adapter } = require('./helpers/adapter');
const { MobileState, MobileVault } = require('../src/mobile');
const { bytes, text, digest } = require('../src/bytes');
const { makeRevision } = require('../src/protocol');
const state = (adapter = new Adapter()) => new MobileState(adapter, '.obsidian/state', 'https://example.test/vault/', 'u');
const pending = () => ({ kind: 'push', physical: 'x.md', rev: makeRevision({ path: 'x.md', blob: digest('new'), device: 'phone' }), staged: true });

test('B1: mobile pending journal survives restart independently of snapshot', async () => {
  const adapter = new Adapter(), s = state(adapter), intent = pending();
  await s.save({ version: 1, known: [], files: [], reviewed: [], absent: [], pending: null });
  await s.savePending(intent);
  assert.deepEqual(await state(adapter).loadPending(), intent);
  assert.equal((await state(adapter).load()).pending, null);
  await s.clearPending(); await s.clearPending();
  assert.equal(await state(adapter).loadPending(), null);
});

test('B1: mobile pending journal rejects corruption instead of forgetting intent', async () => {
  const adapter = new Adapter(), s = state(adapter); await s.savePending(pending());
  adapter.put(s.pendingFile, '{broken');
  await assert.rejects(state(adapter).loadPending(), /损坏|校验/);
});

test('B1: an unfinished pending journal cannot be replaced by another operation', async () => {
  const adapter = new Adapter(), s = state(adapter), old = pending();
  await s.savePending(old);
  await assert.rejects(s.savePending(pending()), /未完成|pending|日志/);
  assert.deepEqual(await state(adapter).loadPending(), old);
});

test('B1: pending is recoverable when process exits immediately after publication', async () => {
  const adapter = new Adapter(), s = state(adapter), intent = pending();
  adapter.hook = async (op, p, when) => { if (op === 'rename' && p.includes('pending-writing-') && when === 'after') throw new Error('killed'); };
  await assert.rejects(s.savePending(intent), /killed/);
  adapter.hook = async () => {};
  assert.deepEqual(await state(adapter).loadPending(), intent);
});

test('B1: pending temporary partial write never becomes a committed journal', async () => {
  const adapter = new Adapter(), s = state(adapter);
  adapter.hook = async (op, p, when) => {
    if (op === 'write' && p.includes('pending-writing-') && when === 'after') { adapter.files.set(p, bytes('{partial')); throw new Error('killed'); }
  };
  await assert.rejects(s.savePending(pending()), /killed/);
  adapter.hook = async () => {};
  assert.equal(await state(adapter).loadPending(), null);
});

test('B1: mobile checkpoints do not reread committed slots during consecutive saves', async () => {
  const adapter = new Adapter(), s = state(adapter); await s.load();
  let slotReads = 0, temporaryReads = 0;
  const read = adapter.readBinary.bind(adapter);
  adapter.readBinary = async p => { if (/state-[01]\.json$/.test(p)) slotReads++; if (p.includes('/writing-')) temporaryReads++; return read(p); };
  await s.save({ n: 1 }); await s.save({ n: 2 }); await s.save({ n: 3 });
  assert.equal(slotReads, 0); assert.equal(temporaryReads, 3);
  assert.deepEqual(await state(adapter).load(), { n: 3 });
});

test('B1: incomplete checkpoint write preserves the latest complete slot', async () => {
  const adapter = new Adapter(), s = state(adapter); await s.save({ n: 1 }); await s.save({ n: 2 });
  adapter.hook = async (op, p, when) => {
    if (op === 'write' && p.includes('/writing-') && when === 'after') { adapter.files.set(p, bytes('{partial')); throw new Error('killed'); }
  };
  await assert.rejects(s.save({ n: 3 }), /killed/); adapter.hook = async () => {};
  assert.deepEqual(await state(adapter).load(), { n: 2 });
});

test('B1: confirmed directory checks are cached without losing file collision checks', async () => {
  const adapter = new Adapter(), s = state(adapter), counts = new Map();
  const stat = adapter.stat.bind(adapter);
  adapter.stat = async p => { if (!/\.(json)|writing-/.test(p)) counts.set(p, (counts.get(p) || 0) + 1); return stat(p); };
  await s.save({ n: 1 }); const first = new Map(counts); await s.save({ n: 2 });
  assert.deepEqual(counts, first);
  const conflicting = new Adapter(); conflicting.put('.obsidian', 'file');
  await assert.rejects(state(conflicting).save({ n: 1 }), /占用/);
});

test('B1: desktop pending journal is independent, durable and idempotently cleared', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DiskState } = require('../src/local');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-pending-'));
  try {
    const s = new DiskState(root, 'https://example.test/vault/', 'u'), intent = pending();
    await s.save({ version: 1, pending: null }); await s.savePending(intent);
    assert.deepEqual(await new DiskState(root, 'https://example.test/vault/', 'u').loadPending(), intent);
    assert.equal((await s.load()).pending, null);
    await s.clearPending(); await s.clearPending(); assert.equal(await s.loadPending(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('B1: beta 0.3 snapshot envelope and embedded pending stay readable during upgrade', async () => {
  const adapter = new Adapter(), s = state(adapter), intent = pending();
  const original = { version: 1, known: [], files: [], reviewed: [], absent: [], pending: intent };
  const payload = JSON.stringify(original);
  adapter.put(s.directory + '/state-1.json', JSON.stringify({ sequence: 42, payload, hash: digest(payload) }));
  assert.deepEqual(await s.load(), original);
  assert.equal(await s.loadPending(), null);
  await s.save({ ...original, pending: null });
  const next = JSON.parse(text(adapter.files.get(s.directory + '/state-0.json')));
  assert.equal(next.sequence, 43); assert.equal(JSON.parse(next.payload).pending, null);
});

test('B1: repeated save of the exact pending intent is idempotent', async () => {
  const adapter = new Adapter(), s = state(adapter), intent = pending();
  await s.savePending(intent);
  let writes = 0; const write = adapter.writeBinary.bind(adapter);
  adapter.writeBinary = async (...args) => { writes++; return write(...args); };
  await s.savePending(intent);
  assert.equal(writes, 0); assert.deepEqual(await s.loadPending(), intent);
});
