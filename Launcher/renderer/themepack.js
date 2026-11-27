'use strict';

// Theme packs: one JSON file with a theme's colors, CSS and pictures, for the
// launcher (Settings > Theme > Import) and the website. CSS and pictures only:
// no scripts, nothing fetched from the internet. The format is described in
// theme-pack-format.md (shared notes); in short:
//   { "rbx2017Theme": 1, "name": "Sunset", "base": "web2016", "dark": false,
//     "vars": { "--accent": "#ff7a00" }, "css": "...",
//     "assets": { "sky.jpg": "data:image/jpeg;base64,..." }, "preview": "sky.jpg" }
// CSS refers to its pictures by name: url("sky.jpg").
//
// check() runs where a pack is stored (the launcher's main process, the site's
// import). compile() runs where it's shown: it lets the browser parse the CSS
// first (which undoes escapes like u\72l), checks it again and puts the
// pictures in. Works in Node 16 and Chromium 108 (the Windows 7 build).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThemePack = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const FORMAT = 1;
  const LIMITS = {
    file: 8 * 1024 * 1024, // the whole .json
    css: 400 * 1024,
    asset: 4 * 1024 * 1024, // one picture or font, as base64
    assets: 40,
    vars: 300,
    varValue: 2000,
  };
  const TARGETS = ['launcher', 'site'];
  // Bases the launcher no longer has (the Xbox looks): packs
  // built on them are refused there.
  const RETIRED = { launcher: ['xbox', 'xbox2016'] };
  const ASSET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/;
  const VAR_NAME = /^--[A-Za-z0-9_-]{1,60}$/;
  const DATA_URI = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml|avif)|font\/(?:woff2|woff|ttf|otf)|application\/(?:font-woff2?|x-font-ttf|x-font-otf|font-sfnt|vnd\.ms-opentype|octet-stream));base64,([A-Za-z0-9+/=\s]+)$/;

  function fail(text) {
    const error = new Error(text);
    error.themePack = true;
    throw error;
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'theme';
  }

  // A short, stable fingerprint of the pack (FNV-1a), for its id.
  function fingerprint(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (`0000000${hash.toString(16)}`).slice(-8);
  }

  // What a url(...) may point at: one of the pack's pictures (by name), or a
  // picture or font packed right into the CSS. Anything else is dropped.
  function urlTarget(raw, assets) {
    let value = String(raw).trim();
    if ((value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
    value = value.trim();
    if (/^asset:/i.test(value)) value = value.slice(6);
    if (assets && Object.prototype.hasOwnProperty.call(assets, value) && ASSET_NAME.test(value)) return { asset: value };
    if (DATA_URI.test(value.replace(/\s+/g, ''))) return { data: value.replace(/\s+/g, '') };
    return null;
  }

  // The CSS without anything that could fetch from elsewhere or run code.
  function cleanCss(css, assets) {
    let text = String(css || '');
    text = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' '); // comments (and one left open)
    // Escapes could spell "url" or "@import" in ways the lines below miss
    // (u\72l, \75 rl): spell them out, then drop any backslash left.
    text = text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (match, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
    }).replace(/\\(.)/g, '$1').replace(/\\/g, '');
    // No markup: CSS never needs "<" (">" is a selector combinator).
    text = text.replace(/</g, ' ');
    // At-rules that load or change parsing: @import, @charset, @namespace.
    text = text.replace(/@(?:-[a-z]+-)?(?:import|charset|namespace)\b[^;{}]*;?/gi, ' ');
    // url(...): quoted or bare.
    text = text.replace(/url\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)/gi, (match, inner) => {
      const target = urlTarget(inner, assets);
      if (!target) return 'none';
      return target.asset ? `url("asset:${target.asset}")` : `url("${target.data}")`;
    });
    // Functions that take a picture address as a plain string.
    text = text.replace(/(?:-webkit-)?(?:image-set|cross-fade|image)\s*\(|(?<![-\w])src\s*\(/gi, 'invalid(');
    // Old engines' script hooks (no effect in Chromium, but never kept).
    text = text.replace(/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/gi, 'invalid(');
    // compile() also lets the browser parse the result and checks it again.
    if (text.length > LIMITS.css) fail('Its CSS is too big.');
    return text;
  }

  function cleanValue(value, assets) {
    let text = cleanCss(String(value), assets).replace(/[;{}]/g, ' ').replace(/!\s*important/gi, ' ').trim();
    if (text.length > LIMITS.varValue) text = text.slice(0, LIMITS.varValue);
    return text;
  }

  // Checks a pack (its JSON text or the parsed object) and returns a clean
  // copy. options.bases: the built-in theme ids it may start from.
  // options.target: "launcher" or "site" (whose CSS to keep).
  function check(input, options = {}) {
    let pack = input;
    if (typeof input === 'string') {
      if (input.length > LIMITS.file) fail('That file is too big for a theme (8 MB at most).');
      try { pack = JSON.parse(input); } catch (error) { fail('That file is not a theme pack.'); }
    }
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) fail('That file is not a theme pack.');
    if (pack.rbx2017Theme !== FORMAT) fail(pack.rbx2017Theme > FORMAT ? 'That theme needs a newer launcher.' : 'That file is not a theme pack.');
    const name = cleanText(pack.name, 40);
    if (!name) fail('The theme has no name.');
    const target = TARGETS.includes(options.target) ? options.target : 'launcher';
    const targets = Array.isArray(pack.targets) ? pack.targets.filter((t) => TARGETS.includes(t)) : TARGETS.slice();
    if (!targets.includes(target)) fail(`That theme is only for the ${targets.join(' and ') || 'other'} side.`);
    if ((RETIRED[target] || []).includes(pack.base)) fail('That theme is built on the Xbox look, which the launcher no longer has.');

    const assets = {};
    let assetBytes = 0;
    if (pack.assets && typeof pack.assets === 'object') {
      const names = Object.keys(pack.assets);
      if (names.length > LIMITS.assets) fail(`A theme can have ${LIMITS.assets} pictures and fonts at most.`);
      for (const key of names) {
        const value = typeof pack.assets[key] === 'string' ? pack.assets[key].replace(/\s+/g, '') : '';
        if (!ASSET_NAME.test(key) || !DATA_URI.test(value)) continue;
        if (value.length > LIMITS.asset) fail(`"${cleanText(key, 64)}" is too big (4 MB at most).`);
        assetBytes += value.length;
        assets[key] = value;
      }
    }
    if (assetBytes > LIMITS.file) fail('Its pictures are too big together (8 MB at most).');

    const vars = {};
    if (pack.vars && typeof pack.vars === 'object') {
      const keys = Object.keys(pack.vars).slice(0, LIMITS.vars);
      for (const key of keys) {
        if (!VAR_NAME.test(key) || (typeof pack.vars[key] !== 'string' && typeof pack.vars[key] !== 'number')) continue;
        const value = cleanValue(pack.vars[key], assets);
        if (value) vars[key] = value;
      }
    }

    let css = pack.css;
    if (css && typeof css === 'object') css = css[target];
    css = typeof css === 'string' ? cleanCss(css, assets) : '';

    const bases = Array.isArray(options.bases) ? options.bases : null;
    const base = typeof pack.base === 'string' && /^[a-z0-9-]{1,32}$/.test(pack.base) && (!bases || bases.includes(pack.base))
      ? pack.base : (options.defaultBase || 'web2017');
    const year = Number(pack.year);
    const clean = {
      rbx2017Theme: FORMAT,
      name,
      base,
      targets,
      vars,
      css,
      assets,
    };
    if (Number.isInteger(year) && year >= 2004 && year <= 2040) clean.year = year;
    if (typeof pack.dark === 'boolean') clean.dark = pack.dark;
    const author = cleanText(pack.author, 40);
    if (author) clean.author = author;
    const description = cleanText(pack.description, 200);
    if (description) clean.description = description;
    if (typeof pack.preview === 'string' && assets[pack.preview] && /^data:image\//.test(assets[pack.preview])) clean.preview = pack.preview;
    clean.id = `${slug(name)}-${fingerprint(JSON.stringify([name, base, vars, css, Object.keys(assets).sort()]))}`;
    return clean;
  }

  // Puts the pictures in: url("asset:x") becomes the picture itself.
  function resolve(text, assets) {
    return String(text).replace(/url\("asset:([^"]+)"\)/g, (match, name) => (assets && assets[name] ? `url("${assets[name]}")` : 'none'));
  }

  // Lets the browser parse the CSS and write it back out (escapes undone,
  // one canonical form), then checks it again.
  function canonical(css, assets) {
    if (typeof CSSStyleSheet === 'undefined' || !css) return css;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      const parts = [];
      for (const rule of sheet.cssRules) parts.push(rule.cssText);
      return cleanCss(parts.join('\n'), assets);
    } catch (error) {
      return '';
    }
  }

  // A checked pack, ready for <html>: { id, name, base, dark, vars, css }.
  function compile(pack) {
    const assets = pack.assets || {};
    const css = resolve(canonical(cleanCss(pack.css || '', assets), assets), assets);
    const vars = {};
    for (const key of Object.keys(pack.vars || {})) {
      if (!VAR_NAME.test(key)) continue;
      vars[key] = resolve(cleanValue(pack.vars[key], assets), assets);
    }
    const out = { id: pack.id, name: pack.name, base: pack.base, vars, css };
    if (typeof pack.dark === 'boolean') out.dark = pack.dark;
    return out;
  }

  return { FORMAT, LIMITS, TARGETS, check, compile, cleanCss };
}));
