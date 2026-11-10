'use strict';
const http = require('node:http');
const https = require('node:https');
// No automatic redirect (including same-host redirects). Never send a Basic
// credential to a location returned in a response or use a server href for GET.
function nodeRequest({ url, method, headers, body, limit }) {
  return new Promise((resolve, reject) => {
    let timer;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers, rejectUnauthorized: true }, res => {
      const chunks = [];
      let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > limit) req.destroy(new Error('response size'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (!res.complete) return reject(new Error('incomplete response'));
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    timer = setTimeout(() => req.destroy(new Error('deadline')), 10 * 60_000);
    req.setTimeout(60_000, () => req.destroy(new Error('idle timeout')));
    req.end(body);
  });
}

module.exports = { nodeRequest };
