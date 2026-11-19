'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DiskState } = require('../src/local');
const { safePath, validateRevision, indexRevisions } = require('../src/protocol');
const HASH = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const invalid = () => { throw new Error('同步恢复记录缺失、损坏或与删除保护清单不一致；请保留 state/ 并按文档处理'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function ids(value, nonempty = true) {
  if (!Array.isArray(value) || (nonempty && !value.length) || !value.every(id => typeof id === 'string' && HASH.test(id)) || new Set(value).size !== value.length) invalid();
  return [...value].sort(compare);
}
function logical(name) {
  try { safePath(name); } catch { invalid(); }
  return name.normalize('NFC');
}
function physical(name) {
  if (typeof name !== 'string') invalid();
  try { safePath(name.replace(/ \(sync-conflict /giu, ' (reserved ')); } catch { invalid(); }
  return name.normalize('NFC');
}
function pairs(value, check) {
  if (!Array.isArray(value)) invalid();
  const map = new Map();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2) invalid();
    const [name, content] = check(row);
    if (map.has(name)) invalid();
    map.set(name, content);
  }
  return map;
}
function absentPairs(value) {
  return pairs(value, ([name, parents]) => [logical(name), ids(parents)]);
}
function references(parents, known) {
  const result = ids(parents);
  if (known && !result.every(id => known.has(id))) invalid();
  return result;
}
function binding(value, known) {
  if (!object(value) || typeof value.blob !== 'string' || !HASH.test(value.blob)) invalid();
  logical(value.path); references(value.parents, known);
}
function watermark(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function validateCheckpoint(value) {
  if (value === null) return true;
  try {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'absent,receiptSequence') return false;
    watermark(value.receiptSequence);
    const absent = [...absentPairs(value.absent)].sort(([a], [b]) => compare(a, b));
    return JSON.stringify(absent) === JSON.stringify(value.absent);
  } catch { return false; }
}
function operation(entry) {
  if (!object(entry) || !['push', 'apply'].includes(entry.kind) || typeof entry.operationId !== 'string' || !entry.operationId.length) invalid();
  physical(entry.physical);
  const known = new Set(ids(entry.known));
  if (entry.next !== null) binding(entry.next, known);
  if (entry.absent !== null) {
    if (!object(entry.absent) || entry.next !== null || logical(entry.absent.path) !== physical(entry.physical)) invalid();
    references(entry.absent.parents, known);
  }
  return entry;
}

// Gate and approval calculations only read local state. The lock-owning runner
// separately calls reconcileDeletion after the gate, before engine recovery.
class Recovery {
  constructor(config) {
    this.state = new DiskState(config.stateDir, config.url, config.username);
    this.proofFile = path.join(config.stateDir, 'last-applied-delete.json');
  }

  pendingApplyDeleted(pending) {
    // An old journal is also counted unless the surviving transaction or its
    // matching proof shows that the engine actually moved this inode.
    let proof;
    try { proof = JSON.parse(fs.readFileSync(this.proofFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; invalid(); }
    if (typeof proof?.operationId !== 'string' || typeof proof.physical !== 'string') invalid();
    return proof.operationId === pending.operationId && proof.physical === pending.physical;
  }

  async read(since) {
    let disk, receipts, pending;
    let bound = new Map();
    try {
      disk = await this.state.load();
      if (disk !== null) {
        if (!object(disk) || disk.version !== 1 || !Array.isArray(disk.files) || !Array.isArray(disk.reviewed)) invalid();
        const known = new Set(ids(disk.known, false));
        bound = pairs(disk.files, ([name, value]) => { binding(value, known); return [physical(name), value]; });
        pairs(disk.reviewed, ([name, parents]) => [logical(name), references(parents, known)]);
        for (const [, parents] of absentPairs(disk.absent)) references(parents, known);
        if (disk.pending !== null) invalid(); // New headless instances never use legacy embedded journals.
      }
      const sequence = watermark(disk?.receiptSequence ?? 0);
      receipts = await this.state.loadReceipts(sequence);
      pending = await this.state.loadPending();
      const absent = absentPairs(disk?.absent || []);
      let currentSequence = sequence;
      const completed = new Set();
      for (const row of receipts) {
        if (row.sequence !== ++currentSequence) invalid();
        const entry = operation(row.entry);
        if (completed.has(entry.operationId)) invalid();
        completed.add(entry.operationId);
        if (entry.next) bound.set(physical(entry.physical), entry.next);
        else bound.delete(physical(entry.physical));
        if (entry.absent) absent.set(logical(entry.absent.path), ids(entry.absent.parents));
        else if (entry.next && physical(entry.physical) === logical(entry.next.path)) absent.delete(logical(entry.next.path));
      }
      // Push pending records have a different shape; they are never deletion
      // exemptions. Apply records use the same next/absent/known fields as receipts.
      if (pending !== null) {
        if (!object(pending) || !['push', 'apply'].includes(pending.kind)) invalid();
        if (pending.kind === 'apply') operation(pending);
        else {
          physical(pending.physical); validateRevision(pending.rev);
          if (typeof pending.operationId !== 'string' || !pending.operationId.length ||
              (pending.staged !== undefined && pending.staged !== true) ||
              (pending.bytes !== undefined && typeof pending.bytes !== 'string')) invalid();
        }
      }
      let retained = receipts;
      if (since !== undefined && sequence > since) {
        // The engine checkpoints before the NAS gate. A conflict copy can be
        // removed with no logical tombstone, so retain its physical receipt
        // across this window. Upgraded vaults may lack an old compacted prefix.
        const first = this.state.receiptFiles().find(row => row.sequence > since);
        if (first && first.sequence <= sequence) retained = await this.state.loadReceipts(first.sequence - 1);
      }
      const compactedPending = pending && retained.some(row => row.sequence <= sequence && row.entry.operationId === pending.operationId);
      if (compactedPending) completed.add(pending.operationId);
      const checkpoint = disk === null && !receipts.length ? null : {
        receiptSequence: currentSequence, absent: [...absent].sort(([a], [b]) => compare(a, b)),
      };
      return { bound, disk, completed, compactedPending, statePresent: disk !== null, checkpoint, receipts, retained, pending };
    } catch { invalid(); }
  }

  async deletedSince(checkpoint, records) {
    if (!validateCheckpoint(checkpoint)) invalid();
    const since = checkpoint?.receiptSequence ?? 0;
    const current = records || await this.read(since);
    if (checkpoint !== null && (!current.statePresent || current.checkpoint === null || current.checkpoint.receiptSequence < checkpoint.receiptSequence)) invalid();
    const prior = new Map(checkpoint?.absent || []), deleted = new Set();
    const freshAbsent = absent => JSON.stringify(prior.get(logical(absent.path)) || null) !== JSON.stringify(ids(absent.parents));
    for (const [name, parents] of current.checkpoint?.absent || []) if (freshAbsent({ path: name, parents })) deleted.add(name);
    for (const { sequence, entry } of current.retained) {
      operation(entry);
      if (sequence <= since) continue;
      if (entry.next) { deleted.delete(physical(entry.physical)); continue; }
      if (entry.kind !== 'apply') continue;
      if (entry.absent === null || freshAbsent(entry.absent)) deleted.add(physical(entry.physical));
    }
    // A later receipt can recreate the same physical file. Its next disappearance
    // must not inherit an exemption from an earlier operation.
    for (const name of current.bound.keys()) deleted.delete(name);
    const pending = current.pending;
    if (!current.completed.has(pending?.operationId) && pending?.kind === 'apply' && pending.next === null && (pending.absent === null || freshAbsent(pending.absent)) && this.pendingApplyDeleted(pending)) deleted.add(physical(pending.physical));
    return deleted;
  }

  // Called only by the lock owner after the local gate has passed. A pending
  // push bypasses local reads in SyncEngine._recover, so reconcile its immutable
  // revision before handing the journal back to the ordinary recovery path.
  async reconcileDeletion(records, allowed, remote) {
    const pending = records?.pending;
    if (pending?.kind !== 'push' || pending.rev.blob !== null) return;
    if (records.compactedPending) {
      // _open may have checkpointed this receipt just before another process
      // interruption. Its binding is durable; only the stale intent remains.
      await this.state.clearPending();
      return;
    }
    if (records.completed.has(pending.operationId)) return;
    const { rev, operationId } = pending;
    const name = physical(pending.physical);
    const { byId } = indexRevisions(await remote.listRevisions());
    for (const id of records.disk?.known || []) if (!byId.has(id)) invalid();
    for (const { entry } of records.receipts) for (const id of entry.known) if (!byId.has(id)) invalid();
    if (!rev.parents.length || rev.parents.some(id => byId.get(id)?.path !== rev.path)) invalid();

    if (byId.has(rev.id)) {
      // The server already has this exact content-addressed deletion. Record the
      // same completion as a successful push, without issuing another write.
      // Keeping pending until the engine clears it makes a crash here retryable.
      const absent = pending.physical === rev.path ? { path: rev.path, parents: [rev.id] } : null;
      await this.state.saveReceipt({ operationId, kind: 'push', physical: pending.physical, next: null, absent, known: [rev.id] });
    } else if (!allowed.has(name)) {
      // No remote commit to acknowledge and this round did not authorize it.
      // Its pre-push binding is still intact; capture the restored file normally.
      await this.state.clearPending();
    }
  }

  async checkpoint() {
    const current = await this.read();
    if (current.pending !== null) invalid();
    return current.checkpoint;
  }
}

module.exports = { Recovery, validateCheckpoint };
