'use strict';

const { indexRevisions, isConflictPath, makeRevision, project, safePath, validateRevision } = require('./protocol');

const { base64, fromBase64, sha256, randomUUID } = require('./bytes');
const { parallel } = require('./sharded');
const { parentDirectory, residualDirectories } = require('./directories');

const hashOf = async bytes => bytes === null ? null : sha256(bytes);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const MAX_BYTES = 512 * 1024 * 1024;
const counts = () => ({ uploaded: 0, downloaded: 0, deleted: 0, cleanedDirectories: 0, conflicts: 0, deferred: 0,
  conflictPaths: [], deferredPaths: [], stalePaths: [], staleCopies: [],
  confirmations: { staleCopies: [], deletionConflicts: [], staleConflicts: [] },
  appliedDecisions: 0, skippedDecisions: [], trashedFiles: 0, directoryCleanupBlocked: false,
  stats: { durationMs: 0, vaultReads: 0, hashBytes: 0, httpRequests: 0, full: 1 } });

class ConfirmationChanged extends Error {}

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
  const index = indexRevisions(rows);
  const view = project(rows, index); // Also validates parent links and filename collisions.
  const byPath = new Map();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const tips = new Map();
  const versions = new Map();
  for (const [path, history] of byPath) {
    const ids = [...index.leaves.get(path)].sort();
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
  constructor({ remote, local, state, device, concurrency = 4, retainedDirectories = () => [] }) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Transfer concurrency must be between 1 and 4');
    this.concurrency = concurrency;
    this.remote = remote;
    this.local = local;
    this.state = state;
    this.device = device;
    this.queue = Promise.resolve();
    this.staleCopies = new Map();
    this.retainedDirectories = retainedDirectories;
    this.emptyDirectories = [];
  }

  sync(options = {}) { return this._enqueue(() => this._run(undefined, options)); }
  resolve(physicalPath) { return this._enqueue(() => this._run(physicalPath)); }
  confirm(actions, callbacks = {}) {
    return this._enqueue(() => {
      if (!Array.isArray(actions)) throw new Error('Expected a list of confirmation actions');
      return this._run(undefined, { full: true, decisions: actions, decisionCallbacks: callbacks });
    });
  }

  _enqueue(run) {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  _snapshot(s) {
    return { version: 1, known: [...s.known], files: [...s.files],
      reviewed: [...s.reviewed], absent: [...s.absent], pending: s.splitJournal ? null : s.pending,
      ...(s.receiptSupported ? { receiptSequence: s.receiptSequence } : {}) };
  }

  async _save(s) {
    // Serialization happens only at a checkpoint, never for each split journal.
    // Legacy/test state implementations retain their original per-operation save.
    if (!s.splitJournal || s.changed) {
      const snapshot = this._snapshot(s);
      const serialized = JSON.stringify(snapshot);
      if (!s.splitJournal || serialized !== s.savedSnapshot) {
        await this.state.save(snapshot);
        s.savedSnapshot = serialized;
      }
      s.changed = false;
    }
    // The watermark is durable before cleanup starts. A crash during cleanup
    // leaves only stale receipts, which loadReceipts skips on the next start.
    if (s.receiptSupported && s.receiptsNeedCleanup) {
      await this.state.clearReceipts(s.receiptSequence);
      s.receiptsNeedCleanup = false;
    }
    s.sinceCheckpoint = 0;
    s.checkpointAt = Date.now();
  }

  async _beginPending(s) {
    if (s.splitJournal && s.receiptSupported) s.pending.operationId = randomUUID();
    if (s.splitJournal) await this.state.savePending(s.pending);
    else await this._save(s);
  }

  async _finishPending(s) {
    const pending = s.pending;
    s.pending = null;
    if (s.splitJournal) {
      // A storage adapter implementing only the optional pending API cannot
      // discard that journal before the new binding has its own durable record.
      if (!s.receiptSupported || !pending.operationId) await this._save(s);
      await this.state.clearPending();
    } else await this._save(s);
  }

  _validateReceipt(s, entry) {
    if (!entry || !['push', 'apply'].includes(entry.kind) || typeof entry.operationId !== 'string' || !entry.operationId ||
        !Array.isArray(entry.known) || !entry.known.length) throw new Error('Invalid completion receipt');
    checkPhysical(entry.physical);
    for (const id of entry.known) if (!s.revs.has(id)) throw new Error('Completion receipt references missing remote revision: ' + id);
    const next = entry.next;
    if (next !== null) {
      if (!next || typeof next !== 'object') throw new Error('Invalid completion receipt binding');
      safePath(next.path);
      if (!Array.isArray(next.parents) || !next.parents.length || !next.parents.every(id => {
        const r = s.revs.get(id); return r && r.path === next.path && r.blob === next.blob;
      })) throw new Error('Completion receipt binding does not match remote revisions');
    }
    if (entry.absent !== null) {
      const absent = entry.absent;
      if (!absent || typeof absent !== 'object') throw new Error('Invalid completion receipt deletion');
      safePath(absent.path);
      if (entry.physical !== absent.path || next !== null || !Array.isArray(absent.parents) || !absent.parents.length || !absent.parents.every(id => {
        const r = s.revs.get(id); return r && r.path === absent.path && r.blob === null;
      })) throw new Error('Completion receipt deletion does not match remote revisions');
    }
  }

  _applyReceipt(s, entry) {
    this._validateReceipt(s, entry);
    this._bind(s, entry.physical, entry.next);
    if (entry.absent) this._setAbsent(s, entry.absent.path, entry.absent.parents);
    else if (entry.next && entry.physical === entry.next.path) this._setAbsent(s, entry.next.path, null);
    for (const id of entry.known) {
      if (!s.known.has(id)) { s.known.add(id); s.changed = true; }
    }
  }

  async _replayReceipts(s) {
    if (!s.receiptSupported) return;
    const receipts = await this.state.loadReceipts(s.receiptSequence);
    if (s.legacyPending && receipts.length) throw new Error('Legacy pending and completion receipts overlap; retain local-state and stop');
    for (const { sequence, entry } of receipts) {
      if (!Number.isSafeInteger(sequence) || sequence !== s.receiptSequence + 1 || s.completedOperations.has(entry?.operationId)) {
        throw new Error('Invalid completion receipt ordering');
      }
      this._applyReceipt(s, entry);
      s.completedOperations.add(entry.operationId);
      s.receiptSequence = sequence;
      s.changed = true;
    }
    s.receiptsNeedCleanup = true;
  }

  async _completeOperation(s, next, absent, known) {
    if (!s.splitJournal || !s.receiptSupported || !s.pending.operationId) return;
    const entry = { operationId: s.pending.operationId, kind: s.pending.kind, physical: s.pending.physical,
      next, absent, known };
    this._validateReceipt(s, entry);
    const sequence = await this.state.saveReceipt(entry);
    if (sequence !== s.receiptSequence + 1) throw new Error('Unexpected completion receipt sequence');
    s.receiptSequence = sequence;
    s.completedOperations.add(entry.operationId);
    s.changed = true;
    s.receiptsNeedCleanup = true;
  }

  async _checkpointProgress(s) {
    if (!s.splitJournal) return;
    s.sinceCheckpoint++;
    if (s.sinceCheckpoint >= 200 || Date.now() - s.checkpointAt >= 5000) await this._save(s);
  }

  async _open() {
    const disk = await this.state.load();
    if (disk !== null && (!disk || disk.version !== 1 || !Array.isArray(disk.known) ||
        !Array.isArray(disk.files) || !Array.isArray(disk.reviewed))) {
      throw new Error('Invalid sync state; the vault has not been changed');
    }
    const splitSupported = ['loadPending', 'savePending', 'clearPending'].every(name => typeof this.state[name] === 'function');
    const receiptSupported = splitSupported && ['loadReceipts', 'saveReceipt', 'clearReceipts'].every(name => typeof this.state[name] === 'function');
    const receiptSequence = disk?.receiptSequence ?? 0;
    if (!Number.isSafeInteger(receiptSequence) || receiptSequence < 0) throw new Error('Invalid completion receipt watermark');
    const independent = splitSupported ? await this.state.loadPending() : null;
    const embedded = disk?.pending ?? null;
    if (embedded && independent) throw new Error('Both legacy and independent sync journals are present; retain local-state and stop');
    const s = { known: new Set(disk?.known), files: new Map(disk?.files),
      reviewed: new Map(disk?.reviewed), absent: new Map(disk?.absent), pending: embedded || independent,
      revs: new Map(), splitJournal: splitSupported && !embedded, legacyPending: splitSupported && !!embedded,
      changed: disk === null, sinceCheckpoint: 0, checkpointAt: Date.now(),
      receiptSupported, receiptSequence, completedOperations: new Set(), receiptsNeedCleanup: false,
      cleanupPaths: new Set(), appliedDeletions: new Set() };
    s.savedSnapshot = disk === null ? null : JSON.stringify(this._snapshot(s));
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
    // Restore completed local ancestry before recording newly discovered remote
    // history or advancing the checkpoint watermark.
    await this._replayReceipts(s);
    const discovered = s.revs.size !== s.known.size;
    s.known = new Set(s.revs.keys());
    if (discovered) { s.changed = true; await this._save(s); }
    return s;
  }

  _bind(s, physical, binding) {
    const previous = s.files.get(physical);
    if (binding) {
      if (previous && previous.path === binding.path && previous.blob === binding.blob && sameIds(previous.parents, binding.parents)) return false;
      s.files.set(physical, binding);
    } else if (!s.files.delete(physical)) return false;
    s.changed = true;
    return true;
  }

  _setAbsent(s, path, ids) {
    if (ids) {
      if (sameIds(s.absent.get(path) || [], ids)) return;
      s.absent.set(path, ids);
      s.cleanupPaths.add(path);
    } else if (!s.absent.delete(path)) return;
    s.changed = true;
  }

  _rebindDescendant(s, before, physical, base, hash) {
    // A completed operation can outlive the last checkpoint after its separate
    // journal was cleared. Recover only a leaf acknowledging every old parent;
    // matching bytes on an unrelated branch must remain concurrent work.
    for (const id of before.tips.get(base.path) || []) {
      const leaf = s.revs.get(id);
      if (leaf.blob !== hash) continue;
      const needed = new Set(base.parents), visited = new Set(), pending = [id];
      while (pending.length && needed.size) {
        const next = pending.pop();
        if (visited.has(next)) continue;
        visited.add(next); needed.delete(next);
        pending.push(...s.revs.get(next).parents);
      }
      if (needed.size) continue;
      this._bind(s, physical, hash === null ? null : { path: base.path, blob: hash, parents: [id] });
      if (hash === null && physical === base.path) this._setAbsent(s, physical, [id]);
      return true;
    }
    return false;
  }

  async _hash(value) {
    if (value !== null) this.stats.hashBytes += typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength;
    return hashOf(value);
  }

  async _read(physical, limit) {
    const data = await this.local.read(physical, limit);
    if (data !== null && !this.local.tracksStats) this.stats.vaultReads++;
    return data;
  }

  async _localHash(physical) {
    return this.local.hash ? this.local.hash(physical) : this._hash(await this._read(physical));
  }

  async _observedHash(physical) {
    if (!this.observed.has(physical)) this.observed.set(physical, await this._localHash(physical));
    return this.observed.get(physical);
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
    if (!s.known.has(rev.id)) { s.known.add(rev.id); s.changed = true; }
    this._bind(s, physical, rev.blob === null ? null : { path: rev.path, blob: rev.blob, parents: [rev.id] });
    const absent = physical === rev.path && rev.blob === null ? { path: physical, parents: [rev.id] } : null;
    if (absent) this._setAbsent(s, physical, absent.parents);
    await this._completeOperation(s, rev.blob === null ? null : { path: rev.path, blob: rev.blob, parents: [rev.id] }, absent, [rev.id]);
    await this._finishPending(s);
    if (staged) await this.state.clearStaged(rev.blob);
    this.local.invalidate?.(physical); // Refresh the persistent hint from the saved file at flush.
    result.uploaded++;
    await this._checkpointProgress(s);
  }

  async _push(s, physical, path, parents, data, result) {
    checkSize(data, physical);
    const rev = makeRevision({ path, parents, blob: await this._hash(data), device: this.device });
    // Check that a new conflict, including its generated filename, is representable before publication.
    project([...s.revs.values()].filter(r => r.path === path).concat(rev));
    if (s.reviewed.delete(path)) s.changed = true;
    s.pending = { kind: 'push', physical, rev };
    if (data !== null && this.state.stageBlob && this.state.readStaged && this.state.clearStaged) {
      // Write bytes first. Once the journal is durable, retry needs neither the open editor nor its file.
      await this.state.stageBlob(rev.blob, data);
      s.pending.staged = true;
    } else if (data !== null) {
      s.pending.bytes = base64(data);
    }
    await this._beginPending(s);
    await this._ackPush(s, result);
    this.observed.set(physical, rev.blob);
  }

  async _recover(s, result) {
    if (!s.pending) return;
    if (s.pending.operationId && s.completedOperations.has(s.pending.operationId)) {
      // Completion already has an exact durable baseline. Do not reinterpret an
      // editor change after that completion through the older pending intent.
      const { kind, staged, rev, physical } = s.pending;
      await this._finishPending(s);
      if (kind === 'push' && staged) await this.state.clearStaged(rev.blob);
      this.local.invalidate?.(physical);
      return;
    }
    if (s.pending.kind === 'push') return this._ackPush(s, result);
    if (s.pending.kind !== 'apply') throw new Error('Unknown sync journal entry');
    const { physical, next } = s.pending;
    checkPhysical(physical);
    const actual = await this._localHash(physical);
    // The local CAS may have completed immediately before the crash. A subsequent user edit
    // does not match the staged result; keep its earlier baseline for conservative capture.
    if (actual === (next?.blob ?? null)) {
      this._bind(s, physical, next);
      const absent = s.pending.absent || null;
      if (absent) this._setAbsent(s, absent.path, absent.parents);
      await this._completeOperation(s, next, absent, s.pending.known || next?.parents || []);
    }
    await this._finishPending(s);
    await this._checkpointProgress(s);
  }

  async _resolve(s, selected, before, result, expected = null) {
    const reject = message => { throw expected ? new ConfirmationChanged(message) : new Error(message); };
    checkPhysical(selected);
    const binding = s.files.get(selected);
    if (!binding) reject('Select a synchronized member of a conflict and sync first');
    const path = binding.path;
    const reviewed = s.reviewed.get(path);
    const tips = before.tips.get(path) || [];
    if (!reviewed || !sameIds(reviewed, tips)) reject('Conflict changed; sync and review all versions first');
    if (before.versions.get(path)?.size < 2) reject('No unresolved conflict for ' + path);
    if (expected && (expected.path !== path || !sameIds(expected.tips, tips))) reject('Confirmation history changed');
    for (const [physical, v] of before.files) {
      if (v.path !== path || physical === selected) continue;
      const data = await this._read(physical);
      if (await this._hash(data) !== v.blob || (expected && this.local.guard && !this.local.guard(physical, data))) {
        reject('Another conflict copy was edited or removed; sync and review it first: ' + physical);
      }
    }
    const data = await this._read(selected);
    if (data === null) reject('Selected conflict file is missing: ' + selected);
    if (expected) {
      const chosen = expected.files.find(file => file.physical === selected);
      if (!chosen || await this._hash(data) !== chosen.hash || (this.local.guard && !this.local.guard(selected, data))) {
        reject('Selected conflict content changed after confirmation: ' + selected);
      }
    }
    await this._push(s, selected, path, tips, data, result);
  }

  _ancestorBlobs(s, ids) {
    const blobs = new Set(), visited = new Set(), pending = ids.flatMap(id => s.revs.get(id).parents);
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const rev = s.revs.get(id);
      if (rev.blob !== null) blobs.add(rev.blob);
      pending.push(...rev.parents);
    }
    return blobs;
  }

  _confirmationGroups(s, view, staleCopies = []) {
    const groups = { staleCopies, deletionConflicts: [], staleConflicts: [] };
    const filesByPath = new Map();
    for (const [physical, binding] of view.files) {
      if (!filesByPath.has(binding.path)) filesByPath.set(binding.path, []);
      filesByPath.get(binding.path).push({ physical, hash: binding.blob });
    }
    for (const [path, versions] of view.versions) {
      if (versions.size < 2) continue;
      const files = (filesByPath.get(path) || []).sort((a, b) => a.physical < b.physical ? -1 : a.physical > b.physical ? 1 : 0);
      const tips = [...view.tips.get(path)];
      const devices = [...new Set(tips.map(id => s.revs.get(id)).filter(rev => rev.blob !== null).map(rev => rev.device))].sort();
      if (versions.has(null)) {
        const prior = this._ancestorBlobs(s, versions.get(null));
        groups.deletionConflicts.push({ path, tips, files, devices,
          unchanged: [...versions.keys()].filter(hash => hash !== null).every(hash => prior.has(hash)),
          selected: files.find(file => file.physical === path)?.physical || files[0]?.physical });
      } else if (versions.size === 2) {
        const [a, b] = [...versions.keys()];
        // Equal-content parallel heads are one displayed version. Any ancestry
        // evidence in the opposite direction makes "newer" ambiguous.
        const aBeforeB = versions.get(b).some(id => this._ancestorBlobs(s, [id]).has(a));
        const bBeforeA = versions.get(a).some(id => this._ancestorBlobs(s, [id]).has(b));
        if (aBeforeB !== bBeforeA) {
          const newer = aBeforeB ? b : a;
          groups.staleConflicts.push({ path, tips, files, devices, selected: files.find(file => file.hash === newer).physical });
        }
      }
    }
    for (const entries of [groups.deletionConflicts, groups.staleConflicts]) entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return groups;
  }

  _sameDecisionFiles(actual, expected) {
    if (!Array.isArray(actual) || actual.length !== expected.length || actual.some(file => !file || typeof file.physical !== 'string')) return false;
    const ordered = [...actual].sort((a, b) => a.physical < b.physical ? -1 : a.physical > b.physical ? 1 : 0);
    return ordered.every((file, index) => file.physical === expected[index].physical && file.hash === expected[index].hash);
  }

  async _decisionFileMatches(physical, hash) {
    this.local.checkActive?.();
    const data = await this._read(physical);
    checkSize(data, physical);
    if (data === null || await this._hash(data) !== hash) {
      this.local.invalidate?.(physical);
      return false;
    }
    return !this.local.guard || this.local.guard(physical, data);
  }

  async _confirm(s, before, actions, callbacks, result) {
    const groups = this._confirmationGroups(s, before);
    const deletions = new Map(groups.deletionConflicts.map(entry => [entry.path, entry]));
    const older = new Map(groups.staleConflicts.map(entry => [entry.path, entry]));
    const prepared = [], seen = new Set();
    const skip = (kind, path, reason) => result.skippedDecisions.push({ kind, path, reason });
    for (const action of actions) {
      const kind = action?.kind, entry = action?.entry, path = entry?.path;
      if (!['stale-delete', 'stale-keep', 'conflict-delete', 'resolve'].includes(kind) || typeof path !== 'string') {
        skip(kind || 'unknown', typeof path === 'string' ? path : null, 'invalid-entry'); continue;
      }
      try { safePath(path); } catch { skip(kind, path, 'invalid-entry'); continue; }
      if (seen.has(path)) { skip(kind, path, 'duplicate'); continue; }
      if (!Array.isArray(entry.tips) || !sameIds(entry.tips, before.tips.get(path) || [])) {
        skip(kind, path, 'remote-changed'); continue;
      }
      let canonical, files, selected;
      if (kind === 'stale-delete' || kind === 'stale-keep') {
        const versions = before.versions.get(path);
        if (s.files.has(path) || s.absent.has(path) || versions?.size !== 1 || !versions.has(null) ||
            typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) ||
            !(before.byPath.get(path) || []).some(rev => rev.blob === entry.hash)) {
          skip(kind, path, 'baseline-changed'); continue;
        }
        canonical = { path, hash: entry.hash, tips: [...before.tips.get(path)] };
        files = [{ physical: path, hash: entry.hash }];
      } else {
        canonical = deletions.get(path) || (kind === 'resolve' ? older.get(path) : null);
        if (!canonical || !this._sameDecisionFiles(entry.files, canonical.files)) {
          skip(kind, path, 'baseline-changed'); continue;
        }
        files = canonical.files;
        if (files.some(file => { const base = s.files.get(file.physical); return !base || base.path !== path || base.blob !== file.hash; })) {
          skip(kind, path, 'baseline-changed'); continue;
        }
        if (kind === 'resolve') {
          selected = action.selected ?? entry.selected ?? canonical.selected;
          if (!files.some(file => file.physical === selected) || (older.has(path) && selected !== canonical.selected)) {
            skip(kind, path, 'invalid-selection'); continue;
          }
        }
      }
      const deleting = kind === 'stale-delete' || kind === 'conflict-delete';
      if (deleting && (typeof callbacks.canTrash !== 'function' || typeof callbacks.trash !== 'function')) {
        skip(kind, path, 'trash-unavailable'); continue;
      }
      let valid = true;
      for (const file of files) {
        if (!await this._decisionFileMatches(file.physical, file.hash) ||
            (deleting && await callbacks.canTrash(file.physical, file.hash) !== true)) { valid = false; break; }
      }
      if (!valid) { skip(kind, path, 'local-changed'); continue; }
      seen.add(path); prepared.push({ kind, path, entry: canonical, files, selected });
    }

    // A clean incremental poll can discover equal-content heads without yet
    // acknowledging them locally. Fresh byte checks above permit that binding
    // now; persist all such parents before the first recoverable trash call.
    if (prepared.some(action => action.kind === 'conflict-delete')) {
      for (const action of prepared) if (action.kind === 'conflict-delete') {
        for (const file of action.files) this._bind(s, file.physical, before.files.get(file.physical));
      }
      await this._save(s);
    }
    for (const action of prepared) {
      const { kind, path, entry, files, selected } = action;
      this.local.checkActive?.();
      if (kind === 'stale-keep') {
        if (!await this._decisionFileMatches(path, entry.hash)) { skip(kind, path, 'local-changed'); continue; }
        this.keep.add(path);
      } else if (kind === 'resolve') {
        try { await this._resolve(s, selected, before, result, entry); }
        catch (error) {
          if (!(error instanceof ConfirmationChanged)) throw error;
          skip(kind, path, 'local-or-review-changed'); continue;
        }
      } else {
        let applied = true;
        for (const file of files) {
          this.local.checkActive?.();
          const trashed = await callbacks.trash(file.physical, file.hash);
          if (trashed === true) result.trashedFiles++;
          this.local.invalidate?.(file.physical);
          if (trashed !== true || await this._read(file.physical) !== null) { applied = false; break; }
        }
        if (!applied) { skip(kind, path, 'local-changed'); continue; }
      }
      result.appliedDecisions++;
    }
  }

  * _batches(items) {
    const budget = this.local.transferBudget || 128 * 1024 * 1024;
    let batch = [], total = 0;
    for (const item of items) {
      if (batch.length && (batch.length >= this.concurrency || total + item.size > budget)) {
        yield batch; batch = []; total = 0;
      }
      batch.push(item); total += item.size;
      // A single oversized or unknown-size body reserves the whole channel.
      if (item.size > budget) { yield batch; batch = []; total = 0; }
    }
    if (batch.length) yield batch;
  }

  async _recognizeUnbound(s, before, physical, hash) {
    if (hash === null || isConflictPath(physical) || s.absent.has(physical)) return false;
    const history = before.byPath.get(physical);
    if (!history) return false;
    const remote = before.files.get(physical);
    if (remote && hash === remote.blob) {
      if (this._bind(s, physical, remote)) await this._checkpointProgress(s);
      return true;
    }
    const versions = before.versions.get(physical);
    const deleted = versions?.size === 1 && versions.has(null);
    if (deleted && this.keep.has(physical)) return false;
    const earlier = history.filter(revision => revision.blob === hash).map(revision => revision.id).sort();
    if (!earlier.length) return false;
    if (deleted) {
      // Lost local state is not consent to delete an unchanged historical copy,
      // nor evidence of a new edit. Keep it unbound until the user decides.
      this.nextStaleCopies.set(physical, { path: physical, hash, tips: [...before.tips.get(physical)] });
    } else if (this._bind(s, physical, { path: physical, blob: hash, parents: earlier })) {
      await this._checkpointProgress(s);
    }
    return true;
  }

  async _capture(s, before, result, deferred) {
    const changed = new Set([...this.dirty, ...this.keep]);
    // Pending copies have no file binding. Revisit them when the remote target
    // changes, but retain their UI entries on otherwise clean incremental polls.
    if (!this.full) for (const [physical, entry] of this.staleCopies) {
      if (!sameIds(entry.tips, before.tips.get(physical) || [])) changed.add(physical);
    }
    const listed = this.full ? await this.local.list() : [...changed];
    const paths = new Set(this.full ? [...listed, ...s.files.keys()] : listed);
    const sizes = new Map();
    const sizeOf = async name => {
      if (!sizes.has(name)) sizes.set(name, this.local.size ? await this.local.size(name) : undefined);
      const size = sizes.get(name);
      if (size !== undefined && size !== null && (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES)) throw new Error('Invalid or oversized local file: ' + name);
      return size;
    };
    // Validate all potential new names before publishing. Keep metadata only;
    // incremental batches of new files must not turn into a whole-vault readAhead.
    const provisional = [];
    for (const name of listed) {
      checkPhysical(name);
      if (!isConflictPath(name) && !before.files.has(name)) {
        if (!this.full) {
          const size = await sizeOf(name);
          if (size === null) continue;
          if (size === undefined) {
            const value = await this._read(name); checkSize(value, name);
            if (value === null) continue;
          }
        }
        provisional.push(makeRevision({ path: name, parents: [], blob: '0'.repeat(64), device: this.device }));
      }
    }
    if (provisional.length) project([...s.revs.values(), ...provisional]);
    const candidates = [];
    for (const physical of paths) {
      this.nextStaleCopies.delete(physical);
      const base = s.files.get(physical);
      if (base && this.local.hash && await this._observedHash(physical) === base.blob) continue;
      // Only history-bearing, unbound paths need this classification. Ordinary
      // initial uploads keep the original read path and accounting unchanged.
      if (!base && !isConflictPath(physical) && !s.absent.has(physical) && before.byPath.has(physical)) {
        const hash = await this._observedHash(physical);
        if (hash === null || await this._recognizeUnbound(s, before, physical, hash)) continue;
      }
      const size = await sizeOf(physical);
      candidates.push({ physical, base, size: size === undefined ? MAX_BYTES : size === null ? 0 : size });
    }
    for (const batch of this._batches(candidates)) {
      try {
        await parallel(batch, async row => {
          this.local.checkActive?.();
          row.data = await this._read(row.physical, row.size); checkSize(row.data, row.physical);
          if (row.data !== null && row.data.byteLength > row.size) throw new Error('Local file grew beyond reserved size: ' + row.physical);
          row.hash = await this._hash(row.data);
          this.observed.set(row.physical, row.hash);
        }, this.concurrency);
        const pushes = [];
        for (const row of batch) {
          const { physical, base, hash, data } = row;
          if (base) {
            if (hash !== base.blob) {
              if (s.splitJournal && this._rebindDescendant(s, before, physical, base, hash)) await this._checkpointProgress(s);
              else pushes.push({ ...row, path: base.path, parents: base.parents });
            }
          } else if (data !== null) {
            const remote = before.files.get(physical);
            if (remote && hash === remote.blob) {
              if (this._bind(s, physical, remote)) await this._checkpointProgress(s);
            } else if (isConflictPath(physical)) deferred.add(physical);
            else if (!await this._recognizeUnbound(s, before, physical, hash)) {
              const versions = before.versions.get(physical);
              const keepDeleted = this.keep.has(physical) && versions?.size === 1 && versions.has(null);
              pushes.push({ ...row, path: physical,
                parents: s.absent.get(physical) || (keepDeleted ? before.tips.get(physical) : []) });
            }
          }
        }
        // Content-addressed blobs are safe to pre-upload. Revision publication,
        // journals and acknowledgements below remain strictly serial.
        await parallel(pushes.filter(row => row.data !== null), async row => {
          this.local.checkActive?.();
          await this.remote.putBlob(row.hash, row.data);
        }, this.concurrency);
        for (const row of pushes) {
          this.local.checkActive?.();
          await this._push(s, row.physical, row.path, row.parents, row.data, result);
          row.data = null;
        }
      } finally {
        for (const row of batch) row.data = null;
      }
    }
    await this._save(s);
  }

  async _apply(s, nextView, result, deferred) {
    const paths = new Set([...nextView.files.keys(), ...s.files.keys()]);
    const plans = [];
    for (const physical of paths) {
      if (deferred.has(physical)) continue;
      const old = s.files.get(physical);
      const next = nextView.files.get(physical) || null;
      const expected = old?.blob ?? null;
      const wanted = next?.blob ?? null;
      // No local observation means no new ancestry acknowledgement either.
      if (!this.full && !this.dirty.has(physical) && expected === wanted) continue;
      const actual = await this._observedHash(physical);
      if (actual === wanted) {
        if (this._bind(s, physical, next)) await this._checkpointProgress(s);
        continue;
      }
      if (actual !== expected) { deferred.add(physical); continue; }
      const deletionIds = old && physical === old.path && nextView.versions.get(old.path)?.size === 1
        ? nextView.versions.get(old.path).get(null) : null;
      const absent = !next && deletionIds ? { path: old.path, parents: deletionIds } : null;
      const known = next?.parents || nextView.tips.get(old?.path) || [];
      plans.push({ physical, next, expected, wanted, absent, known, size: 0 });
    }
    // HEADs transfer metadata only, in the same bounded pool. The remote passes
    // each preflight to the subsequent GET instead of issuing another HEAD.
    await parallel(plans.filter(row => row.next), async row => {
      this.local.checkActive?.();
      const size = this.remote.getBlobSize ? await this.remote.getBlobSize(row.wanted) : null;
      if (size !== null && (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES)) throw new Error('Invalid remote blob size');
      row.size = size === null ? MAX_BYTES : size;
    }, this.concurrency);
    for (const batch of this._batches(plans)) {
      try {
        await parallel(batch, async row => {
          this.local.checkActive?.();
          row.data = row.next ? await this.remote.getBlob(row.wanted, row.size) : null;
          if (row.data !== null && row.data.byteLength > row.size) throw new Error('Downloaded content exceeds reserved size: ' + row.physical);
          if (await this._hash(row.data) !== row.wanted) throw new Error('Downloaded content checksum mismatch for ' + row.physical);
        }, this.concurrency);
        // All completed payloads stay charged to this batch until CAS and journal
        // acknowledgement finish. No next batch starts while these bytes are held.
        for (const row of batch) {
          const { physical, next, expected, wanted, absent, known, data } = row;
          this.local.checkActive?.();
          s.pending = { kind: 'apply', physical, next,
            ...(s.splitJournal && s.receiptSupported ? { absent, known } : {}) };
          await this._beginPending(s);
          const applied = await this.local.compareAndSet(physical, expected, data);
          if (applied) {
            this.observed.set(physical, wanted);
            this._bind(s, physical, next);
            if (absent) this._setAbsent(s, absent.path, absent.parents);
            await this._completeOperation(s, next, absent, known);
            if (next) result.downloaded++;
            else {
              result.deleted++; s.appliedDeletions.add(physical);
              this.local.directorySnapshot?.get(parentDirectory(physical))?.files.delete(physical);
            }
          } else {
            this.observed.delete(physical);
            deferred.add(physical); // An editor change after the scan must survive.
          }
          await this._finishPending(s);
          await this._checkpointProgress(s);
          row.data = null;
        }
      } finally {
        for (const row of batch) row.data = null;
      }
    }
    await this._save(s);
  }

  async _run(selected, options = {}) {
    try { return await this._runOnce(selected, options); }
    finally { this.remote.clearBlobPreflights?.(); }
  }

  async _pruneDirectories(s, view, deferred, result) {
    if (!this.local.pruneEmptyDirectories) return;
    const directories = new Set(), protectedDirectories = new Set();
    const parents = (name, target) => {
      for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) {
        target.add(name.slice(0, slash));
      }
    };
    // Desktop only prunes files actually removed by this round's successful
    // apply CAS. Local edits, old tombstones and crash recovery are not origins.
    // Keep the legacy mobile adapter's opt-in/test behavior unchanged.
    if (this.local.syncAppliedDirectoryCleanup) {
      for (const name of s.appliedDeletions) parents(name, directories);
    } else {
      for (const name of this.full ? s.absent.keys() : s.cleanupPaths) {
        const versions = view.versions.get(name);
        if (s.absent.has(name) && versions?.size === 1 && versions.has(null) && !deferred.has(name)) parents(name, directories);
      }
    }
    if (!directories.size) return;
    for (const names of [view.files.keys(), s.files.keys(), deferred, this.nextStaleCopies.keys()]) {
      for (const name of names) parents(name, protectedDirectories);
    }
    for (const dir of this.retainedDirectories()) {
      protectedDirectories.add(dir); parents(dir, protectedDirectories);
      for (const candidate of directories) if (candidate.startsWith(dir + '/')) protectedDirectories.add(candidate);
    }
    for (const dir of protectedDirectories) directories.delete(dir);
    if (directories.size) result.cleanedDirectories = await this.local.pruneEmptyDirectories(directories);
  }

  async _restoreStaged(s, tx) {
    const pending = s.pending, next = pending?.next;
    const base = s.files.get(tx.name);
    // Recreate only a downloaded payload authorized by the exact unfinished
    // apply journal, its old binding and checksum-validated remote revisions.
    if (pending?.kind !== 'apply' || pending.physical !== tx.name || !next ||
        next.blob !== tx.next || (base?.blob ?? null) !== tx.expected ||
        (base && base.path !== next.path) || s.completedOperations.has(pending.operationId) ||
        !Array.isArray(next.parents) || !next.parents.length || !next.parents.every(id => {
          const rev = s.revs.get(id);
          return rev && rev.path === next.path && rev.blob === tx.next;
        })) throw new Error('手机暂存记录与同步日志不一致；已停止自动恢复，请保留 local-state。');
    checkPhysical(tx.name); safePath(next.path);
    return this.remote.getBlob(tx.next);
  }

  async _runOnce(selected, options = {}) {
    const result = counts();
    const started = Date.now();
    this.stats = result.stats;
    this.observed = new Map();
    this.full = selected !== undefined || options.full !== false || options.deep === true;
    this.dirty = new Set(options.dirty || []);
    this.keep = new Set(options.keep || []);
    this.nextStaleCopies = this.full ? new Map() : new Map(this.staleCopies);
    result.stats.full = Number(this.full);
    this.local.stats = this.state.stats = result.stats;
    if (this.remote.setStats) this.remote.setStats(result.stats);
    else {
      this.remote.stats = result.stats;
      if (this.remote.request) this.remote.request.stats = result.stats;
    }
    await this.local.beginRound?.({ deep: options.deep === true });
    let s;
    await this.local.recover?.(async tx => {
      // Ordinary local crash recovery still works offline. Only a genuinely
      // missing staged payload needs the remote history and a fresh blob GET.
      s ||= await this._open();
      return this._restoreStaged(s, tx);
    });
    s ||= await this._open();
    await this._recover(s, result);
    // Finish an old embedded intent through its original durable snapshot path
    // before subsequent operations start using the independent pending file.
    if (s.legacyPending) { s.legacyPending = false; s.splitJournal = true; }
    const before = snapshot(s.revs);
    if (selected !== undefined) {
      await this._resolve(s, selected, before, result);
    }
    if (options.decisions) await this._confirm(s, before, options.decisions, options.decisionCallbacks || {}, result);
    const deferred = new Set();
    const captureView = selected === undefined && !options.decisions ? before : snapshot(s.revs);
    const capturedRevisionCount = s.revs.size;
    await this._capture(s, captureView, result, deferred);
    const after = s.revs.size === capturedRevisionCount ? captureView : snapshot(s.revs);
    await this._apply(s, after, result, deferred);
    const reviewed = new Map();
    for (const [path, versions] of after.versions) {
      if (!deferred.has(path)) {
        if (versions.size === 1 && versions.has(null)) {
          // A later local recreation acknowledges only deletions already observed here.
          const ids = versions.get(null);
          if (!this.full && !this.dirty.has(path) && sameIds(s.absent.get(path) || [], ids)) continue;
          if (await this._observedHash(path) === null) this._setAbsent(s, path, ids);
        } else if (s.files.has(path)) {
          this._setAbsent(s, path, null);
        }
      }
      if (versions.size > 1) {
        result.conflictPaths.push(path);
        reviewed.set(path, after.tips.get(path));
      }
    }
    for (const physical of deferred) {
      const path = after.files.get(physical)?.path ?? s.files.get(physical)?.path ?? physical;
      reviewed.delete(path);
    }
    if (s.reviewed.size !== reviewed.size || [...reviewed].some(([path, ids]) => !sameIds(s.reviewed.get(path) || [], ids))) {
      s.reviewed = reviewed; s.changed = true;
    }
    result.conflictPaths.sort();
    result.conflicts = result.conflictPaths.length;
    result.deferredPaths = [...deferred].sort();
    result.deferred = result.deferredPaths.length;
    await this._save(s);
    await this.local.flush?.();
    // File transactions, receipts and deletion baselines must be durable before
    // cosmetic directory cleanup. A failed cleanup is safe to retry in full.
    await this._pruneDirectories(s, after, deferred, result);
    result.directoryCleanupBlocked = !!this.local.directoryCleanupBlocked;
    for (const [path, entry] of this.nextStaleCopies) {
      const versions = after.versions.get(path);
      if (s.files.has(path) || versions?.size !== 1 || !versions.has(null)) this.nextStaleCopies.delete(path);
      else entry.tips = [...after.tips.get(path)];
    }
    this.staleCopies = this.nextStaleCopies;
    result.staleCopies = [...this.staleCopies.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map(entry => ({ path: entry.path, hash: entry.hash, tips: [...entry.tips] }));
    result.stalePaths = result.staleCopies.map(entry => entry.path);
    result.confirmations = this._confirmationGroups(s, after, result.staleCopies);
    this.directoryContext = { history: [...after.byPath.keys()],
      protectedPaths: [...after.files.keys(), ...s.files.keys(), ...deferred, ...this.staleCopies.keys(),
        ...(s.pending ? [s.pending.physical] : [])] };
    if (this.full) this.emptyDirectories = this._residualDirectories(this.local.directorySnapshot);
    result.emptyDirectories = this.emptyDirectories;
    result.stats.durationMs = Date.now() - started;
    return result;
  }

  _residualDirectories(records) {
    if (!this.directoryContext) return [];
    return residualDirectories(records, { ...this.directoryContext, retained: this.retainedDirectories(),
      allowDSStore: this.local.syncAppliedDirectoryCleanup === true });
  }
}

module.exports = { SyncEngine };
