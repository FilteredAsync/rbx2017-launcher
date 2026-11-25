'use strict';

// Players (the accounts the launcher, website, Studio and phone app share)
// with a panel per player, and player reports.

// Who is in which game now: name (lower case) -> place.
function playingNow() {
  const out = new Map();
  for (const place of data.places) {
    for (const server of place.servers || []) {
      for (const name of Array.isArray(server.players) ? server.players : []) out.set(String(name).toLowerCase(), place);
    }
  }
  return out;
}

// --- players ----------------------------------------------------------------------------------

const people = { filter: 'all', sort: 'login', text: '', open: null };
const DAY = 86400000;

function accountMatches(account, playing) {
  const text = people.text.trim().toLowerCase();
  if (text && !account.name.toLowerCase().includes(text) && !String(account.userId).includes(text)) return false;
  if (people.filter === 'playing') return playing.has(account.name.toLowerCase());
  if (people.filter === 'admins') return account.admin;
  if (people.filter === 'new') return Date.now() - Date.parse(account.createdAt) < 7 * DAY;
  if (people.filter === 'away') return !account.lastLoginAt || Date.now() - Date.parse(account.lastLoginAt) > 30 * DAY;
  return true;
}

function renderPlayers() {
  const playing = playingNow();
  const list = data.accounts;
  const admins = list.filter((account) => account.admin).length;
  const online = list.filter((account) => playing.has(account.name.toLowerCase())).length;
  $('players-sub').textContent = data.accountsError || (list.length ? `${plural(list.length, 'account')}, ${plural(admins, 'admin')}, ${online} playing` : '');
  for (const button of document.querySelectorAll('#players-filter button')) {
    button.classList.toggle('active', button.dataset.filter === people.filter);
    const saved = people.filter;
    people.filter = button.dataset.filter;
    const n = list.filter((account) => accountMatches(account, playing)).length;
    people.filter = saved;
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = button.dataset.filter === 'all' ? '' : n || '';
  }
  const sorters = {
    login: (a, b) => String(b.lastLoginAt || '').localeCompare(String(a.lastLoginAt || '')) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    robux: (a, b) => (b.robux || 0) - (a.robux || 0),
    joined: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  };
  const shown = list.filter((account) => accountMatches(account, playing)).sort(sorters[people.sort] || sorters.login);
  const against = new Map();
  for (const report of data.reports) {
    if (report.status !== 'open' || report.reportedId === null || report.reportedId === undefined) continue;
    against.set(Number(report.reportedId), (against.get(Number(report.reportedId)) || 0) + 1);
  }
  const rows = $('account-rows');
  const focused = rows.contains(document.activeElement) ? document.activeElement : null;
  const refocus = focused && focused.dataset.kind ? [focused.closest('tr').dataset.name, focused.dataset.kind] : null;
  const signature = JSON.stringify([shown, [...against], shown.map((account) => playing.has(account.name.toLowerCase()) && playing.get(account.name.toLowerCase()).placeId)]);
  const changed = paint(rows, signature, () => (shown.length ? shown.map((account) => {
    const where = playing.get(account.name.toLowerCase());
    const reports = against.get(Number(account.userId)) || 0;
    return h('tr', { dataset: { name: account.name }, class: 'clickable', onclick: () => { location.hash = `players/${encodeURIComponent(account.name)}`; } },
      h('td', {}, h('div', { class: 'game-name' }, h('span', { text: account.name }), account.admin && h('span', { class: 'tag', text: 'Admin' })),
        where ? h('div', { class: 'sub playing', text: `Playing ${where.name}` }) : h('div', { class: 'sub mono', text: account.userId })),
      h('td', { class: 'sub hide-sm', text: account.lastLoginAt ? ago(account.lastLoginAt) : 'Never' }),
      h('td', { class: 'sub hide-sm', text: when(account.createdAt).replace(/,? \d+:\d\d.*$/, '') }),
      h('td', { class: 'num' }, h('button', {
        type: 'button', class: 'linkish', title: `Give or take ${account.name}'s Robux`, dataset: { kind: 'robux' },
        text: Number(account.robux || 0).toLocaleString(), onclick: (event) => { event.stopPropagation(); changeRobux(account); },
      })),
      h('td', { class: 'num hide-sm' }, reports ? h('span', { class: 'bad-count', text: reports, title: plural(reports, 'open report') }) : ''),
      h('td', { class: 'right' }, adminSwitch(account)));
  }) : h('tr', {}, h('td', { class: 'empty-cell', colSpan: 6, text: list.length ? 'No player matches.' : 'No accounts yet.' }))));
  if (changed && refocus) {
    const row = Array.from(rows.children).find((tr) => tr.dataset.name === refocus[0]);
    const control = row && row.querySelector(`[data-kind="${refocus[1]}"]`);
    if (control) control.focus();
  }
  if (people.open) renderPlayerPanel();
}

