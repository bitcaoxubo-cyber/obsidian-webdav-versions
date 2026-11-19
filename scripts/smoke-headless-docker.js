'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { fakeDav } = require('../test/helpers/headless-dav');
const { digest, makeRevision } = require('../src/protocol');

test('native Docker image initializes and syncs through the release Compose file', async t => {
  const image = 'obsidian-webdav-headless:' + require('../manifest.json').version;
  const defaultUser = await exec('docker', ['run', '--rm', '--entrypoint', 'id', image, '-u']);
  assert.ok(Number(defaultUser.stdout.trim()) > 0, 'image defaults to a non-root user');
  const uid = process.getuid();
  assert.notEqual(uid, 0, 'run the smoke test as a non-root user with Docker access');

  const dav = await fakeDav(t);
  const remote = dav.remote();
  const body = Buffer.from('remote smoke note');
  const blob = digest(body);
  await remote.putBlob(blob, body);
  await remote.putRevision(makeRevision({ path: 'download.md', parents: [], blob, device: 'smoke-peer' }));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-docker-'));
  const data = path.join(root, 'data');
  const config = path.join(root, 'config.json');
  const password = path.join(root, 'webdav-password');
  const override = path.join(root, 'loopback.yaml');
  const env = { ...process.env, NAS_SYNC_IMAGE: image, NAS_SYNC_UID: String(uid), NAS_SYNC_GID: String(process.getgid()),
    NAS_SYNC_DATA: data, NAS_SYNC_CONFIG: config, NAS_SYNC_PASSWORD_FILE: password };
  const composeFile = path.resolve(__dirname, '../headless/docker-compose.example.yml');
  const compose = (...args) => exec('docker', ['compose', '-p', 'nas-smoke-' + process.pid, '-f', composeFile, '-f', override, ...args], { env });
  const run = (...args) => compose('run', '--rm', '--no-deps', '-T', 'sync', ...args);

  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(config, JSON.stringify({ ...require('../headless/config.example.json'), url: dav.url, username: dav.username,
    allowInsecureLoopback: true, settleSeconds: 0.05 }), { mode: 0o600 });
  fs.writeFileSync(password, dav.password, { mode: 0o600 });
  // Use the runner's loopback for the temporary test server only.
  fs.writeFileSync(override, 'services:\n  sync:\n    network_mode: host\n');
  t.after(async () => {
    try { await compose('down'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  assert.equal((await compose('config', '--images')).stdout.trim(), image);
  await run('init');
  const vault = path.join(data, 'vault');
  fs.writeFileSync(path.join(vault, 'upload.md'), 'local smoke note');
  await run('run', '--once');
  await run('status', '--check');
  assert.equal(fs.readFileSync(path.join(vault, 'download.md'), 'utf8'), body.toString());
  assert.equal(fs.statSync(path.join(vault, 'download.md')).uid, uid);
  const uploaded = (await remote.listRevisions()).find(row => row.path === 'upload.md');
  assert.ok(uploaded?.blob);
  assert.equal(Buffer.from(await remote.getBlob(uploaded.blob)).toString(), 'local smoke note');
});
