'use strict';

const { DiskState } = require('../src/local');
const { safePath, validateRevision } = require('../src/protocol');
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

// Read only the adapter's existing durable records. This module never repairs
// notes, changes engine state or contacts WebDAV. SyncEngine remains responsible
// for validating these ancestry references against the remote revision graph.
class Recovery {
  constructor(config) { this.state = new DiskState(config.stateDir, config.url, config.username); }

  async read() {
    let disk, receipts, pending;
    try {
      disk = await this.state.load();
      if (disk !== null) {
        if (!object(disk) || disk.version !== 1 || !Array.isArray(disk.files) || !Array.isArray(disk.reviewed)) invalid();
        const known = new Set(ids(disk.known, false));
        pairs(disk.files, ([name, value]) => { binding(value, known); return [physical(name), value]; });
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
      return { statePresent: disk !== null, checkpoint: disk === null && receipts.length === 0 ? null : { receiptSequence: currentSequence, absent: [...absent].sort(([a], [b]) => compare(a, b)) }, receipts, pending };
    } catch { invalid(); }
  }

  async deletedSince(checkpoint) {
    if (!validateCheckpoint(checkpoint)) invalid();
    const current = await this.read();
    if (checkpoint !== null && (!current.statePresent || current.checkpoint === null || current.checkpoint.receiptSequence < checkpoint.receiptSequence)) invalid();
    const prior = new Map(checkpoint?.absent || []), deleted = new Set();
    const freshAbsent = absent => JSON.stringify(prior.get(logical(absent.path)) || null) !== JSON.stringify(ids(absent.parents));
    for (const [name, parents] of current.checkpoint?.absent || []) if (freshAbsent({ path: name, parents })) deleted.add(name);
    for (const { sequence, entry } of current.receipts) {
      if (sequence <= (checkpoint?.receiptSequence ?? 0) || entry.kind !== 'apply' || entry.next !== null) continue;
      if (entry.absent === null || freshAbsent(entry.absent)) deleted.add(physical(entry.physical));
    }
    const pending = current.pending;
    if (pending?.kind === 'apply' && pending.next === null && (pending.absent === null || freshAbsent(pending.absent))) deleted.add(physical(pending.physical));
    return deleted;
  }

  async checkpoint() {
    const current = await this.read();
    if (current.pending !== null) invalid();
    return current.checkpoint;
  }
}

module.exports = { Recovery, validateCheckpoint };