function adminSwitch(account) {
  return h('input', {
    type: 'checkbox', class: 'switch', checked: account.admin, 'aria-label': `${account.name} is an admin`, dataset: { kind: 'admin' },
    onclick: (event) => event.stopPropagation(),
    onchange: (event) => {
      const on = event.target.checked;
      act(async () => {
        await change('POST', `/api/studio/accounts/${encodeURIComponent(account.name)}`, JSON.stringify({ admin: on }));
        await loadAccounts();
      }, on ? `Making ${account.name} an admin` : `Removing ${account.name} as admin`, on ? `${account.name} is an admin` : `${account.name} is no longer an admin`);
    },
  });
}

// Gives or takes an account's Robux (lib/robux.js).
function changeRobux(account) {
  const dialog = $('robux-dialog');
  $('robux-title').textContent = `${account.name}'s Robux`;
  $('robux-now').textContent = `They have R$ ${Number(account.robux || 0).toLocaleString()}.`;
  $('robux-amount').value = '';
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue !== 'ok') return;
    const amount = Math.trunc(Number($('robux-amount').value.replace(/[,\s]/g, '')));
    if (!Number.isFinite(amount) || amount === 0) { toast('Type an amount, such as 100 or -50.', 'error'); return; }
    act(async () => {
      await change('POST', `/api/studio/accounts/${encodeURIComponent(account.name)}/robux`, JSON.stringify({ amount }));
      await loadAccounts();
    }, amount > 0 ? `Giving ${account.name} R$ ${amount}` : `Taking R$ ${-amount} from ${account.name}`, 'Robux changed');
  };
  dialog.showModal();
  $('robux-amount').focus();
}

async function deleteAccount(account) {
  if (!await ask(`Delete ${account.name}?`, 'This is how a password is reset. They are logged out, and the next login with this name makes a new account that gets the games this one owns, so only do this for its owner.', 'Delete', true)) return;
  const done = await act(async () => {
    await change('DELETE', `/api/studio/accounts/${encodeURIComponent(account.name)}`);
    await loadAccounts();
  }, `Deleting ${account.name}`, `${account.name} deleted`);
  if (done !== null && people.open) location.hash = 'players';
}

