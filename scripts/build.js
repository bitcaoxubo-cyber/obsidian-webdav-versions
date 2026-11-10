'use strict';
// Package all project modules as static CommonJS factories. Obsidian and the
// desktop Node built-ins are provided by the host. No runtime eval or installer.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
function modules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? modules(file) : e.name.endsWith('.js') ? [file] : [];
  });
}
const body = modules(src).map(file => {
  const id = path.relative(src, file).slice(0, -3);
  return JSON.stringify(id) + ':function(module,exports,require){\n' + fs.readFileSync(file, 'utf8') + '\n}';
}).join(',\n');
const loader = `
const nativeRequire = require;
const cache = Object.create(null);
function load(id) {
  if (cache[id]) return cache[id].exports;
  if (!Object.hasOwn(factories, id)) throw new Error('Unknown local module: ' + id);
  const mod = cache[id] = { exports: {} };
  const dir = id.split('/').slice(0,-1);
  factories[id](mod, mod.exports, name => name.startsWith('./') ? load([...dir, name.slice(2)].join('/')) : nativeRequire(name));
  return mod.exports;
}
module.exports = load('plugin');
`;
fs.writeFileSync(path.join(root, 'main.js'), '// Generated from src/ by scripts/build.js\nconst factories = {\n' + body + '\n};\n' + loader);
