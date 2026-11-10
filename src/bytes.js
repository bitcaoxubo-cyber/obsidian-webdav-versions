'use strict';

// Portable byte operations. No Buffer, Node or Electron globals on mobile.
const encoder = new TextEncoder();
function bytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected text or bytes');
}
const byteLength = text => encoder.encode(text).length;
const text = value => new TextDecoder('utf-8', { fatal: true }).decode(value);
function arrayBuffer(value) { const b = bytes(value); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function base64(value) {
  const b = bytes(value); let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(out);
}
function fromBase64(value) { return Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); }
function randomUUID() {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('此环境缺少安全随机数；请更新 Obsidian。');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// SHA-256 (FIPS 180-4), incremental compression without duplicating an attachment.
// Synchronous so revision IDs and the existing v1 protocol remain byte-for-byte compatible.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function digest(value) {
  const data = bytes(value);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  function block(b, offset) {
    for (let i = 0; i < 16; i++) { const p = offset + i * 4; w[i] = (b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3]; }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      w[i] = (w[i-16] + (rotr(x,7)^rotr(x,18)^(x>>>3)) + w[i-7] + (rotr(y,17)^rotr(y,19)^(y>>>10))) >>> 0;
    }
    let [a,b0,c,d,e,f,g,h0] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (h0 + (rotr(e,6)^rotr(e,11)^rotr(e,25)) + ((e&f)^(~e&g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a,2)^rotr(a,13)^rotr(a,22)) + ((a&b0)^(a&c)^(b0&c))) >>> 0;
      h0=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b0; b0=a; a=(t1+t2)>>>0;
    }
    for (const [i, n] of [a,b0,c,d,e,f,g,h0].entries()) h[i] = (h[i] + n) >>> 0;
  }
  const full = data.length - data.length % 64;
  for (let i = 0; i < full; i += 64) block(data, i);
  const tail = new Uint8Array(data.length % 64 < 56 ? 64 : 128);
  tail.set(data.subarray(full)); tail[data.length % 64] = 128;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length-8, Math.floor(data.length / 0x20000000));
  view.setUint32(tail.length-4, (data.length * 8) >>> 0);
  block(tail,0); if (tail.length === 128) block(tail,64);
  return [...h].map(n => n.toString(16).padStart(8,'0')).join('');
}
module.exports = { bytes, text, byteLength, arrayBuffer, base64, fromBase64, randomUUID, digest };
