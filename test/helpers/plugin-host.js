'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { bytes, digest, text } = require('../../src/bytes');
const manifest = require('../../manifest.json');

function result(groups = {}) {
  return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferred: 0,
    conflictPaths: [], deferredPaths: [], confirmations: { staleCopies: [], deletionConflicts: [], staleConflicts: [], ...groups },
    stats: { durationMs: 1, vaultReads: 0, hashBytes: 0, httpRequests: 1, full: 1 } };
}
const stale = name => ({ path: name, hash: digest('old'), tips: ['deleted-' + name] });

async function host({ mobile = true } = {}) {
  const notices = [], modals = [], commands = new Map(), settingTabs = [], timers = [], fileObjects = new Map(), trashed = new Map();
  let fileClock = 1;
  class FileMap extends Map {
    set(name, data) {
      const file = fileObjects.get(name) || { path: name, stat: { ctime: fileClock } };
      file.stat = { ctime: file.stat.ctime, mtime: ++fileClock, size: data.byteLength };
      fileObjects.set(name, file); return super.set(name, data);
    }
    delete(name) { fileObjects.delete(name); return super.delete(name); }
  }
  const files = new FileMap();
  class Element {
    constructor() { this.empty(); }
    empty() { this.settings = []; this.texts = []; }
    createEl(tag, options) { this.texts.push(options.text); return new Element(); }
    setText(value) { this.text = value; }
    setAttribute() {} addEventListener() {}
  }
  class Setting {
    constructor(el) { el.settings.push(this); this.buttons = []; }
    setName(name) { this.name = name; return this; }
    setDesc(desc) { this.desc = desc; return this; }
    setHeading() { return this; }
    addButton(callback) {
      const b = { setButtonText(label) { this.label = label; return this; }, setCta() { return this; },
        onClick(fn) { this.click = fn; return this; } };
      callback(b); this.buttons.push(b); return this;
    }
    addText(callback) { callback({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
    addToggle(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
    addComponent(callback) { callback(new Element()); return this; }
  }
  class Modal {
    constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element(); this.opened = false; }
    open() { this.opened = true; modals.push(this); this.onOpen?.(); }
    close() { this.opened = false; this.onClose?.(); }
  }
  class Plugin {
    async loadData() { return { url: 'https://example.test/vault/', username: 'u', secret: 'key', device: 'test', auto: true }; }
    async saveData() {} addStatusBarItem() { return new Element(); } addRibbonIcon() {}
    addCommand(c) { commands.set(c.id, c); } addSettingTab(s) { settingTabs.push(s); }
    registerEvent() {} registerDomEvent() {}
  }
  const api = { Plugin, Modal, Setting,
    PluginSettingTab: class { constructor(app) { this.app = app; this.containerEl = new Element(); } },
    SecretComponent: class { setValue() { return this; } onChange() { return this; } },
    Notice: class { constructor(message) { notices.push(message); } },
    Platform: { isMobile: mobile, isIosApp: mobile }, requestUrl() { throw new Error('Unexpected network access'); } };
  const document = { visibilityState: 'visible' };
  const context = vm.createContext({ module: { exports: {} }, require(name) { if (name === 'obsidian') return api; if (!mobile && name === 'node:os') return { hostname: () => 'test-host' }; throw new Error(name); },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView, URL, structuredClone, btoa, atob,
    document, window: { setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8'), context);
  const p = new context.module.exports(); p.manifest = manifest;
  let trashOption = 'local', leaves = [], outcome = result(), syncCalls = 0, confirmCalls = 0;
  const callbacks = [], received = [];
  p.app = { secretStorage: { getSecret: () => 'secret' },
    vault: { configDir: '.obsidian', adapter: {}, on() { return {}; }, getConfig: () => trashOption,
      getAbstractFileByPath(name) { return fileObjects.get(name) || null; } },
    fileManager: { async trashFile(file) { trashed.set(file.path, files.get(file.path)); files.delete(file.path); } },
    workspace: { onLayoutReady(f) { f(); }, getLeavesOfType: () => leaves, getLeaf: () => ({ openFile: async () => {} }) },
    plugins: { enabledPlugins: new Set() } };
  await p.onload();
  const engine = { local: { read: async name => files.get(name) || null, invalidate() {} },
    async sync() { syncCalls++; return structuredClone(outcome); },
    async confirm(actions, hooks) { confirmCalls++; received.push(actions); callbacks.push(hooks); return { ...result(), appliedDecisions: actions.length, skippedDecisions: [] }; } };
  p.engine = engine;
  return { p, files, trashed, notices, modals, commands, settingTabs, document, engine, received, callbacks,
    setResult(r) { outcome = r; }, setTrash(value) { trashOption = value; }, setLeaves(value) { leaves = value; },
    get syncCalls() { return syncCalls; }, get confirmCalls() { return confirmCalls; } };
}
function button(modal, label) {
  const found = modal.contentEl.settings.flatMap(s => s.buttons).filter(b => b.label === label);
  assert.equal(found.length, 1, label); return found[0];
}

module.exports = { host, result, stale, button };
