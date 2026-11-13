'use strict';

// Serves Webserver/www the way Apache did, minus PHP:
//   - folders use index.html, then index.php (Apache's DirectoryIndex order);
//   - a .php file that only prints fixed text (optionally with header()
//     calls) is served as that text, with its Content-Type;
//   - a .php file with real logic that routes.js does not port gets 501;
//   - .ashx and every other file are sent as-is (Apache never ran .ashx
//     through PHP either).
// Paths match case-insensitively, like Apache on Windows, so the same tree
// also works on Linux. Dot-folders (.test, .127.0.0.1), private keys and
// folder listings are not served.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const STATIC_TYPES = {
  html: 'text/html', htm: 'text/html', txt: 'text/plain', xml: 'text/xml', json: 'application/json',
  lua: 'text/plain', ashx: 'text/plain', aspx: 'text/plain', js: 'application/javascript', css: 'text/css',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', rbxl: 'application/octet-stream',
  rbxlx: 'application/octet-stream', rbxm: 'application/octet-stream', rbxmx: 'application/octet-stream',
};
const BLOCKED = new Set(['.pem', '.key', '.crt', '.cert', '.htaccess', '.htpasswd']);

function resolve(relative) {
  let current = core.WWW;
  for (const segment of relative.split('/')) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..' || segment.startsWith('.') || /[\\:\x00]/.test(segment)) return null;
    let next = path.join(current, segment);
    if (!fs.existsSync(next)) {
      let entries;
      try {
        entries = fs.readdirSync(current);
      } catch (error) {
        return null;
      }
      const lower = segment.toLowerCase();
      const match = entries.find((entry) => entry.toLowerCase() === lower);
      if (match === undefined) return null;
      next = path.join(current, match);
    }
    current = next;
  }
  return current;
}

// Splits PHP source into literal and code segments the way the PHP lexer
// does: "<?php" (short tags are off) or "<?=" opens code, "?>" closes it
// and swallows one following newline. Always ends with a literal segment.
function phpSegments(text) {
  const segments = [];
  const opener = /<\?(?:php(?=\s|$)|=)/gi;
  let position = 0;
  for (;;) {
    opener.lastIndex = position;
    const match = opener.exec(text);
    if (!match) {
      segments.push({ literal: true, text: text.slice(position) });
      return segments;
    }
    segments.push({ literal: true, text: text.slice(position, match.index) });
    const codeStart = match.index + match[0].length;
    const close = text.indexOf('?>', codeStart);
    segments.push({ literal: false, echo: match[0] === '<?=', text: close < 0 ? text.slice(codeStart) : text.slice(codeStart, close) });
    if (close < 0) {
      segments.push({ literal: true, text: '' });
      return segments;
    }
    position = close + 2;
    if (text.startsWith('\r\n', position)) position += 2;
    else if (text[position] === '\n' || text[position] === '\r') position += 1;
  }
}

// Returns { body, contentType } when every code block only calls header()
// (or is a comment), else null.
function literalPhp(buffer) {
  const segments = phpSegments(buffer.toString('latin1'));
  let contentType = null;
  let body = '';
  const header = /^\s*header\s*\(\s*(["'])([^"'\\]*)\1\s*\)\s*;?/i;
  for (const segment of segments) {
    if (segment.literal) {
      body += segment.text;
      continue;
    }
    if (segment.echo) return null;
    let rest = segment.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|#).*$/gm, '');
    while (rest.trim() !== '') {
      const call = header.exec(rest);
      if (!call) return null;
      const colon = call[2].indexOf(':');
      if (colon > 0 && call[2].slice(0, colon).trim().toLowerCase() === 'content-type') {
        contentType = call[2].slice(colon + 1).trim();
      }
      rest = rest.slice(call[0].length);
    }
  }
  return { body: Buffer.from(body, 'latin1'), contentType: contentType || 'text/html' };
}

const literalCache = new Map();

function literalPhpFile(file) {
  const stamp = core.mtimeMs(file);
  const cached = literalCache.get(file);
  if (cached && cached.stamp === stamp) return cached.value;
  let value = null;
  try {
    value = literalPhp(fs.readFileSync(file));
  } catch (error) {
    value = null;
  }
  literalCache.set(file, { stamp, value });
  return value;
}

function directoryIndex(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return null;
  }
  for (const name of ['index.html', 'index.php']) {
    const match = entries.find((entry) => entry.toLowerCase() === name);
    if (match !== undefined && core.isFile(path.join(directory, match))) return path.join(directory, match);
  }
  return null;
}

const notPortedLogged = new Set();

// Returns true when it answered the request.
function serve(ctx, send, sendFile, log) {
  let file = resolve(ctx.path);
  if (file === null) return false;
  if (core.isDirectory(file)) {
    file = directoryIndex(file);
    if (file === null) return false;
  }
  if (!core.isFile(file) || BLOCKED.has(path.extname(file).toLowerCase())) return false;

  if (path.extname(file).toLowerCase() === '.php') {
    const literal = literalPhpFile(file);
    if (literal === null) {
      const relative = path.relative(core.WWW, file);
      if (!notPortedLogged.has(relative)) {
        notPortedLogged.add(relative);
        log(`not ported (needs PHP): ${relative}`);
      }
      send(ctx, 501, { 'Content-Type': 'text/plain; charset=utf-8' },
        `This endpoint ran PHP code that was not ported to the Node web server: ${relative}\n`);
      return true;
    }
    send(ctx, 200, { 'Content-Type': literal.contentType }, literal.body);
    return true;
  }

  const extension = path.extname(file).slice(1).toLowerCase();
  sendFile(ctx, file, { 'Content-Type': STATIC_TYPES[extension] || 'application/octet-stream' });
  return true;
}

module.exports = { resolve, phpSegments, literalPhp, serve };
