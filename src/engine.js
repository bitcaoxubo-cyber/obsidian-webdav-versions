'use strict';

const { indexRevisions, isConflictPath, makeRevision, project, safePath, validateRevision } = require('./protocol');

const { base64, fromBase64, sha256, randomUUID } = require('./bytes');
const { parallel } = require('./sharded');

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
  constructor({ remote, local, state, device, concurrency = 4 }) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Transfer concurrency must be between 1 and 4');
    this.concurrency = concurrency;
    this.remote = remote;
    this.local = local;
    this.state = state;
    this.device = device;
    this.queue = Promise.resolve();
  }

  sync(options = {}) { return this._enqueue(() => this._run(undefined, options)); }
  resolve(physicalPath) { return this._enqueue(() => this._run(physicalPath)); }

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
      receiptSupported, receiptSequence, completedOperations: new Set(), receiptsNeedCleanup: false };
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

  async _capture(s, before, result, deferred) {
    const listed = this.full ? await this.local.list() : [...this.dirty];
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
      const base = s.files.get(physical);
      if (base && this.local.hash && await this._observedHash(physical) === base.blob) continue;
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
            else pushes.push({ ...row, path: physical, parents: s.absent.get(physical) || [] });
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
            else result.deleted++;
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

  async _runOnce(selected, options = {}) {
    const result = counts();
    const started = Date.now();
    this.stats = result.stats;
    this.observed = new Map();
    this.full = selected !== undefined || options.full !== false || options.deep === true;
    this.dirty = new Set(options.dirty || []);
    result.stats.full = Number(this.full);
    this.local.stats = this.state.stats = result.stats;
    if (this.remote.setStats) this.remote.setStats(result.stats);
    else {
      this.remote.stats = result.stats;
      if (this.remote.request) this.remote.request.stats = result.stats;
    }
    await this.local.beginRound?.({ deep: options.deep === true });
    await this.local.recover?.();
    const s = await this._open();
    await this._recover(s, result);
    // Finish an old embedded intent through its original durable snapshot path
    // before subsequent operations start using the independent pending file.
    if (s.legacyPending) { s.legacyPending = false; s.splitJournal = true; }
    const before = snapshot(s.revs);
    if (selected !== undefined) {
      await this._resolve(s, selected, before, result);
    }
    const deferred = new Set();
    const captureView = selected === undefined ? before : snapshot(s.revs);
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
    result.stats.durationMs = Date.now() - started;
    return result;
  }
}

module.exports = { SyncEngine };