// The panel for one player (#players/<name>).
function renderPlayerPanel() {
  const panel = $('drawer');
  const account = data.accounts.find((item) => item.name.toLowerCase() === String(people.open).toLowerCase());
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  $('scrim').hidden = false;
  if (!account) {
    paint($('drawer-head'), `none:${people.open}`, () => [h('div', { class: 'head-text' }, h('h2', { text: people.open }), h('div', { class: 'meta', text: data.accounts.length ? 'No account with this name.' : 'Loading' })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: closePanel })]);
    $('drawer-body').replaceChildren();
    return;
  }
  const where = playingNow().get(account.name.toLowerCase());
  const owns = data.places.filter((place) => place.owner && Number(place.owner.userId) === Number(account.userId));
  const edits = data.places.filter((place) => (place.editors || []).some((editor) => Number(editor.userId) === Number(account.userId)));
  const about = data.reports.filter((report) => Number(report.reportedId) === Number(account.userId));
  const by = data.reports.filter((report) => Number(report.reporterId) === Number(account.userId));
  paint($('drawer-head'), JSON.stringify([account, where && where.placeId]), () => [
    h('div', { class: 'avatar', text: account.name.charAt(0).toUpperCase() }),
    h('div', { class: 'head-text' }, h('h2', { text: account.name }),
      h('div', { class: 'meta' }, h('span', { text: `User ${account.userId}` }), account.admin && h('span', { class: 'tag', text: 'Admin' })),
      where && h('div', { class: 'playing' }, 'Playing ', link(where.name, `games/${where.placeId}/servers`))),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: closePanel }),
  ]);
  const fact = (label, value) => [h('dt', { text: label }), h('dd', {}, value)];
  paint($('drawer-body'), JSON.stringify([account, owns.map((place) => place.placeId), edits.map((place) => place.placeId), about, by.length]), () => [
    h('dl', { class: 'card facts' },
      fact('Joined', when(account.createdAt)),
      fact('Last login', account.lastLoginAt ? `${when(account.lastLoginAt)} (${ago(account.lastLoginAt)})` : 'Never'),
      fact('Robux', h('span', {}, `R$ ${Number(account.robux || 0).toLocaleString()} `, h('button', { type: 'button', class: 'linkish', text: 'Change', onclick: () => changeRobux(account) }))),
      fact('Admin', h('label', { class: 'inline check' }, adminSwitch(account), account.admin ? 'Yes' : 'No')),
      fact('Reported', by.length ? plural(by.length, 'player') : 'Nobody')),
    owns.length || edits.length ? h('div', {}, h('h3', { text: 'Games' }),
      h('div', { class: 'card list' }, [...owns.map((place) => [place, 'Owner']), ...edits.map((place) => [place, 'Editor'])].map(([place, role]) => h('a', { class: 'list-row', href: `#games/${place.placeId}` },
        thumb(place), h('div', { class: 'text' }, h('b', { text: place.name }), h('small', { text: role })))))) : null,
    h('div', {}, h('h3', { text: about.length ? `Reports about them (${about.length})` : 'Reports about them' }),
      about.length ? h('div', { class: 'reports compact' }, about.map((report) => reportCard(report, { compact: true })))
        : h('p', { class: 'muted', text: 'None.' })),
    h('div', { class: 'danger-zone' },
      h('div', {}, h('b', { text: 'Delete this account' }), h('p', { text: 'How a password is reset.' })),
      btn('Delete', 'danger', () => deleteAccount(account))),
  ]);
}

function closePanel() { location.hash = 'players'; }
function hidePanel() {
  people.open = null;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').hidden = true;
  $('drawer-head').dataset.sig = '';
  $('drawer-body').dataset.sig = '';
}

views.players = {
  show(args) {
    people.open = args[0] || null;
    if (!people.open) hidePanel();
    if (!data.accounts.length) loadAccounts();
    renderPlayers();
  },
  render(what) { if (['accounts', 'places', 'reports'].includes(what)) renderPlayers(); },
  async leave() { hidePanel(); return true; },
};

// --- reports ----------------------------------------------------------------------------------

const reportView = { status: 'open', group: 'none', text: '', game: '', selected: new Set() };
const openChats = new Set();   // reports whose chat is unfolded

function reportMatches(report) {
  if (reportView.status && report.status !== reportView.status) return false;
  if (reportView.game && report.placeId !== reportView.game) return false;
  const text = reportView.text.trim().toLowerCase();
  if (text && !`${report.reportedName || ''} ${report.reporterName || ''} ${report.reason || ''} ${report.text || ''} ${report.gameName || ''}`.toLowerCase().includes(text)) return false;
  return true;
}

