'use strict';
const http = require('node:http');
const { AdaptiveDavRemote, V2_NAMESPACE, FORMAT_TEXT } = require('../../src/sharded');
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const response = (p, dir) => `<d:response><d:href>${escape(encodeURI(p))}</d:href><d:propstat><d:prop><d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
async function fakeDav(t, options = {}) {
  const fixture = { entries: new Map(), dirs: new Set(['/vault/']), calls: [], failStatus: 0, intercept: options.intercept, username: 'local-test', password: 'HEADLESS_PASSWORD_SENTINEL_4e9f' };
  if (options.layout === 'v2') {
    fixture.dirs.add('/vault/' + V2_NAMESPACE + '/');
    fixture.entries.set('/vault/' + V2_NAMESPACE + '/format.json', Buffer.from(FORMAT_TEXT));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks), method = req.method;
      fixture.calls.push({ method, path: p });
      const send = (status, body = '') => { res.writeHead(status); res.end(body); };
      if (fixture.failStatus) return send(fixture.failStatus, fixture.password);
      if (req.headers.authorization !== 'Basic ' + Buffer.from(fixture.username + ':' + fixture.password).toString('base64')) return send(401, fixture.password);
      if (await fixture.intercept?.({ req, res, method, path: p, data, send, fixture })) return;
      if (method === 'PROPFIND') {
        if (!fixture.dirs.has(p)) return send(404);
        const direct = n => n.startsWith(p) && n !== p && !n.slice(p.length).replace(/\/$/, '').includes('/');
        const children = req.headers.depth === '0' ? [] : [...fixture.entries.keys(), ...fixture.dirs].filter(direct);
        return send(207, '<d:multistatus xmlns:d="DAV:">' + response(p, true) + children.map(n => response(n, fixture.dirs.has(n))).join('') + '</d:multistatus>');
      }
      if (method === 'GET') return fixture.entries.has(p) ? send(200, fixture.entries.get(p)) : send(404);
      if (method === 'MKCOL') {
        if (fixture.dirs.has(p)) return send(405);
        fixture.dirs.add(p); return send(201);
      }
      if (method === 'PUT') {
        if (!fixture.dirs.has(p.slice(0, p.lastIndexOf('/') + 1))) return send(409);
        fixture.entries.set(p, data); return send(201);
      }
      return send(405);
    } catch { res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  fixture.url = `http://127.0.0.1:${server.address().port}/vault/`;
  fixture.remote = () => new AdaptiveDavRemote({ url: fixture.url, username: fixture.username, password: fixture.password, allowInsecureLoopback: true });
  return fixture;
}
module.exports = { fakeDav };
