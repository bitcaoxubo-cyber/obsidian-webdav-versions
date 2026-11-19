'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('./io');
const { scanVault } = require('./gates');
const { DiskState, DiskVault } = require('../src/local');

class LateDisappearance extends Error {
  constructor() { super('检查之后又有文件消失，本轮已中止；下一轮将重新检查。'); }
}

class GuardedVault extends DiskVault {
  startGate(gate) {
    this.present = new Set(gate.snapshot.files.map(file => file.path.normalize('NFC')));
    this.allowed = gate.allowed;
    this.pending = gate.records?.pending;
    this.witness = this.present.values().next().value;
  }

  observe(name, value) {
    const key = name.normalize('NFC');
    if (value === null) {
      if (this.present.has(key)) throw new LateDisappearance();
    } else {
      this.present.add(key);
      this.allowed.delete(key);
    }
    return value;
  }

  async read(name, limit) { return this.observe(name, await super.read(name, limit)); }
  async size(name) { return this.observe(name, await super.size(name)); }
  async hash(name) {
    try { return this.observe(name, await super.hash(name)); }
    catch (error) {
      // A stream can lose its source between lstat and open, or at the final
      // post-hash stat. Distinguish disappearance from an ordinary I/O error.
      if (!(error instanceof LateDisappearance) && this.present.has(name.normalize('NFC')) && await super.size(name) === null) throw new LateDisappearance();
      throw error;
    }
  }
  async list() {
    try { return await super.list(); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new LateDisappearance();
      throw error;
    }
  }

  finishTransaction() {
    if (this.pending?.kind === 'apply' && this.pending.next === null) {
      const old = this.readFile(path.join(this.transaction, 'previous'));
      if (old !== null) {
        const tx = JSON.parse(this.readFile(path.join(this.transaction, 'intent.json')));
        if (tx.name === this.pending.physical && tx.next === null && this.hashOf(old) === tx.expected) {
          // Record proof while the original inode is still in the transaction.
          // If killed earlier, recover() calls us again before disposing of it.
          atomicJson(path.join(this.privateDir, 'last-applied-delete.json'), { operationId: this.pending.operationId, physical: tx.name });
        }
      }
    }
    super.finishTransaction();
  }

  async compareAndSet(name, expected, next) {
    let priorWitness;
    if (expected === null && next !== null && this.present.size) {
      // A new download would hide an externally emptied vault from the next
      // scan. Usually one previously seen file witnesses that it is nonempty.
      // A move or an unrelated external addition is also a valid witness.
      if (!this.witness || !fs.statSync(this.filePath(this.witness), { throwIfNoEntry: false })?.isFile()) {
        this.witness = scanVault(this.root).files[0]?.path;
        if (!this.witness) throw new LateDisappearance();
      }
      priorWitness = this.witness;
    }
    const done = await super.compareAndSet(name, expected, next);
    if (done) {
      if (priorWitness && !fs.statSync(this.filePath(priorWitness), { throwIfNoEntry: false })?.isFile() &&
          scanVault(this.root).files.every(file => file.path === name)) {
        // The last witness disappeared across the hard link. Leave the pending
        // apply intact: the next gate can recognize the sole new download even
        // after process death, until a restore or approval resolves the wipe.
        throw new LateDisappearance();
      }
      const key = name.normalize('NFC');
      if (next === null) this.present.delete(key);
      else {
        this.present.add(key);
        this.witness = key;
      }
      this.allowed.delete(key);
    }
    return done;
  }
}

class GuardedState extends DiskState {
  constructor(directory, url, username, local) {
    super(directory, url, username);
    this.local = local;
  }
  async savePending(entry) {
    if (entry.kind === 'apply' && entry.next && this.local.present.size && !this.local.present.has(entry.physical.normalize('NFC'))) {
      entry = { ...entry, checkMaskedWipe: true };
    }
    this.local.pending = entry;
    if (entry.kind === 'push' && entry.rev.blob === null && !this.local.allowed.delete(entry.physical.normalize('NFC'))) {
      // Check the physical source, including generated conflict names, before
      // the engine can persist a new tombstone intent and submit its revision.
      throw new LateDisappearance();
    }
    return super.savePending(entry);
  }

  // The engine has compacted these receipts into its main state. Keep their
  // physical-path evidence until the NAS gate has durably advanced as well.
  async clearReceipts(through) { this.compactedThrough = through; }
  async finishRound() {
    if (this.compactedThrough !== undefined) await super.clearReceipts(this.compactedThrough);
  }
}

module.exports = { GuardedVault, GuardedState, LateDisappearance };
