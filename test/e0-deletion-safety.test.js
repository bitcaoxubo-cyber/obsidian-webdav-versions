'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Adapter } = require('./helpers/adapter');
const { MobileVault, MobileState } = require('../src/mobile');
const { SyncEngine } = require('../src/engine');
const { bytes, text, digest } = require('../src/bytes');
const assertTrash = app => require('../src/deletion').assertRecoverableTrash(app);

// Models the inspected Capacitor JS contract, not an actual iPhone runtime:
// its rmdir wrapper accepts a flag but always delegates a recursive operation.
class RecursiveNativeModel extends Adapter {
  constructor(capability) {
    super();
    this.supportsAtomicEmptyDirectoryRemoval = capability;
    this.visibleRemovals = [];
    this.visibleReads = 0;
  }
  async rmdir(name, requestedRecursive) {
    if (!name.startsWith('.obsidian/')) this.visibleRemovals.push({ name, requestedRecursive });
    return super.rmdir(name, true);
  }
  async list(name) {
    if (name && !name.startsWith('.obsidian')) this.visibleReads++;
    return super.list(name);
  }
}

for (const capability of [undefined, false, 'true', 1]) test(`E0: untrusted empty-directory capability ${String(capability)} never invokes native removal`, async () => {
  const adapter = new RecursiveNativeModel(capability), local = new MobileVault(adapter);
  adapter.folders.add('candidate');
  assert.equal(await local.pruneEmptyDirectories(new Set(['candidate'])), 0);
  assert.deepEqual(adapter.visibleRemovals, []);
  assert.equal(adapter.visibleReads, 0);
  assert.equal(adapter.folders.has('candidate'), true);
  assert.equal(local.directoryCleanupBlocked, true);
});

test('E0: a stale empty listing cannot let a recursive native adapter destroy newly created content', async () => {
  const adapter = new RecursiveNativeModel(undefined), local = new MobileVault(adapter);
  adapter.folders.add('candidate');
  const emptySnapshot = await Adapter.prototype.list.call(adapter, 'candidate');
  adapter.put('candidate/new-local.md', 'the only copy of newly typed content');
  const list = adapter.list.bind(adapter);
  adapter.list = async name => name === 'candidate' ? emptySnapshot : list(name);
  assert.equal(await local.pruneEmptyDirectories(new Set(['candidate'])), 0);
  assert.deepEqual(adapter.visibleRemovals, []);
  assert.equal(text(adapter.files.get('candidate/new-local.md')), 'the only copy of newly typed content');
  assert.equal(adapter.folders.has('candidate'), true);
});

test('E0: an explicitly capable adapter retains atomic empty-only removal and its concurrent-file guard', async () => {
  const adapter = new Adapter(), local = new MobileVault(adapter);
  assert.equal(adapter.supportsAtomicEmptyDirectoryRemoval, true);
  adapter.folders.add('empty'); adapter.folders.add('racing');
  let raced = false;
  adapter.hook = async (operation, name, when) => {
    if (operation === 'rmdir' && name === 'racing' && when === 'before') {
      raced = true; adapter.put('racing/new.md', 'new content');
    }
  };
  assert.equal(await local.pruneEmptyDirectories(new Set(['empty', 'racing'])), 1);
  assert.equal(raced, true); assert.equal(adapter.folders.has('empty'), false);
  assert.equal(text(adapter.files.get('racing/new.md')), 'new content');
  assert.equal(local.directoryCleanupBlocked, false);
});

test('E0: directory-cleanup capability blocking is per-round and never a persisted state field', async () => {
  const adapter = new RecursiveNativeModel(undefined), local = new MobileVault(adapter);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test/e0/', 'test');
  adapter.folders.add('candidate');
  await local.pruneEmptyDirectories(new Set(['candidate']));
  assert.equal(local.directoryCleanupBlocked, true);
  local.beginRound(); assert.equal(local.directoryCleanupBlocked, false);
  assert.equal(await local.pruneEmptyDirectories(new Set()), 0);
  assert.equal(local.directoryCleanupBlocked, false);
  const remote = { async listRevisions() { return []; } };
  const engine = new SyncEngine({ remote, local, state, device: 'test' });
  await engine.sync();
  assert.equal(Object.hasOwn(await state.load(), 'directoryCleanupBlocked'), false);
});

