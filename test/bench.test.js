'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Adapter } = require('./helpers/adapter');
const repo = path.resolve(__dirname, '..');
const bench = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts/bench-sync.js'), repo, '2', '0', 'v1', ...args], { encoding: 'utf8' });

test('Prep: benchmark JSON preserves all rounds and accounts for every adapter operation', () => {
  const run = bench('--json');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.rounds.map(r => r.id), ['upload', 'download', 'idle', 'edit', 'idle2', 'incremental']);
  assert.equal(report.config.fileCount, 2);
  assert.equal(report.config.vaultBytes, 4037);
  for (const round of report.rounds) {
    const a = round.adapter;
    assert.equal(a.totalCalls, Object.values(a.calls).reduce((s, n) => s + n, 0));
    for (const [method, n] of Object.entries(a.calls)) assert.equal(n, (a.vault.calls[method] || 0) + (a.private.calls[method] || 0));
    assert.equal(a.readBytes, a.vault.readBytes + a.private.readBytes);
    assert.equal(a.writeBytes, a.vault.writeBytes + a.private.writeBytes);
    assert.equal(round.hash.totalBytes, round.hash.js.bytes + round.hash.webcrypto.bytes);
    assert.equal(typeof round.hash.js.maxInputBytes, 'number');
    assert.equal(typeof round.hash.webcrypto.calls, 'number');
  }
});

test('Prep: benchmark assertions fail closed and latency/round selection remain measurable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-bench-'));
  try {
    const thresholds = path.join(dir, 'thresholds.json');
    fs.writeFileSync(thresholds, JSON.stringify({ rules: [{ round: 'upload', metric: 'http.totalCalls', max: 0 }] }));
    const failed = bench('--json', '--assert', thresholds, '--rounds', 'upload', '--latency', '1');
    assert.notEqual(failed.status, 0);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.assertions.passed, false);
    assert.match(report.assertions.failures[0], /upload.*http.totalCalls/);
    assert.deepEqual(report.rounds.map(r => r.id), ['upload']);
    assert.equal(report.config.latencyMs, 1);
    assert.ok(report.rounds[0].wallMs >= report.rounds[0].http.totalCalls * 0.5);
    fs.writeFileSync(thresholds, JSON.stringify({ rules: [{ round: 'upload', metric: 'http.totalCalls', max: 100 }] }));
    assert.equal(bench('--json', '--assert', thresholds, '--rounds', 'upload').status, 0);
    assert.notEqual(bench('--json', '--latency', '-1').status, 0);
    assert.notEqual(bench('--json', '--rounds', 'unknown').status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Prep: adapter mtimes advance on every file mutation and support recent-time fixtures', async () => {
  const adapter = new Adapter();
  adapter.put('a.md', 'one');
  let previous = (await adapter.stat('a.md')).mtime;
  assert.ok(Number.isFinite(previous));
  assert.ok(previous < Date.now() - 2000);
  for (const action of [() => adapter.put('a.md', 'two'), () => adapter.writeBinary('a.md', new Uint8Array([3]).buffer), () => adapter.copy('a.md', 'b.md'), () => adapter.rename('b.md', 'c.md')]) {
    await action();
    const latest = Math.max(...[...adapter.files.keys()].map(p => adapter.mtimes.get(p)));
    assert.ok(latest > previous);
    previous = latest;
  }
  adapter.setTime(Date.now());
  adapter.put('recent.md', 'recent');
  assert.ok((await adapter.stat('recent.md')).mtime >= Date.now() - 100);
});

test('C2: marginal upload requests exclude session overhead and fail above five per added file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-marginal-'));
  try {
    const thresholds = path.join(dir, 'thresholds.json'), previous = path.join(dir, 'previous.json');
    fs.writeFileSync(thresholds, JSON.stringify({ rules: [{ round: 'upload', metric: 'http.totalCalls', maxMarginalPerFile: 5 }] }));
    const small = spawnSync(process.execPath, [path.join(repo, 'scripts/bench-sync.js'), repo, '1', '0', 'v1', '--rounds', 'upload', '--json'], { encoding: 'utf8' });
    assert.equal(small.status, 0, small.stderr);
    fs.writeFileSync(previous, small.stdout);
    const valid = bench('--json', '--rounds', 'upload', '--assert', thresholds, '--compare', previous);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    const accepted = JSON.parse(valid.stdout);
    assert.equal(accepted.assertions.checked[0].value, 5);
    assert.equal(accepted.assertions.checked[0].max, 5);
    assert.equal(accepted.assertions.checked[0].comparison.fileDelta, 1);
    assert.equal(accepted.assertions.checked[0].comparison.metricDelta, 5);
    assert.ok(accepted.rounds[0].http.totalCalls / accepted.config.fileCount > 5);
    const tooMany = JSON.parse(small.stdout);
    tooMany.rounds[0].http.totalCalls--;
    fs.writeFileSync(previous, JSON.stringify(tooMany));
    const rejected = bench('--json', '--rounds', 'upload', '--assert', thresholds, '--compare', previous);
    assert.notEqual(rejected.status, 0);
    const result = JSON.parse(rejected.stdout);
    assert.equal(result.assertions.passed, false);
    assert.equal(result.assertions.checked[0].value, 6);
    assert.match(result.assertions.failures[0], /upload.*http.totalCalls.*6.*5/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('C2: marginal comparisons reject missing baselines, invalid file deltas and different layouts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-marginal-guards-'));
  try {
    const thresholds = path.join(dir, 'thresholds.json'), previous = path.join(dir, 'previous.json');
    fs.writeFileSync(thresholds, JSON.stringify({ rules: [{ round: 'upload', metric: 'http.totalCalls', maxMarginalPerFile: 5 }] }));
    const args = ['--json', '--rounds', 'upload', '--assert', thresholds];
    const missing = bench(...args);
    assert.notEqual(missing.status, 0);
    assert.match(JSON.parse(missing.stdout).assertions.failures[0], /comparison report/);
    const baseline = { config: { fileCount: 1, layout: 'v1' }, rounds: [{ id: 'upload', http: { totalCalls: 14 } }] };
    const invalid = [];
    for (const count of [undefined, null, 0, -1, 1.5, '1', 2, 3, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ value: { ...baseline, config: { ...baseline.config, fileCount: count } }, error: /file counts|file delta/ });
    }
    invalid.push({ value: { ...baseline, config: { ...baseline.config, layout: 'v2' } }, error: /layouts/ });
    invalid.push({ value: { ...baseline, rounds: [] }, error: /comparison value/ });
    invalid.push({ value: { ...baseline, rounds: [{ id: 'upload', http: { totalCalls: -1 } }] }, error: /comparison value/ });
    for (const { value, error } of invalid) {
      fs.writeFileSync(previous, JSON.stringify(value));
      const run = bench(...args, '--compare', previous);
      assert.notEqual(run.status, 0, JSON.stringify(value));
      const result = JSON.parse(run.stdout);
      assert.equal(result.assertions.passed, false);
      assert.match(result.assertions.failures[0], error);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('C2: stage B leaves upload slope to the scaling comparison', () => {
  const thresholds = JSON.parse(fs.readFileSync(path.join(repo, 'docs/perf/thresholds.json'), 'utf8'));
  assert.equal(thresholds.stages.B.some(rule => rule.round === 'upload' && rule.metric === 'http.totalCalls'), false);
  assert.deepEqual(thresholds.stages.scaling.find(rule => rule.round === 'upload'), { round: 'upload', metric: 'http.totalCalls', maxMarginalPerFile: 5 });
});
