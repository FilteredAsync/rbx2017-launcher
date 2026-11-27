'use strict';

// The Groups tab: your groups and a search on the left; a group's page on the
// right (shout, About with its games, Members, Wall, and Manage for its
// admins). Making a group costs R$ 100. Server: /api/launcher/groups
// (lib/groupapi.js, servers from 2026-11-21 on).
//
//   const groupsView = GroupsView.create({ api, el, message, personPicture, openProfile, getMe, onRobux })
//   groupsView.activate()   groupsView.reset()   groupsView.open(groupId)

(function () {
  const $ = (id) => document.getElementById(id);
  const NET = 'launcher-net://server/';
  const SECTIONS = [['about', 'About'], ['members', 'Members'], ['wall', 'Wall'], ['manage', 'Manage']];

  function create({ api, el, message, personPicture, openProfile, getMe, onRobux }) {
    let mine = [];
    let results = null; // a search's groups, or null
    let current = null; // the open group's page
    let section = 'about';
    let membersRole = 0;
    let cost = 100;
    let unsupported = false;

    const status = (text, kind) => {
      const node = $('groups-status');
      node.textContent = text || '';
      node.className = `status groups-status${kind ? ` ${kind}` : ''}`;
    };

    async function call(method, route, body) {
      try {
        return await api.groups(method, route, body);
      } catch (error) {
        if (/unknown launcher request/i.test(message(error))) unsupported = true;
        throw error;
      }
    }

    function emblem(group, className = 'group-emblem') {
      const box = el('div', className);
      if (group && group.emblem) {
        const img = el('img');
        img.alt = '';
        img.src = NET + group.emblem;
        img.addEventListener('error', () => img.remove());
        box.append(img);
      } else {
        box.append(el('span', 'group-emblem-letter', String((group && group.name) || '?').charAt(0).toUpperCase()));
      }
      return box;
    }

    const when = (iso) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    function button(label, kind, onClick) {
      const node = el('button', `${kind} small`, label);
      node.addEventListener('click', onClick);
      return node;
    }

    // --- the side list ------------------------------------------------------------------------

    function renderList() {
      const list = $('groups-list');
      list.textContent = '';
      $('groups-list-title').textContent = results ? 'RESULTS' : 'MY GROUPS';
      if (unsupported) {
        list.append(el('div', 'chat-none', "This server doesn't have groups yet."));
        return;
      }
      const shown = results || mine;
      if (!shown.length) {
        list.append(el('div', 'chat-none', results ? 'No groups found.' : getMe() ? 'No groups yet. Find one or make your own.' : 'Search for groups.'));
        return;
      }
      for (const group of shown) {
        const item = el('button', 'chat-item nav-target');
        if (current && current.id === group.id) item.classList.add('active');
        const text = el('div', 'chat-item-text');
        text.append(el('b', 'chat-item-title', group.name), el('div', 'chat-item-last', group.mine ? group.mine.role : `${plural(group.memberCount, 'member', 'members')} · By ${group.owner.name}`));
        item.append(emblem(group, 'group-emblem small'), text);
        item.addEventListener('click', () => open(group.id));
        list.append(item);
      }
    }

    async function loadMine() {
      if (!getMe()) {
        mine = [];
        renderList();
        return;
      }
      try {
        const data = await call('GET', 'groups/mine');
        mine = data.groups || [];
        cost = data.cost || cost;
      } catch (error) {
        if (!unsupported) status(message(error), 'error');
      }
      renderList();
    }

    async function search(event) {
      if (event) event.preventDefault();
      const text = $('groups-search').value.trim();
      if (!text) {
        results = null;
        renderList();
        return;
      }
      try {
        const data = await call('GET', `groups?search=${encodeURIComponent(text).slice(0, 80)}`);
        results = data.groups || [];
      } catch (error) {
        status(message(error), 'error');
        results = [];
      }
      renderList();
    }

    // --- making a group ---------------------------------------------------------------------

    function showCreate() {
      if (!getMe()) {
        status('Sign in to make a group.', 'error');
        return;
      }
      current = null;
      renderList();
      const pane = $('group-pane');
      pane.textContent = '';
      const form = el('form', 'group-create');
      form.append(el('div', 'group-title', 'Create Group'));
      const name = el('input');
      name.maxLength = 50;
      name.placeholder = 'Group name';
      const description = el('textarea');
      description.maxLength = 1000;
      description.placeholder = 'What is it about?';
      const open = el('label', 'group-check');
      const check = el('input');
      check.type = 'checkbox';
      check.checked = true;
      open.append(check, document.createTextNode(' Anyone can join'));
      const go = el('button', 'primary', `Create for R$ ${cost}`);
      const cancel = button('Cancel', 'ghost', (event) => { event.preventDefault(); showEmpty(); });
      const row = el('div', 'group-actions');
      row.append(go, cancel);
      form.append(name, description, open, row);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        go.disabled = true;
        try {
          const data = await call('POST', 'groups', { name: name.value, description: description.value, public: check.checked });
          if (onRobux && Number.isFinite(data.balance)) onRobux(data.balance);
          status(`Made ${data.group.name}.`, 'good');
          await loadMine();
          show(data.group);
        } catch (error) {
          status(message(error), 'error');
        } finally {
          go.disabled = false;
        }
      });
      pane.append(form);
      name.focus();
    }

    function showEmpty() {
      current = null;
      const pane = $('group-pane');
      pane.textContent = '';
      pane.append(el('div', 'chat-empty', 'Pick a group, or find one.'));
      renderList();
    }

    // --- a group's page --------------------------------------------------------------------

    async function open(groupId) {
      status('');
      try {
        const data = await call('GET', `groups/${groupId}`);
        if (current && current.id !== data.group.id) section = 'about';
        show(data.group);
      } catch (error) {
        status(message(error), 'error');
      }
    }

    async function act(route, body, done) {
      status('');
      try {
        const data = await call('POST', `groups/${current.id}/${route}`, body || {});
        if (done) status(typeof done === 'function' ? done(data) : done, 'good');
        if (data.group) show(data.group);
        else showEmpty();
        loadMine();
        return data;
      } catch (error) {
        status(message(error), 'error');
        return null;
      }
    }

    function show(group) {
      current = group;
      renderList();
      const pane = $('group-pane');
      pane.textContent = '';
      const head = el('header', 'group-head');
      head.append(emblem(group, 'group-emblem big'));
      const text = el('div', 'group-head-text');
      text.append(el('div', 'group-title', group.name));
      const by = el('div', 'group-sub');
      by.append(document.createTextNode('By '));
      if (group.owner.userId) {
        const owner = el('button', 'link', group.owner.name);
        owner.addEventListener('click', () => openProfile({ userId: group.owner.userId, name: group.owner.name }));
        by.append(owner);
      } else by.append(document.createTextNode(group.owner.name));
      by.append(document.createTextNode(` · ${plural(group.memberCount, 'member', 'members')}${group.public ? '' : ' · Ask to join'}`));
      text.append(by);
      if (group.mine) text.append(el('div', 'group-sub', `Your rank: ${group.mine.role}`));
      head.append(text);
      const actions = el('div', 'group-actions');
      if (getMe()) {
        if (group.mine) {
          if (!(group.canOwn && group.owner.userId)) actions.append(button('Leave', 'ghost', () => {
            if (window.confirm(`Leave ${group.name}?`)) act('leave', {}, `Left ${group.name}.`);
          }));
        } else if (group.requested) {
          actions.append(button('Cancel request', 'ghost', () => act('leave', {}, 'Request taken back.')));
        } else {
          actions.append(button(group.public ? 'Join Group' : 'Ask to Join', 'primary', () => act('join', {}, (d) => (d.requested ? 'Asked to join.' : `Joined ${group.name}!`))));
        }
      }
      head.append(actions);
      pane.append(head);

      if (group.shout) {
        const shout = el('div', 'group-shout');
        shout.append(el('div', 'group-shout-text', group.shout.text), el('div', 'group-sub', `${group.shout.by.name} · ${when(group.shout.at)}`));
        pane.append(shout);
      }

      const tabs = el('nav', 'group-tabs');
      for (const [key, label] of SECTIONS) {
        if (key === 'manage' && !group.canManage && !group.isAdmin) continue;
        const tab = el('button', `group-tab nav-target${section === key ? ' active' : ''}`, key === 'manage' && group.requestCount ? `${label} (${group.requestCount})` : label);
        tab.addEventListener('click', () => {
          section = key;
          show(current);
        });
        tabs.append(tab);
      }
      if (section === 'manage' && !group.canManage && !group.isAdmin) section = 'about';
      pane.append(tabs);
      const body = el('div', 'group-body');
      pane.append(body);
      if (section === 'about') renderAbout(body, group);
      else if (section === 'members') renderMembers(body, group);
      else if (section === 'wall') renderWall(body, group);
      else renderManage(body, group);
    }

    function renderAbout(body, group) {
      body.append(el('div', `group-description${group.description ? '' : ' empty'}`, group.description || 'No description.'));
      if (group.games && group.games.length) {
        body.append(el('div', 'section-title', 'GAMES'));
        const list = el('div', 'group-games');
        for (const game of group.games) list.append(el('div', 'group-game', game.name));
        body.append(list);
      }
      if (!group.imported) body.append(el('div', 'group-sub', `Made ${when(group.created)}`));
    }

    async function renderMembers(body, group) {
      const filter = el('select', 'group-role-filter');
      const all = el('option', null, `All (${group.memberCount})`);
      all.value = '0';
      filter.append(all);
      for (const role of group.roles.slice().reverse()) {
        const option = el('option', null, `${role.name} (${role.count})`);
        option.value = String(role.id);
        if (role.id === membersRole) option.selected = true;
        filter.append(option);
      }
      filter.addEventListener('change', () => {
        membersRole = Number(filter.value) || 0;
        show(current);
      });
      body.append(filter);
      const grid = el('div', 'group-members');
      body.append(grid);
      try {
        const data = await call('GET', `groups/${group.id}/members?role=${membersRole}`);
        if (current !== group) return;
        if (!data.members.length) grid.append(el('div', 'chat-none', 'Nobody here.'));
        for (const member of data.members) {
          const card = el('div', `group-member p-${member.presence || 'offline'}`);
          const main = el('button', 'group-member-main nav-target');
          const pic = el('div', 'chat-pic');
          personPicture(pic, member.userId, 110);
          const text = el('div', 'chat-item-text');
          text.append(el('b', 'chat-item-title', member.name), el('div', 'chat-item-last', member.role));
          main.append(pic, text);
          main.addEventListener('click', () => openProfile({ userId: member.userId, name: member.name }));
          card.append(main);
          const me = getMe();
          const myRank = group.canOwn ? 256 : group.mine ? group.mine.rank : 0;
          if (group.canManage && me && member.userId !== me.account.userId && member.rank < myRank && member.userId !== group.owner.userId) {
            const pick = el('select', 'group-rank-pick');
            for (const role of group.roles) {
              if (role.rank >= Math.min(myRank, 255)) continue;
              const option = el('option', null, role.name);
              option.value = String(role.id);
              if (role.id === member.roleId) option.selected = true;
              pick.append(option);
            }
            pick.addEventListener('change', () => act(`members/${member.userId}/rank`, { roleId: Number(pick.value) }, `${member.name} is now ${pick.selectedOptions[0].textContent}.`));
            const kick = button('Remove', 'ghost', () => {
              if (window.confirm(`Remove ${member.name} from ${group.name}?`)) act(`members/${member.userId}/kick`, {}, `Removed ${member.name}.`);
            });
            card.append(pick, kick);
          }
          grid.append(card);
        }
      } catch (error) {
        grid.append(el('div', 'chat-none', message(error)));
      }
    }

    async function renderWall(body, group) {
      if (group.mine) {
        const form = el('form', 'group-post');
        const text = el('textarea');
        text.maxLength = 500;
        text.placeholder = 'Say something';
        const go = el('button', 'primary small', 'Post');
        form.append(text, go);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!text.value.trim()) return;
          go.disabled = true;
          const done = await act('wall', { text: text.value });
          go.disabled = false;
          if (done) section = 'wall';
        });
        body.append(form);
      }
      const list = el('div', 'group-wall');
      body.append(list);
      try {
        const data = await call('GET', `groups/${group.id}/wall`);
        if (current !== group) return;
        if (!data.posts.length) list.append(el('div', 'chat-none', 'No posts yet.'));
        for (const post of data.posts) {
          const row = el('div', 'group-wall-post');
          const top = el('div', 'group-wall-top');
          const who = el('button', 'link', post.from.name);
          who.addEventListener('click', () => openProfile({ userId: post.from.userId, name: post.from.name }));
          top.append(who, el('span', 'group-sub', when(post.at)));
          if (post.canDelete) top.append(button('Delete', 'ghost', () => act(`wall/${post.id}/delete`, {}, 'Post deleted.')));
          row.append(top, el('div', 'group-wall-text', post.text));
          list.append(row);
        }
      } catch (error) {
        list.append(el('div', 'chat-none', message(error)));
      }
    }

    function field(labelText, node) {
      const label = el('label', 'group-field');
      label.append(el('span', '', labelText), node);
      return label;
    }

    async function renderManage(body, group) {
      if (group.canManage) {
        // Shout
        const shoutForm = el('form', 'group-manage-row');
        const shout = el('input');
        shout.maxLength = 255;
        shout.placeholder = 'Shout to the group';
        shout.value = group.shout ? group.shout.text : '';
        shoutForm.append(field('Shout', shout), button('Shout', 'primary', (event) => { event.preventDefault(); act('shout', { text: shout.value }, 'Shout updated.'); }));
        body.append(shoutForm);
        // Requests
        if (!group.public || group.requestCount) {
          body.append(el('div', 'section-title', `REQUESTS (${group.requestCount})`));
          const list = el('div', 'group-requests');
          body.append(list);
          try {
            const data = await call('GET', `groups/${group.id}/requests`);
            if (!data.requests.length) list.append(el('div', 'chat-none', 'Nobody is waiting.'));
            for (const request of data.requests) {
              const row = el('div', 'group-request');
              const who = el('button', 'link', request.name);
              who.addEventListener('click', () => openProfile({ userId: request.userId, name: request.name }));
              row.append(who, button('Accept', 'primary', () => act(`requests/${request.userId}/accept`, {}, `${request.name} joined.`)),
                button('Decline', 'ghost', () => act(`requests/${request.userId}/decline`, {}, 'Declined.')));
              list.append(row);
            }
          } catch (error) {
            list.append(el('div', 'chat-none', message(error)));
          }
        }
      }
      if (group.canOwn) {
        body.append(el('div', 'section-title', 'SETTINGS'));
        const settings = el('form', 'group-settings');
        const description = el('textarea');
        description.maxLength = 1000;
        description.value = group.description || '';
        const openBox = el('input');
        openBox.type = 'checkbox';
        openBox.checked = group.public;
        const openLabel = el('label', 'group-check');
        openLabel.append(openBox, document.createTextNode(' Anyone can join'));
        settings.append(field('Description', description), openLabel,
          button('Save', 'primary', (event) => { event.preventDefault(); act('settings', { description: description.value, public: openBox.checked }, 'Saved.'); }));
        body.append(settings);

        // Emblem
        const pictureRow = el('div', 'group-manage-row');
        const file = el('input');
        file.type = 'file';
        file.accept = 'image/png,image/jpeg';
        file.className = 'hidden';
        file.addEventListener('change', async () => {
          const chosen = file.files && file.files[0];
          if (!chosen) return;
          if (chosen.size > 1024 * 1024) {
            status('Pictures can be up to 1 MB.', 'error');
            return;
          }
          try {
            const data = await api.groupEmblem(group.id, new Uint8Array(await chosen.arrayBuffer()));
            status('Picture changed.', 'good');
            show(data.group);
            loadMine();
          } catch (error) {
            status(message(error), 'error');
          }
        });
        pictureRow.append(emblem(group, 'group-emblem small'), file, button('Upload picture', 'ghost', (event) => { event.preventDefault(); file.click(); }));
        if (group.emblem) pictureRow.append(button('Remove picture', 'ghost', () => act('emblem/remove', {}, 'Picture removed.')));
        body.append(pictureRow);

        // Ranks
        body.append(el('div', 'section-title', 'RANKS'));
        const ranks = el('div', 'group-ranks');
        const rows = [];
        const addRow = (role) => {
          const row = el('div', 'group-rank-row');
          const name = el('input');
          name.maxLength = 50;
          name.value = role.name || '';
          name.placeholder = 'Rank name';
          const number = el('input');
          number.type = 'number';
          number.min = '1';
          number.max = '254';
          number.value = String(role.rank || '');
          const drop = button('×', 'ghost', (event) => {
            event.preventDefault();
            rows.splice(rows.indexOf(entry), 1);
            row.remove();
          });
          const entry = { id: role.id || 0, name, number };
          rows.push(entry);
          row.append(name, number, drop);
          ranks.append(row);
        };
        for (const role of group.roles) if (role.rank < 255) addRow(role);
        const owner = group.roles.find((role) => role.rank === 255);
        body.append(ranks);
        const rankButtons = el('div', 'group-actions');
        rankButtons.append(button('Add rank', 'ghost', () => addRow({ name: '', rank: '' })),
          button('Save ranks', 'primary', () => act('roles', { roles: rows.map((r) => ({ id: r.id, name: r.name.value, rank: Number(r.number.value) })) }, 'Ranks saved.')));
        body.append(rankButtons);
        if (owner) body.append(el('div', 'group-sub', `The owner's rank (255) is "${owner.name}".`));

        // Owner
        if (group.owner.userId) {
          body.append(el('div', 'section-title', 'OWNER'));
          const transferRow = el('div', 'group-manage-row');
          const who = el('input');
          who.placeholder = 'Member name';
          who.maxLength = 20;
          transferRow.append(field('Give the group to', who), button('Give away', 'ghost', async (event) => {
            event.preventDefault();
            const name = who.value.trim();
            if (!name) return;
            try {
              const found = await call('GET', `groups/${group.id}/members`);
              const all = [];
              for (let page = 1, pages = found.pages; page <= pages; page++) {
                const data = page === 1 ? found : await call('GET', `groups/${group.id}/members?page=${page}`);
                all.push(...data.members);
              }
              const member = all.find((m) => m.name.toLowerCase() === name.toLowerCase());
              if (!member) return status(`${name} is not in the group.`, 'error');
              if (window.confirm(`Give ${group.name} to ${member.name}? You can't undo this yourself.`)) act('transfer', { userId: member.userId }, `${member.name} owns ${group.name} now.`);
            } catch (error) {
              status(message(error), 'error');
            }
            return undefined;
          }));
          body.append(transferRow);
        }
      }
      if (group.isAdmin && !group.canOwn && group.emblem) {
        body.append(el('div', 'section-title', 'SERVER ADMIN'));
        body.append(button('Remove picture', 'ghost', () => act('emblem/remove', {}, 'Picture removed.')));
      }
      if (group.isAdmin || (group.canOwn && group.owner.userId && group.memberCount === 1)) {
        const del = button('Delete group', 'ghost danger-text', () => {
          if (window.confirm(`Delete ${group.name} for good? Its members, wall and ranks go with it.`)) act('delete', {}, 'Group deleted.');
        });
        body.append(del);
      }
    }

    // --- wiring ------------------------------------------------------------------------------

    $('groups-search-form').addEventListener('submit', search);
    $('groups-search').addEventListener('input', () => { if (!$('groups-search').value.trim() && results) { results = null; renderList(); } });
    $('groups-create').addEventListener('click', showCreate);

    return {
      activate() {
        loadMine();
        if (current) open(current.id);
        else if (!$('group-pane').childElementCount) showEmpty();
      },
      reset() {
        mine = [];
        results = null;
        current = null;
        unsupported = false;
        $('groups-search').value = '';
        showEmpty();
      },
      open(groupId) {
        section = 'about';
        return open(groupId);
      },
    };
  }

  window.GroupsView = { create };
})();
