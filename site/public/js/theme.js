// The site's look (Settings > Theme), loaded in <head> so the saved theme is
// on <html> before anything draws:
//   data-theme   the built-in theme's id (site.css has its colors)
//   data-nav     "side" (the 2016+ left column, docked on wide screens) or
//                "top" (the left column only opens from the menu button)
//   data-me      set while this browser was last seen signed in, so the
//                docked left column has its room before the page knows
// The ids are the launcher's (theme-pack-format.md), so a theme pack made for
// one starts from the same look in the other. A pack (themepack.js, checked
// when imported) goes on top of its base theme: its colors as custom
// properties on <html>, its CSS in an adopted sheet. Nothing here is ever
// uploaded: packs stay in this browser (localStorage and IndexedDB).
// ?theme=default puts the default back, in case a pack hides the settings.
(function () {
  'use strict';
  var BUILTIN = [
    { id: 'web2014', name: '2014', year: 2014, nav: 'top' },
    { id: 'web2015', name: '2015', year: 2015, nav: 'top' },
    { id: 'web2016', name: '2016', year: 2016, nav: 'side' },
    { id: 'web2017', name: '2017', year: 2017, nav: 'side' },
    { id: 'web2017-dark', name: '2017 dark', year: 2017, nav: 'side', dark: true },
    { id: 'web2018', name: '2018', year: 2018, nav: 'side' },
    { id: 'web2018-dark', name: '2018 dark', year: 2018, nav: 'side', dark: true },
    { id: 'web2019', name: '2019', year: 2019, nav: 'side' },
    { id: 'web2019-dark', name: '2019 dark', year: 2019, nav: 'side', dark: true },
    { id: 'studio-light', name: 'Studio', year: 2017, nav: 'side' },
    { id: 'studio-dark', name: 'Studio dark', year: 2018, nav: 'side', dark: true },
    { id: 'bc', name: 'Builders Club', nav: 'top', dark: true },
    { id: 'midnight', name: 'Midnight', nav: 'side', dark: true },
    { id: 'light', name: 'Light', nav: 'top' },
    { id: 'contrast', name: 'High contrast', nav: 'top', dark: true },
  ];
  var DEFAULT = 'web2017';
  // The launcher's console looks have no website version.
  var ALIAS = { xbox: 'web2017', xbox2016: 'web2017' };
  var CUSTOM = 'custom:';
  var KEY = 'rbx2017.theme';
  var PACK_KEY = 'rbx2017.themePack';
  var ME_KEY = 'rbx2017.signedIn';

  function read(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function find(id) {
    id = ALIAS[id] || id;
    for (var i = 0; i < BUILTIN.length; i++) if (BUILTIN[i].id === id) return BUILTIN[i];
    return null;
  }

  var customVars = [];
  function clearCustom(root) {
    for (var i = 0; i < customVars.length; i++) root.style.removeProperty(customVars[i]);
    customVars = [];
    root.style.removeProperty('color-scheme');
    delete root.dataset.custom;
    try { document.adoptedStyleSheets = []; } catch (error) { /* older browser */ }
  }

  // choice: a built-in id, or a compiled pack { id, base, dark, vars, css }
  // (ThemePack.compile: its pictures already in place).
  function apply(choice) {
    var root = document.documentElement;
    var pack = choice && typeof choice === 'object' ? choice : null;
    var theme = find(pack ? pack.base : choice) || find(DEFAULT);
    clearCustom(root);
    root.dataset.theme = theme.id;
    root.dataset.nav = theme.nav;
    if (theme.dark) root.dataset.dark = '';
    else delete root.dataset.dark;
    if (!pack) return theme;
    root.dataset.custom = pack.id;
    var names = Object.keys(pack.vars || {});
    for (var i = 0; i < names.length; i++) {
      root.style.setProperty(names[i], pack.vars[names[i]]);
      customVars.push(names[i]);
    }
    if (typeof pack.dark === 'boolean') {
      root.style.setProperty('color-scheme', pack.dark ? 'dark' : 'light');
      if (pack.dark) root.dataset.dark = '';
      else delete root.dataset.dark;
    }
    if (pack.css) {
      try {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(pack.css);
        document.adoptedStyleSheets = [sheet];
      } catch (error) { /* a sheet this browser can't take: colors only */ }
    }
    return theme;
  }

  // The saved choice: a built-in id, or a compiled pack from the cache.
  function saved() {
    var value = read(KEY);
    if (value && value.indexOf(CUSTOM) === 0) {
      try {
        var pack = JSON.parse(read(PACK_KEY) || 'null');
        if (pack && CUSTOM + pack.id === value) return pack;
      } catch (error) { /* a broken cache: the default */ }
      return DEFAULT;
    }
    return find(value) ? (ALIAS[value] || value) : DEFAULT;
  }

  // A pack too big for localStorage keeps only its colors there; the rest
  // comes from IndexedDB a moment later.
  function fillLater(pack) {
    if (!pack || !pack.partial || !window.indexedDB) return;
    openStore(function (db) {
      var get = db.transaction('packs').objectStore('packs').get(pack.id);
      get.onsuccess = function () {
        var stored = get.result;
        if (stored && stored.compiled && read(KEY) === CUSTOM + pack.id) apply(stored.compiled);
      };
    });
  }

  function openStore(then, failed) {
    try {
      var open = indexedDB.open('rbx2017-themes', 1);
      open.onupgradeneeded = function () { open.result.createObjectStore('packs', { keyPath: 'id' }); };
      open.onsuccess = function () { then(open.result); };
      open.onerror = function () { if (failed) failed(open.error); };
    } catch (error) {
      if (failed) failed(error);
    }
  }

  // Use a built-in theme (id) or a stored pack (compiled), and remember it.
  function choose(choice) {
    if (choice && typeof choice === 'object') {
      var text = JSON.stringify(choice);
      if (text.length > 1500000 || !write(PACK_KEY, text)) {
        write(PACK_KEY, JSON.stringify({ id: choice.id, name: choice.name, base: choice.base, dark: choice.dark, vars: choice.vars, partial: true }));
      }
      write(KEY, CUSTOM + choice.id);
    } else {
      write(PACK_KEY, null);
      write(KEY, find(choice) ? choice : DEFAULT);
    }
    return apply(choice);
  }

  if (/[?&]theme=default(?:&|$)/.test(location.search)) {
    write(KEY, null);
    write(PACK_KEY, null);
  }
  if (read(ME_KEY) === '1') document.documentElement.dataset.me = '';
  var start = saved();
  apply(start);
  if (start && typeof start === 'object') fillLater(start);

  window.SiteThemes = {
    BUILTIN: BUILTIN, DEFAULT: DEFAULT, CUSTOM: CUSTOM, find: find, apply: apply, saved: saved, choose: choose,
    openStore: openStore, current: function () { return read(KEY) || DEFAULT; },
    signedIn: function (yes) {
      write(ME_KEY, yes ? '1' : null);
      if (yes) document.documentElement.dataset.me = '';
      else delete document.documentElement.dataset.me;
    },
  };
}());
