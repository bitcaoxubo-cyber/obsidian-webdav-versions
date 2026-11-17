'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AdaptiveDavRemote } = require('../src/sharded');
const { publicText } = require('./io');
const FIELDS = new Set(['url', 'username', 'password', 'passwordFile', 'device', 'dataDir', 'intervalSeconds', 'settleSeconds', 'deletionLimit', 'allowInsecureLoopback']);
function loadConfig(file, { env = process.env } = {}) {
  if (!file) throw new Error('请用 --config 或 HEADLESS_CONFIG 指定 JSON 配置文件。');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('配置文件无法读取或不是有效 JSON。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须是 JSON 对象。');
  // Resolve possible credentials before formatting validation errors. Never
  // echo a mistyped field name which happens to contain a configured password.
  let filePassword;
  if (typeof raw.passwordFile === 'string' && raw.passwordFile) {
    try { filePassword = fs.readFileSync(path.resolve(path.dirname(path.resolve(file)), raw.passwordFile), 'utf8').replace(/\r?\n$/, ''); } catch {}
  }
  try {
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) throw new Error('配置含未知字段：' + (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : '[字段名已隐藏]'));
  for (const key of ['url', 'username', 'password', 'passwordFile', 'device', 'dataDir']) {
    if (Object.hasOwn(raw, key) && (typeof raw[key] !== 'string' || !raw[key].length)) throw new Error('配置项 ' + key + ' 必须是非空字符串。');
  }
  for (const key of ['url', 'username', 'dataDir']) if (!raw[key]) throw new Error('缺少配置项：' + key);
  const config = { device: 'NAS', intervalSeconds: 30, settleSeconds: 5, deletionLimit: 20, allowInsecureLoopback: false, ...raw };
  for (const key of ['intervalSeconds', 'settleSeconds']) if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) throw new Error('配置项 ' + key + ' 必须是大于 0 的有限数值。');
  if (!Number.isSafeInteger(config.deletionLimit) || config.deletionLimit < 0) throw new Error('配置项 deletionLimit 必须是非负安全整数。');
  if (typeof config.allowInsecureLoopback !== 'boolean') throw new Error('配置项 allowInsecureLoopback 必须是布尔值。');
  if (!config.device.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(config.device) || Buffer.byteLength(config.device) > 256) throw new Error('配置项 device 格式无效。');
  if (Object.hasOwn(env, 'HEADLESS_PASSWORD')) config.password = env.HEADLESS_PASSWORD;
  else if (config.passwordFile) {
    try { config.password = fs.readFileSync(path.resolve(path.dirname(path.resolve(file)), config.passwordFile), 'utf8').replace(/\r?\n$/, ''); }
    catch { throw new Error('配置项 passwordFile 无法读取。'); }
  }
  if (typeof config.password !== 'string' || !config.password.length) throw new Error('缺少密码；请设置 password、passwordFile 或 HEADLESS_PASSWORD。');
  try { new AdaptiveDavRemote(config); } catch (e) { throw new Error('配置项 url 或 username 无效：' + e.message); }
  config.dataDir = path.resolve(path.dirname(path.resolve(file)), config.dataDir);
  config.vaultDir = path.join(config.dataDir, 'vault'); config.stateDir = path.join(config.dataDir, 'state');
  return config;
  } catch (error) {
    let message = error.message;
    for (const password of [raw.password, env.HEADLESS_PASSWORD, filePassword].filter(value => typeof value === 'string' && value)) message = publicText(message, { password });
    throw new Error(message);
  }
}
module.exports = { loadConfig };
