'use strict';
// Adapted from leopard530/obsidian-sync-webdav: onload commands, ribbon,
// status bar and debounced vault events. Every trigger now uses the same engine.
const { Plugin, PluginSettingTab, Setting, SecretComponent, Notice, Modal, Platform, requestUrl } = require('obsidian');
const { text } = require('./bytes');
const { MobileVault, MobileState, mobileRequest } = require('./mobile');
const { SyncEngine } = require('./engine');
const { SyncScheduler } = require('./scheduler');
const { AdaptiveDavRemote: DavRemote } = require('./sharded');

const defaults = { url: '', username: '', secret: '', device: Platform.isMobile ? (Platform.isIosApp ? 'iPhone' : 'Android') : require('node:os').hostname().split('.')[0], auto: false };
const activeVaults = Symbol.for('obsidian-webdav-versions.active');

class ResolveModal extends Modal {
  constructor(app, file, resolve) { super(app); this.file = file; this.resolve = resolve; }
  onOpen() {
    this.titleEl.setText('采用当前版本');
    this.contentEl.createEl('p', { text: '各设备将以「' + this.file + '」的已保存内容作为正文，其他已知冲突副本将从笔记列表收起。原版本仍保存在飞牛上。' });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText('取消').onClick(() => this.close()))
      .addButton(b => b.setCta().setButtonText('采用此版本').onClick(() => { this.close(); void this.resolve(); }));
  }
}

class ConflictsModal extends Modal {
  constructor(app, result) { super(app); this.result = result; }
  onOpen() {
    this.titleEl.setText('同步冲突');
    if (!this.result) { this.contentEl.createEl('p', { text: '先运行一次同步以读取当前冲突。' }); return; }
    const conflicts = this.result.conflictPaths || [];
    const deferred = this.result.deferredPaths || [];
    if (!conflicts.length && !deferred.length) this.contentEl.createEl('p', { text: '最近一次同步没有待处理的文件。' });
    else this.contentEl.createEl('p', { text: '先比较正文与同目录的 sync-conflict 副本。打开要保留的版本后，运行「采用当前文件解决冲突」。若冲突来自另一台设备的删除，列表中只有仍有内容的版本。' });
    for (const name of conflicts) {
      new Setting(this.contentEl).setName(name).addButton(b => b.setButtonText('打开正文').onClick(async () => {
        const file = this.app.vault.getAbstractFileByPath(name);
        if (file) { this.close(); await this.app.workspace.getLeaf(false).openFile(file); }
      }));
    }
    for (const name of deferred) this.contentEl.createEl('p', { text: '等待同步：' + name });
  }
}

class SyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    const p = this.plugin;
    const draft = { ...p.settings };
    new Setting(el).setName('飞牛 WebDAV 版本同步').setHeading();
    new Setting(el).setName('同步状态').setDesc(p.lastError || p.statusMessage || '就绪')
      .addButton(b => b.setButtonText('立即同步').onClick(async () => { await p.run('sync', true); this.display(); }))
      .addButton(b => b.setButtonText('查看详情').onClick(() => p.openStatus()));
    if (Platform.isMobile) el.createEl('p', { text: '手机测试版：单个文件最多 128 MiB；首次接入先使用独立测试库，保持应用在前台。' });
    new Setting(el).setName('WebDAV 文件夹地址').setDesc('填写各设备共用的专用文件夹的完整 HTTPS 地址。请先在飞牛中建好该文件夹。')
      .addText(t => t.setPlaceholder('https://nas.example/笔记同步/').setValue(draft.url).onChange(v => { draft.url = v.trim(); }));
    new Setting(el).setName('用户名').addText(t => t.setValue(draft.username).onChange(v => { draft.username = v.trim(); }));
    new Setting(el).setName('WebDAV 密码').setDesc('在本机 Obsidian 的密钥存储中选择或新建一个密码。')
      .addComponent(container => new SecretComponent(this.app, container).setValue(draft.secret).onChange(v => { draft.secret = v; }));
    new Setting(el).setName('设备名称').setDesc('用于辨认冲突副本，例如 iPhone、MacBook 或 Mac mini。')
      .addText(t => t.setValue(draft.device).onChange(v => { draft.device = v.trim(); }));
    new Setting(el).setName('自动同步').setDesc('首次与回到前台时全量同步；文件变更后手机等待 15 秒、桌面等待 5 秒。空闲轮询从 60 秒逐步延长至 300 秒，每 10 分钟全量检查。首次配置先手动同步，手机请等到已同步再离开。')
      .addToggle(t => t.setValue(draft.auto).onChange(v => { draft.auto = v; }));
    new Setting(el).addButton(b => b.setButtonText('测试连接').onClick(async () => {
      try { await p.remoteFor(draft).probe(); new Notice('已确认可读取 WebDAV 文件夹'); }
      catch (err) { new Notice('连接测试失败：' + err.message, 10000); }
    })).addButton(b => b.setButtonText('保存设置').setCta().onClick(async () => {
      try { await p.configure(draft); new Notice('已保存同步设置'); }
      catch (err) { new Notice(err.message, 10000); }
    }));
  }
}