function reportCard(report, options) {
  const compact = options && options.compact;
  const open = report.status === 'open';
  const who = report.reportedId === null || report.reportedId === undefined ? 'The game' : (report.reportedName || `User ${report.reportedId}`);
  const game = report.gameName || (report.placeId ? `Place ${report.placeId}` : null);
  const messages = report.messages || [];
  const pick = !compact && h('input', {
    type: 'checkbox', checked: reportView.selected.has(report.id), 'aria-label': 'Select this report',
    onchange: (event) => { if (event.target.checked) reportView.selected.add(report.id); else reportView.selected.delete(report.id); renderReports(true); },
  });
  return h('div', { class: `card report-item${open ? '' : ' resolved'}` },
    pick,
    h('div', { class: 'body' },
      h('div', { class: 'head' },
        report.reportedId !== null && report.reportedId !== undefined && !compact
          ? link(who, `players/${encodeURIComponent(report.reportedName || '')}`, 'who') : h('span', { class: 'who', text: who }),
        report.reason ? h('span', { class: 'reason', text: report.reason }) : null),
      report.text ? h('div', { class: 'text', text: report.text }) : null,
      h('div', { class: 'meta' },
        h('span', { text: report.reporterName ? `By ${report.reporterName}` : 'Reporter unknown' }),
        game ? (report.placeId && placeById(report.placeId) ? link(game, `games/${report.placeId}`) : h('span', { text: game })) : null,
        report.source === 'launcher' ? h('span', { text: 'From the launcher' }) : null,
        h('span', { text: when(report.at) }),
        open ? null : h('span', { text: `Resolved${report.resolvedBy ? ` by ${report.resolvedBy}` : ''}` })),
      messages.length ? h('details', {
        class: 'notes', open: openChats.has(report.id),
        ontoggle: (event) => { if (event.target.open) openChats.add(report.id); else openChats.delete(report.id); },
      }, h('summary', { text: `Chat (${messages.length})` }), h('pre', { text: messages.join('\n') })) : null),
    h('div', { class: 'actions' },
      open ? btn('Resolve', 'small', () => act(async () => {
        await change('POST', `/api/reports/${report.id}/resolve`, '{}');
        await loadReports();
      }, 'Resolving', 'Resolved')) : null,
      btn('Delete', 'small quiet danger', async () => {
        if (!await ask('Delete this report?', '', 'Delete', true)) return;
        act(async () => {
          await change('DELETE', `/api/reports/${report.id}`);
          await loadReports();
        }, 'Deleting', 'Deleted');
      })));
}

