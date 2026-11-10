'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DavRemote, NAMESPACE } = require('../src/dav');
const { DiskState, DiskVault } = require('../src/local');
const { SyncEngine } = require('../src/engine');
const { headsFor } = require('../src/protocol');

const DEFAULT_RECEIPT = path.resolve(__dirname, '..', '.local', 'acceptance.json');
const CHECKS = ['configuration', 'parent-readable', 'absent-test-path', 'empty-test-folder',
  'initial-copy', 'concurrent-writes', 'restart-convergence', 'explicit-resolution', 'history'];
const FAILURES = ['configuration', 'cancelled', 'http-auth', 'http-error', 'transport', 'listing', 'integrity', 'invariant', 'local-io', 'unexpected'];
const FAILURE_HINT = {
  configuration: '请检查 HTTPS 文件夹地址和账号设置。', cancelled: '已取消验收。',
  'http-auth': '服务器拒绝了账号或目录权限。', 'http-error': '服务器未返回预期的 HTTP 状态。',
  transport: '网络或 TLS 证书校验失败。', listing: '服务器返回了不完整的目录清单。',
  integrity: '文件或版本内容校验失败。', invariant: '实际结果与预期不一致，请保留测试目录以便核对。',
  'local-io': '本机临时文件操作失败。', unexpected: '验收未能完成，请保留测试目录以便核对。',
};
class AcceptanceError extends Error {
  constructor(message, category = 'invariant') { super(message); this.category = category; }
}
function endpointFingerprint(input) {
  try {
    const u = new URL(input);
    if (!['https:', 'http:'].includes(u.protocol)) return null;
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    // Normalize port/host through WHATWG URL and unreserved path escapes only.
    u.pathname = u.pathname.replace(/%[a-f0-9]{2}/gi, esc => {
      const ch = String.fromCharCode(parseInt(esc.slice(1), 16));
      return /[A-Za-z0-9._~-]/.test(ch) ? ch : esc.toUpperCase();
    }).replace(/\/*$/, '/');
    return createHash('sha256').update(u.href).digest('hex');
  } catch { return null; }
}
function categoryOf(err, stage) {
  if (err instanceof AcceptanceError && FAILURES.includes(err.category)) {
    return stage === 'configuration' && err.category === 'invariant' ? 'configuration' : err.category;
  }
  const msg = String(err?.message || '');
  if (/HTTP (401|403)\b/.test(msg)) return 'http-auth';
  if (/HTTP [1-5]\d\d/.test(msg)) return 'http-error';
  if (/TLS|传输失败/.test(msg)) return 'transport';
  if (/目录清单/.test(msg)) return 'listing';
  if (/校验|不符|checksum/i.test(msg)) return 'integrity';
  if (/^E[A-Z]+$/.test(String(err?.code))) return 'local-io';
  return stage === 'configuration' ? 'configuration' : 'unexpected';
}
function context(log, signal) {
  return { id: randomUUID(), stage: 'configuration', passed: [], log, signal };
}
function checkSignal(ctx) {
  if (ctx.signal?.aborted) throw new AcceptanceError('验收已取消。', 'cancelled');
}
function check(ok, message) { if (!ok) throw new AcceptanceError(message); }
async function together(tasks) {
  // A failing client must not keep working while the other client's temporary vault is removed.
  const settled = await Promise.allSettled(tasks);
  for (const item of settled) if (item.status === 'rejected') throw item.reason;
  return settled.map(item => item.value);
}

// A small real one-page PDF with a binary marker and a valid cross-reference table.
function samplePDF(label) {
  const stream = `BT /F1 12 Tf 20 100 Td (WebDAV acceptance: ${label}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n%\xff\xfe\xf0\x80\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}
const noteName = '验收资料/实验笔记.md';
const pdfName = '验收资料/参考资料.pdf';
async function write(client, file, bytes) {
  const destination = path.join(client.local.root, file);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, bytes);
}
async function read(client) {
  const map = new Map();
  for (const file of await client.local.list()) map.set(file, await client.local.read(file));
  return map;
}
function sameFiles(a, b) {
  return a.size === b.size && [...a].every(([name, bytes]) => b.get(name)?.equals(bytes));
}

async function executeAcceptance(options, ctx) {
  let temp;
  let phase = '验证 HTTPS 地址';
  const step = (stage, label) => {
    ctx.passed.push(ctx.stage); ctx.stage = stage;
    checkSignal(ctx);
    phase = label;
    ctx.log(label + '…');
  };
  try {
    checkSignal(ctx);
    check(typeof options?.url === 'string' && typeof options.username === 'string' && options.username &&
      typeof options.password === 'string' && options.password, '需要 HTTPS 文件夹地址、用户名和密码。');
    const parent = new DavRemote(options);
    const segments = parent.base.pathname.split('/').map(x => decodeURIComponent(x).toLowerCase());
    check(!segments.includes(NAMESPACE.toLowerCase()), '请指定普通 WebDAV 父文件夹，不要选择插件的版本目录。');
    step('parent-readable', '验证父目录可读');
    await parent.probe();
    const trial = new URL('obsidian-acceptance-' + ctx.id + '/', parent.base);
    step('absent-test-path', '确认随机测试路径不存在');
    check(await parent.propfind(trial, 0, true) === null, '随机测试路径已存在，已停止，本次不会写入。');
    // This address is shown before MKCOL in case the acknowledgement is lost.
    ctx.log('本次测试目录：' + trial.href);
    step('empty-test-folder', '创建并验证新的空目录');
    const created = await parent.call('MKCOL', trial, {}, undefined, 64 * 1024);
    check(created.status === 201, '未确认新建目录（HTTP ' + created.status + '）；已停止，尚未上传测试文件。');
    check((await parent.propfind(trial, 1)).size === 0, '新建目录不是空目录；已停止，尚未上传测试文件。');
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-dav-acceptance-'));
    const client = async device => {
      const dir = path.join(temp, device);
      await fsp.mkdir(dir, { recursive: true });
      const local = new DiskVault(dir);
      const remote = new DavRemote({ ...options, url: trial.href });
      const state = new DiskState(local.privateDir, trial.href, options.username);
      return { local, remote, engine: new SyncEngine({ local, remote, state, device }) };
    };
    let a = await client('Mac-A'), b = await client('Mac-B');
    const common = Buffer.from('两台设备的共同底稿。\n');
    const aText = Buffer.from('A 在离线时修改。\r\n'), bText = Buffer.from('B 在离线时修改。\n');
    const aPdf = samplePDF('edit A'), bPdf = samplePDF('edit B');
    step('initial-copy', '同步 Markdown 笔记和 PDF 初稿');
    await write(a, noteName, common); await write(a, pdfName, samplePDF('base'));
    await a.engine.sync(); await b.engine.sync();
    check(sameFiles(await read(a), await read(b)), '初次下载的文件名或内容不一致。');
    step('concurrent-writes', '两台本地测试设备并发上传同名笔记和 PDF 的不同修改');
    await write(a, noteName, aText); await write(b, noteName, bText);
    await write(a, pdfName, aPdf); await write(b, pdfName, bPdf);
    await together([a.engine.sync(), b.engine.sync()]);
    step('restart-convergence', '重新连接两台设备，并用全新第三设备检查四份冲突内容');
    a = await client('Mac-A'); b = await client('Mac-B');
    const c = await client('Mac-C');
    const clients = [a, b, c];
    const stats = await together(clients.map(x => x.engine.sync()));
    check(stats.every(s => s.conflicts === 2 && s.deferred === 0), '没有确认两组可处理的冲突。');
    const [mapA, mapB, mapC] = await together(clients.map(read));
    check(mapA.size === 4 && sameFiles(mapA, mapB) && sameFiles(mapA, mapC), '三台设备的四个冲突文件不一致。');
    for (const expected of [aText, bText, aPdf, bPdf]) {
      check([...mapA.values()].some(b => b.equals(expected)), '逐字节比较失败：缺少一侧修改。');
    }
    step('explicit-resolution', '合并两份笔记并选定一份 PDF，验证所有设备和远端历史');
    const merged = Buffer.from('A 在离线时修改。\nB 在离线时修改。\n');
    await write(a, noteName, merged);
    check((await a.engine.resolve(noteName)).conflicts === 1, '选择合并笔记后另一个 PDF 冲突状态异常。');
    const alternate = [...mapA].find(([name]) => name.endsWith('.pdf') && name !== pdfName);
    check(alternate, '没有可独立选择的 PDF 冲突副本。');
    check((await a.engine.resolve(alternate[0])).conflicts === 0, '选择 PDF 版本后仍有冲突。');
    await together([b.engine.sync(), c.engine.sync()]);
    const expected = new Map([[noteName, merged], [pdfName, alternate[1]]]);
    for (const files of await together(clients.map(read))) check(sameFiles(files, expected), '解决冲突后内容或文件名不一致。');
    step('history', '检查远端八个历史版本是否完整');
    const history = await (await client('Mac-C')).remote.listRevisions();
    check(history.length === 8 && [noteName, pdfName].every(n => headsFor(history, n).length === 1),
      '远端八个历史版本或最终版本关系不完整。');
    checkSignal(ctx);
    ctx.passed.push('history');
    ctx.stage = 'cleanup';
    return trial.href;
  } catch (err) {
    if (err instanceof AcceptanceError) throw err;
    // Server content, request headers and the underlying error are never printed.
    const text = String(err?.message || '');
    const status = text.match(/HTTP [1-5][0-9][0-9]/)?.[0];
    const reason = status || (text.includes('TLS') ? '网络或 TLS 验证失败' :
      text.includes('清单') ? 'WebDAV 目录清单不完整' : '输入、服务响应或本地完整性校验失败');
    throw new AcceptanceError(phase + '失败（' + reason + '）。', categoryOf(err, ctx.stage));
  } finally {
    if (temp) await fsp.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

// No process listeners or exits in the library API. Signal policy belongs to the caller.
async function runAcceptance(options, log = () => {}, { signal } = {}) {
  return executeAcceptance(options, context(log, signal));
}

async function writeReceipt(file, receipt) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await fsp.lstat(dir)).isDirectory()) throw new Error('回执目录不是普通文件夹。');
  const scratch = path.join(dir, '.acceptance-' + randomUUID() + '.tmp');
  const handle = await fsp.open(scratch, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await fsp.rename(scratch, file);
  } finally { await fsp.rm(scratch, { force: true }); }
}

// Used by both the terminal and future in-app checks. The receipt contains no free-form server messages.
async function checkAcceptance(options, { receiptFile = DEFAULT_RECEIPT, log = () => {}, signal } = {}) {
  const ctx = context(log, signal);
  let failure = null;
  try { await executeAcceptance(options, ctx); }
  catch (err) { failure = { stage: ctx.stage, category: categoryOf(err, ctx.stage) }; }
  const receipt = { version: 1, testId: ctx.id, timestamp: new Date().toISOString(),
    endpointSha256: endpointFingerprint(options?.url), status: failure ? 'failed' : 'passed', checks: ctx.passed, failure };
  if (receiptFile !== null) await writeReceipt(receiptFile, receipt);
  return receipt;
}

async function readAcceptanceReceipt(parentUrl, receiptFile = DEFAULT_RECEIPT) {
  const expected = endpointFingerprint(parentUrl);
  if (!expected) return null;
  let handle;
  try {
    handle = await fsp.open(receiptFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.size > 8192) return null;
    const r = JSON.parse(await handle.readFile('utf8'));
    if (!r || Object.keys(r).sort().join(',') !== 'checks,endpointSha256,failure,status,testId,timestamp,version' ||
        r.version !== 1 || r.endpointSha256 !== expected || typeof r.testId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.testId) ||
        typeof r.timestamp !== 'string' || !Number.isFinite(Date.parse(r.timestamp)) ||
        new Date(r.timestamp).toISOString() !== r.timestamp ||
        !Array.isArray(r.checks) || r.checks.length > CHECKS.length ||
        !r.checks.every((stage, i) => stage === CHECKS[i])) return null;
    if (r.status === 'passed') return r.failure === null && r.checks.length === CHECKS.length ? r : null;
    const f = r.failure;
    if (r.status !== 'failed' || !f || Object.keys(f).sort().join(',') !== 'category,stage' ||
        !FAILURES.includes(f.category) || f.stage !== (CHECKS[r.checks.length] || 'cleanup')) return null;
    return r;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP' || err instanceof SyntaxError) return null;
    throw err;
  } finally { if (handle) await handle.close(); }
}

if (require.main === module) {
  (async () => {
    check(process.argv.length === 2 && !process.stdin.isTTY, '请通过“飞牛空库验收.command”启动；请勿在命令行参数中输入凭据。');
    const fields = fs.readFileSync(0, 'utf8').replace(/\n$/, '').split('\n');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const [url, username, password] = fields.length === 3 ? fields : [];
      const r = await checkAcceptance({ url, username, password }, { log: console.log, signal: controller.signal });
      console.log('本次验收回执：.local/acceptance.json');
      if (r.status !== 'passed') {
        console.error('验收未通过。' + FAILURE_HINT[r.failure.category] + '（' + r.failure.stage + '）');
        process.exitCode = r.failure.category === 'cancelled' ? 130 : 1;
      } else {
        console.log('验收通过：冲突内容、手动选择和八个远端版本已核对。');
        console.log('可在飞牛文件管理器中自行清理上述随机测试目录。');
      }
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  })().catch(err => {
    console.error('验收未完成。' + (err instanceof AcceptanceError ? err.message : '本地环境或回执写入失败。'));
    process.exitCode = 1;
  });
}
module.exports = { runAcceptance, checkAcceptance, readAcceptanceReceipt, endpointFingerprint };
