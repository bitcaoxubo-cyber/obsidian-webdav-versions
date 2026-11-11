'use strict';

const { headsFor, isConflictPath, makeRevision, project, safePath, validateRevision } = require('./protocol');

const { base64, fromBase64, sha256 } = require('./bytes');

const hashOf = async bytes => bytes === null ? null : sha256(bytes);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const MAX_BYTES = 512 * 1024 * 1024;
const counts = () => ({ uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferred: 0,
  conflictPaths: [], deferredPaths: [],
  stats: { durationMs: 0, vaultReads: 0, hashBytes: 0, httpRequests: 0, full: 1 } });

// Conflict names are valid physical paths, but are never valid logical note names.
function checkPhysical(path) {
  if (typeof path !== 'string') throw new Error('Invalid physical path');
  safePath(path.replace(/ \(sync-conflict /giu, ' (reserved '));
}

function checkSize(data, physical) {
  if (data !== null && data.byteLength > MAX_BYTES) {
    throw new Error('File exceeds the 512 MiB per-file sync limit: ' + physical);
  }
}

function snapshot(revisions) {
  const rows = [...revisions.values()];
  const view = project(rows); // Also validates parent links and filename collisions.
  const byPath = new Map();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const tips = new Map();
  const versions = new Map();
  for (const [path, history] of byPath) {
    const ids = headsFor(history, path);
    tips.set(path, ids);
    const grouped = new Map();
    for (const id of ids) {
      const blob = revisions.get(id).blob;
      if (!grouped.has(blob)) grouped.set(blob, []);
      grouped.get(blob).push(id);
    }
    versions.set(path, grouped);
  }
  const files = new Map();
  for (const [physical, v] of view) {
    files.set(physical, { path: v.path, blob: v.blob, parents: versions.get(v.path).get(v.blob) });
  }
  return { files, tips, versions, byPath };
}

class SyncEngine {
  constructor({ remote, local, state, device }) {
    this.remote = remote;
    this.local = local;
    this.state = state;
    this.device = device;
    this.queue = Promise.resolve();
  }

  sync() { return this._enqueue(() => this._run()); }
  resolve(physicalPath) { return this._enqueue(() => this._run(physicalPath)); }

  _enqueue(run) {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _save(s) {
    await this.state.save({ version: 1, known: [...s.known], files: [...s.files],
      reviewed: [...s.reviewed], absent: [...s.absent], pending: s.pending });
  }

  async _open() {
    const disk = await this.state.load();
    if (disk !== null && (!disk || disk.version !== 1 || !Array.isArray(disk.known) ||
        !Array.isArray(disk.files) || !Array.isArray(disk.reviewed))) {
      throw new Error('Invalid sync state; the vault has not been changed');
    }
    const s = { known: new Set(disk?.known), files: new Map(disk?.files),
      reviewed: new Map(disk?.reviewed), absent: new Map(disk?.absent), pending: disk?.pending ?? null, revs: new Map() };
    for (const r of await this.remote.listRevisions()) {
      validateRevision(r);
      s.revs.set(r.id, r);
    }
    for (const id of s.known) {
      if (!s.revs.has(id)) throw new Error('Remote history is incomplete: previously seen revision missing: ' + id);
    }
    project(s.revs.values());
    for (const [physical, binding] of s.files) {
      checkPhysical(physical);
      safePath(binding.path);
      if (!Array.isArray(binding.parents) || !binding.parents.length || !binding.parents.every(id => {
        const rev = s.revs.get(id);
        return rev && rev.path === binding.path && rev.blob === binding.blob;
      })) throw new Error('Invalid file baseline for ' + physical);
    }
    for (const [path, ids] of s.absent) {
      safePath(path);
      if (!Array.isArray(ids) || !ids.length || !ids.every(id => {
        const r = s.revs.get(id);
        return r && r.path === path && r.blob === null;
      })) throw new Error('Invalid deletion baseline for ' + path);
    }
    const discovered = s.revs.size !== s.known.size;
    s.known = new Set(s.revs.keys());
    if (discovered) await this._save(s);
    return s;
  }

  _bind(s, physical, binding) {
    if (binding) s.files.set(physical, binding);
    else s.files.delete(physical);
  }

  async _hash(value) {
    if (value !== null) this.stats.hashBytes += typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength;
    return hashOf(value);
  }

  async _read(physical) {
    const data = await this.local.read(physical);
    if (data !== null && !this.local.tracksStats) this.stats.vaultReads++;
    return data;
  }

  async _localHash(physical) {
    return this.local.hash ? this.local.hash(physical) : this._hash(await this._read(physical));
  }

  async _ackPush(s, result) {
    const { rev, physical, bytes, staged } = s.pending;
    validateRevision(rev);
    checkPhysical(physical);
    if (rev.blob !== null) {
      if (!staged && typeof bytes !== 'string') throw new Error('Missing staged content for ' + physical);
      const data = staged ? await this.state.readStaged(rev.blob) : fromBase64(bytes);
      if (!data || data.byteLength > MAX_BYTES) throw new Error('Missing or oversized staged content for ' + physical);
      if (await this._hash(data) !== rev.blob) throw new Error('Staged content checksum mismatch: ' + physical);
      await this.remote.putBlob(rev.blob, data);
    }
    // A retry always publishes the exact same document and identifier.
    await this.remote.putRevision(rev);
    s.revs.set(rev.id, rev);
    s.known.add(rev.id);
    this._bind(s, physical, rev.blob === null ? null : { path: rev.path, blob: rev.blob, parents: [rev.id] });
    if (physical === rev.path && rev.blob === null) s.absent.set(physical, [rev.id]);
    s.pending = null;
    await this._save(s);
    if (staged) await this.state.clearStaged(rev.blob);
    result.uploaded++;
  }

  async _push(s, physical, path, parents, data, result) {
    checkSize(data, physical);
    const rev = makeRevision({ path, parents, blob: await this._hash(data), device: this.device });
    // Check that a new conflict, including its generated filename, is representable before publication.
    project([...s.revs.values()].filter(r => r.path === path).concat(rev));
    s.reviewed.delete(path);
    s.pending = { kind: 'push', physical, rev };
    if (data !== null && this.state.stageBlob && this.state.readStaged && this.state.clearStaged) {
      // Write bytes first. Once the journal is durable, retry needs neither the open editor nor its file.
      await this.state.stageBlob(rev.blob, data);
      s.pending.staged = true;
    } else if (data !== null) {
      s.pending.bytes = base64(data);
    }
    await this._save(s);
    await this._ackPush(s, result);
  }

  async _recover(s, result) {
    if (!s.pending) return;
    if (s.pending.kind === 'push') return this._ackPush(s, result);
    if (s.pending.kind !== 'apply') throw new Error('Unknown sync journal entry');
    const { physical, next } = s.pending;
    checkPhysical(physical);
    const actual = await this._localHash(physical);
    // The local CAS may have completed immediately before the crash. A subsequent user edit
    // does not match the staged result; keep its earlier baseline for conservative capture.
    if (actual === (next?.blob ?? null)) this._bind(s, physical, next);
    s.pending = null;
    await this._save(s);
  }

  async _resolve(s, selected, before, result) {
    checkPhysical(selected);
    const binding = s.files.get(selected);
    if (!binding) throw new Error('Select a synchronized member of a conflict and sync first');
    const path = binding.path;
    const reviewed = s.reviewed.get(path);
    const tips = before.tips.get(path) || [];
    if (!reviewed || !sameIds(reviewed, tips)) throw new Error('Conflict changed; sync and review all versions first');
    if (before.versions.get(path)?.size < 2) throw new Error('No unresolved conflict for ' + path);
    for (const [physical, v] of before.files) {
      if (v.path !== path || physical === selected) continue;
      if (await this._hash(await this._read(physical)) !== v.blob) {
        throw new Error('Another conflict copy was edited or removed; sync and review it first: ' + physical);
      }
    }
    const data = await this._read(selected);
    if (data === null) throw new Error('Selected conflict file is missing: ' + selected);
    await this._push(s, selected, path, tips, data, result);
  }

  async _capture(s, before, result, deferred) {
    const listed = await this.local.list();
    const paths = new Set([...listed, ...s.files.keys()]);
    // Detect file/folder, case and Unicode collisions before publishing new filenames.
    const provisional = [];
    for (const name of listed) {
      checkPhysical(name);
      if (!isConflictPath(name) && !before.files.has(name)) {
        provisional.push(makeRevision({ path: name, parents: [], blob: '0'.repeat(64), device: this.device }));
      }
    }
    if (provisional.length) project([...s.revs.values(), ...provisional]);
    for (const physical of paths) {
      const base = s.files.get(physical);
      if (base && this.local.hash && await this._localHash(physical) === base.blob) continue;
      const data = await this._read(physical);
      checkSize(data, physical);
      const hash = await this._hash(data);
      if (base) {
        if (hash !== base.blob) await this._push(s, physical, base.path, base.parents, data, result);
        continue;
      }
      if (data === null) continue;
      const remote = before.files.get(physical);
      if (remote && hash === remote.blob) {
        this._bind(s, physical, remote); // Fresh device with identical content.
      } else if (isConflictPath(physical)) {
        // A generated copy without a recorded owner cannot safely become a new logical note.
        deferred.add(physical);
      } else {
        // Independent roots preserve different pre-existing files on the first sync.
        await this._push(s, physical, physical, s.absent.get(physical) || [], data, result);
      }
    }
    await this._save(s);
  }

  async _apply(s, nextView, result, deferred) {
    const paths = new Set([...nextView.files.keys(), ...s.files.keys()]);
    for (const physical of paths) {
      if (deferred.has(physical)) continue;
      const old = s.files.get(physical);
      const next = nextView.files.get(physical) || null;
      const expected = old?.blob ?? null;
      const wanted = next?.blob ?? null;
      const actual = await this._localHash(physical);
      if (actual === wanted) {
        this._bind(s, physical, next);
        continue;
      }
      if (actual !== expected) {
        deferred.add(physical);
        continue;
      }
      const data = next ? await this.remote.getBlob(wanted) : null;
      if (await this._hash(data) !== wanted) throw new Error('Downloaded content checksum mismatch for ' + physical);
      s.pending = { kind: 'apply', physical, next };
      await this._save(s);
      const applied = await this.local.compareAndSet(physical, expected, data);
      if (applied) {
        this._bind(s, physical, next);
        if (next) result.downloaded++;
        else result.deleted++;
      } else {
        deferred.add(physical); // The editor changed it after the scan. Capture on next sync.
      }
      s.pending = null;
      await this._save(s);
    }
  }

  async _run(selected) {
    const result = counts();
    const started = Date.now();
    this.stats = result.stats;
    this.local.stats = this.state.stats = result.stats;
    if (this.remote.setStats) this.remote.setStats(result.stats);
    else {
      this.remote.stats = result.stats;
      if (this.remote.request) this.remote.request.stats = result.stats;
    }
    await this.local.recover?.();
    const s = await this._open();
    await this._recover(s, result);
    const before = snapshot(s.revs);
    if (selected !== undefined) {
      await this._resolve(s, selected, before, result);
    }
    const deferred = new Set();
    await this._capture(s, selected === undefined ? before : snapshot(s.revs), result, deferred);
    const after = snapshot(s.revs);
    await this._apply(s, after, result, deferred);
    s.reviewed.clear();
    for (const [path, versions] of after.versions) {
      if (!deferred.has(path)) {
        if (versions.size === 1 && versions.has(null)) {
          // A later local recreation acknowledges only deletions already observed here.
          if (await this._localHash(path) === null) s.absent.set(path, versions.get(null));
        } else if (s.files.has(path)) {
          s.absent.delete(path);
        }
      }
      if (versions.size > 1) {
        result.conflictPaths.push(path);
        s.reviewed.set(path, after.tips.get(path));
      }
    }
    for (const physical of deferred) {
      const path = after.files.get(physical)?.path ?? s.files.get(physical)?.path ?? physical;
      s.reviewed.delete(path);
    }
    result.conflictPaths.sort();
    result.conflicts = result.conflictPaths.length;
    result.deferredPaths = [...deferred].sort();
    result.deferred = result.deferredPaths.length;
    await this._save(s);
    result.stats.durationMs = Date.now() - started;
    return result;
  }
}

module.exports = { SyncEngine };
