'use strict';

// Desktop and mobile use the same Obsidian FileManager.trashFile contract; the
// plugin's minimum supported host is 1.11.4. The method follows trashOption:
// the inspected desktop 1.15.0 implementation routes "none" to vault.delete.
// Its presence or name alone therefore cannot guarantee recoverable deletion.
// This preflight neither changes preferences nor deletes anything. Call it
// immediately before each actual trashFile call, including in a batch.
function assertRecoverableTrash(app) {
  if (typeof app?.fileManager?.trashFile !== 'function') {
    throw new Error('当前 Obsidian 缺少回收站删除接口；请更新到 1.11.4 或更高版本。未执行删除。');
  }
  if (typeof app?.vault?.getConfig !== 'function') {
    throw new Error('无法确认 Obsidian 回收站设置；未执行删除。');
  }
  let option;
  try { option = app.vault.getConfig('trashOption'); }
  catch { throw new Error('无法读取 Obsidian 回收站设置；未执行删除。'); }
  if (option !== 'system' && option !== 'local') {
    throw new Error('请先在 Obsidian 的文件与链接设置中选择系统回收站或 Obsidian 回收站，再确认删除。当前设置不支持可恢复删除。');
  }
  return option;
}

module.exports = { assertRecoverableTrash };
