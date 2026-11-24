'use strict';
const fs = require('node:fs');

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { throw new Error(`${file} 缺失或不可读，请提供可读取的文件。`); }
}

function readJson(file) {
  const text = readText(file);
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${file} 的 JSON 无法解析，应为有效的 JSON 对象。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} 的内容为 ${JSON.stringify(value)}，应为 JSON 对象。`);
  }
  return value;
}

const numeric = /^\d+$/;
function parseVersion(value, source) {
  const format = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const match = typeof value === 'string' && format.exec(value);
  const pre = match && match[4] ? match[4].split('.') : [];
  if (!match || match[0] !== value || pre.some(id => /^0\d+$/.test(id))) {
    throw new Error(`${source} 的版本号为 ${JSON.stringify(value) ?? '空缺'}，应符合 SemVer 2.0.0。`);
  }
  return { core: match.slice(1, 4), pre };
}

function compareIdentifier(a, b) {
  if (a === b) return 0;
  const aNumeric = numeric.test(a), bNumeric = numeric.test(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  // Numeric identifiers have no leading zeros and can exceed Number's precision.
  if (aNumeric && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : 1;
}

function compareVersions(a, b) {
  for (let i = 0; i < a.core.length; i++) {
    const order = compareIdentifier(a.core[i], b.core[i]);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const order = compareIdentifier(a.pre[i], b.pre[i]);
    if (order) return order;
  }
  return a.pre.length - b.pre.length;
}

function firstHeading(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  let start = 0;
  if (lines[0].trimEnd() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (end !== -1) start = end + 1;
  }
  let fence = '', previous = '', inComment = false;
  for (let i = start; i < lines.length; i++) {
    let line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
      continue;
    }
    if (marker && !inComment) { fence = marker[1]; previous = ''; continue; }
    // A commented-out heading or version is not part of the published title.
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open !== -1) { line = line.slice(0, open); inComment = true; }
    const heading = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/);
    if (heading) return heading[1] || '';
    if (previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return previous;
    previous = /^(?: {4}|\t)/.test(line) ? '' : line.trim();
  }
  return '';
}

function releaseType() {
  const { version, minAppVersion } = readJson('manifest.json');
  const pkg = readJson('package.json');
  if (pkg.version !== version) {
    throw new Error(`package.json 的版本号为 ${JSON.stringify(pkg.version) ?? '空缺'}，应与 manifest.json 的 ${JSON.stringify(version) ?? '空缺'} 一致。`);
  }

  const history = readJson('versions.json');
  if (typeof minAppVersion !== 'string' || !minAppVersion) {
    throw new Error(`manifest.json 的 minAppVersion 为 ${JSON.stringify(minAppVersion) ?? '空缺'}，应填写最低 Obsidian 版本号。`);
  }
  if (!Object.hasOwn(history, version) || history[version] !== minAppVersion) {
    const actual = Object.hasOwn(history, version) ? JSON.stringify(history[version]) : '缺失';
    throw new Error(`versions.json 中版本 ${JSON.stringify(version)} 的条目为 ${actual}，应为 ${JSON.stringify(minAppVersion)}。`);
  }

  const candidate = parseVersion(version, 'manifest.json');
  for (const other of Object.keys(history)) {
    if (other === version) continue;
    const order = compareVersions(candidate, parseVersion(other, 'versions.json'));
    if (order <= 0) {
      const relation = order < 0 ? `小于已发布的 ${other}` : `与已发布的 ${other} 优先级相同`;
      throw new Error(`发布版本 ${version} ${relation}，应高于所有已发布版本。`);
    }
  }

  const heading = firstHeading(readText('docs/RELEASE.md'));
  const tokens = heading.match(/[0-9A-Za-z+-]+(?:\.[0-9A-Za-z+-]+)*/g) || [];
  if (!tokens.includes(version)) {
    throw new Error(`docs/RELEASE.md 的首个标题为 ${JSON.stringify(heading)}，应含完整版本号 ${version}。`);
  }
  return version.includes('-') ? 'prerelease' : 'stable';
}

try { console.log(releaseType()); }
catch (error) { console.error(error.message); process.exitCode = 1; }
