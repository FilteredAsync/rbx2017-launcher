'use strict';

// Announcements to every launcher, and the always-on server itself: updates,
// restarting, the website key and its logs.

// --- announcements --------------------------------------------------------------------------

async function loadNews() {
  try {
    const response = await fetch('/api/announcements', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderNews(result.announcements || []);
  } catch (error) {
    $('news-list').replaceChildren(h('p', { class: 'empty', text: error.message }));
  }
}

function renderNews(list) {
  if (!list.length) {
    $('news-list').replaceChildren(h('p', { class: 'empty', text: 'Nothing posted right now.' }));
    return;
  }
  $('news-list').replaceChildren(...list.map((item) => h('div', { class: `card news-item${item.level === 'important' ? ' important' : ''}` },
    h('div', { class: 'body' },
      item.title && h('div', { class: 'head', text: item.title }),
      h('div', { class: 'text', text: item.text }),
      h('div', { class: 'meta' }, h('span', { text: `Posted ${when(item.postedAt)}` }),
        h('span', { text: item.expiresAt ? `Until ${when(item.expiresAt)}` : 'Until removed' }),
        item.level === 'important' && h('span', { class: 'pop', text: 'Pops up' }))),
    btn('Remove', 'small', async () => {
      if (!await ask('Remove this announcement?', 'It disappears from every launcher.', 'Remove', true)) return;
      try {
        await change('DELETE', `/api/announcements/${encodeURIComponent(item.id)}`);
        toast('Removed', 'good');
      } catch (error) {
        toast(error.message, 'error');
      }
      loadNews();
    }))));
}

views.news = {
  show() { loadNews(); },
  tick(current) { if (current === 'news') loadNews(); },
};

// --- server ------------------------------------------------------------------------------------

let logName = 'server';

function renderServer() {
  const info = data.serverInfo;
  if (!info) { $('srv-sub').textContent = data.serverInfoError || ''; return; }
  const installed = info.installed || {};
  const status = info.runner || {};
  const checks = status.updates || null;
  const live = data.places.reduce((sum, place) => sum + (place.servers || []).filter((server) => server.state === 'running').length, 0);
  $('srv-sub').textContent = data.serverInfoError || (status.running ? '' : "The always-on server isn't running. Updates and restarts wait for it.");

  const stat = (label, value, note, kind) => h('div', { class: 'card stat' },
    h('div', { class: 'label', text: label }), h('div', { class: `value ${kind || ''}`, text: value }), note && h('div', { class: 'note', text: note }));
  const last = info.lastResult;
  paint($('srv-stats'), JSON.stringify([status.running, live, installed, last, data.runner.maxGames, data.runner.idleStopMinutes]), () => [
    stat('Status', status.running ? 'Running' : 'Stopped', data.runner.idleStopMinutes ? `Empty servers stop after ${data.runner.idleStopMinutes} min` : null, status.running ? 'good' : 'bad'),
    stat('Game servers', `${live}${data.runner.maxGames ? ` of ${data.runner.maxGames}` : ''}`, 'running now'),
    stat('Version', installed.publicLabel || 'Not recorded', installed.privateLabel ? `Private files ${installed.privateLabel}` : null),
    stat('Last update', last ? (last.ok ? 'Installed' : 'Failed') : 'None yet', last ? `${when(last.at)}${last.ok ? '' : `: ${last.error}`}` : null, last && !last.ok ? 'bad' : ''),
  ]);

  const waiting = info.staged.filter((item) => !item.failed);
  const failed = info.staged.filter((item) => item.failed);
  const label = (item) => `${item.kind === 'private' ? 'Private files' : 'Server files'} ${item.label}`;
  paint($('srv-updates'), JSON.stringify([waiting, failed, checks]), () => {
    const out = [];
    if (waiting.length) {
      out.push(h('b', { text: `Ready to install: ${waiting.map(label).join(', ')}` }));
      if (!checks || checks.autoUpdate !== false) out.push(h('small', { text: 'Installs by itself once nobody has played for 3 minutes.' }));
      for (const item of waiting) if (item.notes) out.push(h('small', { text: item.notes }));
    } else if (checks && checks.checking) {
      out.push(h('b', { text: 'Checking for updates' }));
    } else if (checks && checks.lastError) {
      out.push(h('b', { class: 'bad', text: "Couldn't check for updates" }), h('small', { text: checks.lastError }));
    } else {
      out.push(h('b', { text: 'Up to date' }), h('small', { text: checks && checks.lastCheck ? `Checked ${when(checks.lastCheck)}` : 'Not checked yet' }));
    }
    for (const item of failed) {
      out.push(h('div', { class: 'bad', text: `${label(item)} didn't work: ${item.failed}` }),
        h('div', {}, btn('Discard it', 'small danger', async () => {
          try {
            await change('POST', `/api/server/update/discard?build=${item.build}`);
            loadServer();
          } catch (error) {
            toast(error.message, 'error');
          }
        })));
    }
    return out;
  });
  $('srv-install').hidden = waiting.length === 0;
}

async function serverAction(url, message, done) {
  try {
    const note = toast(message, 'busy', true);
    await change('POST', url).finally(() => note.close());
    toast(done, 'good');
    setTimeout(loadServer, 4000);
    setTimeout(loadServer, 15000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

// Refreshed every few seconds while the Server view is open. It follows new
// lines only when scrolled to the end, and waits while text in it is selected.
async function loadLog() {
  for (const button of document.querySelectorAll('#log-tabs button')) button.classList.toggle('active', button.dataset.log === logName);
  const out = $('srv-log');
  const name = logName;
  let text;
  try {
    const response = await fetch(`/api/server/logs?name=${encodeURIComponent(name)}&lines=300`, { headers: authHeaders(), cache: 'no-store' });
    text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = JSON.parse(text).error; } catch (error) { /* plain text */ }
      throw new Error(message || `HTTP ${response.status}`);
    }
    text = text || '(empty)';
  } catch (error) {
    text = error.message;
  }
  if (name !== logName) return;
  const selection = window.getSelection();
  if (out.dataset.log === name && selection && !selection.isCollapsed && out.contains(selection.anchorNode)) return;
  if (out.dataset.log === name && out.textContent === text) return;
  const follow = out.dataset.log !== name || out.scrollHeight - out.scrollTop - out.clientHeight < 30;
  const top = out.scrollTop;
  out.textContent = text;
  out.dataset.log = name;
  out.scrollTop = follow ? out.scrollHeight : top;
}

views.server = {
  show() { renderServer(); loadLog(); },
  render(what) { if (['serverInfo', 'places'].includes(what)) renderServer(); },
  tick(current) { if (current === 'server') loadLog(); },
};

document.addEventListener('DOMContentLoaded', () => {
  $('news-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await change('POST', '/api/announcements', JSON.stringify({
        title: $('news-title').value,
        text: $('news-text').value,
        level: $('news-important').checked ? 'important' : 'info',
        expiresHours: Number($('news-expires').value),
      }));
      $('news-title').value = '';
      $('news-text').value = '';
      $('news-important').checked = false;
      toast('Posted. Launchers pick it up within a few minutes.', 'good');
      loadNews();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // The website key (lib/sitekey.js), shown on request.
  $('site-key-show').addEventListener('click', async () => {
    const box = $('site-key');
    if (!box.hidden) {
      box.hidden = true;
      $('site-key-copy').hidden = true;
      $('site-key-show').textContent = 'Show';
      return;
    }
    try {
      const result = await getJson('/api/server/site-key');
      box.textContent = result.key;
      box.hidden = false;
      $('site-key-copy').hidden = false;
      $('site-key-show').textContent = 'Hide';
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('site-key-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('site-key').textContent);
      toast('Website key copied', 'good');
    } catch (error) {
      toast("Couldn't copy. Select the key and copy it.", 'error');
    }
  });

  $('srv-check').addEventListener('click', () => serverAction('/api/server/update/check', 'Asking the server to check', 'Checking. The result shows here in a few seconds.'));
  $('srv-install').addEventListener('click', async () => {
    if (!await ask('Install the update now?', 'Players are saved and get a message. The server is back in about a minute, and if the new version fails the old one comes back.', 'Install')) return;
    serverAction('/api/server/update/install', 'Asking the server to install', 'Installing. Reload this page in a minute.');
  });
  $('srv-restart').addEventListener('click', async () => {
    if (!await ask('Restart the whole server?', 'Players are saved and get a message. Everything is back in about a minute.', 'Restart', true)) return;
    serverAction('/api/server/restart', 'Asking the server to restart', 'Restarting. Reload this page in a minute.');
  });
  $('srv-upload-button').addEventListener('click', () => $('srv-upload').click());
  $('srv-upload').addEventListener('change', async () => {
    const file = $('srv-upload').files[0];
    $('srv-upload').value = '';
    if (!file) return;
    const progress = $('srv-progress');
    const note = toast(`Uploading ${file.name}`, 'busy', true);
    try {
      progress.hidden = false;
      progress.value = 0;
      const result = await uploadFile('/api/server/update/upload', file, (percent) => { progress.value = percent; });
      toast(`Ready: ${result.staged.kind === 'private' ? 'private files' : 'server files'} ${result.staged.label}, ${result.staged.files} files`, 'good');
      loadServer();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      note.close();
      progress.hidden = true;
    }
  });
  for (const button of document.querySelectorAll('#log-tabs button')) {
    button.addEventListener('click', () => { logName = button.dataset.log; loadLog(); });
  }
  $('log-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('srv-log').textContent);
      toast('Log copied', 'good');
    } catch (error) {
      toast("Couldn't copy. Select the text and copy it.", 'error');
    }
  });
});
