'use strict';

// Downloading, caching and serving Roblox assets for the 2017 client.
// Port of Webserver/lib/legacy-assets.php + www/asset/index.php; the cache
// (RobloxClient/cache/assets), credentials and override folder are shared.

const fs = require('fs');
const path = require('path');
const core = require('./core');
const mesh = require('./mesh');

const USER_AGENT = 'Roblox/WinInet LegacyContentProvider/1.0';

// --- Credentials -------------------------------------------------------------

function apiKeyPath() {
  return core.rootPath('config', 'roblox-api-key.txt');
}

function cookiePath() {
  // Written by detect-roblox-user.ps1 -LoadAvatar.
  return core.rootPath('cache', '.roblosecurity');
}

function readSecret(file) {
  const text = core.readText(file);
  if (text === null) return null;
  for (let line of text.split(/\r\n|\r|\n/)) {
    line = line.trim();
    if (line !== '' && line[0] !== '#') {
      // Never let a stray newline or header separator into a request header.
      return /^[\x21-\x7e]+$/.test(line) ? line : null;
    }
  }
  return null;
}

function apiKey() {
  return readSecret(apiKeyPath());
}

function roblosecurity() {
  let cookie = readSecret(cookiePath());
  if (cookie !== null && cookie.toUpperCase().startsWith('.ROBLOSECURITY=')) {
    cookie = cookie.slice('.ROBLOSECURITY='.length);
  }
  return cookie;
}

function credentialsMtime() {
  return Math.max(core.mtimeMs(apiKeyPath()), core.mtimeMs(cookiePath()));
}

// --- HTTP -------------------------------------------------------------------

