'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/release-check.js');
const minAppVersion = '1.11.4';

function runCheck(t, {
  version = '0.4.1',
  packageVersion = version,
  previous = [],
  versions = Object.fromEntries([...previous, version].map(key => [key, minAppVersion])),
  notes = '# WebDAV Versions ' + version + ' 正式说明\n',
} = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'manifest.json'), JSON.stringify({ version, minAppVersion }));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: packageVersion }));
  fs.writeFileSync(path.join(cwd, 'versions.json'), JSON.stringify(versions));
  fs.writeFileSync(path.join(cwd, 'docs/RELEASE.md'), notes);
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function rejected(result, ...values) {
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  const message = result.stderr.trimEnd();
  assert.doesNotMatch(message, /[\r\n]/);
  assert.match(message, /\p{Script=Han}/u);
  for (const value of values) assert.ok(message.includes(value), message);
  return message;
}

const betas = Array.from({ length: 6 }, (_, index) => '0.4.0-beta.' + (index + 1));
const priorStable = [...betas, '0.4.0'];
for (const [version, previous, channel] of [
  ['0.4.0', betas, 'stable'],
  ['0.4.1-beta.1', priorStable, 'prerelease'],
  ['0.5.0-beta.1', priorStable, 'prerelease'],
  ['0.4.1', [...priorStable, '0.4.1-beta.1'], 'stable'],
  ['0.4.1-beta.10', ['0.4.1-beta.9'], 'prerelease'],
  ['0.4.1-rc.1', ['0.4.1-beta.2'], 'prerelease'],
  ['0.4.1-alpha', ['0.4.1-99'], 'prerelease'],
  ['0.4.1-rc.1', ['0.4.1-rc'], 'prerelease'],
  ['0.4.1-beta.9007199254740993', ['0.4.1-beta.9007199254740992'], 'prerelease'],
]) {
  test(`release check accepts ${version} after ${previous.at(-1)} as ${channel}`, t => {
    const result = runCheck(t, { version, previous });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, channel + '\n');
    assert.equal(result.stderr, '');
  });
}

test('release check rejects the next beta when its stable release was already published', t => {
  const message = rejected(runCheck(t, { version: '0.4.0-beta.7', previous: priorStable }), '0.4.0-beta.7');
  assert.match(message, /0\.4\.0(?![-+.0-9A-Za-z])/);
});

test('release check rejects equal precedence despite different build metadata', t => {
  rejected(runCheck(t, { version: '0.4.1+new', previous: ['0.4.1+old'] }), '0.4.1+new', '0.4.1+old');
});

test('release check reports mismatched manifest and package versions before checking the history', t => {
  rejected(runCheck(t, { packageVersion: '0.4.2', versions: {} }), '0.4.1', '0.4.2');
});

test('release check rejects a missing minimum-app-version entry', t => {
  rejected(runCheck(t, { versions: { '0.4.0': minAppVersion } }), '0.4.1');
});

test('release check reports actual and required minimum app versions', t => {
  rejected(runCheck(t, { versions: { '0.4.1': '1.9.0' } }), '1.9.0', minAppVersion);
});

test('release check only accepts a version in the first heading', t => {
  rejected(runCheck(t, { notes: '0.4.1\n\n## 旧版说明 0.4.0\n\n# 0.4.1\n' }), '0.4.1');
});

for (const longer of ['0.4.1-beta.2', '10.4.1', '0.4.10', '0.4.1+build.2']) {
  test(`release check rejects 0.4.1 as part of heading version ${longer}`, t => {
    rejected(runCheck(t, { notes: '# 发布 ' + longer + '\n' }), '0.4.1');
  });
}

for (const [source, example] of [
  ['fenced example', '~~~markdown\n# WebDAV 0.4.1\n~~~'],
  ['multiline HTML comment', '<!--\n# WebDAV 0.4.1\n-->'],
]) {
  test('release check skips a heading inside a ' + source, t => {
    const notes = example + '\n\n# WebDAV 0.4.0\n\n正文中提到 0.4.1。\n';
    rejected(runCheck(t, { notes }), '0.4.1', '0.4.0');
  });
}

test('release check locates the first rendered heading after YAML front matter', t => {
  const notes = '---\ntitle: 更新记录\n# 0.4.0\n---\n\n# WebDAV Versions 0.4.1\n';
  const result = runCheck(t, { notes });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'stable\n');
  assert.equal(result.stderr, '');
});

test('release check rejects numeric prerelease identifiers with leading zeros', t => {
  rejected(runCheck(t, { version: '0.4.1-beta.01' }), '0.4.1-beta.01');
});
