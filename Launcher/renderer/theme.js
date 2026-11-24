'use strict';

// The launcher's look (Settings > Theme): "xbox", the console app (the
// default), or "site", the 2017 website look of rbx2017.com. Loaded in <head>,
// so the saved one is on the page before anything draws. app.js switches it.
(function () {
  let theme = 'xbox';
  try {
    if (localStorage.getItem('theme') === 'site') theme = 'site';
  } catch (error) { /* storage blocked */ }
  document.documentElement.dataset.theme = theme;
}());
