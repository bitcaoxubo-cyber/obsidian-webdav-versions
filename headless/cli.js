#!/usr/bin/env node
'use strict';
const { loadConfig } = require('./config');
const { publicError } = require('./io');
const { init, run, readStatus, checkHealth, approve } = require('./runtime');
function parseArgs(argv, env = process.env) {
  let file = env.HEADLESS_CONFIG, command, once = false, check = false, count;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--config 缺少路径。'); file = argv[++i]; }
    else if (arg === '--once') once = true;
    else if (arg === '--check') check = true;
    else if (arg === '--count') { if (!/^\d+$/.test(argv[i + 1] || '')) throw new Error('--count 必须是非负整数。'); count = Number(argv[++i]); if (!Number.isSafeInteger(count)) throw new Error('--count 超出安全整数范围。'); }
    else if (!command && ['init', 'run', 'status', 'approve-deletions'].includes(arg)) command = arg;
    else throw new Error('命令或参数无效；支持 init、run [--once]、status [--check]、approve-deletions --count N。');
  }
  if (!command || (once && command !== 'run') || (check && command !== 'status') || (count !== undefined && command !== 'approve-deletions') || (command === 'approve-deletions' && count === undefined)) throw new Error('命令或选项组合无效。');
  return { file, command, once, check, count };
}
async function main(argv = process.argv.slice(2), { env = process.env, stdout = line => process.stdout.write(line + '\n'), stderr = line => process.stderr.write(line + '\n'), ...options } = {}) {
  let config;
  const quiet = argv.includes('status') && argv.includes('--check');
  try {
    const args = parseArgs(argv, env); config = loadConfig(args.file, { env });
    if (args.command === 'init') { await init(config, options); stdout('初始化完成；请运行 run 开始首次同步。'); return 0; }
    if (args.command === 'run') return await run(config, { ...options, once: args.once });
    if (args.command === 'approve-deletions') { const result = await approve(config, args.count, options); stdout('已批准本次删除 ' + result.count + ' 个文件；批准只对当前这组路径有效，且只能使用一次。'); return 0; }
    const status = readStatus(config);
    if (args.check) return checkHealth(status) ? 0 : 1;
    stdout('状态：' + ({ ok: '正常', paused: '暂停', error: '出错' }[status.state]));
    stdout('原因：' + (status.reason || '无')); stdout('上次成功：' + (status.lastSuccess || '尚无'));
    if (status.lastResult) stdout('上一轮：上传 ' + status.lastResult.uploaded + '，下载 ' + status.lastResult.downloaded + '，删除 ' + status.lastResult.deleted);
    if (status.conflicts?.length) stdout('冲突：' + status.conflicts.join('、') + '；请在 Mac 或手机的插件里处理。');
    if (Object.values(status.needsAttention || {}).some(Boolean)) stdout('待确认：' + JSON.stringify(status.needsAttention) + '；请在 Mac 或手机的插件里处理。');
    if (status.pendingDeletions) {
      const { count, paths, allPaths } = status.pendingDeletions;
      stdout('待批准删除：' + count + '；' + (allPaths || paths).join('、'));
    }
    return 0;
  } catch (error) { if (!quiet) stderr(publicError(error.message, config || { password: env.HEADLESS_PASSWORD })); return 1; }
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.stderr.write('同步端发生未处理错误。\n'); process.exitCode = 1; });
module.exports = { main, parseArgs };
