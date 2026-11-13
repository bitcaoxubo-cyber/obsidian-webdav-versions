'use strict';

const parentDirectory = name => name.slice(0, Math.max(0, name.lastIndexOf('/')));
const underDirectory = (name, dir) => name === dir || name.startsWith(dir + '/');
function addParents(name, set) {
  for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) set.add(name.slice(0, slash));
}
function directoryRecord() { return { files: new Set(), folders: new Set(), blocked: false }; }
function forgetDirectory(records, dir) {
  if (!records) return;
  for (const name of records.keys()) if (underDirectory(name, dir)) records.delete(name);
  records.get(parentDirectory(dir))?.folders.delete(dir);
}

// Pure calculation over the directory entries already seen by list(). No I/O,
// persistent progress or remote directory objects are needed.
function residualDirectories(records, { history, protectedPaths = [], retained = [], allowDSStore = false }) {
  if (!records) return [];
  const historical = new Set(), protectedDirs = new Set(), eligible = new Map();
  for (const name of history) addParents(name, historical);
  for (const name of protectedPaths) { protectedDirs.add(name); addParents(name, protectedDirs); }
  for (const dir of retained) { protectedDirs.add(dir); addParents(dir, protectedDirs); }
  const ordered = [...records.keys()].filter(Boolean).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  for (const dir of ordered) {
    const record = records.get(dir);
    if (record.blocked || !historical.has(dir) || protectedDirs.has(dir) || retained.some(p => underDirectory(dir, p))) continue;
    let ds = false, blocked = false, count = 0;
    for (const file of record.files) {
      if (allowDSStore && file === dir + '/.DS_Store') ds = true;
      else { blocked = true; break; }
    }
    if (blocked) continue;
    for (const child of record.folders) {
      const e = eligible.get(child);
      if (!e) { blocked = true; break; }
      count += 1 + e.subdirectoryCount; ds ||= e.containsDSStore;
    }
    if (!blocked) eligible.set(dir, { path: dir, subdirectoryCount: count, containsDSStore: ds });
  }
  return [...eligible.values()].filter(e => !eligible.has(parentDirectory(e.path))).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
module.exports = { parentDirectory, underDirectory, addParents, directoryRecord, forgetDirectory, residualDirectories };