module.exports = class WebDAVVersionsPlugin extends Plugin {
  async onload() {
    if (!this.app.secretStorage || !SecretComponent) throw new Error('请更新到 Obsidian 1.11.4 或更高版本。');
    this.settings = Object.assign({}, defaults, await this.loadData());
    this.stopped = false;
    this.ready = false;
    this.scheduler = new SyncScheduler({ mobile: Platform.isMobile,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: timer => window.clearTimeout(timer),
      run: () => this.autoSync(), enabled: () => this.ready && this.settings.auto && !this.stopped, active: () => this.isActive() });
    this.status = this.addStatusBarItem();
    this.showStatus('就绪');
    this.status.addEventListener('click', () => this.run('sync', true));
    this.addRibbonIcon('refresh-cw', '飞牛 WebDAV：立即同步', () => this.run('sync', true));
    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => this.run('sync', true) });
    this.addCommand({ id: 'sync-deep', name: '深度校验同步', callback: () => this.run('deep', true) });
    this.addCommand({ id: 'sync-status', name: '查看同步状态', callback: () => this.openStatus() });
    this.addCommand({ id: 'show-conflicts', name: '查看同步冲突', callback: () => new ConflictsModal(this.app, this.result).open() });
    this.addCommand({ id: 'resolve-current', name: '采用当前文件解决冲突', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return false;
      if (!checking) new ResolveModal(this.app, file.path, () => this.run('resolve', true, file.path)).open();
      return true;
    } });
    this.addSettingTab(new SyncSettings(this.app, this));

    for (const event of ['create', 'modify', 'rename', 'delete']) {
      this.registerEvent(this.app.vault.on(event, (file, previous) => {
        const paths = [file.path, ...(event === 'rename' && previous ? [previous] : [])].filter(path => this.visible(path));
        // A folder rename may have no per-file events; rescan its descendants.
        if (paths.length) this.scheduler.change(Array.isArray(file.children) ? [] : paths, { full: Array.isArray(file.children) });
      }));
    }
    this.registerDomEvent(window, 'online', () => { this.scheduler.resetPoll(); this.schedule(1000); });
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState !== 'hidden' && this.isActive()) this.scheduler.foreground();
      else if (Platform.isMobile) this.scheduler.pause();
    });
    this.app.workspace.onLayoutReady(() => { this.ready = true; this.scheduler.resetPoll(); this.schedule(1200); });
  }
  visible(name) {
    const parts = name.split('/');
    return parts[0] !== this.app.vault.configDir && parts.every(p => p && !p.startsWith('.'));
  }
  remoteFor(s) {
    if (!s.url || !s.username || !s.secret || !s.device) throw new Error('请先填写地址、用户名、密钥和设备名称。');
    if (s.device.length > 64 || /[\u0000-\u001f]/.test(s.device)) throw new Error('请使用简短的设备名称。');
    const password = this.app.secretStorage.getSecret(s.secret);
    if (!password) throw new Error('本机尚未配置所选 WebDAV 密码。');
    return new DavRemote({ url: s.url, username: s.username, password, ...(Platform.isMobile ? { request: mobileRequest(requestUrl, () => this.isActive()) } : {}) });
  }
  async configure(draft) {
    if (this.busy || this.configuring) throw new Error('请等当前操作完成再保存设置。');
    this.configuring = true;
    try {
      this.remoteFor(draft);
      await this.saveData({ ...draft });
      this.settings = { ...draft };
      this.engine = null;
      this.result = null;
      this.lastError = '';
      this.showStatus('就绪');
      this.scheduler.reset();
      this.schedule();
    } finally { this.configuring = false; }
  }
  editorMatches(name, bytes) {
    if (this.stopped) return false;
    // A buffer with unsaved typing may be newer than the filesystem snapshot.
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view.file?.path === name && view.getMode?.() === 'source' && view.editor) {
        if (!bytes || view.editor.getValue() !== text(bytes).replace(/\r\n/g, '\n')) return false;
      }
    }
    return true;
  }
  getEngine() {
    if (this.engine) return this.engine;
    const s = this.settings;
    const remote = this.remoteFor(s);
    const guard = (p, b) => this.editorMatches(p, b);
    let local, state;
    if (Platform.isMobile) {
      local = new MobileVault(this.app.vault.adapter, this.app.vault.configDir, guard, () => this.isActive());
      state = new MobileState(this.app.vault.adapter, local.privateDir, s.url, s.username);
    } else {
      const { DiskVault, DiskState } = require('./local');
      local = new DiskVault(this.app.vault.adapter.getBasePath(), this.app.vault.configDir, guard);
      state = new DiskState(local.privateDir, s.url, s.username);
    }
    this.engine = new SyncEngine({ remote, local, state, device: s.device });
    return this.engine;
  }
  schedule(delay) { this.scheduler.schedule(delay); }
  autoSync() { if (this.ready && this.settings.auto && this.isActive() && !this.busy) return this.run('sync', false); }
  isActive() { return !this.stopped && (!Platform.isMobile || document.visibilityState !== 'hidden'); }
  openStatus() {
    const modal = new Modal(this.app);
    modal.titleEl.setText('飞牛同步状态');
    modal.contentEl.createEl('p', { text: this.statusMessage || '就绪' });
    if (this.lastError) modal.contentEl.createEl('p', { text: this.lastError });
    if (this.result) {
      const r = this.result;
      modal.contentEl.createEl('p', { text: `最近一轮：上传 ${r.uploaded}，下载 ${r.downloaded}，删除 ${r.deleted}，冲突 ${r.conflicts}，待处理 ${r.deferred}。` });
    }
    if (this.result?.stats) {
      const s = this.result.stats;
      modal.contentEl.createEl('p', { text: `${s.full ? '全量' : '增量'}同步：耗时 ${s.durationMs} 毫秒，读取库内文件 ${s.vaultReads} 次，内容及状态哈希 ${s.hashBytes} 字节，HTTP 请求 ${s.httpRequests} 次。` });
    }
    modal.contentEl.createEl('p', { text: `当前轮询间隔：${this.scheduler.pollIntervalMs / 1000} 秒。` });
    new Setting(modal.contentEl).addButton(b => b.setButtonText('立即同步').onClick(async () => { modal.close(); await this.run('sync', true); this.openStatus(); }));
    modal.open();
  }
  showStatus(message) {
    this.statusMessage = message;
    this.status.setText('WebDAV · ' + message);
    this.status.setAttribute('aria-label', this.lastError || message);
  }
  async run(mode, notify, file) {
    if (!this.isActive() || !this.ready || this.configuring) return;
    const lock = globalThis[activeVaults] ||= new Set();
    const key = this.app.vault.adapter;
    if (lock.has(key)) { if (notify) new Notice('正在同步，请等待完成'); return; }
    lock.add(key);
    this.busy = true;
    const ticket = this.scheduler.begin({ manual: notify, deep: mode === 'deep', resolve: mode === 'resolve' });
    try {
      this.showStatus('同步中');
      if (this.app.plugins?.enabledPlugins?.has('obsidian-sync-webdav')) throw new Error('请先停用旧版 WebDAV Sync，再运行版本同步。');
      const engine = this.getEngine();
      if (mode === 'resolve' && !this.editorMatches(file, await engine.local.read(file))) {
        throw new Error('这篇笔记还有正在保存的修改，请稍后再采用此版本。');
      }
      const r = mode === 'resolve' ? await engine.resolve(file) : await engine.sync({ full: ticket.full, dirty: ticket.dirty, deep: ticket.deep });
      this.scheduler.complete(ticket, r);
      if (r.stats) r.stats.pollIntervalMs = this.scheduler.pollIntervalMs;
      this.result = r;
      this.lastError = '';
      const message = r.deferred ? '有更改待下轮同步' : r.conflicts ? '有 ' + r.conflicts + ' 组冲突' : '已同步';
      if (!this.stopped) this.showStatus(message);
      if (notify && !this.stopped) new Notice(message);
    } catch (err) {
      this.scheduler.fail(ticket);
      if (this.stopped) return;
      const message = String(err.message || err);
      if (notify || this.lastError !== message) new Notice('WebDAV：' + message, 10000);
      this.lastError = message;
      this.showStatus('同步暂停');
    } finally { this.busy = false; lock.delete(key); }
  }
  onunload() {
    this.stopped = true;
    this.scheduler.stop();
  }
};
