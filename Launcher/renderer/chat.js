'use strict';

// The Chat tab: chats with friends (one-to-one and groups) and private
// messages (Inbox, Sent, Archive), from the server's /api/launcher/chat and
// /messages (lib/talkapi.js, servers from 2026-11-21 on). While the tab is
// open the list is checked every 8 s and an open chat every 2.5 s; otherwise
// only the unread counts, every 20 s (and the main process's 30 s beat, which
// also shows notifications).
//
//   const chat = ChatView.create({ api, el, message, personPicture, openProfile, sfx, getMe, onCounts })
//   chat.activate()  chat.deactivate()  chat.reset()  chat.openWith(person)  chat.writeTo(person)
//   chat.setCounts(counts)  chat.refreshCounts()

(function () {
  const $ = (id) => document.getElementById(id);
  const LIST_MS = 8000;
  const OPEN_MS = 2500;
  const COUNTS_MS = 20000;
  const TYPING_EVERY_MS = 3000;
  const RUN_MS = 5 * 60 * 1000; // lines closer than this from one sender share a name

  function create({ api, el, message, personPicture, openProfile, sfx, getMe, onCounts, onTrades }) {
    let active = false;
    let mode = 'chat';
    let unsupported = false;
    let convos = [];
    let open = null; // { id, convo, lastSeq, oldest, hasOlder }
    let openTimer = null;
    let listTimer = null;
    let countsTimer = null;
    let typingSent = 0;
    let picker = null; // { kind: 'one' | 'group' | 'add', chosen: Set }
    let folder = 'inbox';
    let page = 1;
    let reading = null;
    let lastCounts = null;
    let busy = false;

    const status = (text, kind) => {
      const node = $('chat-status');
      node.textContent = text || '';
      node.className = `status chat-status${kind ? ` ${kind}` : ''}`;
    };

    async function call(method, route, body) {
      try {
        return await api.talk(method, route, body);
      } catch (error) {
        if (/unknown launcher request/i.test(message(error))) unsupported = true;
        throw error;
      }
    }

    function when(iso, long) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const sameDay = date.toDateString() === now.toDateString();
      const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      if (sameDay) return time;
      const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
      return long ? `${day}, ${time}` : day;
    }

    function setCounts(counts) {
      if (!counts) return;
      lastCounts = counts;
      const show = (id, n) => {
        const node = $(id);
        if (!node) return;
        node.textContent = String(n);
        node.classList.toggle('hidden', !(n > 0));
      };
      show('chat-badge-chat', counts.chat);
      show('chat-badge-mail', counts.messages);
      if (onCounts) onCounts(counts);
    }

    async function refreshCounts() {
      if (!getMe() || unsupported) return;
      try {
        setCounts(await call('GET', 'counts'));
      } catch (error) { /* next time */ }
    }

    // --- layout ------------------------------------------------------------------------------

    function showPane(name) {
      for (const id of ['chat-empty', 'chat-convo', 'chat-picker', 'mail-read', 'mail-write', 'trade-pane']) $(id).classList.toggle('hidden', id !== name);
    }

    function setMode(next) {
      mode = next;
      $('chat-mode-chat').classList.toggle('active', mode === 'chat');
      $('chat-mode-mail').classList.toggle('active', mode === 'mail');
      $('chat-mode-trade').classList.toggle('active', mode === 'trade');
      $('chat-side-chat').classList.toggle('hidden', mode !== 'chat');
      $('chat-side-mail').classList.toggle('hidden', mode !== 'mail');
      $('chat-side-trade').classList.toggle('hidden', mode !== 'trade');
      status('');
      if (mode === 'trade') {
        closeConversation();
        showPane('trade-pane');
        if (onTrades) onTrades();
      } else if (mode === 'chat') {
        if (open) showPane('chat-convo');
        else showPane('chat-empty');
        $('chat-empty-text').textContent = 'Pick a chat, or start one with a friend.';
        loadList();
      } else {
        closeConversation();
        showPane('chat-empty');
        $('chat-empty-text').textContent = 'Pick a message, or write one.';
        loadFolder();
      }
    }

    function guestState() {
      const guest = !getMe();
      $('chat-guest').classList.toggle('hidden', !guest);
      $('chat-layout').classList.toggle('hidden', guest);
      return guest;
    }

    // --- chats -------------------------------------------------------------------------------

    function pictureFor(convo, size) {
      const box = el('div', 'chat-pic');
      const others = convo.members.filter((m) => !m.self);
      if (convo.type === 'group' && others.length > 1) {
        box.classList.add('group');
        for (const member of others.slice(0, 2)) {
          const small = el('div', 'chat-pic-part');
          personPicture(small, member.userId, size);
          box.append(small);
        }
      } else {
        personPicture(box, (others[0] || convo.members[0] || {}).userId, size);
      }
      const other = convo.type === 'one' ? others[0] : null;
      if (other && other.presence && other.presence !== 'offline') box.classList.add(`p-${other.presence}`);
      return box;
    }

    function renderList() {
      const list = $('chat-list');
      list.textContent = '';
      if (unsupported) {
        list.append(el('div', 'chat-none', "This server doesn't have chat yet."));
        return;
      }
      if (!convos.length) {
        list.append(el('div', 'chat-none', 'No chats yet.'));
        return;
      }
      for (const convo of convos) {
        const item = el('button', 'chat-item nav-target');
        if (open && open.id === convo.id) item.classList.add('active');
        if (convo.unread > 0) item.classList.add('unread');
        const text = el('div', 'chat-item-text');
        const top = el('div', 'chat-item-top');
        top.append(el('b', 'chat-item-title', convo.title), el('span', 'chat-item-time', convo.last ? when(convo.last.at) : ''));
        const line = convo.last ? `${convo.last.mine ? 'You' : convo.type === 'group' ? convo.last.name : ''}${convo.last.mine || convo.type === 'group' ? ': ' : ''}${convo.last.text}` : 'No messages yet';
        text.append(top, el('div', 'chat-item-last', line));
        item.append(pictureFor(convo, 110), text);
        if (convo.unread > 0) item.append(el('span', 'chat-item-count', String(convo.unread)));
        item.addEventListener('click', () => openConversation(convo.id));
        list.append(item);
      }
    }

    async function loadList() {
      if (!getMe()) return;
      try {
        const data = await call('GET', 'chat');
        convos = data.conversations || [];
        if (data.counts) setCounts(data.counts);
        $('chat-text').maxLength = data.maxText || 200;
        if (open) {
          const fresh = convos.find((c) => c.id === open.id);
          if (fresh) {
            open.convo = fresh;
            renderHead();
          }
        }
      } catch (error) {
        if (!unsupported) status(message(error), 'error');
      }
      renderList();
    }

    function closeConversation() {
      open = null;
      clearInterval(openTimer);
      openTimer = null;
    }

    function messageNode(m, previous) {
      const run = previous && previous.from === m.from && new Date(m.at) - new Date(previous.at) < RUN_MS;
      const row = el('div', `msg ${m.mine ? 'mine' : 'theirs'}${run ? ' run' : ''}`);
      row.dataset.seq = String(m.seq);
      if (!m.mine) {
        const pic = el('button', 'msg-pic');
        pic.tabIndex = -1;
        if (!run) {
          personPicture(pic, m.from, 110);
          pic.title = m.name;
          pic.addEventListener('click', () => openProfile({ userId: m.from, name: m.name }));
        }
        row.append(pic);
      }
      const body = el('div', 'msg-body');
      if (!run && !m.mine && open && open.convo.type === 'group') body.append(el('div', 'msg-name', m.name));
      const bubble = el('div', 'msg-text', m.text);
      bubble.title = when(m.at, true);
      body.append(bubble);
      row.append(body);
      return row;
    }

    function dayLine(m, previous) {
      const day = new Date(m.at).toDateString();
      if (previous && new Date(previous.at).toDateString() === day) return null;
      const today = new Date().toDateString();
      return el('div', 'msg-day', day === today ? 'Today' : new Date(m.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    }

    let shown = []; // messages in the open chat, oldest first

    function renderMessages(stick) {
      const box = $('chat-messages');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      box.textContent = '';
      if (open && open.hasOlder) {
        const more = el('button', 'ghost msg-older', 'Older messages');
        more.addEventListener('click', loadOlder);
        box.append(more);
      }
      if (!shown.length) box.append(el('div', 'chat-none', 'Say hi!'));
      shown.forEach((m, index) => {
        const previous = shown[index - 1];
        const line = dayLine(m, previous);
        if (line) box.append(line);
        box.append(messageNode(m, line ? null : previous));
      });
      if (stick || nearBottom) box.scrollTop = box.scrollHeight;
    }

    function memberChip(member, convo) {
      const chip = el('span', `chat-member p-${member.presence || 'offline'}`);
      const name = el('button', 'link', member.self ? `${member.name} (you)` : member.name);
      name.addEventListener('click', () => openProfile({ userId: member.userId, name: member.name }));
      chip.append(name);
      if (convo.isOwner && !member.self && convo.type === 'group') {
        const out = el('button', 'chat-member-out', '×');
        out.title = `Take ${member.name} out`;
        out.addEventListener('click', () => removeMember(member));
        chip.append(out);
      }
      return chip;
    }

    function headButton(label, onClick, kind = 'ghost') {
      const button = el('button', `${kind} small`, label);
      button.addEventListener('click', onClick);
      return button;
    }

    function renderHead() {
      if (!open) return;
      const convo = open.convo;
      const pics = $('chat-head-pic');
      pics.textContent = '';
      pics.append(pictureFor(convo, 150));
      $('chat-title').textContent = convo.title;
      const sub = $('chat-sub');
      sub.textContent = '';
      if (convo.type === 'group') {
        for (const member of convo.members) sub.append(memberChip(member, convo));
      } else {
        const other = convo.members.find((m) => !m.self);
        const where = { game: 'In a game', studio: 'In Studio', online: 'Online', offline: 'Offline' };
        sub.append(el('span', `chat-presence p-${(other && other.presence) || 'offline'}`, where[(other && other.presence) || 'offline'] || 'Offline'));
      }
      const actions = $('chat-head-actions');
      actions.textContent = '';
      if (convo.type === 'group') {
        actions.append(headButton('Add', () => openPicker('add')), headButton('Rename', renameGroup), headButton('Leave', leaveGroup));
      } else {
        const other = convo.members.find((m) => !m.self);
        if (other) actions.append(headButton('Profile', () => openProfile({ userId: other.userId, name: other.name })));
      }
      $('chat-form').classList.toggle('hidden', !convo.canSend);
      $('chat-closed').classList.toggle('hidden', convo.canSend);
      $('chat-closed').textContent = convo.reason || '';
    }

    async function openConversation(id) {
      if (picker) closePicker(true);
      closeConversation();
      open = { id, convo: convos.find((c) => c.id === id) || null, lastSeq: 0, oldest: 0, hasOlder: false };
      shown = [];
      showPane('chat-convo');
      status('');
      if (open.convo) renderHead();
      renderMessages(true);
      renderList();
      try {
        const data = await call('GET', `chat/${id}`);
        if (!open || open.id !== id) return;
        open.convo = data.conversation;
        shown = data.messages || [];
        open.lastSeq = shown.length ? shown[shown.length - 1].seq : 0;
        open.oldest = shown.length ? shown[0].seq : 0;
        open.hasOlder = shown.length >= 50;
        renderHead();
        renderMessages(true);
        showTyping(data.typing);
        markRead();
      } catch (error) {
        status(message(error), 'error');
      }
      openTimer = setInterval(pollOpen, OPEN_MS);
      if (open && open.convo && open.convo.canSend) $('chat-text').focus();
    }

    function showTyping(names) {
      const list = Array.isArray(names) ? names : [];
      $('chat-typing').textContent = list.length ? `${list.join(', ')} ${list.length === 1 ? 'is' : 'are'} typing…` : '';
    }

    async function markRead() {
      if (!open || !open.convo || !(open.convo.unread > 0)) return;
      open.convo.unread = 0;
      const convo = convos.find((c) => c.id === open.id);
      if (convo) convo.unread = 0;
      renderList();
      try {
        await call('POST', `chat/${open.id}/read`, {});
        refreshCounts();
      } catch (error) { /* next poll */ }
    }

    async function pollOpen() {
      if (!open || busy || document.hidden) return;
      const id = open.id;
      try {
        const data = await call('GET', `chat/${id}?after=${open.lastSeq}`);
        if (!open || open.id !== id) return;
        const fresh = (data.messages || []).filter((m) => m.seq > open.lastSeq);
        if (fresh.length) {
          shown.push(...fresh);
          open.lastSeq = fresh[fresh.length - 1].seq;
          renderMessages(false);
          if (fresh.some((m) => !m.mine)) sfx.play('select');
        }
        const before = JSON.stringify([open.convo && open.convo.canSend, open.convo && open.convo.members.map((m) => m.userId + m.presence), open.convo && open.convo.title]);
        open.convo = data.conversation;
        if (JSON.stringify([open.convo.canSend, open.convo.members.map((m) => m.userId + m.presence), open.convo.title]) !== before) renderHead();
        showTyping(data.typing);
        if (fresh.length && active) markRead();
      } catch (error) {
        if (/no such chat/i.test(message(error))) {
          closeConversation();
          showPane('chat-empty');
          loadList();
        }
      }
    }

    async function loadOlder() {
      if (!open || !open.oldest) return;
      const id = open.id;
      try {
        const data = await call('GET', `chat/${id}?before=${open.oldest}`);
        if (!open || open.id !== id) return;
        const older = data.messages || [];
        open.hasOlder = older.length >= 50;
        if (older.length) {
          shown = older.concat(shown);
          open.oldest = older[0].seq;
        }
        const box = $('chat-messages');
        const fromBottom = box.scrollHeight - box.scrollTop;
        renderMessages(false);
        box.scrollTop = box.scrollHeight - fromBottom;
      } catch (error) {
        status(message(error), 'error');
      }
    }

    async function sendLine(event) {
      event.preventDefault();
      const input = $('chat-text');
      const text = input.value.trim();
      if (!text || !open || busy) return;
      busy = true;
      try {
        const data = await call('POST', `chat/${open.id}/send`, { text });
        input.value = '';
        typingSent = 0;
        if (data.message && open && data.message.seq > open.lastSeq) {
          shown.push(data.message);
          open.lastSeq = data.message.seq;
          renderMessages(true);
        }
        if (data.conversation && open) open.convo = data.conversation;
        status('');
        loadList();
      } catch (error) {
        status(message(error), 'error');
      } finally {
        busy = false;
        input.focus();
      }
    }

    function onTyping() {
      if (!open || !$('chat-text').value.trim()) return;
      if (Date.now() - typingSent < TYPING_EVERY_MS) return;
      typingSent = Date.now();
      call('POST', `chat/${open.id}/typing`, { on: true }).catch(() => {});
    }

    async function renameGroup() {
      if (!open) return;
      const title = window.prompt('Group name', open.convo.customTitle || '');
      if (title === null) return;
      try {
        await call('POST', `chat/${open.id}/rename`, { title });
        await loadList();
      } catch (error) {
        status(message(error), 'error');
      }
    }

    async function leaveGroup() {
      if (!open || !window.confirm(`Leave "${open.convo.title}"?`)) return;
      try {
        await call('POST', `chat/${open.id}/leave`, {});
        closeConversation();
        showPane('chat-empty');
        await loadList();
      } catch (error) {
        status(message(error), 'error');
      }
    }

    async function removeMember(member) {
      if (!open || !window.confirm(`Take ${member.name} out of this group?`)) return;
      try {
        const data = await call('POST', `chat/${open.id}/remove`, { userId: member.userId });
        if (data.conversation) open.convo = data.conversation;
        renderHead();
        loadList();
      } catch (error) {
        status(message(error), 'error');
      }
    }

    // --- picking friends (new chat, new group, add) ---------------------------------------------

    async function openPicker(kind) {
      picker = { kind, chosen: new Set(), friends: [] };
      showPane('chat-picker');
      status('');
      $('picker-title').textContent = kind === 'one' ? 'New chat' : kind === 'group' ? 'New group' : 'Add to group';
      $('picker-name').classList.toggle('hidden', kind !== 'group');
      $('picker-name').value = '';
      $('picker-go').classList.toggle('hidden', kind === 'one');
      $('picker-go').textContent = kind === 'group' ? 'Start' : 'Add';
      const grid = $('picker-grid');
      grid.textContent = '';
      grid.append(el('div', 'chat-none', 'Loading friends…'));
      try {
        const data = await api.friends();
        const members = kind === 'add' && open ? new Set(open.convo.members.map((m) => m.userId)) : new Set();
        picker.friends = (data.friends || []).filter((f) => !members.has(f.userId));
      } catch (error) {
        status(message(error), 'error');
      }
      renderPicker();
    }

    function renderPicker() {
      const grid = $('picker-grid');
      grid.textContent = '';
      if (!picker) return;
      if (!picker.friends.length) {
        grid.append(el('div', 'chat-none', picker.kind === 'add' ? 'All your friends are in it already.' : 'No friends yet. Add some in People.'));
        return;
      }
      for (const friend of picker.friends) {
        const chip = el('button', `picker-friend nav-target p-${friend.presence || 'offline'}`);
        if (picker.chosen.has(friend.userId)) chip.classList.add('chosen');
        const pic = el('div', 'chat-pic');
        personPicture(pic, friend.userId, 110);
        chip.append(pic, el('span', '', friend.name));
        chip.addEventListener('click', () => {
          if (picker.kind === 'one') {
            startWith(friend.userId);
            return;
          }
          if (picker.chosen.has(friend.userId)) picker.chosen.delete(friend.userId);
          else picker.chosen.add(friend.userId);
          renderPicker();
        });
        grid.append(chip);
      }
    }

    function closePicker(quiet) {
      picker = null;
      if (quiet) return;
      if (open) showPane('chat-convo');
      else showPane('chat-empty');
    }

    async function startWith(userId) {
      try {
        const data = await call('POST', 'chat/start', { userId });
        picker = null;
        await loadList();
        await openConversation(data.conversation.id);
      } catch (error) {
        status(message(error), 'error');
      }
    }

    async function pickerGo() {
      if (!picker) return;
      const ids = [...picker.chosen];
      if (!ids.length) {
        status('Pick at least one friend.', 'error');
        return;
      }
      try {
        let data;
        if (picker.kind === 'group') data = await call('POST', 'chat/group', { userIds: ids, title: $('picker-name').value });
        else data = await call('POST', `chat/${open.id}/add`, { userIds: ids });
        const kind = picker.kind;
        picker = null;
        if (data.rejected && data.rejected.length) status(`Couldn't add ${data.rejected.join(', ')}.`, 'error');
        await loadList();
        if (kind === 'group' && data.conversation) await openConversation(data.conversation.id);
        else if (open) {
          if (data.conversation) open.convo = data.conversation;
          showPane('chat-convo');
          renderHead();
        }
      } catch (error) {
        status(message(error), 'error');
      }
    }

    // --- messages ---------------------------------------------------------------------------

    function renderFolderTabs() {
      document.querySelectorAll('#mail-folders button').forEach((button) => button.classList.toggle('active', button.dataset.folder === folder));
    }

    async function loadFolder() {
      if (!getMe()) return;
      renderFolderTabs();
      const list = $('mail-list');
      try {
        const data = await call('GET', `messages?folder=${folder}&page=${page}`);
        if (data.counts) setCounts(data.counts);
        list.textContent = '';
        if (!data.messages.length) list.append(el('div', 'chat-none', folder === 'inbox' ? 'No messages.' : folder === 'sent' ? 'Nothing sent yet.' : 'Nothing archived.'));
        for (const letter of data.messages) {
          const item = el('button', `chat-item mail-item nav-target${letter.read ? '' : ' unread'}`);
          if (reading && reading.id === letter.id) item.classList.add('active');
          const other = letter.mine ? letter.to : letter.from;
          const pic = el('div', 'chat-pic');
          personPicture(pic, other.userId, 110);
          const text = el('div', 'chat-item-text');
          const top = el('div', 'chat-item-top');
          top.append(el('b', 'chat-item-title', letter.mine ? `To ${other.name}` : other.name), el('span', 'chat-item-time', when(letter.at)));
          text.append(top, el('div', 'chat-item-last', letter.subject));
          item.append(pic, text);
          item.addEventListener('click', () => readLetter(letter.id));
          list.append(item);
        }
        const pages = $('mail-pages');
        pages.textContent = '';
        if (data.pages > 1) {
          const back = headButton('‹', () => { page = Math.max(1, page - 1); loadFolder(); });
          const next = headButton('›', () => { page = Math.min(data.pages, page + 1); loadFolder(); });
          back.disabled = data.page <= 1;
          next.disabled = data.page >= data.pages;
          pages.append(back, el('span', '', `${data.page} / ${data.pages}`), next);
        }
      } catch (error) {
        list.textContent = '';
        list.append(el('div', 'chat-none', unsupported ? "This server doesn't have messages yet." : message(error)));
      }
    }

    async function readLetter(id) {
      status('');
      try {
        const data = await call('GET', `messages/${id}`);
        reading = data.message;
        if (data.counts) setCounts(data.counts);
        const letter = reading;
        $('mail-subject').textContent = letter.subject;
        const who = $('mail-who');
        who.textContent = '';
        const person = letter.mine ? letter.to : letter.from;
        const name = el('button', 'link', person.name);
        name.addEventListener('click', () => openProfile({ userId: person.userId, name: person.name }));
        who.append(document.createTextNode(letter.mine ? 'To ' : 'From '), name, document.createTextNode(` · ${when(letter.at, true)}`));
        $('mail-body').textContent = letter.body;
        const actions = $('mail-actions');
        actions.textContent = '';
        if (!letter.mine) {
          actions.append(headButton('Reply', () => writeLetter(person.name, letter.subject.startsWith('RE: ') ? letter.subject : `RE: ${letter.subject}`, letter.id), 'primary'));
          actions.append(headButton(letter.archived ? 'Move to Inbox' : 'Archive', async () => {
            try {
              await call('POST', `messages/${letter.id}/archive`, { archived: !letter.archived });
              reading = null;
              showPane('chat-empty');
              loadFolder();
            } catch (error) {
              status(message(error), 'error');
            }
          }));
        }
        showPane('mail-read');
        loadFolder();
      } catch (error) {
        status(message(error), 'error');
      }
    }

    function writeLetter(to, subject, replyTo) {
      reading = null;
      $('mail-to').value = to || '';
      $('mail-to-subject').value = subject || '';
      $('mail-to-body').value = '';
      $('mail-write').dataset.replyTo = replyTo ? String(replyTo) : '';
      showPane('mail-write');
      status('');
      (to ? $('mail-to-body') : $('mail-to')).focus();
    }

    async function sendLetter(event) {
      event.preventDefault();
      if (busy) return;
      busy = true;
      try {
        const replyTo = Number($('mail-write').dataset.replyTo) || null;
        await call('POST', 'messages', { to: $('mail-to').value.trim(), subject: $('mail-to-subject').value, body: $('mail-to-body').value, replyTo });
        status('Sent.', 'good');
        showPane('chat-empty');
        folder = 'sent';
        page = 1;
        loadFolder();
      } catch (error) {
        status(message(error), 'error');
      } finally {
        busy = false;
      }
    }

    // --- wiring ------------------------------------------------------------------------------

    $('chat-mode-chat').addEventListener('click', () => setMode('chat'));
    $('chat-mode-mail').addEventListener('click', () => setMode('mail'));
    $('chat-mode-trade').addEventListener('click', () => setMode('trade'));
    $('chat-new').addEventListener('click', () => openPicker('one'));
    $('chat-new-group').addEventListener('click', () => openPicker('group'));
    $('picker-go').addEventListener('click', pickerGo);
    $('picker-cancel').addEventListener('click', () => closePicker());
    $('chat-form').addEventListener('submit', sendLine);
    $('chat-text').addEventListener('input', onTyping);
    $('mail-new').addEventListener('click', () => writeLetter('', '', null));
    $('mail-write').addEventListener('submit', sendLetter);
    $('mail-cancel').addEventListener('click', () => showPane(reading ? 'mail-read' : 'chat-empty'));
    document.querySelectorAll('#mail-folders button').forEach((button) => button.addEventListener('click', () => {
      folder = button.dataset.folder;
      page = 1;
      reading = null;
      showPane('chat-empty');
      loadFolder();
    }));

    countsTimer = setInterval(() => { if (!active) refreshCounts(); }, COUNTS_MS);

    return {
      activate() {
        active = true;
        if (guestState()) return;
        clearInterval(listTimer);
        listTimer = setInterval(() => { if (!document.hidden) (mode === 'chat' ? loadList() : null); }, LIST_MS);
        if (mode === 'chat') {
          loadList();
          if (open && !openTimer) openTimer = setInterval(pollOpen, OPEN_MS);
        } else if (mode === 'trade') {
          if (onTrades) onTrades();
        } else loadFolder();
      },
      deactivate() {
        active = false;
        clearInterval(listTimer);
        listTimer = null;
        clearInterval(openTimer);
        openTimer = null;
      },
      reset() {
        closeConversation();
        convos = [];
        shown = [];
        reading = null;
        picker = null;
        unsupported = false;
        lastCounts = null;
        setCounts({ chat: 0, messages: 0, friendRequests: 0 });
        renderList();
        showPane('chat-empty');
        guestState();
        refreshCounts();
      },
      async openWith(person) {
        if (mode !== 'chat') setMode('chat');
        await startWith(person.userId);
      },
      writeTo(person) {
        if (mode !== 'mail') setMode('mail');
        writeLetter(person.name, '', null);
      },
      showTrades() {
        if (mode !== 'trade') setMode('trade');
      },
      setCounts,
      refreshCounts,
      counts: () => lastCounts,
    };
  }

  window.ChatView = { create };
})();