test('E0: untrusted native directory cleanup keeps normal file tombstone synchronization working', async () => {
  const remote = { revisions: new Map(), blobs: new Map(),
    async listRevisions() { return [...this.revisions.values()]; },
    async putRevision(rev) { this.revisions.set(rev.id, rev); },
    async putBlob(hash, value) { assert.equal(digest(value), hash); this.blobs.set(hash, bytes(value).slice()); },
    async getBlob(hash) { return this.blobs.get(hash).slice(); },
  };
  const connect = (adapter, device) => {
    const local = new MobileVault(adapter), state = new MobileState(adapter, local.privateDir, 'https://example.test/e0/', 'test');
    return { local, engine: new SyncEngine({ remote, local, state, device }) };
  };
  const senderAdapter = new Adapter(), receiverAdapter = new RecursiveNativeModel(undefined);
  const sender = connect(senderAdapter, 'sender'), receiver = connect(receiverAdapter, 'receiver');
  senderAdapter.folders.add('candidate'); senderAdapter.put('candidate/old.md', 'old');
  await sender.engine.sync(); await receiver.engine.sync();
  await senderAdapter.remove('candidate/old.md'); await sender.engine.sync();
  const result = await receiver.engine.sync({ full: false, dirty: [] });
  assert.equal(result.deleted, 1); assert.equal(result.conflicts, 0); assert.equal(result.deferred, 0);
  assert.equal(result.cleanedDirectories, 0);
  assert.equal(receiverAdapter.files.has('candidate/old.md'), false);
  assert.equal(receiverAdapter.folders.has('candidate'), true);
  assert.deepEqual(receiverAdapter.visibleRemovals, []);
  assert.equal(receiver.local.directoryCleanupBlocked, true);
});

function appFor(option, platform) {
  const calls = [];
  return { platform, calls,
    vault: { getConfig(name) { calls.push(['getConfig', name]); return option; },
      setConfig() { throw new Error('must not change preferences'); },
      delete() { throw new Error('must not delete during preflight'); },
      trash() { throw new Error('must not trash during preflight'); } },
    fileManager: { trashFile() { throw new Error('must not invoke trashFile during preflight'); } },
  };
}

for (const platform of ['desktop', 'mobile']) test(`E0: ${platform} trash preflight allows only system and local without side effects`, () => {
  for (const option of ['system', 'local']) {
    const app = appFor(option, platform);
    assert.equal(assertTrash(app), option);
    assert.deepEqual(app.calls, [['getConfig', 'trashOption']]);
  }
});

for (const platform of ['desktop', 'mobile']) test(`E0: ${platform} permanent or unknown trash settings fail closed`, () => {
  for (const option of ['none', undefined, null, '', 'unknown', 'SYSTEM', true]) {
    const app = appFor(option, platform);
    assert.throws(() => assertTrash(app), /回收站|恢复|设置/);
    assert.deepEqual(app.calls, [['getConfig', 'trashOption']]);
  }
});

test('E0: missing trashFile or unreadable settings refuse deletion on hosts below the required API contract', () => {
  for (const app of [undefined, {}, { vault: {} }, { vault: { getConfig: () => 'local' } },
    { vault: { getConfig: () => 'system' }, fileManager: { trashFile: true } }]) {
    assert.throws(() => assertTrash(app), /回收站|设置|接口|1\.11\.4/);
  }
  const app = appFor('local', 'mobile');
  app.vault.getConfig = () => { throw new Error('unavailable settings'); };
  assert.throws(() => assertTrash(app));
});

test('E0: changing the trash setting between actions is detected without caching an earlier approval', () => {
  let option = 'local', reads = 0;
  const app = { vault: { getConfig() { reads++; return option; } }, fileManager: { trashFile() {} } };
  assert.equal(assertTrash(app), 'local'); option = 'none';
  assert.throws(() => assertTrash(app), /回收站|恢复|设置/);
  assert.equal(reads, 2);
});
