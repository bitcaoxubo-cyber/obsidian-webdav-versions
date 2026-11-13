'use strict';
// Adapted from leopard530/obsidian-sync-webdav: onload commands, ribbon,
// status bar and debounced vault events. Every trigger now uses the same engine.
const { Plugin, PluginSettingTab, Setting, SecretComponent, Notice, Modal, Platform, requestUrl } = require('obsidian');
const { text, sha256 } = require('./bytes');
const { MobileVault, MobileState, mobileRequest } = require('./mobile');
const { SyncEngine } = require('./engine');
const { SyncScheduler } = require('./scheduler');
const { AdaptiveDavRemote: DavRemote } = require('./sharded');
const { assertRecoverableTrash } = require('./deletion');
const { underDirectory } = require('./directories');
const { createConfirmationModal, confirmationKeys, confirmationCount } = require('./confirmations');
const ConfirmationModal = createConfirmationModal({ Modal, Notice, Setting });

const defaults = { url: '', username: '', secret: '', device: Platform.isMobile ? (Platform.isIosApp ? 'iPhone' : 'Android') : require('node:os').hostname().split('.')[0], auto: false, retainedEmptyDirectories: [] };
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

class SyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    const p = this.plugin;
    const draft = { ...p.settings };
    new Setting(el).setName('飞牛 WebDAV 版本同步 · ' + p.manifest.version)
      .setDesc('更新请用 BRAT 或覆盖 main.js 与 manifest.json，不要卸载重装').setHeading();
    new Setting(el).setName('同步状态').setDesc(p.lastError || p.statusMessage || '就绪')
      .addButton(b => b.setButtonText('立即同步').onClick(async () => { await p.run('sync', true); this.display(); }))
      .addButton(b => b.setButtonText('查看详情').onClick(() => p.openStatus()));
    new Setting(el).setName(`已保留 ${p.settings.retainedEmptyDirectories.length} 个空文件夹`)
      .setDesc('仅本机生效。重置后，下次全量同步会重新识别。')
      .addButton(b => b.setButtonText('重置').onClick(async () => {
        if (await p.saveRetainedDirectories([], true)) this.display();
      }));
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
    this.settings.retainedEmptyDirectories = this.validRetainedDirectories(this.settings.retainedEmptyDirectories);
    this.directoryTokens = new Set();
    this.stopped = false;
    this.ready = false;
    this.confirmationModal = null;
    this.lastPromptKeys = new Set();
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
    this.addCommand({ id: 'show-conflicts', name: '查看同步冲突', callback: () => this.openConfirmations() });
    this.addCommand({ id: 'resolve-current', name: '采用当前文件解决冲突', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return false;
      if (!checking) new ResolveModal(this.app, file.path, () => this.run('resolve', true, file.path)).open();
      return true;
    } });
    this.addSettingTab(new SyncSettings(this.app, this));

    for (const event of ['create', 'modify', 'rename', 'delete']) {
      this.registerEvent(this.app.vault.on(event, (file, previous) => {
        this.noteDirectoryEvent(file.path, event === 'rename' ? previous : null);
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
  validRetainedDirectories(paths) {
    return [...new Set((Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' &&
      !/[\\\u0000-\u001f]/.test(p) && !/^[A-Za-z]:/.test(p) && this.visible(p) &&
      p.split('/')[0].normalize('NFC').toLowerCase() !== this.app.vault.configDir.normalize('NFC').toLowerCase()))].sort();
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
      const settings = { ...draft, retainedEmptyDirectories: this.settings.retainedEmptyDirectories };
      await this.saveData(settings);
      this.settings = settings;
      this.engine = null;
      this.result = null;
      this.confirmationModal?.close();
      this.lastPromptKeys = new Set();
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
    this.engine = new SyncEngine({ remote, local, state, device: s.device,
      retainedDirectories: () => this.settings.retainedEmptyDirectories });
    return this.engine;
  }
  schedule(delay) { this.scheduler.schedule(delay); }
  autoSync() { if (this.ready && this.settings.auto && this.isActive() && !this.busy) return this.run('sync', false); }
  isActive() { return !this.stopped && (!Platform.isMobile || document.visibilityState !== 'hidden'); }
  openConfirmations() {
    if (this.confirmationModal) return;
    this.lastPromptKeys = confirmationKeys(this.result);
    this.confirmationModal = new ConfirmationModal(this);
    this.confirmationModal.open();
  }
  updateConfirmations() {
    const keys = confirmationKeys(this.result);
    if (this.confirmationModal) {
      this.lastPromptKeys = keys;
      this.confirmationModal.setResult(this.result);
    } else if ([...keys].some(key => !this.lastPromptKeys.has(key))) this.openConfirmations();
  }
  canRunDecisions(actions) {
    try {
      if (!this.isActive()) throw new Error('请保持 Obsidian 在前台再确认。');
      if (actions.some(a => ['stale-delete', 'conflict-delete'].includes(a.kind))) assertRecoverableTrash(this.app);
      return true;
    } catch (error) { new Notice(error.message, 10000); return false; }
  }
  fileStamp(file) {
    const s = file?.stat;
    return s && Number.isFinite(s.mtime) && Number.isFinite(s.ctime) && Number.isSafeInteger(s.size)
      ? JSON.stringify([s.mtime, s.ctime, s.size]) : null;
  }
  trashTokenCurrent(token) {
    return this.isActive() && this.app.vault.getAbstractFileByPath(token.physical) === token.file &&
      token.file.path === token.physical && this.fileStamp(token.file) === token.stamp &&
      this.scheduler.dirty.get(token.physical) === token.generation && this.editorMatches(token.physical, token.data);
  }
  async trashToken(physical, hash) {
    const file = this.app.vault.getAbstractFileByPath(physical);
    if (!file || file.path !== physical || Array.isArray(file.children)) return null;
    const stamp = this.fileStamp(file);
    if (stamp === null) return null;
    const generation = this.scheduler.dirty.get(physical);
    const data = await this.getEngine().local.read(physical);
    if (data === null || await sha256(data) !== hash) return null;
    const token = { physical, file, stamp, generation, data };
    return this.trashTokenCurrent(token) ? token : null;
  }
  async canTrash(physical, hash) { return !!await this.trashToken(physical, hash); }
  async trashConfirmed(physical, hash) {
    const token = await this.trashToken(physical, hash);
    // Check again after the await: editor changes, renames, a new file object,
    // host stat updates and newer event generations invalidate this permission.
    if (!token || !this.trashTokenCurrent(token)) return false;
    // Keep the preference check adjacent to the actual API call. A batch must
    // stop using trashFile if the user switches to permanent deletion midway.
    assertRecoverableTrash(this.app);
    await this.app.fileManager.trashFile(token.file);
    this.getEngine().local.invalidate?.(physical);
    return true;
  }
  noteDirectoryEvent(path, previous) {
    for (const token of this.directoryTokens) {
      if ([path, previous].some(p => p && (underDirectory(p, token.path) || underDirectory(token.path, p)))) token.changed = true;
    }
  }
  beginDirectoryTrash(path) {
    const token = { path, file: this.app.vault.getAbstractFileByPath(path), changed: false };
    this.directoryTokens.add(token); return token;
  }
  directoryTrashCurrent(token) {
    return !!token && !token.changed && this.isActive() && document.visibilityState !== 'hidden' &&
      Array.isArray(token.file?.children) && token.file.path === token.path &&
      this.app.vault.getAbstractFileByPath(token.path) === token.file &&
      !this.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view.file && underDirectory(leaf.view.file.path, token.path));
  }
  async trashEmptyDirectory(path, token, inspect) {
    if (!this.directoryTrashCurrent(token)) return false;
    // The second subtree listing is adjacent to the final synchronous token and
    // preference checks. The remaining native-call race is recoverable in trash.
    if (!await inspect() || !this.directoryTrashCurrent(token)) return false;
    assertRecoverableTrash(this.app);
    this.getEngine().local.forgetDirectoryHints?.(path);
    // 1.15.1 returns false when OS trash refuses; older public versions resolve
    // void on success. A refusal must not be reported as a cleaned directory.
    return await this.app.fileManager.trashFile(token.file) !== false;
  }
  async saveRetainedDirectories(paths, reset = false) {
    if (this.busy || this.configuring) { new Notice('请等当前操作完成再保留或重置。'); return false; }
    const retainedEmptyDirectories = this.validRetainedDirectories(reset ? [] : [...this.settings.retainedEmptyDirectories, ...paths]);
    this.configuring = true;
    try {
      const settings = { ...this.settings, retainedEmptyDirectories };
      await this.saveData(settings); this.settings = settings; return true;
    } finally { this.configuring = false; }
  }
  async runDirectories(paths, keep = false) {
    if (!this.isActive() || document.visibilityState === 'hidden' || !this.ready || this.busy || this.configuring) return;
    const lock = globalThis[activeVaults] ||= new Set(), key = this.app.vault.adapter;
    if (lock.has(key)) { new Notice('正在同步，请等待完成'); return; }
    lock.add(key); this.busy = true; this.scheduler.pause(); this.scheduler.running = true;
    try {
      const engine = this.getEngine();
      let outcome;
      if (keep) {
        const emptyDirectories = await engine.retainDirectories(paths, async accepted => {
          const settings = { ...this.settings, retainedEmptyDirectories: this.validRetainedDirectories([...this.settings.retainedEmptyDirectories, ...accepted]) };
          await this.saveData(settings); this.settings = settings;
        });
        outcome = { emptyDirectories }; new Notice(`已保留 ${paths.length} 个空文件夹，仅本机生效。`);
      } else {
        outcome = await engine.cleanDirectories(paths, {
          begin: path => this.beginDirectoryTrash(path), finish: token => this.directoryTokens.delete(token),
          trash: (path, token, inspect) => this.trashEmptyDirectory(path, token, inspect),
        });
        new Notice(`已清理 ${outcome.cleaned.length} 个空文件夹，跳过 ${outcome.skipped.length} 个。内容、编辑器或同步状态已变化的目录会保留。`, 10000);
      }
      if (this.result) this.result = { ...this.result, emptyDirectories: outcome.emptyDirectories };
      this.updateConfirmations(); return outcome;
    } catch (error) { new Notice('空文件夹处理未完成：' + error.message, 10000); }
    finally {
      this.busy = false; lock.delete(key); this.scheduler.running = false; this.scheduler.armPoll();
      if (this.scheduler.fullRequested > this.scheduler.fullCompleted || this.scheduler.eventDirty.size) this.scheduler.schedule(1000);
    }
  }
  openStatus() {
    const modal = new Modal(this.app);
    modal.titleEl.setText('飞牛同步状态');
    modal.contentEl.createEl('p', { text: this.statusMessage || '就绪' });
    if (this.lastError) modal.contentEl.createEl('p', { text: this.lastError });
    if (this.result) {
      const r = this.result;
      modal.contentEl.createEl('p', { text: `最近一轮：上传 ${r.uploaded}，下载 ${r.downloaded}，删除 ${r.deleted}，冲突 ${r.conflicts}，待处理 ${r.deferred}。` });
      if (r.cleanedDirectories) modal.contentEl.createEl('p', { text: `已清理空文件夹 ${r.cleanedDirectories} 个。` });
      const waiting = confirmationCount(r);
      if (waiting) modal.contentEl.createEl('p', { text: `有 ${waiting} 个文件等待确认。请打开“查看同步冲突”处理。` });
      if (r.emptyDirectories?.length) modal.contentEl.createEl('p', { text: `有 ${r.emptyDirectories.length} 个空文件夹可清理。请打开“查看同步冲突”。` });
      if (r.directoryCleanupBlocked) modal.contentEl.createEl('p', { text: '手机空文件夹不会自动清理；请在“查看同步冲突”的空文件夹组中确认清理。' });
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
    if (mode === 'decide' && !this.canRunDecisions(file)) return;
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
      const r = mode === 'decide' ? await engine.confirm(file, {
        canTrash: (physical, hash) => this.canTrash(physical, hash),
        trash: (physical, hash) => this.trashConfirmed(physical, hash),
      }) : mode === 'resolve' ? await engine.resolve(file) : await engine.sync({ full: ticket.full, dirty: ticket.dirty, deep: ticket.deep });
      this.scheduler.complete(ticket, r);
      if (r.stats) r.stats.pollIntervalMs = this.scheduler.pollIntervalMs;
      this.result = r;
      this.lastError = '';
      const waiting = confirmationCount(r);
      const message = waiting ? `有 ${waiting} 个文件等待确认` : r.deferred ? '有更改待下轮同步' : r.conflicts ? '有 ' + r.conflicts + ' 组冲突' : '已同步';
      if (!this.stopped) this.showStatus(message);
      if (notify && !this.stopped) new Notice(message);
      if (mode === 'decide' && !this.stopped) new Notice(`${r.trashedFiles ? `已将 ${r.trashedFiles} 个文件移入回收站；` : ''}已处理 ${r.appliedDecisions || 0} 个，跳过 ${(r.skippedDecisions || []).length} 个。跳过的条目可能已有内容、编辑器或同步状态变化。`, 10000);
      if (!this.stopped) this.updateConfirmations();
      return r;
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
    this.confirmationModal?.close();
    this.scheduler.stop();
  }
};
