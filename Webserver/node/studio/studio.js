/* Shared by Studio's start page and publish dialog (lib/studio.js).
   Studio 2017 shows these in an old WebKit: ES5 and XMLHttpRequest only. */
var Studio = (function () {
  function $(id) { return document.getElementById(id); }

  function api(method, path, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) done(null, data);
      else done(data.error || ('The server answered ' + xhr.status + '.'), data);
    };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  // window.external is Studio's own object; in a normal browser it is missing.
  function inStudio() {
    try { return !!(window.external && typeof window.external.StartGame !== 'undefined'); } catch (e) { return false; }
  }

  function text(el, value) { el.textContent = value; }

  function show(el, visible) { el.style.display = visible ? '' : 'none'; }

  function status(el, message, kind) {
    text(el, message || '');
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function make(tag, className, content) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }

  // Wires a login form: #login-name, #login-password, #login-go, #login-status.
  function loginForm(onLoggedIn) {
    var go = $('login-go');
    function submit(event) {
      if (event) event.preventDefault();
      var name = $('login-name').value.replace(/^\s+|\s+$/g, '');
      var password = $('login-password').value;
      status($('login-status'), 'Logging in…');
      go.disabled = true;
      api('POST', '/studio/api/login', { name: name, password: password }, function (error, data) {
        go.disabled = false;
        if (error) { status($('login-status'), error, 'bad'); return; }
        $('login-password').value = '';
        status($('login-status'), data.created ? 'Account created. Welcome, ' + data.account.name + '!' : '', 'good');
        onLoggedIn(data.account);
      });
    }
    $('login-form').onsubmit = submit;
  }

  function logout(done) {
    api('POST', '/studio/api/logout', {}, function () { done(); });
  }

  function statusLine(game) {
    if (!game.online) return 'Offline';
    if (game.running) return 'Online · ' + game.players + (game.players === 1 ? ' player' : ' players');
    return 'Online · starting';
  }

  // "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "Mar 2".
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function timeAgo(iso) {
    var time = Date.parse(iso || '');
    if (isNaN(time)) return '';
    var minutes = Math.round((new Date().getTime() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' h ago';
    var days = Math.round(hours / 24);
    if (days < 2) return 'yesterday';
    if (days < 7) return days + ' days ago';
    var date = new Date(time);
    return MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  return { $: $, api: api, inStudio: inStudio, text: text, show: show, status: status, make: make, loginForm: loginForm, logout: logout, statusLine: statusLine, timeAgo: timeAgo };
}());
