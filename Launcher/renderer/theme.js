'use strict';

// The launcher's look (Settings > Theme). Loaded in <head>, so the saved theme
// is on <html> before anything draws:
//   data-theme   the theme's id (themes.css has its colors and touches)
//   data-family  always "web": every look is a website look (theme-web.css)
//   data-nav     "top" (tabs in the header) or "side" (a column on the left)
// An imported theme pack (themepack.js) runs on top of its base theme: its
// colors go on <html> as custom properties and its CSS in an adopted sheet.
// The active pack is cached in localStorage so it, too, is there before paint.
(function () {
  const BUILTIN = [
    { id: 'web2014', name: '2014', year: 2014, nav: 'top' },
    { id: 'web2015', name: '2015', year: 2015, nav: 'top' },
    { id: 'web2016', name: '2016', year: 2016, nav: 'top' },
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
  const DEFAULT = 'web2017';
  // Values saved by older launchers: "site" (before 1.20). The Xbox looks
  // ("xbox", "xbox2016") are gone; they and anything unknown get the default.
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
  // its pictures already in place, from ThemePack.compile). A pack whose
  // base is no longer here (an Xbox one) isn't used: the default instead.
  function apply(choice) {
    const root = document.documentElement;
    let pack = choice && typeof choice === 'object' ? choice : null;
    if (pack && !find(pack.base)) pack = null;
    const theme = find(pack ? pack.base : choice) || find(DEFAULT);
    clearCustom(root);
    root.dataset.theme = theme.id;
    root.dataset.family = 'web';
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
        if (pack && CUSTOM + pack.id === value && find(pack.base)) return pack;
      } catch (error) { /* a broken cache: the default */ }
      return DEFAULT;
    }
    if (value && OLD[value]) return OLD[value];
    return find(value) ? value : DEFAULT;
  }

  window.LauncherThemes = { BUILTIN, DEFAULT, CUSTOM, find, apply, saved };
  apply(saved());
}());
