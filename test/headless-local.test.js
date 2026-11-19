'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiskVault } = require('../src/local');

test('H2: DiskVault without options retains the original private directory and transaction path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = new DiskVault(root);
  const expected = path.join(fs.realpathSync(root), '.obsidian/plugins/obsidian-webdav-versions/local-state');
  assert.equal(vault.privateDir, expected);
  assert.equal(vault.transaction, path.join(expected, 'file-transaction'));
  assert.ok(fs.statSync(expected).isDirectory());
});

test('H2/H10: explicit external private directory creates no Obsidian directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notes = path.join(root, 'vault'), state = path.join(root, 'state');
  fs.mkdirSync(notes);
  const vault = new DiskVault(notes, '.obsidian', () => true, { privateDir: state });
  assert.equal(vault.privateDir, state);
  assert.equal(vault.transaction, path.join(state, 'file-transaction'));
  assert.deepEqual(fs.readdirSync(notes), []);
  assert.throws(() => new DiskVault(notes, '.obsidian', () => true, { privateDir: 'relative' }), /绝对路径/);
});
