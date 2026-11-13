'use strict';

function groups(result) {
  const c = result?.confirmations || {};
  return { staleCopies: c.staleCopies || result?.staleCopies || [],
    deletionConflicts: c.deletionConflicts || [], staleConflicts: c.staleConflicts || [] };
}
function confirmationKeys(result) {
  const keys = new Set();
  for (const [kind, entries] of Object.entries(groups(result))) {
    for (const e of entries) keys.add(JSON.stringify([kind, e.path, e.hash || null, e.tips,
      e.files?.map(f => [f.physical, f.hash]), e.selected || null]));
  }
  return keys;
}
function confirmationCount(result) {
  return new Set(Object.values(groups(result)).flat().map(e => e.path)).size;
}
const decision = (kind, entry, selected) => ({ kind, entry, ...(selected ? { selected } : {}) });

function createConfirmationModal({ Modal, Notice, Setting }) {
  return class ConfirmationModal extends Modal {
    constructor(plugin) { super(plugin.app); this.plugin = plugin; this.result = plugin.result; }
    onOpen() { this.render(); }
    onClose() { if (this.plugin.confirmationModal === this) this.plugin.confirmationModal = null; }
    setResult(result) { this.result = result; this.render(); }
    async execute(actions) {
      if (this.plugin.busy) { new Notice('正在同步，请等待完成后再确认。'); return; }
      if (!this.plugin.canRunDecisions(actions)) return;
      this.close();
      await this.plugin.run('decide', true, actions);
    }
    confirmBatch(label, actions, deleting = false) {
      if (!actions.length) return;
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: deleting
        ? `将处理 ${actions.length} 个笔记，删除 ${actions.reduce((n, a) => n + (a.entry.files?.length || 1), 0)} 个本地文件，可在所选回收站恢复。内容或同步状态已变化的条目会跳过。`
        : `将处理 ${actions.length} 个笔记。内容或同步状态已变化的条目会跳过。` });
      new Setting(this.contentEl)
        .addButton(b => b.setButtonText('返回').onClick(() => this.render()))
        .addButton(b => b.setButtonText(label).setCta().onClick(() => this.execute(actions)));
    }
    async executeDirectories(entries, keep = false) {
      if (this.plugin.busy) { new Notice('正在同步，请等待完成后再确认。'); return; }
      this.close(); await this.plugin.runDirectories(entries.map(e => e.path), keep);
    }
    confirmDirectories(entries) {
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: `将清理 ${entries.length} 个空文件夹。只删除空文件夹，不删除任何笔记。目录内容或同步状态已变化时会跳过；手机及含 .DS_Store 的目录会移入回收站。` });
      new Setting(this.contentEl)
        .addButton(b => b.setButtonText('返回').onClick(() => this.render()))
        .addButton(b => b.setButtonText('确认清理空文件夹').setCta().onClick(() => this.executeDirectories(entries)));
    }
    async openFile(name) {
      const file = this.app.vault.getAbstractFileByPath(name);
      if (file) { this.close(); await this.app.workspace.getLeaf(false).openFile(file); }
    }
    render() {
      this.titleEl.setText('同步确认');
      this.contentEl.empty();
      if (!this.result) { this.contentEl.createEl('p', { text: '先运行一次同步以读取当前状态。' }); return; }
      const { staleCopies, deletionConflicts, staleConflicts } = groups(this.result);
      const classified = new Set([...deletionConflicts, ...staleConflicts].map(e => e.path));
      if (staleCopies.length) {
        this.contentEl.createEl('h3', { text: `本机的旧副本 · ${staleCopies.length}` });
        this.contentEl.createEl('p', { text: '其他设备已删除这些文件，本机仍留有内容相同的旧副本。请选择移入回收站，或保留并重新同步。' });
        new Setting(this.contentEl)
          .addButton(b => b.setButtonText('全部删除本机副本').onClick(() => this.confirmBatch('确认删除本机副本', staleCopies.map(e => decision('stale-delete', e)), true)))
          .addButton(b => b.setButtonText('全部保留').onClick(() => this.confirmBatch('确认全部保留', staleCopies.map(e => decision('stale-keep', e)))));
        for (const entry of staleCopies) new Setting(this.contentEl).setName(entry.path)
          .addButton(b => b.setButtonText('删除本机副本').onClick(() => this.execute([decision('stale-delete', entry)])))
          .addButton(b => b.setButtonText('保留并重新同步').onClick(() => this.execute([decision('stale-keep', entry)])));
      }
      if (deletionConflicts.length) {
        this.contentEl.createEl('h3', { text: `删除冲突 · ${deletionConflicts.length}` });
        const unchanged = deletionConflicts.filter(e => e.unchanged);
        if (unchanged.length) new Setting(this.contentEl)
          .addButton(b => b.setButtonText(`删除内容未变的 ${unchanged.length} 个`).onClick(() => this.confirmBatch('确认删除内容未变的文件', unchanged.map(e => decision('conflict-delete', e)), true)));
        for (const entry of deletionConflicts) {
          const row = new Setting(this.contentEl).setName(entry.path)
            .setDesc(`${(entry.devices || []).join('、')} · ${entry.unchanged ? '内容与删除前相同' : '删除后有改动'}`)
            .addButton(b => b.setButtonText('删除').onClick(() => this.execute([decision('conflict-delete', entry)])));
          if (entry.files.length === 1) row.addButton(b => b.setButtonText('保留').onClick(() => this.execute([decision('resolve', entry, entry.files[0].physical)])));
          else for (const f of entry.files) new Setting(this.contentEl).setName(f.physical)
            .addButton(b => b.setButtonText('打开').onClick(() => this.openFile(f.physical)))
            .addButton(b => b.setButtonText('保留此版本').onClick(() => this.execute([decision('resolve', entry, f.physical)])));
        }
      }
      if (staleConflicts.length) {
        this.contentEl.createEl('h3', { text: `旧版本冲突 · ${staleConflicts.length}` });
        new Setting(this.contentEl).addButton(b => b.setButtonText('全部采用较新版本')
          .onClick(() => this.confirmBatch('确认采用较新版本', staleConflicts.map(e => decision('resolve', e, e.selected)))));
        for (const entry of staleConflicts) new Setting(this.contentEl).setName(entry.path).setDesc('较新版本：' + entry.selected)
          .addButton(b => b.setButtonText('采用较新版本').onClick(() => this.execute([decision('resolve', entry, entry.selected)])));
      }
      const empty = this.result.emptyDirectories || [];
      if (empty.length) {
        this.contentEl.createEl('h3', { text: `空文件夹 · ${empty.length}` });
        new Setting(this.contentEl)
          .addButton(b => b.setButtonText('全部清理').onClick(() => this.confirmDirectories(empty)))
          .addButton(b => b.setButtonText('全部保留').onClick(() => this.executeDirectories(empty, true)));
        for (const entry of empty) new Setting(this.contentEl).setName(entry.path)
          .setDesc(`包含 ${entry.subdirectoryCount} 个子文件夹${entry.containsDSStore ? ' · 含 .DS_Store' : ''}`)
          .addButton(b => b.setButtonText('清理').onClick(() => this.executeDirectories([entry])))
          .addButton(b => b.setButtonText('保留').onClick(() => this.executeDirectories([entry], true)));
      }
      const other = (this.result.conflictPaths || []).filter(p => !classified.has(p));
      const deferred = this.result.deferredPaths || [];
      if (other.length) {
        this.contentEl.createEl('h3', { text: '其他冲突' });
        this.contentEl.createEl('p', { text: '请比较正文与冲突副本，打开要保留的版本，运行“采用当前文件解决冲突”。' });
        for (const name of other) new Setting(this.contentEl).setName(name).addButton(b => b.setButtonText('打开正文').onClick(() => this.openFile(name)));
      }
      if (deferred.length) this.contentEl.createEl('h3', { text: '等待同步' });
      for (const name of deferred) this.contentEl.createEl('p', { text: name });
      if (!confirmationCount(this.result) && !other.length && !deferred.length && !empty.length) this.contentEl.createEl('p', { text: '最近一次同步没有需要确认或等待处理的文件。' });
    }
  };
}

module.exports = { createConfirmationModal, confirmationKeys, confirmationCount };