// fetch() asks for gzip/deflate/br and undoes any Content-Encoding itself.
async function httpRequest(url, headers, timeoutMs, postBody) {
  try {
    const response = await fetch(url, {
      method: postBody === undefined ? 'GET' : 'POST',
      headers: Object.assign({ 'User-Agent': USER_AGENT }, headers),
      body: postBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const location = response.headers.get('location');
    return {
      status: response.status,
      body,
      contentType: response.headers.get('content-type') || '',
      redirect: location ? new URL(location, url).toString() : '',
      error: '',
    };
  } catch (error) {
    const reason = error && error.cause && error.cause.code ? error.cause.code : (error && error.message) || String(error);
    return { status: 0, body: Buffer.alloc(0), contentType: '', redirect: '', error: reason };
  }
}

// Follows redirects by hand so credentials only go to the first host, never
// to the CDN the download redirects to.
async function httpGet(url, authHeaders, timeoutMs) {
  let headers = Object.assign({ Accept: '*/*' }, authHeaders);
  for (let hop = 0; hop < 6; hop++) {
    const response = await httpRequest(url, headers, timeoutMs);
    if (response.status >= 300 && response.status < 400 && response.redirect !== '') {
      url = response.redirect;
      headers = { Accept: '*/*' };
      continue;
    }
    return response;
  }
  return { status: 0, body: Buffer.alloc(0), contentType: '', redirect: '', error: 'Too many redirects' };
}

async function httpGetJson(url, timeoutMs) {
  const response = await httpRequest(url, { Accept: 'application/json' }, timeoutMs);
  if (response.status !== 200) return null;
  try {
    const data = JSON.parse(response.body.toString('utf8'));
    return data !== null && typeof data === 'object' ? data : null;
  } catch (error) {
    return null;
  }
}

// --- Downloads ----------------------------------------------------------------

function errorMessage(body) {
  if (body.length === 0 || body[0] !== 0x7b) return '';
  try {
    const data = JSON.parse(body.toString('utf8'));
    const message = data && data.errors && data.errors[0] && data.errors[0].message;
    return typeof message === 'string' ? message : '';
  } catch (error) {
    return '';
  }
}

function classify(response, via) {
  const body = response.body;
  const looksLikeError = body.length > 0 && body[0] === 0x7b
    && body.toString('latin1', 0, Math.min(256, body.length)).includes('"errors"');
  if (response.status >= 200 && response.status < 300 && body.length > 0 && !looksLikeError) {
    const contentType = response.contentType.split(';')[0].trim();
    return {
      ok: true, status: response.status, body,
      contentType: contentType === '' ? 'application/octet-stream' : contentType,
      via, message: '',
    };
  }
  let status = response.status;
  if (status >= 200 && status < 300) status = looksLikeError ? 404 : 502;
  let message = errorMessage(body);
  if (message === '' && response.error !== '') message = response.error;
  return { ok: false, status, body: Buffer.alloc(0), contentType: '', via, message };
}

// Anonymous first; on 401/403 retry with the Open Cloud API key and then the
// .ROBLOSECURITY cookie, whichever are configured.
// kind: 'id', 'assetversionid', or 'named' with value "<universeId>:<name>"
// (an rbxgameasset:// name, resolved by Roblox for that universe).
async function downloadAsset(kind, value) {
  let legacyUrl;
  if (kind === 'named') {
    const split = String(value).indexOf(':');
    const universe = String(value).slice(0, split);
    const name = String(value).slice(split + 1);
    legacyUrl = `https://assetdelivery.roblox.com/v1/asset/?universeId=${encodeURIComponent(universe)}&assetName=${encodeURIComponent(name)}`;
  } else {
    const query = kind === 'id' ? 'id' : 'assetversionid';
    legacyUrl = `https://assetdelivery.roblox.com/v1/asset/?${query}=${encodeURIComponent(value)}`;
  }

  let result = classify(await httpGet(legacyUrl, {}, 60000), 'anonymous');
  if (result.ok || (result.status !== 401 && result.status !== 403)) return result;
  const failures = [result];

  const key = apiKey();
  if (key !== null && kind === 'id') {
    const lookup = await httpRequest(
      `https://apis.roblox.com/asset-delivery-api/v1/assetId/${encodeURIComponent(value)}`,
      { Accept: 'application/json', 'x-api-key': key },
      30000
    );
    let location = null;
    if (lookup.status === 200) {
      try {
        const data = JSON.parse(lookup.body.toString('utf8'));
        if (data && typeof data.location === 'string' && /^https:\/\//i.test(data.location)) location = data.location;
      } catch (error) {
        location = null;
      }
    }
    if (location !== null) {
      result = classify(await httpGet(location, {}, 60000), 'api-key');
    } else {
      result = classify(lookup, 'api-key');
      if (result.ok) {
        result = { ok: false, status: 502, body: Buffer.alloc(0), contentType: '', via: 'api-key', message: 'Open Cloud returned no download location' };
      }
    }
    if (result.ok) return result;
    failures.push(result);
  }

  const cookie = roblosecurity();
  if (cookie !== null) {
    result = classify(await httpGet(legacyUrl, { Cookie: `.ROBLOSECURITY=${cookie}` }, 60000), 'cookie');
    if (result.ok) return result;
    failures.push(result);
  }

  // "Private" (403) is the more useful answer once credentials were tried.
  return failures.find((failure) => failure.status === 403) || failures[failures.length - 1];
}

// --- Overrides ---------------------------------------------------------------

const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav',
  lua: 'text/plain', txt: 'text/plain', rbxmx: 'text/xml', xml: 'text/xml',
};

function contentTypeFor(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  return CONTENT_TYPES[extension] || 'application/octet-stream';
}

// RobloxClient/assets-override/<relative>, with or without an extension.
function findOverride(relative) {
  const segments = relative.replace(/\\/g, '/').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\x00-\x1f:*?"<>|]/.test(segment)) return null;
  }
  const name = segments.pop().toLowerCase();
  const directory = core.rootPath('assets-override', ...segments);
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry);
    if (!core.isFile(full)) continue;
    const lower = entry.toLowerCase();
    if (lower === name || path.parse(lower).name === name) return full;
  }
  return null;
}

module.exports = {
  apiKey, roblosecurity, credentialsMtime,
  httpRequest, httpGet, httpGetJson,
  downloadAsset, findOverride, contentTypeFor,
  normalizeAsset: mesh.normalizeAsset, needsNormalizing: mesh.needsNormalizing, meshError: mesh.meshError,
};
