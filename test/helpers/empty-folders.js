'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncEngine } = require('../../src/engine');
const { DiskVault, DiskState } = require('../../src/local');
const { MobileVault, MobileState } = require('../../src/mobile');
const { Adapter } = require('./adapter');
const { bytes, digest } = require('../../src/bytes');
function remote() {
  return { revisions: new Map(), blobs: new Map(), reads: 0, writes: 0,
    async listRevisions() { this.reads++; return [...this.revisions.values()]; },
    async putRevision(r) { this.writes++; this.revisions.set(r.id, r); },
    async putBlob(h, b) { this.writes++; assert.equal(digest(b), h); this.blobs.set(h, bytes(b).slice()); },
    async getBlob(h) { this.reads++; return this.blobs.get(h).slice(); },
    async getBlobSize(h) { this.reads++; return this.blobs.get(h).length; } };
}
function disk(t, r = remote(), retained = () => []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-f-folders-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = new DiskVault(root), state = new DiskState(local.privateDir, 'https://example.test/folders', 'test');
  return { root, local, state, remote: r,
    engine: new SyncEngine({ remote: r, local, state, device: 'Mac', retainedDirectories: retained }),
    mkdir(p) { fs.mkdirSync(path.join(root, p), { recursive: true }); },
    put(p, value) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), value); },
    remove(p) { fs.unlinkSync(path.join(root, p)); },
    has(p) { return fs.existsSync(path.join(root, p)); },
    read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); } };
}
function mobile(r = remote(), adapter = new Adapter(), retained = () => []) {
  adapter.supportsAtomicEmptyDirectoryRemoval = false;
  const local = new MobileVault(adapter), state = new MobileState(adapter, local.privateDir, 'https://example.test/folders', 'test');
  return { adapter, local, state, remote: r,
    engine: new SyncEngine({ remote: r, local, state, device: 'phone', retainedDirectories: retained }),
    mkdir(p) { const parts = p.split('/'); for (let i = 1; i <= parts.length; i++) adapter.folders.add(parts.slice(0, i).join('/')); },
    put(p, value) { if (p.includes('/')) this.mkdir(p.slice(0, p.lastIndexOf('/'))); adapter.put(p, value); },
    remove(p) { adapter.files.delete(p); adapter.mtimes.delete(p); },
    has(p) { return adapter.files.has(p) || adapter.folders.has(p); } };
}
async function seeded(t, paths = ['p/q/note.md'], retained) {
  const r = remote(), a = disk(t, r), b = disk(t, r, retained);
  for (const p of paths) a.put(p, 'content:' + p);
  await a.engine.sync(); await b.engine.sync();
  return { r, a, b };
}
module.exports = { remote, disk, mobile, seeded };
