'use strict';
// Instrumented model of the MOBILE path. Every original adapter/digest/HTTP call remains counted.
// node scripts/bench-sync.js [repo=.] [notes=1000] [attachments=20] [layout=v1|v2]
//   [--latency ms] [--json] [--rounds upload,download,idle,edit,idle2,incremental]
//   [--assert file] [--stage A|B] [--compare previous-report.json]
const path = require('node:path');
const fs = require('node:fs');
const ids = ['upload', 'download', 'idle', 'edit', 'idle2', 'incremental'];
function argumentsOf(args) {
  const positional = [], options = { latency: 0, json: false, rounds: ids, stage: 'B' };
  const values = new Set(['--latency', '--rounds', '--assert', '--stage', '--compare']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for ' + arg);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('--')) throw new Error('Unknown option: ' + arg);
    else positional.push(arg);
  }
  if (positional.length > 4) throw new Error('Expected at most four positional arguments');
  options.repo = path.resolve(positional[0] || path.join(__dirname, '..'));
  options.notes = Number(positional[1] ?? 1000);
  options.attachments = Number(positional[2] ?? 20);
  options.layout = positional[3] || 'v1';
  options.latency = Number(options.latency);
  if (!Number.isSafeInteger(options.notes) || options.notes < 1 || !Number.isSafeInteger(options.attachments) || options.attachments < 0) throw new Error('Expected notes >= 1 and attachments >= 0');
  if (!['v1', 'v2'].includes(options.layout)) throw new Error('Expected layout v1 or v2');
  if (!Number.isFinite(options.latency) || options.latency < 0) throw new Error('Expected a nonnegative latency');
  if (typeof options.rounds === 'string') options.rounds = options.rounds.split(',');
  if (!options.rounds.length || options.rounds.some(id => !ids.includes(id))) throw new Error('Unknown round; use ' + ids.join(','));
  return options;
}
let options;
try { options = argumentsOf(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
const { repo, notes: N, attachments: ATT, layout: LAYOUT } = options;
const src = f => require(path.join(repo, 'src', f));
const freshHash = () => ({ calls: 0, bytes: 0, maxInputBytes: 0, ms: 0 });
let hashes = { js: freshHash(), webcrypto: freshHash() };
const B = src('bytes');
const rawDigest = B.digest;
B.digest = value => {
  const b = B.bytes(value), stats = hashes.js, started = performance.now();
  stats.calls++; stats.bytes += b.byteLength; stats.maxInputBytes = Math.max(stats.maxInputBytes, b.byteLength);
  try { return rawDigest(b); } finally { stats.ms += performance.now() - started; }
};
// Count the actual native path, rather than counting sha256() calls that may fall back to JS.
if (globalThis.crypto?.subtle) {
  const subtle = globalThis.crypto.subtle, raw = subtle.digest.bind(subtle);
  subtle.digest = async (algorithm, data) => {
    const stats = hashes.webcrypto, started = performance.now();
    stats.calls++; stats.bytes += data.byteLength; stats.maxInputBytes = Math.max(stats.maxInputBytes, data.byteLength);
    try { return await raw(algorithm, data); } finally { stats.ms += performance.now() - started; }
  };
}
const { Adapter } = require(path.join(repo, 'test/helpers/adapter'));
const { MobileVault, MobileState, mobileRequest } = src('mobile');
const { SyncEngine } = src('engine');
const { AdaptiveDavRemote, V2_NAMESPACE, FORMAT_TEXT } = src('sharded');

const base = '/vault/';
const server = { files: new Map(), dirs: new Set([base]), calls: {}, down: 0, up: 0 };
if (LAYOUT === 'v2') { server.dirs.add(base + V2_NAMESPACE + '/'); server.files.set(base + V2_NAMESPACE + '/format.json', Buffer.from(FORMAT_TEXT)); }
const resp = (p, dir) => `<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
async function requestUrl({ url, method, headers, body }) {
  const p = new URL(url).pathname;
  server.calls[method] = (server.calls[method] || 0) + 1;
  if (options.latency) await new Promise(resolve => setTimeout(resolve, options.latency));
  const send = (status, b = '', h = {}) => { const buf = Buffer.from(b); server.down += buf.length;
    return { status, headers: h, arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }; };
  if (method === 'PROPFIND') {
    if (!server.dirs.has(p)) return send(404);
    const imm = s => s.startsWith(p) && s !== p && !s.slice(p.length).replace(/\/$/, '').includes('/');
    const e = headers.Depth === '0' ? [] : [...server.files.keys(), ...server.dirs].filter(imm);
    return send(207, '<d:multistatus xmlns:d="DAV:">' + resp(p, true) + e.map(n => resp(n, server.dirs.has(n))).join('') + '</d:multistatus>');
  }
  if (method === 'HEAD') return server.files.has(p) ? send(200, '', { 'Content-Length': String(server.files.get(p).length) }) : send(404);
  if (method === 'GET') {
    if (!server.files.has(p)) return send(404);
    const f = server.files.get(p), m = /^bytes=(\d+)-(\d+)$/.exec(headers.Range || '');
    if (m) return send(206, f.subarray(+m[1], +m[2] + 1), { 'Content-Range': `bytes ${m[1]}-${m[2]}/${f.length}` });
    return send(200, f);
  }
  if (method === 'MKCOL') { if (server.dirs.has(p)) return send(405); server.dirs.add(p); return send(201); }
  if (method === 'PUT') { const b = Buffer.from(body); server.up += b.length; server.files.set(p, b); return send(201); }
  return send(405);
}

const total = calls => Object.values(calls).reduce((a, b) => a + b, 0);
const freshIO = () => ({ calls: {}, readBytes: 0, writeBytes: 0 });
function counted(adapter, privateDir) {
  const c = { ...freshIO(), vault: freshIO(), private: freshIO() };
  for (const m of ['stat', 'exists', 'mkdir', 'readBinary', 'writeBinary', 'remove', 'rename', 'copy', 'rmdir', 'list']) {
    const f = adapter[m].bind(adapter);
    adapter[m] = async (...a) => {
      // A two-path operation is attributed to its source; binary I/O uses its sole path.
      // Parent directory setup belongs to the private tree too. No calls are omitted.
      const p = a[0], privatePath = p === privateDir || p.startsWith(privateDir + '/') || (p && privateDir.startsWith(p + '/'));
      const category = privatePath ? c.private : c.vault;
      c.calls[m] = (c.calls[m] || 0) + 1; category.calls[m] = (category.calls[m] || 0) + 1;
      const r = await f(...a);
      if (m === 'readBinary') { c.readBytes += r.byteLength; category.readBytes += r.byteLength; }
      if (m === 'writeBinary') { c.writeBytes += a[1].byteLength; category.writeBytes += a[1].byteLength; }
      return r;
    };
  }
  return c;
}
function client(device) {
  const adapter = new Adapter();
  const local = new MobileVault(adapter), io = counted(adapter, local.privateDir);
  const state = new MobileState(adapter, local.privateDir, 'https://example.test' + base, 'u');
  const remote = new AdaptiveDavRemote({ url: 'https://example.test' + base, username: 'u', password: 'p', request: mobileRequest(requestUrl) });
  return { adapter, io, engine: new SyncEngine({ remote, local, state, device }) };
}
const mb = n => (n / 1048576).toFixed(3) + ' MiB';
const report = { schemaVersion: 1, config: { notes: N, attachments: ATT, layout: LAYOUT, latencyMs: options.latency, fileCount: N + ATT }, rounds: [] };
async function round(id, label, c, syncOptions) {
  hashes = { js: freshHash(), webcrypto: freshHash() };
  Object.assign(c.io, freshIO(), { vault: freshIO(), private: freshIO() });
  server.calls = {}; server.down = 0; server.up = 0;
  const started = performance.now(), result = await c.engine.sync(syncOptions), wallMs = performance.now() - started;
  const row = { id, label, wallMs, result, adapter: { ...c.io, totalCalls: total(c.io.calls) },
    hash: { ...hashes, totalBytes: hashes.js.bytes + hashes.webcrypto.bytes },
    http: { calls: server.calls, totalCalls: total(server.calls), downBytes: server.down, upBytes: server.up } };
  if (options.rounds.includes(id)) report.rounds.push(row);
  if (!options.json && options.rounds.includes(id)) {
    console.log(`\n== ${label} == up ${result.uploaded} / down ${result.downloaded}   wall ${wallMs.toFixed(0)} ms (node)`);
    console.log(`  adapter calls ${row.adapter.totalCalls} ${JSON.stringify(c.io.calls)}`);
    console.log(`  local bytes read ${mb(c.io.readBytes)}, written ${mb(c.io.writeBytes)}`);
    for (const category of ['vault', 'private']) console.log(`  ${category}: ${JSON.stringify(c.io[category].calls)} read ${mb(c.io[category].readBytes)}, written ${mb(c.io[category].writeBytes)}`);
    for (const [name, h] of Object.entries(hashes)) console.log(`  ${name} sha256: ${h.calls} calls, ${mb(h.bytes)}, max ${h.maxInputBytes} bytes, ${h.ms.toFixed(0)} ms`);
    console.log(`  HTTP ${row.http.totalCalls} ${JSON.stringify(server.calls)} down ${mb(server.down)} up ${mb(server.up)}`);
  }
}
function evaluateThresholds() {
  const definition = JSON.parse(fs.readFileSync(options.assert, 'utf8'));
  const rules = definition.stages ? definition.stages[options.stage] : definition.rules;
  if (!Array.isArray(rules)) throw new Error('Threshold file has no rules for stage ' + options.stage);
  const previous = options.compare ? JSON.parse(fs.readFileSync(options.compare, 'utf8')) : null;
  const failures = [], checked = [];
  const get = (value, metric) => metric.split('.').reduce((v, key) => v?.[key], value);
  for (const rule of rules) {
    if (rule.layout && rule.layout !== LAYOUT) continue;
    if (rule.requiresCompare && !previous) continue;
    const rounds = rule.round === '*' ? report.rounds : report.rounds.filter(r => r.id === rule.round);
    if (!rounds.length) { failures.push('Missing required round: ' + rule.round); continue; }
    for (const row of rounds) {
      // Absent HTTP methods/call types mean zero calls, not a missing measurement.
      let value = get(row, rule.metric);
      if (value === undefined && /^(http\.calls|adapter\.(calls|vault\.calls|private\.calls))\.[a-zA-Z]+$/.test(rule.metric)) value = 0;
      let max = rule.max;
      if ('maxPerFile' in rule) max = rule.maxPerFile * report.config.fileCount;
      if ('maxVaultMultiple' in rule) max = rule.maxVaultMultiple * report.config.vaultBytes;
      if ('maxRatio' in rule) {
        const baseline = previous?.rounds.find(r => r.id === row.id);
        const old = get(baseline, rule.metric);
        if (!Number.isFinite(old) || old <= 0) { failures.push(`${row.id}.${rule.metric}: missing positive comparison value`); continue; }
        max = old * rule.maxRatio;
      }
      const name = `${row.id}.${rule.metric}`;
      checked.push({ metric: name, value, max });
      if (!Number.isFinite(value) || !Number.isFinite(max) || value > max) failures.push(`${name}: ${value} > ${max}`);
    }
  }
  return { stage: options.stage, passed: failures.length === 0, checked, failures };
}
(async () => {
  const { randomBytes } = require('node:crypto');
  const mac = client('Mac'), phone = client('iPhone');
  let vault = 0;
  const put = (a, p, b) => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) a.folders.add(parts.slice(0, i).join('/')); a.put(p, b); };
  for (let i = 0; i < N; i++) { const b = randomBytes(2000 + (i * 37) % 4000); vault += b.length; put(mac.adapter, `folder${i % 20}/note-${i}.md`, b); }
  for (let i = 0; i < ATT; i++) { const b = randomBytes(1048576); vault += b.length; put(mac.adapter, `attachments/img-${i}.png`, b); }
  report.config.vaultBytes = vault;
  if (!options.json) console.log(`vault: ${N} notes + ${ATT} x 1 MiB attachments = ${mb(vault)}, remote layout ${LAYOUT}`);
  // Earlier rounds establish the same state for any selected later measurement.
  const last = Math.max(...options.rounds.map(id => ids.indexOf(id)));
  await round('upload', 'Mac initial upload (mobile code path)', mac);
  if (last >= 1) await round('download', 'phone initial download', phone);
  if (last >= 2) await round('idle', 'phone IDLE sync (nothing changed anywhere)', phone);
  if (last >= 3) { phone.adapter.put('folder0/note-0.md', 'one small edit'); await round('edit', 'phone sync after editing ONE note', phone); }
  if (last >= 4) await round('idle2', 'phone second IDLE sync', phone);
  if (last >= 5) { phone.adapter.put('folder0/note-0.md', 'one more small edit'); await round('incremental', 'phone incremental sync after editing ONE note', phone, { full: false, dirty: ['folder0/note-0.md'] }); }
  report.stateFileSizes = [...phone.adapter.files.entries()].filter(([k]) => /state-[01]\.json$/.test(k)).map(([, v]) => v.length);
  if (options.assert) report.assertions = evaluateThresholds();
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('\nstate file sizes (bytes):', report.stateFileSizes);
    if (report.assertions) console.log('Thresholds:', JSON.stringify(report.assertions, null, 2));
  }
  if (report.assertions && !report.assertions.passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
