'use strict';

const { digest, randomUUID, byteLength } = require('./bytes');

const HASH = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SURROGATE = /[\uD800-\uDFFF]/u; // With /u, valid pairs are a single non-surrogate code point.
const CONFLICT = / \(sync-conflict /iu;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function isConflictPath(path) {
  return typeof path === 'string' && CONFLICT.test(path);
}

function safePath(path) {
  if (typeof path !== 'string' || !path || CONTROL.test(path) || SURROGATE.test(path) ||
      path.includes('\\') || /^[A-Za-z]:/u.test(path) || isConflictPath(path) || byteLength(path) > 4095) {
    throw new Error('Unsafe or reserved vault path: ' + JSON.stringify(path));
  }
  for (const part of path.split('/')) {
    if (!part || part.startsWith('.') || /[. ]$/u.test(part) || byteLength(part) > 255) {
      throw new Error('Unsafe vault path segment: ' + JSON.stringify(path));
    }
  }
  return path;
}

function checkText(value, name, maxBytes) {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value) ||
      SURROGATE.test(value) || byteLength(value) > maxBytes) {
    throw new Error('Invalid revision ' + name);
  }
}

function revisionId({ path, parents, blob, device, nonce }) {
  return digest(JSON.stringify(['obsidian-webdav-versions/v1', path, parents, blob, device, nonce]));
}

function validateRevision(rev) {
  if (!rev || typeof rev !== 'object' || Array.isArray(rev) ||
      Object.keys(rev).sort().join(',') !== 'blob,device,id,nonce,parents,path') {
    throw new Error('Invalid revision fields');
  }
  safePath(rev.path);
  checkText(rev.device, 'device', 256);
  checkText(rev.nonce, 'nonce', 256);
  if (!(rev.blob === null || (typeof rev.blob === 'string' && HASH.test(rev.blob)))) {
    throw new Error('Invalid revision blob digest');
  }
  if (!Array.isArray(rev.parents)) throw new Error('Invalid revision parents');
  for (let i = 0; i < rev.parents.length; i++) {
    const p = rev.parents[i];
    if (typeof p !== 'string' || !HASH.test(p) || (i > 0 && p <= rev.parents[i - 1])) {
      throw new Error('Invalid revision parent digest or ordering');
    }
  }
  if (rev.id !== revisionId(rev)) throw new Error('Revision checksum mismatch');
  return rev;
}

function makeRevision({ path, parents = [], blob, device, nonce = randomUUID() }) {
  if (!Array.isArray(parents)) throw new Error('Invalid revision parents');
  const rev = { path, parents: [...new Set(parents)].sort(compare), blob, device, nonce };
  rev.id = revisionId(rev);
  return validateRevision(rev);
}

function indexRevisions(revisions) {
  const byId = new Map();
  const leaves = new Map();
  for (const rev of revisions) {
    validateRevision(rev);
    if (byId.has(rev.id)) continue;
    byId.set(rev.id, rev);
    if (!leaves.has(rev.path)) leaves.set(rev.path, new Set());
    leaves.get(rev.path).add(rev.id);
  }
  for (const rev of byId.values()) {
    for (const parent of rev.parents) {
      const base = byId.get(parent);
      if (!base) throw new Error('Missing parent revision: ' + parent);
      if (base.path !== rev.path) throw new Error('Parent belongs to a different logical path');
      leaves.get(rev.path).delete(parent);
    }
  }
  return { byId, leaves };
}

function headsFor(revisions, path) {
  safePath(path);
  // Filter before hashing: callers often ask about each locally modified file.
  const samePath = [];
  for (const rev of revisions) if (rev.path === path) samePath.push(rev);
  const { leaves } = indexRevisions(samePath);
  return [...(leaves.get(path) || [])].sort(compare);
}

function truncate(text, maxBytes) {
  let bytes = 0;
  let result = '';
  for (const ch of text) {
    bytes += byteLength(ch);
    if (bytes > maxBytes) break;
    result += ch;
  }
  return result;
}

function conflictName(path, rev) {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const label = truncate(rev.device.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-'), 28) || 'device';
  const suffix = ' (sync-conflict ' + label + ' ' + rev.id + ')' + extension;
  const budget = 255 - byteLength(suffix);
  const shortStem = truncate(stem, budget);
  if (!shortStem) throw new Error('Cannot represent a conflict filename for ' + path);
  const sibling = path.slice(0, slash + 1) + shortStem + suffix;
  if (byteLength(sibling) > 4095) throw new Error('Conflict path exceeds the supported length: ' + path);
  return sibling;
}

function folded(part) {
  // Conservative comparison for case-insensitive macOS volumes and decomposed Unicode.
  return part.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
}

function registerPath(used, path) {
  let spelling = '';
  let key = '';
  const pieces = path.split('/');
  for (const [i, part] of pieces.entries()) {
    spelling += '/' + part;
    key += '/' + folded(part);
    const directory = i + 1 < pieces.length;
    const prior = used.get(key);
    if (prior && (!directory || !prior.directory || prior.spelling !== spelling)) {
      throw new Error('Vault path collision: ' + prior.spelling.slice(1) + ' / ' + path);
    }
    used.set(key, { spelling, directory });
  }
}

function project(revisions) {
  const { byId, leaves } = indexRevisions(revisions);
  const used = new Map();
  const result = new Map();
  for (const path of [...leaves.keys()].sort(compare)) {
    const displayed = new Set();
    for (const id of [...leaves.get(path)].sort(compare)) {
      const rev = byId.get(id);
      // Keep tombstones and equal-content branches in the DAG, not as extra files.
      if (rev.blob === null || displayed.has(rev.blob)) continue;
      const conflict = displayed.size > 0;
      const physical = conflict ? conflictName(path, rev) : path;
      registerPath(used, physical);
      result.set(physical, { path, id, blob: rev.blob, conflict });
      displayed.add(rev.blob);
    }
  }
  return result;
}

module.exports = { makeRevision, validateRevision, digest, project, headsFor, safePath, isConflictPath };
