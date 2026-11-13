'use strict';

// A self-signed certificate for the launcher's local proxy, made once per PC
// with Node's own crypto (no openssl, nothing shipped with the launcher).
// Roblox Studio 2017 makes some requests over https to localhost (its start
// page, its own API calls) and accepts any certificate, so the proxy only
// needs one that names localhost.
//
//   const { cert, key } = require('./selfcert').load(dir)   // PEM strings

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAMES = ['localhost', '*.localhost', 'localhost.', '*.localhost.', 'www.localhost', 'api.localhost'];

// --- minimal DER ------------------------------------------------------------------------------

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), len(value.length), value]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const nul = () => Buffer.from([0x05, 0x00]);

function oid(text) {
  const parts = text.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let n = part;
    do { chunk.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(buffer) {
  let value = buffer;
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

function time(date) {
  const year = date.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return year < 2050 ? tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`)) : tlv(0x18, Buffer.from(`${year}${rest}`));
}

function name(commonName) {
  return seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));
}

// --- the certificate ----------------------------------------------------------------------------

function make() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid('1.2.840.113549.1.1.11'), nul()); // sha256WithRSAEncryption
  const now = new Date(Date.now() - 24 * 3600 * 1000);
  const until = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const altNames = seq(...NAMES.map((dns) => tlv(0x82, Buffer.from(dns))));
  const extensions = tlv(0xa3, seq(
    seq(oid('2.5.29.17'), tlv(0x04, altNames)), // subjectAltName
    seq(oid('2.5.29.19'), tlv(0x04, seq())), // basicConstraints: not a CA
  ));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // version 3
    integer(serial),
    algorithm,
    name('localhost'),
    seq(time(now), time(until)),
    name('localhost'),
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// The certificate in dir (proxy-cert.pem, proxy-key.pem), made on first use.
function load(dir) {
  const certFile = path.join(dir, 'proxy-cert.pem');
  const keyFile = path.join(dir, 'proxy-key.pem');
  try {
    const cert = fs.readFileSync(certFile, 'utf8');
    const key = fs.readFileSync(keyFile, 'utf8');
    if (new Date(new crypto.X509Certificate(cert).validTo) > new Date(Date.now() + 30 * 24 * 3600 * 1000)) return { cert, key };
  } catch (error) { /* make one */ }
  const made = make();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, made.key);
  fs.writeFileSync(certFile, made.cert);
  return made;
}

module.exports = { load, make, NAMES };