function renderReports(force) {
  const list = data.reports;
  for (const id of [...reportView.selected]) if (!list.some((report) => report.id === id)) reportView.selected.delete(id);
  for (const button of document.querySelectorAll('#reports-filter button')) {
    button.classList.toggle('active', button.dataset.filter === reportView.status);
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = list.filter((report) => !button.dataset.filter || report.status === button.dataset.filter).length || '';
  }
  for (const button of document.querySelectorAll('#reports-group button')) button.classList.toggle('active', button.dataset.group === reportView.group);
  const gameIds = [...new Set(list.map((report) => report.placeId).filter(Boolean))];
  paint($('reports-game'), JSON.stringify(gameIds), () => [h('option', { value: '', text: 'Every game' }),
    ...gameIds.map((id) => h('option', { value: id, text: (placeById(id) || {}).name || list.find((report) => report.placeId === id).gameName || `Place ${id}` }))]);
  $('reports-game').value = reportView.game;

  const shown = list.filter(reportMatches);
  // Bulk bar
  const picked = shown.filter((report) => reportView.selected.has(report.id));
  const bar = $('reports-bulk');
  bar.hidden = !picked.length;
  // What is picked and shown when a button is clicked (the bar outlives polling).
  const pickedNow = () => data.reports.filter(reportMatches).filter((report) => reportView.selected.has(report.id));
  paint(bar, JSON.stringify(picked.map((report) => [report.id, report.status])), () => [
    h('b', { text: `${picked.length} selected` }),
    picked.some((report) => report.status === 'open') && btn('Resolve', 'small', () => bulkReports(pickedNow().filter((report) => report.status === 'open'), 'resolve')),
    btn('Delete', 'small danger', () => bulkReports(pickedNow(), 'delete')),
    h('span', { class: 'grow' }),
    btn('Select all', 'small quiet', () => { for (const report of data.reports.filter(reportMatches)) reportView.selected.add(report.id); renderReports(true); }),
    btn('Clear', 'small quiet', () => { reportView.selected.clear(); renderReports(true); }),
  ]);

  const box = $('report-list');
  const signature = JSON.stringify([shown, reportView.group, [...reportView.selected], data.places.map((place) => place.placeId)]);
  if (!force && box.dataset.sig === signature) return;
  box.dataset.sig = signature;
  if (!shown.length) {
    box.replaceChildren(h('p', { class: 'empty', text: data.reportsError || (reportView.status === 'open' && !reportView.text && !reportView.game ? 'No open reports.' : 'No reports here.') }));
    return;
  }
  if (reportView.group === 'none') {
    box.replaceChildren(...shown.map((report) => reportCard(report)));
    return;
  }
  // Grouped by the reported player, or by game.
  const keyOf = reportView.group === 'player'
    ? (report) => (report.reportedId === null || report.reportedId === undefined ? 'The game' : report.reportedName || `User ${report.reportedId}`)
    : (report) => (report.placeId ? (placeById(report.placeId) || {}).name || report.gameName || `Place ${report.placeId}` : 'No game');
  const groups = new Map();
  for (const report of shown) {
    const key = keyOf(report);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  box.replaceChildren(...sorted.map(([key, items]) => {
    const openOnes = items.filter((report) => report.status === 'open');
    return h('div', { class: 'report-group' },
      h('div', { class: 'group-head' }, h('b', { text: key }), h('span', { class: 'muted', text: openOnes.length ? `${openOnes.length} open` : plural(items.length, 'report') }),
        h('span', { class: 'grow' }),
        openOnes.length > 1 && btn('Resolve all', 'small quiet', () => bulkReports(openOnes, 'resolve'))),
      ...items.map((report) => reportCard(report)));
  }));
}

async function bulkReports(list, what) {
  if (what === 'delete' && !await ask(`Delete ${plural(list.length, 'report')}?`, '', 'Delete', true)) return;
  await actEach(list, (report) => (what === 'resolve' ? change('POST', `/api/reports/${report.id}/resolve`, '{}') : change('DELETE', `/api/reports/${report.id}`)),
    (i, n) => `${what === 'resolve' ? 'Resolving' : 'Deleting'} ${i} of ${n}`, (n) => `${plural(n, 'report')} ${what === 'resolve' ? 'resolved' : 'deleted'}`);
  reportView.selected.clear();
  await loadReports();
}

views.reports = {
  // #reports[/game/<placeId>]
  show(args) {
    if (args[0] === 'game' && args[1]) { reportView.game = args[1]; reportView.status = ''; }
    renderReports(true);
  },
  render(what) { if (['reports', 'places'].includes(what)) renderReports(false); },
};

document.addEventListener('DOMContentLoaded', () => {
  $('accounts-filter').addEventListener('input', () => { people.text = $('accounts-filter').value; renderPlayers(); });
  for (const button of document.querySelectorAll('#players-filter button')) {
    button.addEventListener('click', () => { people.filter = button.dataset.filter; renderPlayers(); });
  }
  $('players-sort').addEventListener('change', () => { people.sort = $('players-sort').value; renderPlayers(); });
  $('scrim').addEventListener('click', closePanel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && people.open && !document.querySelector('dialog[open]')) closePanel();
  });
  for (const button of document.querySelectorAll('#reports-filter button')) {
    button.addEventListener('click', () => { reportView.status = button.dataset.filter; renderReports(true); });
  }
  for (const button of document.querySelectorAll('#reports-group button')) {
    button.addEventListener('click', () => { reportView.group = button.dataset.group; renderReports(true); });
  }
  $('reports-game').addEventListener('change', () => { reportView.game = $('reports-game').value; renderReports(true); });
  $('reports-search').addEventListener('input', () => { reportView.text = $('reports-search').value; renderReports(true); });
});
