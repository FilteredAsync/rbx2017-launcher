'use strict';

// The menu's sound effects, like the 2016-2017 Xbox One app's. The sounds are
// Roblox's, so they are not in this repository: they come with the game files
// (Client/content/sounds/launcher/*.mp3, read through launcher-net://client)
// and the menu is simply silent until those are downloaded.
//
//   sfx.play(name)   name: move | press | screen | menu | overlay | popup | error | success
//   sfx.press()      a plain button press, skipped when a more specific sound
//                    plays for the same click
//   sfx.volume       0-100, Settings > Menu > Sounds (stored as "soundsVolume"; 0 is off)

window.sfx = (() => {
  const FILES = {
    move: 'Roblox_Console-MoveSelection.mp3',
    press: 'Roblox_Console-ButtonPress.mp3',
    screen: 'Roblox_Console-ScreenChange.mp3',
    menu: 'Roblox_Console-SideMenuSlideIn.mp3',
    overlay: 'Roblox_Console-OverlayOpen.mp3',
    popup: 'Roblox_Console-PopUp.mp3',
    error: 'Roblox_Console-Error.mp3',
    success: 'Roblox_Console-PurchaseSuccess.mp3',
  };
  const DEFAULT_VOLUME = 50;
  const sources = {};
  const missing = new Set(); // failed to load (game files without the sounds): not tried again
  let lastSpecific = 0;

  function volume() {
    try {
      const stored = localStorage.getItem('soundsVolume');
      if (stored !== null && Number.isFinite(Number(stored))) return Math.max(0, Math.min(100, Number(stored)));
      return localStorage.getItem('sounds') === 'off' ? 0 : DEFAULT_VOLUME; // the earlier on/off switch
    } catch (error) {
      return DEFAULT_VOLUME;
    }
  }
  const enabled = () => volume() > 0;

  function source(name) {
    if (!sources[name]) {
      const audio = new Audio(`launcher-net://client/sounds/launcher/${FILES[name]}`);
      audio.preload = 'auto';
      audio.addEventListener('error', () => missing.add(name), { once: true });
      sources[name] = audio;
    }
    return sources[name];
  }

  function play(name) {
    if (!FILES[name] || !enabled() || missing.has(name)) return;
    if (name !== 'press') lastSpecific = performance.now();
    // A copy per play, so quick presses overlap instead of cutting each other off.
    const copy = source(name).cloneNode();
    copy.volume = volume() / 100;
    copy.play().catch(() => {}); // not downloaded yet, or blocked: stay silent
  }

  // Runs after the click's own handlers: they may have played something better.
  function press() {
    const at = performance.now();
    setTimeout(() => { if (lastSpecific < at) play('press'); }, 0);
  }

  // Warm the cache once the page is up.
  setTimeout(() => { for (const name of Object.keys(FILES)) source(name); }, 1500);

  return {
    play, press,
    get enabled() { return enabled(); },
    get volume() { return volume(); },
    set volume(value) {
      const clean = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      try { localStorage.setItem('soundsVolume', String(clean)); } catch (error) { /* storage blocked */ }
    },
  };
})();
