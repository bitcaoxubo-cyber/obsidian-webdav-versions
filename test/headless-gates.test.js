'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Gates, scanVault, validateNames, missingFiles } = require('../headless/gates');

function fixture(t, options = {}, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-gates-'));
  const config = { vaultDir: path.join(root, 'vault'), stateDir: path.join(root, 'state'), settleSeconds: 0, deletionLimit: 20, ...options };
  fs.mkdirSync(config.vaultDir); fs.mkdirSync(config.stateDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gates = new Gates(config, { sleep: async () => {}, ...deps });
  gates.initializeBaseline();
  const put = (name, text = 'note') => { const file = path.join(config.vaultDir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const remove = name => fs.rmSync(path.join(config.vaultDir, name));
  const seed = async count => { for (let i = 0; i < count; i++) put('note-' + i + '.md'); await gates.saveBaselineAfterSuccess(); };
  return { config, gates, put, remove, seed, root };
}
const snapshot = (paths, directories = []) => ({ files: paths.map(name => ({ path: name, size: 4, mtimeMs: 100 })), directories });

test('H11 stable scan sees size changes, additions, removals and empty-directory changes', async t => {
  for (const change of ['size', 'add', 'remove', 'directory']) {
    await t.test(change, async t => {
      let mutate;
      const f = fixture(t, {}, { sleep: async () => { if (mutate) { const operation = mutate; mutate = null; operation(); } } });
      f.put('a.md', 'first half');
      mutate = () => {
        if (change === 'size') f.put('a.md', 'first half and second half');
        if (change === 'add') f.put('b.md');
        if (change === 'remove') f.remove('a.md');
        if (change === 'directory') fs.mkdirSync(path.join(f.config.vaultDir, 'empty'));
      };
      assert.equal((await f.gates.check()).ok, false);
      assert.equal((await f.gates.check()).ok, true);
    });
  }
});

test('H11 continuous instability reports ten-minute reason and stable scan resets it', async t => {
  let now = 0, version = 0, changing = true;
  const f = fixture(t, {}, { now: () => now, scanVault: () => ({ files: [{ path: 'a.md', size: changing ? version++ : 1, mtimeMs: 0 }], directories: [] }) });
  assert.match((await f.gates.check()).reason, /正在变化/);
  now = 600001;
  assert.match((await f.gates.check()).reason, /一直在变化/);
  changing = false;
  assert.equal((await f.gates.check()).ok, true);
  changing = true;
  assert.match((await f.gates.check()).reason, /正在变化/);
});

test('H12 H13 deletion threshold is strictly greater than twenty and reports at most twenty paths', async t => {
  const f = fixture(t);
  await f.seed(25);
  for (let i = 0; i < 20; i++) f.remove('note-' + i + '.md');
  assert.equal((await f.gates.check()).ok, true);
  f.remove('note-20.md');
  const result = await f.gates.check();
  assert.equal(result.ok, false);
  assert.equal(result.pendingDeletions.count, 21);
  assert.equal(result.pendingDeletions.paths.length, 20);
  assert.match(result.reason, /21/);
});

test('H14 empty vault pauses even for three deletions', async t => {
  const f = fixture(t);
  await f.seed(3);
  for (let i = 0; i < 3; i++) f.remove('note-' + i + '.md');
  const result = await f.gates.check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /全空/);
  assert.equal(result.pendingDeletions.count, 3);
});

test('H15 H16 missing vault pauses without recreating it and restoration automatically recovers', async t => {
  const f = fixture(t);
  await f.seed(3);
  const saved = path.join(f.root, 'saved');
  fs.renameSync(f.config.vaultDir, saved);
  assert.equal((await f.gates.check()).ok, false);
  assert.equal(fs.existsSync(f.config.vaultDir), false);
  fs.renameSync(saved, f.config.vaultDir);
  assert.equal((await f.gates.check()).ok, true);
});

test('H16 restoring a deleted batch recovers without approval', async t => {
  const f = fixture(t);
  await f.seed(25);
  for (let i = 0; i < 21; i++) f.remove('note-' + i + '.md');
  assert.equal((await f.gates.check()).ok, false);
  for (let i = 0; i < 21; i++) f.put('note-' + i + '.md');
  assert.equal((await f.gates.check()).ok, true);
});

test('H17 count must match, approval authorizes exactly one attempt even if sync fails', async t => {
  const f = fixture(t);
  await f.seed(25);
  for (let i = 0; i < 21; i++) f.remove('note-' + i + '.md');
  await assert.rejects(f.gates.approve(20), /数量不匹配/);
  assert.equal(fs.existsSync(f.gates.approvalFile), false);
  await f.gates.approve(21);
  assert.equal((await f.gates.check()).ok, true);
  assert.equal((await f.gates.check()).ok, false);
});

test('H17 an additional missing path invalidates approval permanently', async t => {
  const f = fixture(t);
  await f.seed(25);
  for (let i = 0; i < 21; i++) f.remove('note-' + i + '.md');
  await f.gates.approve(21);
  f.remove('note-21.md');
  assert.equal((await f.gates.check()).ok, false);
  f.put('note-21.md');
  assert.equal((await f.gates.check()).ok, false);
});

test('H17 replacing one missing path with another invalidates approval with the same count', async t => {
  const f = fixture(t);
  await f.seed(25);
  for (let i = 0; i < 21; i++) f.remove('note-' + i + '.md');
  await f.gates.approve(21);
  f.put('note-0.md'); f.remove('note-21.md');
  assert.equal((await f.gates.check()).ok, false);
});

test('H17 approval cannot be supplied inside the public vault', async t => {
  const f = fixture(t);
  await f.seed(3);
  for (let i = 0; i < 3; i++) f.remove('note-' + i + '.md');
  f.put('.deletion-approval.json', JSON.stringify({ count: 3 }));
  assert.equal((await f.gates.check()).ok, false);
});

test('H17 an observed unstable batch invalidates an older approval', async t => {
  let mutate;
  const f = fixture(t, {}, { sleep: async () => { if (mutate) { mutate(); mutate = null; } } });
  await f.seed(25);
  for (let i = 0; i < 21; i++) f.remove('note-' + i + '.md');
  await f.gates.approve(21);
  mutate = () => f.put('transient.md');
  assert.equal((await f.gates.check()).ok, false);
  f.remove('transient.md');
  assert.equal((await f.gates.check()).ok, false);
});

test('H18 thirty-file directory rename preserves metadata and does not pause', async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.put('old/' + i + '.md');
  await f.gates.saveBaselineAfterSuccess();
  fs.renameSync(path.join(f.config.vaultDir, 'old'), path.join(f.config.vaultDir, 'new'));
  assert.equal((await f.gates.check()).ok, true);
});

test('H18 rename credits are one-to-one and need both size and mtime', () => {
  const previous = snapshot(['a.md', 'b.md', 'c.md']).files;
  assert.deepEqual(missingFiles(previous, snapshot(['new.md']).files), ['b.md', 'c.md']);
  assert.deepEqual(missingFiles(previous, [{ path: 'new.md', size: 4, mtimeMs: 101 }]), ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(missingFiles(previous, [{ path: 'new.md', size: 5, mtimeMs: 100 }]), ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(missingFiles(previous, snapshot(['a.md']).files), ['b.md', 'c.md']);
});

test('H19 post-sync baseline incorporates thirty deletions made by the engine', async t => {
  const f = fixture(t);
  await f.seed(31);
  for (let i = 0; i < 30; i++) f.remove('note-' + i + '.md');
  await f.gates.saveBaselineAfterSuccess();
  assert.equal((await f.gates.check()).ok, true);
});

test('H20 bad names pause with Chinese explanation and recover after caller renames them', async t => {
  for (const name of ['Q: idea.md', 'draft.', 'draft ', 'a\\b.md', ...['*', '"', '<', '>', ':', '|', '?'].map(char => 'a' + char + 'b.md')]) {
    await t.test(name, async t => {
      const f = fixture(t);
      f.put(name, 'unchanged content');
      const before = fs.readFileSync(path.join(f.config.vaultDir, name));
      const result = await f.gates.check();
      assert.equal(result.ok, false);
      assert.ok(result.reason.includes(name));
      assert.match(result.reason, /名字|顶层/);
      assert.deepEqual(fs.readFileSync(path.join(f.config.vaultDir, name)), before);
      fs.renameSync(path.join(f.config.vaultDir, name), path.join(f.config.vaultDir, 'fixed.md'));
      assert.equal((await f.gates.check()).ok, true);
    });
  }
});

test('H20 collision comparison matches protocol folding for case, Unicode and ancestors', () => {
  for (const input of [snapshot(['A.md', 'a.md']), snapshot(['é.md', 'e\u0301.md']), snapshot(['Dir/a.md', 'dir/b.md'], ['Dir', 'dir']), snapshot(['ß.md', 'SS.md'])]) {
    assert.match(validateNames(input)[0].problem, /大小写或 Unicode/);
  }
});

test('H20 name errors are limited to twenty paths in the status reason', async t => {
  const f = fixture(t);
  for (let i = 0; i < 25; i++) f.put('bad' + String(i).padStart(2, '0') + '?.md');
  const result = await f.gates.check();
  assert.ok(result.reason.includes('bad19?.md'));
  assert.equal(result.reason.includes('bad20?.md'), false);
  assert.match(result.reason, /其余 5 项/);
});

test('H21 hidden files, hidden folders, conflict copies and empty folders do not pause', async t => {
  const f = fixture(t);
  f.put('good.md'); f.put('.hidden?.md'); f.put('.hidden/another?.md');
  f.put('a (sync-conflict NAS revision).md');
  fs.mkdirSync(path.join(f.config.vaultDir, 'empty'));
  const result = await f.gates.check();
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.directories, ['empty']);
  assert.equal(result.snapshot.files.some(file => file.path.startsWith('.')), false);
  assert.ok(fs.statSync(path.join(f.config.vaultDir, 'empty')).isDirectory());
});

test('scanning never follows symbolic links and refuses a linked vault root', async t => {
  const f = fixture(t);
  const external = path.join(f.root, 'external'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'outside.md'), 'external content');
  fs.symlinkSync(external, path.join(f.config.vaultDir, 'link'));
  assert.deepEqual(scanVault(f.config.vaultDir), { files: [], directories: [] });
  fs.renameSync(f.config.vaultDir, path.join(f.root, 'original'));
  fs.symlinkSync(external, f.config.vaultDir);
  assert.equal((await f.gates.check()).ok, false);
});

test('baseline missing or corrupt fails closed instead of disabling deletion protection', async t => {
  const f = fixture(t);
  fs.rmSync(f.gates.baselineFile);
  await assert.rejects(f.gates.check(), /清单缺失或损坏/);
  fs.writeFileSync(f.gates.baselineFile, JSON.stringify({ version: 1, files: [], checksum: 'wrong' }));
  await assert.rejects(f.gates.check(), /清单缺失或损坏/);
});

test('corrupt approval is discarded and never authorizes deletion', async t => {
  const f = fixture(t);
  await f.seed(3);
  for (let i = 0; i < 3; i++) f.remove('note-' + i + '.md');
  fs.writeFileSync(f.gates.approvalFile, '{');
  assert.equal((await f.gates.check()).ok, false);
  assert.equal(fs.existsSync(f.gates.approvalFile), false);
});

test('H20 real case-colliding files and directories pause and recover on a case-sensitive filesystem', async t => {
  const f = fixture(t);
  f.put('A.md', 'upper'); f.put('a.md', 'lower');
  if (fs.readdirSync(f.config.vaultDir).length !== 2) {
    t.skip('This host filesystem folds case; the snapshot folding test still covers this rule.');
    return;
  }
  let result = await f.gates.check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /大小写/);
  assert.equal(fs.readFileSync(path.join(f.config.vaultDir, 'A.md'), 'utf8'), 'upper');
  assert.equal(fs.readFileSync(path.join(f.config.vaultDir, 'a.md'), 'utf8'), 'lower');
  fs.renameSync(path.join(f.config.vaultDir, 'a.md'), path.join(f.config.vaultDir, 'lower.md'));
  assert.equal((await f.gates.check()).ok, true);
  f.put('Dir/a.md'); f.put('dir/b.md');
  result = await f.gates.check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /大小写/);
  fs.renameSync(path.join(f.config.vaultDir, 'dir'), path.join(f.config.vaultDir, 'other'));
  assert.equal((await f.gates.check()).ok, true);
});

test('H15 unreadable vault pauses and permissions restored by the caller recover it', async t => {
  if (process.getuid?.() === 0) { t.skip('Root bypasses filesystem permissions.'); return; }
  const f = fixture(t);
  f.put('a.md');
  fs.chmodSync(f.config.vaultDir, 0);
  try { assert.equal((await f.gates.check()).ok, false); }
  finally { fs.chmodSync(f.config.vaultDir, 0o700); }
  assert.equal((await f.gates.check()).ok, true);
});
