'use strict';

// The launcher's look (Settings > Theme). Loaded in <head>, so the saved theme
// is on <html> before anything draws:
//   data-theme   the theme's id (themes.css has its colors and touches)
//   data-family  "web" (website looks, theme-web.css) or "console" (Xbox, style.css)
//   data-nav     "top" (tabs in the header) or "side" (a column on the left)
// An imported theme pack (themepack.js) runs on top of its base theme: its
// colors go on <html> as custom properties and its CSS in an adopted sheet.
// The active pack is cached in localStorage so it, too, is there before paint.
(function () {
  const BUILTIN = [
    { id: 'web2014', name: '2014', year: 2014, family: 'web', nav: 'top' },
    { id: 'web2015', name: '2015', year: 2015, family: 'web', nav: 'top' },
    { id: 'web2016', name: '2016', year: 2016, family: 'web', nav: 'top' },
    { id: 'web2017', name: '2017', year: 2017, family: 'web', nav: 'side' },
    { id: 'web2017-dark', name: '2017 dark', year: 2017, family: 'web', nav: 'side', dark: true },
    { id: 'web2018', name: '2018', year: 2018, family: 'web', nav: 'side' },
    { id: 'web2018-dark', name: '2018 dark', year: 2018, family: 'web', nav: 'side', dark: true },
    { id: 'web2019', name: '2019', year: 2019, family: 'web', nav: 'side' },
    { id: 'web2019-dark', name: '2019 dark', year: 2019, family: 'web', nav: 'side', dark: true },
    { id: 'xbox2016', name: 'Xbox One', year: 2016, family: 'console', nav: 'top', dark: true },
    { id: 'xbox', name: 'Xbox', year: 2017, family: 'console', nav: 'top', dark: true },
    { id: 'studio-light', name: 'Studio', year: 2017, family: 'web', nav: 'side' },
    { id: 'studio-dark', name: 'Studio dark', year: 2018, family: 'web', nav: 'side', dark: true },
    { id: 'bc', name: 'Builders Club', family: 'web', nav: 'top', dark: true },
    { id: 'midnight', name: 'Midnight', family: 'web', nav: 'side', dark: true },
    { id: 'light', name: 'Light', family: 'web', nav: 'top' },
    { id: 'contrast', name: 'High contrast', family: 'web', nav: 'top', dark: true },
  ];
  const DEFAULT = 'web2017';
  // Values saved by launchers before 1.20.
  const OLD = { site: 'web2017' };
  const CUSTOM = 'custom:';

  function read(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  function find(id) {
    return BUILTIN.find((theme) => theme.id === id) || null;
  }

  let customVars = [];
  function clearCustom(root) {
    for (const name of customVars) root.style.removeProperty(name);
    customVars = [];
    root.style.removeProperty('color-scheme');
    delete root.dataset.custom;
    try { document.adoptedStyleSheets = []; } catch (error) { /* older engine */ }
  }

  // id: a built-in id, or a pack: { id, base, dark, vars, css } (css with
  // its pictures already in place, from ThemePack.compile).
  function apply(choice) {
    const root = document.documentElement;
    const pack = choice && typeof choice === 'object' ? choice : null;
    const theme = find(pack ? pack.base : choice) || find(DEFAULT);
    clearCustom(root);
    root.dataset.theme = theme.id;
    root.dataset.family = theme.family;
    root.dataset.nav = theme.nav;
    if (!pack) return theme;
    root.dataset.custom = pack.id;
    for (const name of Object.keys(pack.vars || {})) {
      root.style.setProperty(name, pack.vars[name]);
      customVars.push(name);
    }
    if (typeof pack.dark === 'boolean') root.style.setProperty('color-scheme', pack.dark ? 'dark' : 'light');
    if (pack.css) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(pack.css);
        document.adoptedStyleSheets = [sheet];
      } catch (error) { /* a sheet this engine can't take: colors only */ }
    }
    return theme;
  }

  // The saved choice: a built-in id, or "custom:<id>" with the pack cached.
  function saved() {
    const value = read('theme');
    if (value && value.indexOf(CUSTOM) === 0) {
      try {
        const pack = JSON.parse(read('themePack') || 'null');
        if (pack && CUSTOM + pack.id === value) return pack;
      } catch (error) { /* a broken cache: the default */ }
      return DEFAULT;
    }
    if (value && OLD[value]) return OLD[value];
    return find(value) ? value : DEFAULT;
  }

  window.LauncherThemes = { BUILTIN, DEFAULT, CUSTOM, find, apply, saved };
  apply(saved());
}());
