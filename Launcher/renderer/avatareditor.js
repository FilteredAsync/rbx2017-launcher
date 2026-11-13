'use strict';

// The Avatar tab: a 3D preview (avatar3d.js) beside categories of items from
// the server's catalog (featured classics, or a search), body colors, and
// wearing items by ID. Every change shows at once and is saved to the
// server a moment later; the server checks it again (lib/launcherapi.js).
//
//   const editor = AvatarEditor.create({ api, onSaved })
//   editor.loadAccount()   editor.showGuest()   editor.activate()   editor.rotate(step)
//   editor.pictures()  -> { full: Blob, head: Blob } of what is shown

(function () {
  const $ = (id) => document.getElementById(id);
  const NET = 'launcher-net://server';

  const CATEGORIES = [
    { key: 'wearing', label: 'Wearing' },
    { key: 'colors', label: 'Body colors' },
    { key: 'hats', label: 'Hats', gap: true },
    { key: 'hair', label: 'Hair' },
    { key: 'faces', label: 'Faces' },
    { key: 'heads', label: 'Heads' },
    { key: 'shirts', label: 'Shirts' },
    { key: 'pants', label: 'Pants' },
    { key: 'tshirts', label: 'T-Shirts' },
    { key: 'packages', label: 'Packages' },
    { key: 'face', label: 'Face accessories', gap: true },
    { key: 'neck', label: 'Neck' },
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'front', label: 'Front' },
    { key: 'back', label: 'Back' },
    { key: 'waist', label: 'Waist' },
  ];
  const SINGLE = new Set([2, 11, 12, 17, 18, 27, 28, 29, 30, 31]);
  const ACCESSORIES = new Set([8, 41, 42, 43, 44, 45, 46, 47]);
  const BODY_PARTS = new Set([27, 28, 29, 30, 31]);
  const WEARABLE = new Set([...SINGLE, ...ACCESSORIES]);
  const PARTS = [
    ['all', 'Whole body'], ['HeadColor', 'Head'], ['TorsoColor', 'Torso'], ['LeftArmColor', 'Left arm'],
    ['RightArmColor', 'Right arm'], ['LeftLegColor', 'Left leg'], ['RightLegColor', 'Right leg'],
  ];

  function message(error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function create({ api, onSaved }) {
    const view = window.Avatar3D.create($('avatar-canvas'));
    let avatar = null; // { bodyColors, assets: [{ id, typeId, name }] }
    let mode = 'none'; // 'account' | 'guest'
    let category = 'wearing';
    let keyword = '';
    let nextCursor = null;
    let saveTimer = null;
    let saving = false;
    let pendingSave = false;
    let colorPart = 'all';
    const bundles = new Map(); // bundle ID -> its body part items

    function setStatus(text, kind) {
      const node = $('avatar-status');
      node.textContent = text || '';
      node.className = `stage-status${kind ? ` ${kind}` : ''}`;
    }

    function setCatStatus(text, kind) {
      const node = $('cat-status');
      node.textContent = text || '';
      node.className = `status${kind ? ` ${kind}` : ''}`;
    }

    // --- preview and saving ----------------------------------------------------------

    function preview() {
      if (!avatar) return Promise.resolve();
      return view.show(avatar).catch((error) => setStatus(`Could not draw the avatar: ${message(error)}`, 'error'));
    }

    function changed() {
      preview();
      renderItems(false);
      if (mode !== 'account') return;
      setStatus('Saving…');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 700);
    }

    async function save() {
      if (saving) { pendingSave = true; return; }
      saving = true;
      try {
        const result = await api.saveAvatar({ bodyColors: avatar.bodyColors, assets: avatar.assets.map((asset) => ({ id: asset.id })) });
        avatar = { bodyColors: result.bodyColors, assets: result.assets };
        setStatus('Saved', 'good');
        await preview();
        renderItems(false);
        if (onSaved) onSaved(true);
      } catch (error) {
        setStatus(message(error), 'error');
      } finally {
        saving = false;
        if (pendingSave) { pendingSave = false; save(); }
      }
    }

    function isWorn(id) {
      return Boolean(avatar && avatar.assets.some((asset) => asset.id === String(id)));
    }

    function wear(item) {
      const id = String(item.id);
      if (isWorn(id)) {
        avatar.assets = avatar.assets.filter((asset) => asset.id !== id);
        changed();
        return;
      }
      let list = avatar.assets.slice();
      if (SINGLE.has(item.typeId)) {
        list = list.filter((asset) => asset.typeId !== item.typeId);
      } else if (item.typeId === 8) {
        const hats = list.filter((asset) => asset.typeId === 8);
        if (hats.length >= 3) list = list.filter((asset) => asset !== hats[0]);
      } else if (ACCESSORIES.has(item.typeId)) {
        list = list.filter((asset) => asset.typeId !== item.typeId);
      }
      const accessories = list.filter((asset) => ACCESSORIES.has(asset.typeId));
      if (ACCESSORIES.has(item.typeId) && accessories.length >= 10) list = list.filter((asset) => asset !== accessories[0]);
      list.push({ id, typeId: item.typeId, name: item.name || '' });
      avatar.assets = list;
      changed();
    }

    async function bundleParts(id) {
      if (bundles.has(id)) return bundles.get(id);
      const data = await api.bundle(id);
      const parts = (data.items || []).filter((part) => BODY_PARTS.has(part.typeId) || part.typeId === 17);
      bundles.set(id, parts);
      return parts;
    }

    function packageWorn(id) {
      const parts = bundles.get(String(id));
      return Boolean(parts && parts.length && parts.every((part) => isWorn(part.id)));
    }

    async function wearPackage(bundle, tile) {
      if (tile) tile.classList.add('busy');
      try {
        const parts = await bundleParts(String(bundle.id));
        if (!parts.length) {
          setCatStatus(`"${bundle.name}" has no body parts this client can wear.`, 'error');
          return;
        }
        if (packageWorn(bundle.id)) {
          const ids = new Set(parts.map((part) => String(part.id)));
          avatar.assets = avatar.assets.filter((asset) => !ids.has(asset.id));
        } else {
          const kinds = new Set(parts.map((part) => part.typeId));
          avatar.assets = avatar.assets.filter((asset) => !kinds.has(asset.typeId))
            .concat(parts.map((part) => ({ id: String(part.id), typeId: part.typeId, name: part.name })));
        }
        changed();
      } catch (error) {
        setCatStatus(message(error), 'error');
      } finally {
        if (tile) tile.classList.remove('busy');
      }
    }

    // --- categories and items --------------------------------------------------------------

    function renderCategories() {
      const list = $('cat-list');
      list.textContent = '';
      for (const entry of CATEGORIES) {
        const link = el('button', `cat-link${entry.gap ? ' gap' : ''}${entry.key === category ? ' active' : ''}`, entry.label);
        link.dataset.category = entry.key;
        link.addEventListener('click', () => openCategory(entry.key));
        list.append(link);
      }
    }

    function thumbUrl(item) {
      return item.kind === 'bundle'
        ? `${NET}/bundle-thumbnail/image?bundleId=${encodeURIComponent(item.id)}&width=150&height=150`
        : `${NET}/asset-thumbnail/image?assetId=${encodeURIComponent(item.id)}&width=150&height=150`;
    }

    function tile(item) {
      const node = el('button', 'item-tile');
      const worn = item.kind === 'bundle' ? packageWorn(item.id) : isWorn(item.id);
      node.classList.toggle('worn', worn);
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = thumbUrl(item);
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      node.append(img, el('div', 'item-name', item.name || `Item ${item.id}`));
      node.title = item.name || '';
      node.addEventListener('click', () => (item.kind === 'bundle' ? wearPackage(item, node) : wear(item)));
      node.dataset.id = item.id;
      return node;
    }

    let shownItems = [];

    function renderItems(reset) {
      const grid = $('item-grid');
      if (category === 'colors') return renderColors();
      $('color-pane').classList.add('hidden');
      grid.classList.remove('hidden');
      if (category === 'wearing') {
        shownItems = (avatar ? avatar.assets : []).map((asset) => ({ id: asset.id, kind: 'asset', name: asset.name, typeId: asset.typeId }));
        reset = true;
      }
      const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest('.item-tile')
        ? document.activeElement.dataset.id : null;
      if (reset) grid.textContent = '';
      grid.textContent = '';
      for (const item of shownItems) grid.append(tile(item));
      if (category === 'wearing' && shownItems.length === 0) grid.append(el('div', 'empty-note', 'Nothing worn yet. Pick a category on the left.'));
      if (focusedId) {
        const again = grid.querySelector(`.item-tile[data-id="${CSS.escape(focusedId)}"]`);
        if (again) again.focus({ preventScroll: true });
      }
      $('cat-more').classList.toggle('hidden', !nextCursor || category === 'wearing');
    }

    function renderColors() {
      $('item-grid').classList.add('hidden');
      $('color-pane').classList.remove('hidden');
      $('cat-more').classList.add('hidden');
      const pick = $('part-pick');
      pick.textContent = '';
      for (const [key, label] of PARTS) {
        const button = el('button', key === colorPart ? 'active' : '', label);
        button.addEventListener('click', () => { colorPart = key; renderColors(); });
        pick.append(button);
      }
      const palette = $('palette');
      palette.textContent = '';
      const current = avatar ? (colorPart === 'all' ? avatar.bodyColors.TorsoColor : avatar.bodyColors[colorPart]) : null;
      for (const [id, hex, name] of window.Avatar3D.BRICK_COLORS) {
        const swatch = el('button', `swatch${id === current ? ' current' : ''}`);
        swatch.style.background = hex;
        swatch.title = name;
        swatch.addEventListener('click', () => {
          if (!avatar) return;
          const keys = colorPart === 'all' ? PARTS.slice(1).map(([key]) => key) : [colorPart];
          for (const key of keys) avatar.bodyColors[key] = id;
          renderColors();
          changed();
        });
        palette.append(swatch);
      }
    }

    async function loadItems(append) {
      const asked = { category, keyword, cursor: append ? nextCursor : null };
      setCatStatus(keyword ? `Searching for "${keyword}"…` : 'Loading…');
      $('cat-more').disabled = true;
      try {
        const data = await api.catalog(asked);
        if (asked.category !== category || asked.keyword !== keyword) return;
        shownItems = append ? shownItems.concat(data.items) : data.items;
        nextCursor = data.nextCursor || null;
        setCatStatus(shownItems.length ? '' : (keyword ? 'Nothing found.' : 'Nothing here right now.'));
        renderItems(!append);
      } catch (error) {
        if (asked.category === category) setCatStatus(message(error), 'error');
      } finally {
        $('cat-more').disabled = false;
      }
    }

    function openCategory(key, keepKeyword) {
      category = key;
      if (!keepKeyword) {
        keyword = '';
        $('cat-search').value = '';
      }
      nextCursor = null;
      shownItems = [];
      const entry = CATEGORIES.find((item) => item.key === key);
      $('cat-title').textContent = keyword ? `${entry.label}: "${keyword}"` : entry.label;
      document.querySelectorAll('.cat-link').forEach((link) => link.classList.toggle('active', link.dataset.category === key));
      $('cat-search-form').classList.toggle('hidden', key === 'wearing' || key === 'colors');
      setCatStatus('');
      if (key === 'wearing' || key === 'colors') renderItems(true);
      else {
        $('item-grid').textContent = '';
        renderItems(true);
        loadItems(false);
      }
    }

    $('cat-search-form').addEventListener('submit', (event) => {
      event.preventDefault();
      keyword = $('cat-search').value.trim();
      openCategory(category, true);
    });
    $('cat-more').addEventListener('click', () => loadItems(true));

    $('by-id-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = $('by-id').value.trim();
      if (!/^\d{1,19}$/.test(id)) { setCatStatus('Item IDs are numbers, like 1365767.', 'error'); return; }
      if (mode !== 'account') return;
      setCatStatus('Looking it up…');
      try {
        const data = await api.item(id);
        if (!WEARABLE.has(data.typeId)) { setCatStatus(`"${data.name}" is not something this client can wear.`, 'error'); return; }
        if (!data.item) { setCatStatus(`"${data.name}" could not be read; it may be too new for this client.`, 'error'); }
        else setCatStatus(`${isWorn(id) ? 'Took off' : 'Wearing'} "${data.name}".`, 'good');
        wear({ id, typeId: data.typeId, name: data.name });
        $('by-id').value = '';
      } catch (error) {
        setCatStatus(message(error), 'error');
      }
    });

    let copyArmed = 0;
    $('avatar-copy').addEventListener('click', async () => {
      if (mode !== 'account') return;
      if (Date.now() - copyArmed > 4000) {
        copyArmed = Date.now();
        $('avatar-copy').textContent = 'Click again to replace your avatar';
        setTimeout(() => { $('avatar-copy').textContent = 'Copy my Roblox avatar'; }, 4000);
        return;
      }
      copyArmed = 0;
      $('avatar-copy').textContent = 'Copy my Roblox avatar';
      setStatus('Copying from Roblox…');
      try {
        const result = await api.copyAvatar();
        avatar = { bodyColors: result.bodyColors, assets: result.assets };
        await preview();
        renderItems(true);
        setStatus('Copied from Roblox and saved.', 'good');
        if (onSaved) onSaved(true);
      } catch (error) {
        setStatus(message(error), 'error');
      }
    });

    // --- turning the avatar -------------------------------------------------------------------

    const canvas = $('avatar-canvas');
    let drag = null;
    canvas.addEventListener('pointerdown', (event) => { drag = event.clientX; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', (event) => {
      if (drag === null) return;
      view.rotateBy((event.clientX - drag) * 0.012);
      drag = event.clientX;
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    $('avatar-rotate-left').addEventListener('click', () => view.rotateBy(-0.6));
    $('avatar-rotate-right').addEventListener('click', () => view.rotateBy(0.6));

    // --- modes ----------------------------------------------------------------------------------

    async function loadAccount(account) {
      mode = 'account';
      $('avatar-guest').classList.add('hidden');
      $('avatar-editor').classList.remove('hidden');
      $('stage-name').textContent = account ? account.name : '';
      setStatus('Loading your avatar…');
      try {
        const data = await api.getAvatar();
        avatar = { bodyColors: data.bodyColors, assets: data.assets };
        await preview();
        setStatus(data.source === 'roblox-copy' ? 'Copied from the Roblox account with your name. Change anything you like.' : '');
        renderCategories();
        openCategory(category);
        return data;
      } catch (error) {
        setStatus(message(error), 'error');
        return null;
      }
    }

    async function showGuest(name) {
      mode = 'guest';
      $('avatar-editor').classList.add('hidden');
      $('avatar-guest').classList.remove('hidden');
      $('stage-name').textContent = name || 'Guest';
      setStatus('');
      try {
        const data = await api.guestAvatar();
        avatar = { bodyColors: data.bodyColors, assets: data.assets };
        await preview();
        return data;
      } catch (error) {
        setStatus(message(error), 'error');
        return null;
      }
    }

    function clear() {
      mode = 'none';
      avatar = null;
    }

    async function pictures() {
      if (!avatar) return null;
      await preview();
      const [full, head] = await Promise.all([view.snapshot('full', 420), view.snapshot('head', 150)]);
      return { full, head };
    }

    return {
      loadAccount,
      showGuest,
      clear,
      pictures,
      activate: () => view.resize(),
      rotate: (step) => view.rotateBy(step),
      hasAvatar: () => Boolean(avatar),
    };
  }

  window.AvatarEditor = { create };
}());
