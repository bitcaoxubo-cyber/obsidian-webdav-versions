'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Adapter } = require('./helpers/adapter');
const { MobileState } = require('../src/mobile');
const { bytes } = require('../src/bytes');
const state = adapter => new MobileState(adapter, '.obsidian/state', 'https://example.test/vault/', 'u');
const entry = id => ({ operationId: id, kind: 'apply', physical: 'x.md', next: null, absent: null, known: [] });
const receiptFiles = (adapter, s) => [...adapter.files.keys()].filter(p => p.startsWith(s.directory + '/receipt-') && /\d{16}\.json$/.test(p)).sort();

test('B1: completed receipts are ordered and continue above the durable checkpoint watermark', async () => {
  const adapter = new Adapter(), s = state(adapter);
  assert.deepEqual(await s.loadReceipts(0), []);
  assert.equal(await s.saveReceipt(entry('a')), 1); assert.equal(await s.saveReceipt(entry('b')), 2);
  assert.deepEqual(await state(adapter).loadReceipts(0), [{ sequence: 1, entry: entry('a') }, { sequence: 2, entry: entry('b') }]);
  await s.clearReceipts(2);
  const restarted = state(adapter); assert.deepEqual(await restarted.loadReceipts(2), []);
  assert.equal(await restarted.saveReceipt(entry('c')), 3);
});

test('B1: receipt publication survives a crash before acknowledgement without reusing its sequence', async () => {
  const adapter = new Adapter(), s = state(adapter); await s.loadReceipts(0);
  adapter.hook = async (op, p, when) => { if (op === 'rename' && p.includes('/receipt-writing-') && when === 'after') throw new Error('killed'); };
  await assert.rejects(s.saveReceipt(entry('a')), /killed/); adapter.hook = async () => {};
  assert.deepEqual(await state(adapter).loadReceipts(0), [{ sequence: 1, entry: entry('a') }]);
  assert.equal(await s.saveReceipt(entry('b')), 2, 'the same state instance rescans after uncertain publication');
});

test('B1: an incomplete receipt temporary write is never replayed', async () => {
  const adapter = new Adapter(), s = state(adapter);
  adapter.hook = async (op, p, when) => { if (op === 'write' && p.includes('/receipt-writing-') && when === 'after') { adapter.files.set(p, bytes('{partial')); throw new Error('killed'); } };
  await assert.rejects(s.saveReceipt(entry('a')), /killed/); adapter.hook = async () => {};
  const restarted = state(adapter); assert.deepEqual(await restarted.loadReceipts(0), []);
  assert.equal(await restarted.saveReceipt(entry('b')), 1);
});

test('B1: a committed receipt checksum and sequence gap are validated before replay', async () => {
  const adapter = new Adapter(), s = state(adapter); await s.saveReceipt(entry('a')); await s.saveReceipt(entry('b'));
  const [first, second] = receiptFiles(adapter, s), original = adapter.files.get(first);
  adapter.put(first, '{broken'); await assert.rejects(state(adapter).loadReceipts(0), /损坏|校验/);
  adapter.files.set(first, original); await adapter.remove(first);
  await assert.rejects(state(adapter).loadReceipts(0), /连续|缺失/);
  assert.deepEqual(await state(adapter).loadReceipts(1), [{ sequence: 2, entry: entry('b') }]);
  const row = JSON.parse(new TextDecoder().decode(adapter.files.get(second))); row.sequence = 3; adapter.put(second, JSON.stringify(row));
  await assert.rejects(state(adapter).loadReceipts(1), /损坏|校验/);
});

test('B1: successful checkpoint watermark makes partial receipt cleanup safe and repeatable', async () => {
  const adapter = new Adapter(), s = state(adapter);
  for (const id of ['a','b','c']) await s.saveReceipt(entry(id));
  await s.save({ version: 1, receiptSequence: 3 });
  const remove = adapter.remove.bind(adapter); let removed = 0;
  adapter.remove = async p => { if (p.includes('/receipt-') && ++removed === 2) throw new Error('cleanup stopped'); return remove(p); };
  await assert.rejects(s.clearReceipts(3), /cleanup stopped/); adapter.remove = remove;
  const restarted = state(adapter), checkpoint = await restarted.load();
  assert.deepEqual(await restarted.loadReceipts(checkpoint.receiptSequence), []);
  assert.equal(await restarted.saveReceipt(entry('d')), 4);
  await restarted.clearReceipts(3); await restarted.clearReceipts(3);
  assert.deepEqual(await state(adapter).loadReceipts(3), [{ sequence: 4, entry: entry('d') }]);
});

test('B1: stale receipt bytes below the checkpoint watermark cannot block or affect replay', async () => {
  const adapter = new Adapter(), s = state(adapter); await s.saveReceipt(entry('a')); await s.saveReceipt(entry('b'));
  adapter.put(receiptFiles(adapter, s)[0], '{old cleanup residue');
  assert.deepEqual(await state(adapter).loadReceipts(1), [{ sequence: 2, entry: entry('b') }]);
  await s.clearReceipts(1);
  assert.equal(receiptFiles(adapter, s).length, 1);
});

test('B1: desktop completion receipts are durable, ordered and cleared only through the checkpoint', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DiskState } = require('../src/local');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-receipts-'));
  try {
    const create = () => new DiskState(root, 'https://example.test/vault/', 'u');
    const s = create(); await s.loadReceipts(0);
    assert.equal(await s.saveReceipt(entry('a')), 1); assert.equal(await s.saveReceipt(entry('b')), 2);
    assert.deepEqual(await create().loadReceipts(0), [{ sequence: 1, entry: entry('a') }, { sequence: 2, entry: entry('b') }]);
    await s.clearReceipts(1); await s.clearReceipts(1);
    assert.deepEqual(await create().loadReceipts(1), [{ sequence: 2, entry: entry('b') }]);
    await s.clearReceipts(2); const restart = create(); await restart.loadReceipts(2);
    assert.equal(await restart.saveReceipt(entry('c')), 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
