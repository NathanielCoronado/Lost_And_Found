/* =========================================================
   Lost & Found: shared script (every page loads this file)
   1. Storage             4. Reports & requests   7. UI
   2. Lists & formatting  5. Notifications        8. Setup
   3. Users & login       6. Email & passwords    9. Public API (window.LF)
   ========================================================= */
(function (window, document) {
  'use strict';

  /* ===== 1. STORAGE ===== */
  /* Shared data (accounts, reports, requests, notifications) lives on the server: api/*.php + MySQL.
     Each page loads what the user may see once (api/bootstrap.php), then saves changes with api/sync.php.
     Server calls wait for the answer (synchronous), so the rest of this file works like before.
     One-time messages (flash) and the password-reset demo stay in sessionStorage. */

  var PREFIX = 'lf.';
  var API = 'api/';

  // Falls back to memory if storage is blocked (private mode).
  var STORE = (function () {
    try {
      var s = window.sessionStorage;
      s.setItem(PREFIX + 'test', '1');
      s.removeItem(PREFIX + 'test');
      return s;
    } catch (e) {
      var mem = {};
      return {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  })();

  // Lists saved on the server, one row per item.
  var ROW_KEYS = { users: 1, lostReports: 1, foundReports: 1, claimRequests: 1, foundNotices: 1,
                   notifications: 1, userNotes: 1, trash: 1, deletedAccounts: 1 };
  var META_KEYS = { siteLogo: 1 };
  var DB = { meId: null, pending: null, pwChange: null, meta: {}, data: {}, snap: {}, offline: false };
  var NET_ERROR = 'Can\'t reach the server. Check your internet connection and try again.';

  // Calls api/<file>. Returns the parsed answer, or null if the server can't be reached.
  function api(file, body) {
    var x = new XMLHttpRequest();
    try {
      x.open(body ? 'POST' : 'GET', API + file + (body ? '' : '?t=' + Date.now()), false);
      x.setRequestHeader('X-LF', '1');
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      x.send(body ? JSON.stringify(body) : null);
    } catch (e) { return null; }
    try { return JSON.parse(x.responseText); }
    catch (e) {
      // InfinityFree sometimes answers with its browser check page; reloading passes it.
      var last = +(STORE.getItem(PREFIX + 'reloadAt') || 0);
      if (/<html/i.test(x.responseText || '') && Date.now() - last > 30000) {
        STORE.setItem(PREFIX + 'reloadAt', String(Date.now()));
        window.location.reload();
      }
      return null;
    }
  }

  // Same as api(), but doesn't freeze the page (for calls that send email). Resolves the answer, or null.
  function apiAsync(file, body) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open('POST', API + file, true);
      x.setRequestHeader('X-LF', '1');
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () { try { resolve(JSON.parse(x.responseText)); } catch (e) { resolve(null); } };
      x.onerror = x.ontimeout = function () { resolve(null); };
      x.timeout = 60000;
      x.send(JSON.stringify(body || {}));
    });
  }

  // Puts a user returned by the server into the local list.
  function putUser(u) {
    if (!u || !u.id) return;
    var list = (DB.data.users || []).slice(), i = list.findIndex(function (x) { return x.id === u.id; });
    if (i < 0) return;
    list[i] = u; DB.data.users = list; DB.snap.users[u.id] = JSON.stringify(u);
  }

  function rowId(key, r) { return key === 'deletedAccounts' ? (r.id || String(r.email || '').toLowerCase()) : r.id; }

  function setRows(key, list) {
    DB.data[key] = list; DB.snap[key] = {};
    list.forEach(function (r) { var id = rowId(key, r); if (id != null) DB.snap[key][id] = JSON.stringify(r); });
  }

  (function load() {
    var r = api('bootstrap.php');
    if (!r || !r.ok) { DB.offline = true; Object.keys(ROW_KEYS).forEach(function (k) { setRows(k, []); }); return; }
    DB.meId = r.meId || null;
    DB.pending = r.pending || null;
    DB.pwChange = r.pwChange || null;
    DB.meta = r.meta || {};
    setRows('users', r.users || []);
    Object.keys(ROW_KEYS).forEach(function (k) { if (k !== 'users') setRows(k, (r.data && r.data[k]) || []); });
  })();

  // Sends only the rows that changed since the last save.
  function syncRows(key, list) {
    var old = DB.snap[key] || {}, seen = {}, ups = [], dels = [];
    list.forEach(function (r) {
      var id = rowId(key, r); if (id == null) return;
      var s = JSON.stringify(r); seen[id] = s;
      if (old[id] !== s) ups.push(r);
    });
    Object.keys(old).forEach(function (id) { if (!(id in seen)) dels.push(id); });
    if (!ups.length && !dels.length) { DB.data[key] = list; return true; }
    var res = api('sync.php', { coll: key, upserts: ups, deletes: dels });
    if (!res || !res.ok) {
      lastError = (res && res.error) || NET_ERROR;
      if (res && res.relogin) { DB.meId = null; setTimeout(function () { window.location.replace('LOGIN.html'); }, 1500); }
      return false;
    }
    DB.data[key] = list; DB.snap[key] = seen;
    return true;
  }
  var lastError = '';

  // Get / set / remove values. Server lists come back as a new array (the items themselves are shared).
  function read(key, fallback) {
    if (ROW_KEYS[key]) return (DB.data[key] || []).slice();
    if (META_KEYS[key]) return DB.meta[key] != null ? DB.meta[key] : fallback;
    if (key === 'currentUserId') return DB.meId || fallback;
    if (key === 'pendingUserId') return DB.pending ? DB.pending.id : fallback;
    try {
      var raw = STORE.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    if (ROW_KEYS[key]) return syncRows(key, value || []);
    if (META_KEYS[key]) {
      var res = api('sync.php', { meta: key, value: value });
      if (!res || !res.ok) { lastError = (res && res.error) || NET_ERROR; return false; }
      DB.meta[key] = value; return true;
    }
    if (key === 'currentUserId' || key === 'pendingUserId') return true;   // kept by the server session
    try { STORE.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('Lost & Found: could not save "' + key + '"', e); return false; }
  }

  function remove(key) {
    if (META_KEYS[key]) { write(key, null); return; }
    if (key === 'currentUserId' || key === 'pendingUserId') return;
    try { STORE.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
  }

  // Short unique id with a prefix.
  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  var STORAGE_FULL = 'Couldn\'t save. Check your internet connection, or try a smaller photo.';

  /* ===== 2. LISTS & FORMATTING ===== */

  // Dropdown lists.
  var CATEGORIES = ['Electronics', 'Wallet / Money', 'ID / Documents', 'Bags', 'Clothing',
    'Keys', 'Accessories', 'Books / School Supplies', 'Others'];

  var LOCATIONS = ['Main Building', 'Library', 'Cafeteria', 'Gymnasium', 'Parking Area',
    'Computer Laboratory', 'Hallway / Corridor', 'Restroom', 'Others'];

  // Philippine address list (PSA PSGC): lives in ph-address.js next to this file.
  // It is large, so it loads only when a page shows an address form, and works offline.
  var ADDRESS_SRC = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s && /lf-app\.js(\?.*)?$/.test(s) ? s.replace(/lf-app\.js(\?.*)?$/, 'ph-address.js') : 'ph-address.js';
  })();
  var addressLoading = null;

  // Resolves with window.PH_ADDRESS ({ version, regions }).
  function loadAddress() {
    if (window.PH_ADDRESS) return Promise.resolve(window.PH_ADDRESS);
    if (addressLoading) return addressLoading;
    addressLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ADDRESS_SRC;
      s.onload = function () {
        if (window.PH_ADDRESS) resolve(window.PH_ADDRESS);
        else { addressLoading = null; reject(new Error('ph-address.js is empty')); }
      };
      s.onerror = function () { addressLoading = null; reject(new Error('Could not load ph-address.js')); };
      document.head.appendChild(s);
    });
    return addressLoading;
  }

  // Search key: no accents, lower case, "Sta." -> "santa", "Sto." -> "santo", "Gen." -> "general".
  function addrKey(s) {
    s = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    s = s.replace(/\bsta\.?\s/g, 'santa ').replace(/\bsto\.?\s/g, 'santo ').replace(/\bgen\.?\s/g, 'general ')
         .replace(/\bpres\.?\s/g, 'president ').replace(/\bbrgy\.?\s|\bbgy\.?\s/g, 'barangay ');
    return s.replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // Same place, different wording ("Makati City" = "City of Makati").
  function addrCore(s) {
    return addrKey(String(s || '').replace(/\(.*?\)/g, ' ')).replace(/^city of |\bcity\b|^municipality of /g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Type-to-filter dropdown. The <input> shows the chosen name; only names from the list are accepted.
  function comboBox(input, opts) {
    opts = opts || {};
    var wrap = input.parentNode;
    var list = document.createElement('ul');
    var items = [], chosen = null, shown = [], active = -1, free = false, LIMIT = 300;
    list.className = 'combo-list';
    list.id = input.id + '-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    function filter(q) {
      var toks = addrKey(q).split(' ').filter(Boolean);
      if (!toks.length) return items.slice();
      var first = [], rest = [];
      items.forEach(function (it) {
        var words = it._key.split(' ');
        var ok = toks.every(function (t) { return words.some(function (w) { return w.indexOf(t) === 0; }); });
        if (ok) (it._key.indexOf(toks.join(' ')) === 0 || addrCore(it.n).indexOf(toks.join(' ')) === 0 ? first : rest).push(it);
      });
      return first.concat(rest);
    }
    function render(q) {
      shown = filter(q);
      active = -1;
      var html = shown.slice(0, LIMIT).map(function (it, i) {
        return '<li role="option" id="' + list.id + '-' + i + '" data-i="' + i + '" aria-selected="' + (it === chosen) + '">' +
          esc(it.n) + (it.note ? '<small>' + esc(it.note) + '</small>' : '') + '</li>';
      }).join('');
      if (!shown.length) html = '<li class="combo-empty" role="presentation">No match. Check the spelling.</li>';
      else if (shown.length > LIMIT) html += '<li class="combo-empty" role="presentation">' + (shown.length - LIMIT) + ' more. Keep typing to narrow the list.</li>';
      list.innerHTML = html;
      var sel = shown.indexOf(chosen);
      if (sel >= 0 && sel < LIMIT && !q) setActive(sel);
    }
    function setActive(i) {
      var old = list.querySelector('.active');
      if (old) old.classList.remove('active');
      active = i;
      var li = i >= 0 ? list.querySelector('[data-i="' + i + '"]') : null;
      if (li) {
        li.classList.add('active');
        input.setAttribute('aria-activedescendant', li.id);
        var top = li.offsetTop, bottom = top + li.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
      } else input.removeAttribute('aria-activedescendant');
    }
    function open(q) {
      if (input.disabled || free || !items.length) return;
      render(q || '');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (list.getBoundingClientRect().bottom > window.innerHeight) list.scrollIntoView({ block: 'nearest' });
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function choose(it, silent) {
      var changed = it !== chosen;
      chosen = it;
      input.value = it ? it.n : '';
      close();
      if (it && input.closest('.field.error')) clearFieldError(input);
      if (changed && !silent && opts.onChange) opts.onChange(it);
    }
    // Accept what was typed if it names an item; otherwise put back the last choice.
    function commit() {
      if (free) return;
      var text = input.value.trim();
      if (chosen && text === chosen.n) return;
      if (!text) { choose(null); return; }
      var k = addrCore(text);
      var hit = items.filter(function (it) { return addrCore(it.n) === k; });
      if (hit.length !== 1) { var f = filter(text); hit = f.length === 1 ? f : hit; }
      if (hit.length === 1) choose(hit[0]);
      else input.value = chosen ? chosen.n : '';
    }

    var refocus = false;
    input.addEventListener('focus', function () {
      if (free || refocus) { refocus = false; return; }
      input.select(); open('');
    });
    input.addEventListener('click', function () { if (list.hidden) open(''); });
    input.addEventListener('input', function () { if (!free) open(input.value); });
    var pressing = false;                  // finger/mouse is down on the list (touch taps blur the input first)
    input.addEventListener('blur', function () {
      setTimeout(function () {
        if (pressing || document.activeElement === input) return;
        commit(); close();
      }, 0);
    });
    input.addEventListener('keydown', function (e) {
      if (free) return;
      var n = Math.min(shown.length, LIMIT);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { open(''); return; }
        if (!n) return;
        setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
      } else if (e.key === 'Enter') {
        if (!list.hidden) {
          e.preventDefault();
          if (active >= 0) choose(shown[active]);
          else if (n === 1) choose(shown[0]);
          else commit();
        } else commit();
      } else if (e.key === 'Escape' && !list.hidden) {
        e.preventDefault();
        e.stopPropagation();
        input.value = chosen ? chosen.n : '';
        close();
      } else if (e.key === 'Tab' && !list.hidden && active >= 0) {
        choose(shown[active]);
      }
    });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus in the input
    list.addEventListener('pointerdown', function () { pressing = true; });
    document.addEventListener('pointerup', function () {
      if (!pressing) return;
      setTimeout(function () {
        pressing = false;
        if (document.activeElement !== input && !list.hidden) { commit(); close(); }
      }, 350);
    });
    list.addEventListener('click', function (e) {
      pressing = false;
      var li = e.target.closest('[data-i]');
      if (li) { choose(shown[+li.dataset.i]); if (document.activeElement !== input) { refocus = true; input.focus({ preventScroll: true }); } }
    });

    return {
      input: input,
      setItems: function (arr) {
        items = (arr || []).map(function (it) { it._key = it._key || addrKey(it.n + ' ' + (it.k || '')); return it; });
        chosen = null; input.value = ''; close();
      },
      items: function () { return items; },
      get: function () { return chosen; },
      value: function () { return free ? input.value.trim() : (chosen ? chosen.n : ''); },
      // Pick by saved name (also understands older spellings such as "Makati City" or "NCR").
      set: function (name) {
        if (!name) { choose(null, true); return null; }
        var hit = items.filter(function (it) { return it.n === name; });
        if (!hit.length) { var k = addrCore(name); hit = items.filter(function (it) { return addrCore(it.n) === k; }); }
        if (hit.length !== 1) { var f = filter(name); if (f.length === 1) hit = f; }
        choose(hit.length === 1 ? hit[0] : null, true);
        return chosen;
      },
      setFree: function (on) { free = !!on; close(); },
      commit: commit,
      close: close
    };
  }

  // Escape text for HTML.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Local date as YYYY-MM-DD.
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Date and time formatting.
  function fmtDate(d) {
    if (!d) return 'No date';
    var dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
    return isNaN(dt) ? d : dt.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtTime(d) {
    var dt = new Date(d);
    return isNaN(dt) ? '' : dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }

  function ageFrom(birth) {
    if (!birth) return '';
    var b = new Date(birth + 'T00:00:00'), t = new Date();
    var a = t.getFullYear() - b.getFullYear();
    if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
    return a >= 0 ? a : '';
  }

  function maskMobile(m) {
    return m && m.length >= 7 ? m.slice(0, 4) + '•••' + m.slice(-4) : (m || '—');
  }

  // "Others: umbrella" style labels.
  function catLabel(r) { return r.category === 'Others' && r.categoryDetail ? 'Others: ' + r.categoryDetail : (r.category || ''); }

  function locLabel(r) { return r.location === 'Others' && r.locationDetail ? 'Others: ' + r.locationDetail : (r.location || ''); }

  function digitsOnly(input, max) {
    input.addEventListener('input', function () {
      input.value = input.value.replace(/\D/g, '').slice(0, max);
    });
  }

  /* ===== 3. USERS & LOGIN ===== */

  // Accounts.
  function getUsers() { return read('users', []); }

  function saveUsers(list) { return write('users', list); }

  function findUserByEmail(email) {
    var e = String(email || '').trim().toLowerCase();
    if (!DB.meId) {                                     // not logged in: the server says only id and status
      var res = api('auth.php', { action: 'email_status', email: e });
      return (res && res.user) || null;
    }
    return getUsers().find(function (u) { return String(u.email || '').toLowerCase() === e; }) || null;
  }

  function getUser(id) {
    return getUsers().find(function (u) { return u.id === id; }) || null;
  }

  // New account: pending until an admin approves it. The server hashes the password.
  function createUser(d) {
    var res = api('auth.php', { action: 'register', firstName: d.firstName, lastName: d.lastName, email: d.email,
      password: d.password, accountType: d.accountType, validId: d.validId || null, idType: d.idType || '', emailCode: d.emailCode || '',
      photo: d.photo || null, restore: !!d.restore });
    if (!res || !res.ok) { lastError = (res && res.error) || NET_ERROR; return null; }
    DB.pending = res.user;
    return res.user;
  }

  // U-001 for community, S-001 for staff.
  function nextUserCode(prefix) {
    var max = 0;
    getUsers().forEach(function (u) {
      var m = /^([A-Z])-(\d+)$/.exec(u.code || '');
      if (m && m[1] === prefix) max = Math.max(max, +m[2]);
    });
    return prefix + '-' + String(max + 1).padStart(3, '0');
  }

  // Adds a line to the user's activity log (admin can see it).
  function logActivity(userId, text) {
    var list = getUsers();
    var i = list.findIndex(function (u) { return u.id === userId; });
    if (i < 0) return;
    list[i].activity = (list[i].activity || []).concat({ text: text, at: new Date().toISOString() }).slice(-200);
    saveUsers(list);
  }

  // Removes a declined application so the user can sign up again.
  function clearDeclined(userId) {
    var res = api('auth.php', { action: 'clear_declined', id: userId });
    return (res && res.ok && res.user) || null;
  }

  // Merges changes into a user and saves.
  function updateUser(id, patch) {
    var list = getUsers();
    var i = list.findIndex(function (u) { return u.id === id; });
    if (i < 0) {
      // Between Sign up and Application (not logged in yet): only the Terms answer is saved.
      if (DB.pending && DB.pending.id === id && patch.agreedToTerms) {
        var res = api('auth.php', { action: 'agree_terms' });
        if (!res || !res.ok) return null;
        DB.pending = res.user; return res.user;
      }
      return null;
    }
    list[i] = Object.assign({}, list[i], patch);
    return saveUsers(list) ? list[i] : null;
  }

  // Deletes a user and everything they submitted.
  function deleteUser(id) {
    // Remove the user's reports (and any requests pointing at them) and their requests.
    Object.keys(KINDS).forEach(function (kind) {
      getRecords(kind).forEach(function (r) {
        if (r.ownerId === id) deleteRecord(kind, r.id);
      });
    });
    saveUsers(getUsers().filter(function (u) { return u.id !== id; }));
    if (read('currentUserId', null) === id) logout();
    if (read('pendingUserId', null) === id) clearPendingUser();
  }

  // User between Sign Up and Terms / Application.
  function getPendingUser() { return DB.pending; }

  function clearPendingUser() {
    if (!DB.pending) return;
    DB.pending = null;
    api('auth.php', { action: 'clear_pending' });
  }

  // Returns { ok, next } or { ok: false, error, status }. The server checks the password.
  function login(email, password) {
    var res = api('auth.php', { action: 'login', email: email, password: password });
    if (!res) return { ok: false, error: NET_ERROR };
    if (res.ok && res.approvedAt) {
      setFlash('Your account was approved on ' + fmtDate(res.approvedAt) + '. Welcome to Lost & Found!', 'success');
    }
    return res;
  }

  // Why this account can't log in, or '' if it can.
  function statusBlockMessage(u) {
    if (u.status === 'pending') return 'Your account is waiting for admin approval. You can log in once it\'s approved.';
    if (u.status === 'declined') return 'Your account application was declined' + (u.statusNote ? ': ' + u.statusNote.replace(/[.!?]*$/, '.') : '.') + ' Please sign up again.';
    if (u.status === 'blocked') return 'This account is blocked' + (u.statusNote ? ': ' + u.statusNote.replace(/[.!?]*$/, '.') : '.') + ' Contact ' + 'minicapstonproject@gmail.com if you think this is a mistake.';
    return '';
  }

  // Logged-in user.
  function currentUser() { return DB.meId ? getUser(DB.meId) : null; }

  function logout() {
    DB.meId = null;
    api('auth.php', { action: 'logout' });
  }

  // Roles and each role's home page.
  function roleOf(u) { return u ? (u.accountType || 'community') : ''; }

  function isStaff(u) { return roleOf(u) === 'staff'; }

  function isAdmin(u) { return roleOf(u) === 'admin'; }

  function homeFor(u) { return isAdmin(u) ? 'ADMIN.html' : isStaff(u) ? 'STAFFHOME.html' : 'HOME.html'; }

  // Page guard. opts.role: 'admin' | 'staff' | 'community'; opts.needProfile.
  function requireLogin(opts) {
    opts = opts || {};
    var u = currentUser();
    if (!u) { window.location.replace('LOGIN.html'); return null; }
    // Blocked while logged in: sign out right away.
    var blockMsg = statusBlockMessage(u);
    if (blockMsg && !isAdmin(u)) {
      logout(); setFlash(blockMsg, 'error');
      window.location.replace('LOGIN.html'); return null;
    }
    if (opts.role && opts.role !== roleOf(u)) { window.location.replace(homeFor(u)); return null; }
    if (opts.needProfile && !u.profileCompleted) { window.location.replace(homeFor(u)); return null; }
    return u;
  }

  function displayName(u) {
    if (!u) return '';
    var p = u.profile || {};
    return ((p.firstName || u.firstName || '') + ' ' + (p.lastName || u.lastName || '')).trim();
  }

  // One-time message for the next page.
  function setFlash(msg, type) { write('flash', { msg: msg, type: type || 'success' }); }

  function takeFlash() { var f = read('flash', null); remove('flash'); return f; }

  /* ===== 4. REPORTS & REQUESTS ===== */
  /* Lost/found reports, claim requests (CR-), found notices (FN-). */

  // Record types and where each is stored.
  var KINDS = {
    lost:   { key: 'lostReports',   prefix: 'L',  label: 'Lost' },
    found:  { key: 'foundReports',  prefix: 'F',  label: 'Found' },
    claim:  { key: 'claimRequests', prefix: 'CR', label: 'Claim Request' },
    notice: { key: 'foundNotices',  prefix: 'FN', label: 'Found Notice' }
  };

  function getRecords(kind) { return read(KINDS[kind].key, []); }

  // Reports: 0000000001, 0000000002…  Requests: CR-/FN-0000000001…
  function nextCaseNo(kind) {
    var res = api('sync.php', { op: 'next_case', kind: kind });
    return res && res.ok ? res.caseNo : null;
  }

  // Saves a new record; returns it, or null if storage is full.
  function addRecord(kind, data) {
    var me = currentUser();
    var caseNo = nextCaseNo(kind);
    if (!caseNo) { lastError = NET_ERROR; return null; }
    var rec = Object.assign({
      id: uid(KINDS[kind].prefix),
      caseNo: caseNo,
      kind: kind,
      ownerId: me ? me.id : null,
      ownerName: me ? displayName(me) : '',
      ownerEmail: me ? me.email : '',
      createdAt: new Date().toISOString(),
      history: [{ action: 'Submitted', by: me ? displayName(me) : '', at: new Date().toISOString() }]
    }, data);
    var list = getRecords(kind);
    list.push(rec);
    if (!write(KINDS[kind].key, list)) return null;
    if (me) {
      var what = kind === 'claim' ? 'Sent a claim request for #' + rec.refCase
               : kind === 'notice' ? 'Sent a found notice for #' + rec.refCase
               : 'Submitted a ' + kind + ' report #' + rec.caseNo;
      logActivity(me.id, what + ' (' + rec.itemName + ')');
    }
    return rec;
  }

  function deleteRecord(kind, id) {
    var list = getRecords(kind);
    var rec = list.find(function (r) { return r.id === id; });
    if (!rec) return false;
    write(KINDS[kind].key, list.filter(function (r) { return r.id !== id; }));
    var me = currentUser();
    if (me && rec.ownerId === me.id) logActivity(me.id, 'Deleted ' + (KINDS[kind].label.toLowerCase()) + ' #' + rec.caseNo + ' (' + rec.itemName + ')');
    // Deleting a lost/found report also removes the requests sent for it.
    if (kind === 'lost' || kind === 'found') {
      ['claim', 'notice'].forEach(function (k) {
        write(KINDS[k].key, getRecords(k).filter(function (r) { return r.refCase !== rec.caseNo; }));
      });
    }
    return true;
  }

  function findRecord(kind, id) {
    return getRecords(kind).find(function (r) { return r.id === id; }) || null;
  }

  // Updates a record and optionally adds a history line.
  function updateRecord(kind, id, patch, action, note) {
    var list = getRecords(kind);
    var i = list.findIndex(function (r) { return r.id === id; });
    if (i < 0) return null;
    var rec = Object.assign({}, list[i], patch);
    if (action) {
      var me = currentUser();
      rec.history = (rec.history || []).concat({ action: action, by: me ? displayName(me) : '', at: new Date().toISOString(), note: note || '' });
    }
    list[i] = rec;
    return write(KINDS[kind].key, list) ? rec : null;
  }

  // Notices/claims sent for a report.
  function requestsFor(caseNo) {
    return getRecords('claim').concat(getRecords('notice'))
      .filter(function (r) { return r.refCase === caseNo; });
  }

  function isRequest(r) { return r.kind === 'claim' || r.kind === 'notice'; }

  // Status label, color, and help text used on every page.
  function statusInfo(r) {
    var s = String(r.status || '').toLowerCase();
    if (isRequest(r)) {
      if (r.settled) return { text: 'Returned to owner', cls: 'pill-green',
        help: r.kind === 'notice' ? 'The owner confirmed they got the item back from you. Thank you for returning it!'
                                   : 'The finder confirmed they returned the item to you. This claim is complete.' };
      if (s === 'approved') return { text: 'Approved', cls: 'pill-green',
        help: 'The office approved your request. Visit the Lost and Found office with a valid ID.' };
      if (s === 'rejected') return { text: 'Declined', cls: 'pill-red',
        help: (r.reviewNote ? 'Comment from the office: "' + r.reviewNote + '". ' : 'The office didn\'t leave a comment. ') +
              'You can update your message or photos and send it again.' };
      return { text: 'Pending review', cls: 'pill-orange',
        help: 'The Lost and Found office is still reviewing this. You\'ll be contacted on your mobile number.' };
    }
    if (s === 'claimed') return { text: 'Claimed', cls: 'pill-green',
      help: r.kind === 'lost' ? 'You got your item back. This report is closed.' : 'The owner picked up this item. Thank you for turning it in.' };
    if (s === 'disposed') return { text: 'Disposed', cls: 'pill-red',
      help: 'No one claimed this item within the holding period, so it was disposed.' };
    if (s === 'closed') return { text: 'Case closed', cls: 'pill-gray',
      help: 'No matching item was turned in within ' + HOLD_DAYS + ' days, so this case was closed. You can file a new report if you still need help.' };
    if (r.review === 'pending') return { text: 'Under staff review', cls: 'pill-orange',
      help: 'Staff will check this report before it appears in Matching & Search. This usually takes a day.' };
    if (r.review === 'rejected') return { text: 'Not approved', cls: 'pill-red',
      help: 'Staff did not approve this report' + (r.reviewNote ? ': ' + r.reviewNote : '.') + ' You can delete it and submit a corrected one.' };
    if (r.review === 'approved') return { text: 'Approved, posting soon', cls: 'pill-blue',
      help: 'Staff approved this report. It will appear in Matching & Search once it is posted.' };
    if (r.kind === 'lost') return { text: 'Waiting to be found', cls: 'pill-purple',
      help: 'No one has turned in this item yet. Check Matching & Search for possible matches.' };
    return { text: 'Waiting to be claimed', cls: 'pill-purple',
      help: 'The owner hasn\'t claimed this item yet. It stays at the Lost and Found office.' };
  }

  function statusPill(r) {
    var st = statusInfo(r);
    return '<span class="pill ' + st.cls + '">' + st.text + '</span>';
  }

  // Only posted reports show in Matching & Search.
  function isPublic(r) { return !r.review || r.review === 'posted'; }

  // Owner name, email, and contact block.
  function ownerNameOf(r) {
    if (r.ownerName) return r.ownerName;
    var u = r.ownerId ? getUser(r.ownerId) : null;
    return u ? displayName(u) : 'Unknown user';
  }

  function ownerEmailOf(r) {
    var u = r.ownerId ? getUser(r.ownerId) : null;
    return (u && u.email) || r.ownerEmail || '';
  }

  function contactHTML(r) {
    var e = ownerEmailOf(r), m = r.mobile;
    return (m ? '<a href="tel:' + esc(m) + '">' + esc(m) + '</a>' : 'No mobile') +
      (e ? '<br><a href="mailto:' + esc(e) + '">' + esc(e) + '</a>' : '');
  }

  // History list for a record.
  function timelineHTML(r) {
    var h = r.history || [];
    if (!h.length) return '';
    return '<ol class="timeline">' + h.slice().reverse().map(function (e) {
      return '<li><strong>' + esc(e.action) + '</strong>' +
        '<small>' + (e.by ? esc(e.by) + ' • ' : '') + fmtDate(e.at) + ' ' + fmtTime(e.at) + '</small>' +
        (e.note ? '<p>' + esc(e.note) + '</p>' : '') + '</li>';
    }).join('') + '</ol>';
  }

  // 90-day holding period, counted from the day a report was posted.
  var HOLD_DAYS = 90;

  function toLocalDate(d) { return new Date(String(d).length === 10 ? d + 'T00:00:00' : d); }

  function daysSince(d) {
    if (!d) return 0;
    var start = toLocalDate(d); start.setHours(0, 0, 0, 0);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((today - start) / 864e5));
  }

  // Date the report was last posted.
  function postedAt(r) {
    if (r.postedAt) return r.postedAt;
    var h = (r.history || []).filter(function (e) { return e.action === 'Posted'; }).pop();
    return h ? h.at : (r.createdAt || r.date);
  }

  // { days, left, due, pct, until, from }
  function holdInfo(r) {
    var from = postedAt(r);
    var days = daysSince(from);
    var until = toLocalDate(from); until.setDate(until.getDate() + HOLD_DAYS);
    return { days: days, left: HOLD_DAYS - days, due: days >= HOLD_DAYS,
             pct: Math.min(100, Math.round(days / HOLD_DAYS * 100)), until: until.toISOString(), from: from };
  }

  // Posted and still open.
  function isMonitored(r) {
    if (!r || r.kind === 'claim' || r.kind === 'notice') return false;
    var s = String(r.status || '').toLowerCase();
    return isPublic(r) && s !== 'claimed' && s !== 'disposed' && s !== 'closed';
  }

  // Undo a status change within 10 seconds.
  var UNDO_MS = 10 * 1000;

  function changeRecord(kind, id, patch, action, note) {
    var r = findRecord(kind, id);
    if (!r) return null;
    var prev = {};
    Object.keys(patch).forEach(function (k) { prev[k] = Object.prototype.hasOwnProperty.call(r, k) ? r[k] : null; });
    return updateRecord(kind, id, Object.assign({}, patch, { undo: { prev: prev, action: action, at: new Date().toISOString() } }), action, note);
  }

  function undoLeft(r) {
    if (!r || !r.undo) return 0;
    return Math.max(0, UNDO_MS - (Date.now() - new Date(r.undo.at).getTime()));
  }

  function undoChange(kind, id) {
    var r = findRecord(kind, id);
    if (!undoLeft(r)) return null;
    var restore = {};
    Object.keys(r.undo.prev).forEach(function (k) { restore[k] = r.undo.prev[k] === null ? undefined : r.undo.prev[k]; });
    restore.undo = undefined;
    return updateRecord(kind, id, restore, 'Undid: ' + r.undo.action);
  }

  // Deleted items can be retrieved within 10 seconds.
  var TRASH_MS = 10 * 1000;

  function getTrash() {
    var now = Date.now(), t = read('trash', []);
    var live = t.filter(function (e) { return now - new Date(e.deletedAt).getTime() < TRASH_MS; });
    if (live.length !== t.length) write('trash', live);
    return live;
  }

  function snapshotRecords() {
    var snap = {};
    Object.keys(KINDS).forEach(function (k) { snap[k] = getRecords(k); });
    return snap;
  }

  function removedSince(before) {
    var out = {};
    Object.keys(KINDS).forEach(function (k) {
      var ids = getRecords(k).map(function (r) { return r.id; });
      out[k] = before[k].filter(function (r) { return ids.indexOf(r.id) === -1; });
    });
    return out;
  }

  function pushTrash(entry) {
    entry.id = uid('T');
    entry.deletedAt = new Date().toISOString();
    var t = getTrash(); t.push(entry);
    if (!write('trash', t)) { entry.noRetrieve = true; }   // storage full: deletion still happens
    return entry;
  }

  function trashRecord(kind, id) {
    var rec = findRecord(kind, id);
    if (!rec) return null;
    var before = snapshotRecords();
    deleteRecord(kind, id);
    return pushTrash({ type: 'report', kind: kind, label: rec.itemName, caseNo: rec.caseNo, removed: removedSince(before) });
  }

  // note: optional comment from the admin, shown to the user and put in the email.
  function trashUser(id, note) {
    var u = getUser(id);
    if (!u) return null;
    var before = snapshotRecords();
    deleteUser(id);
    var entry = pushTrash({ type: 'user', user: u, label: displayName(u), removed: removedSince(before) });
    markAccountDeleted(u, 'admin', note, entry.id, entry.removed);
    return entry;
  }

  // The user deletes their own account (Account Settings). Their data is kept in the archive below.
  function deleteOwnAccount(id) {
    var u = getUser(id);
    if (!u) return false;
    var before = snapshotRecords();
    Object.keys(KINDS).forEach(function (kind) {
      getRecords(kind).forEach(function (r) { if (r.ownerId === id) deleteRecord(kind, r.id); });
    });
    markAccountDeleted(u, 'self', '', null, removedSince(before));   // saved while still logged in
    deleteUser(id);                                                  // then the account and the session
    return true;
  }

  /* Deleted accounts: remembered so the person is told why they can't log in.
     Only a hash of email + password is kept, so a stranger typing the email learns nothing. */
  // The account's reports, requests, and history are kept for ARCHIVE_DAYS so the person can bring them back
  // when they sign up again with the same email (they choose; they can also start fresh).
  var ARCHIVE_DAYS = 90;
  function deletedList() {
    var all = read('deletedAccounts', []), now = Date.now();
    var keep = all.filter(function (d) { return now - new Date(d.at).getTime() < ARCHIVE_DAYS * 864e5; });
    if (keep.length !== all.length) write('deletedAccounts', keep);
    return keep;
  }
  function markAccountDeleted(u, by, note, trashId, removed) {
    var salt = uid('d');
    var list = deletedList().filter(function (d) { return d.email !== u.email.toLowerCase(); });
    var entry = {
      email: u.email.toLowerCase(), salt: salt, hash: sha256(salt + u.email.toLowerCase() + '|' + u.password),
      name: displayName(u), by: by, note: note || '', at: new Date().toISOString(), trashId: trashId || null,
      mailed: by !== 'admin',                       // admin deletions are emailed to the user
      archive: { user: u, removed: removed || {} }
    };
    list.push(entry);
    if (!write('deletedAccounts', list)) {          // storage full: keep the notice, drop the old data
      entry.archive = null;
      write('deletedAccounts', list);
    }
  }
  function archiveCounts(d) {
    var c = { reports: 0, requests: 0 }, id = d.archive && d.archive.user.id;
    if (!id) return c;
    Object.keys(d.archive.removed || {}).forEach(function (k) {
      d.archive.removed[k].forEach(function (r) {
        if (r.ownerId !== id) return;
        if (k === 'lost' || k === 'found') c.reports++; else c.requests++;
      });
    });
    return c;
  }
  // What a person signing up with this email could bring back (null if nothing is kept).
  function deletedArchiveInfo(email) {
    email = String(email || '').trim().toLowerCase();
    if (!DB.meId) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
      var res = api('auth.php', { action: 'archive_info', email: email });
      return (res && res.info) || null;
    }
    var d = deletedList().find(function (x) { return x.email === email && x.archive; });
    if (!d) return null;
    var c = archiveCounts(d);
    return { at: d.at, by: d.by, reports: c.reports, requests: c.requests, hasHistory: !!((d.archive.user.history || []).length || (d.archive.user.activity || []).length) };
  }
  // Old password check before bringing data back.
  function checkArchivePassword(email, password) {
    var res = api('auth.php', { action: 'archive_check', email: email, password: password });
    if (res && !res.ok && res.error) lastError = res.error;
    return !!(res && res.ok);
  }

  // Called when an admin approves a returning user who chose to restore their old data.
  // Returns { reports, requests } restored, or null.
  function restoreArchive(userId) {
    var u = getUser(userId);
    if (!u || !u.restoreFrom) return null;
    var d = deletedList().find(function (x) { return x.email === u.restoreFrom && x.archive; });
    if (!d) { updateUser(userId, { restoreFrom: null }); return null; }
    var oldId = d.archive.user.id, old = d.archive.user;
    function remap(obj) { return JSON.parse(JSON.stringify(obj).split(oldId).join(userId)); }
    var got = archiveCounts(d);
    Object.keys(d.archive.removed || {}).forEach(function (k) {
      var list = getRecords(k);
      d.archive.removed[k].forEach(function (r) {
        // Bring back their own records, and requests from people who still have an account.
        if (r.ownerId !== oldId && !getUser(r.ownerId)) return;
        if (list.some(function (x) { return x.id === r.id; })) return;
        list.push(remap(r));
      });
      write(KINDS[k].key, list);
    });
    write('userNotes', read('userNotes', []).map(function (n) { if (n.userId === oldId) n.userId = userId; return n; }));
    var now = new Date().toISOString();
    var fresh = getUser(userId);
    var patch = {
      restoreFrom: null,
      history: remap(old.history || []).concat(fresh.history || [],
        { action: 'Old account restored', by: 'System', at: now, note: got.reports + ' report(s), ' + got.requests + ' request(s) from the account deleted ' + fmtDate(d.at) }),
      activity: remap(old.activity || []).concat(fresh.activity || [])
    };
    if (old.profileCompleted && old.profile) {           // keep the new name/email, bring back the rest
      patch.profile = Object.assign({}, old.profile, { firstName: fresh.firstName, lastName: fresh.lastName, email: fresh.email,
                                                       photo: (fresh.profile && fresh.profile.photo) || old.profile.photo || null });
      patch.profileCompleted = true;
    }
    updateUser(userId, patch);
    write('deletedAccounts', deletedList().filter(function (x) { return x !== d && x.email !== d.email; }));
    return got;
  }
  function forgetDeleted(email) {
    email = String(email || '').toLowerCase();
    write('deletedAccounts', deletedList().filter(function (d) { return d.email !== email; }));
  }
  // The deleted-account record for this email + password, or null.
  function findDeleted(email, password) {
    email = String(email || '').trim().toLowerCase();
    return deletedList().find(function (d) { return d.email === email && d.hash === sha256(d.salt + email + '|' + password); }) || null;
  }

  // Emails people whose accounts an admin deleted, once the 10-second Retrieve window is over.
  // Runs on the admin page (the only page with the email library besides Forgot password).
  var mailingDeleted = false;
  function sendDeletionEmails() {
    if (mailingDeleted || !emailReady() || !isAdmin(currentUser())) return Promise.resolve(0);
    mailingDeleted = true;
    return apiAsync('password.php', { action: 'deletion_emails' }).then(function (r) {
      mailingDeleted = false; return (r && r.sent) || 0;
    });
  }

  function restoreTrash(trashId) {
    var t = getTrash(), e = t.find(function (x) { return x.id === trashId; });
    if (!e) return false;
    if (e.type === 'user' && !getUser(e.user.id)) {
      var users = getUsers(); users.push(e.user); saveUsers(users);
    }
    Object.keys(e.removed || {}).forEach(function (k) {
      var list = getRecords(k);
      e.removed[k].forEach(function (r) { if (!list.some(function (x) { return x.id === r.id; })) list.push(r); });
      write(KINDS[k].key, list);
    });
    write('trash', t.filter(function (x) { return x.id !== trashId; }));
    if (e.type === 'user') write('deletedAccounts', deletedList().filter(function (d) { return d.trashId !== trashId; }));
    return true;
  }

  // The report a notice/claim points to, and whether that item is still open.
  function reportOfRequest(q) {
    var kinds = q.refKind ? [q.refKind] : ['lost', 'found'];
    if (kinds.length === 1) kinds.push(q.refKind === 'lost' ? 'found' : 'lost');
    for (var i = 0; i < kinds.length; i++) {
      var hit = getRecords(kinds[i]).find(function (r) { return r.caseNo === q.refCase; });
      if (hit) return hit;
    }
    return null;
  }

  function itemStatusOf(q) {
    var r = reportOfRequest(q);
    if (!r) return { text: 'Report removed', cls: 'pill-gray', note: 'The report this was sent for no longer exists.', report: null };
    var s = String(r.status || '').toLowerCase();
    if (s === 'claimed') return { text: 'Item claimed', cls: 'pill-green', report: r,
      note: r.settledWith ? 'The item was returned directly (' + r.settledWith + ').' : 'The owner has the item. This case is done.' };
    if (s === 'closed') return { text: 'Case closed', cls: 'pill-gray', report: r, note: 'The case was closed after ' + HOLD_DAYS + ' days without a claim.' };
    if (s === 'disposed') return { text: 'Item disposed', cls: 'pill-gray', report: r, note: 'The item was disposed after ' + HOLD_DAYS + ' days without a claim.' };
    return { text: 'Still open', cls: 'pill-purple', report: r,
      note: r.kind === 'lost' ? 'The owner hasn\'t confirmed getting the item back yet.' : 'The item hasn\'t been claimed yet.' };
  }

  // Photos on a notice/claim (up to 4).
  var MAX_REQ_PHOTOS = 4;

  function requestPhotos(q) {
    return (q.photos && q.photos.length) ? q.photos.slice() : (q.photo ? [q.photo] : []);
  }

  // The sender can edit photos while the item is still open.
  function canEditRequestPhotos(q) {
    var me = currentUser();
    if (!me || q.ownerId !== me.id) return false;
    if (q.settled) return false;
    return itemStatusOf(q).text === 'Still open';
  }

  function setRequestPhotos(kind, id, list, action) {
    return updateRecord(kind, id, { photos: list, photo: list[0] || null }, action);
  }

  // Report photo + request photos. opts.editable adds remove / add controls.
  function requestPhotosHTML(q, opts) {
    opts = opts || {};
    var r = reportOfRequest(q), repPhoto = r && r.photo, own = requestPhotos(q);
    var key = q.kind + ':' + q.id;
    var ownLabel = q.kind === 'claim' ? 'Proof photo' : 'Photo from the finder';
    if (!repPhoto && !own.length && !opts.editable) return '<p class="hint">No photos attached.</p>';
    function box(src, label, sub, removeIdx) {
      return '<figure class="rq-fig">' +
        (src ? '<a class="rq-photo" href="' + src + '" target="_blank" rel="noopener" style="background-image:url(\'' + src + '\')" aria-label="Open ' + esc(label) + ' in a new tab"></a>'
             : '<div class="rq-photo rq-none">No photo</div>') +
        (removeIdx != null ? '<button type="button" class="rq-remove" data-rmphoto="' + esc(key) + ':' + removeIdx + '" aria-label="Delete ' + esc(label) + '">&times;</button>' : '') +
        '<figcaption><b>' + esc(label) + '</b>' + (sub ? '<br>' + esc(sub) : '') + '</figcaption></figure>';
    }
    var html = box(repPhoto, 'Item photo from the report', r ? '#' + r.caseNo + ' ' + r.itemName : 'Report removed');
    own.forEach(function (src, i) {
      html += box(src, own.length > 1 ? ownLabel + ' ' + (i + 1) + ' of ' + own.length : ownLabel, q.name, opts.editable ? i : null);
    });
    if (opts.editable && own.length < MAX_REQ_PHOTOS) {
      html += '<figure class="rq-fig"><label class="rq-photo rq-add">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
        '<span>Add ' + (q.kind === 'claim' ? 'proof ' : '') + 'photo</span>' +
        '<input type="file" accept="image/*" class="rq-add-input" data-addphoto="' + esc(key) + '" hidden></label>' +
        '<figcaption>' + (MAX_REQ_PHOTOS - own.length) + ' more allowed. JPG or PNG.</figcaption></figure>';
    }
    var note = opts.editable
      ? '<p class="hint" style="margin-top:8px">You can still add or delete photos while this request is open. Staff and admin see changes right away.</p>'
      : (opts.mine ? '<p class="hint" style="margin-top:8px">Photos can no longer be changed because this request is finished.</p>' : '');
    return '<div class="rq-figs">' + html + '</div>' + note;
  }

  // Sends a declined notice/claim again.
  function resubmitRequest(kind, id, message) {
    var me = currentUser(), q = findRecord(kind, id);
    if (!me || !q || q.ownerId !== me.id) return null;
    var prevNote = q.reviewNote || '';
    var saved = updateRecord(kind, id, {
      status: 'Pending Review', reviewNote: '', undo: undefined,
      message: String(message || q.message).trim() || q.message,
      resubmittedAt: new Date().toISOString(), resubmitCount: (q.resubmitCount || 0) + 1
    }, 'Sent again', prevNote ? 'Declined earlier: ' + prevNote : 'Declined earlier without a comment');
    if (!saved) return null;
    var label = kind === 'claim' ? 'claim request' : 'found notice';
    logActivity(me.id, 'Sent ' + label + ' #' + q.caseNo + ' again after it was declined');
    notify(displayName(me) + ' sent ' + label + ' #' + q.caseNo + ' again (for #' + q.refCase + ', ' + q.itemName + ') after it was declined.', q.refCase);
    return saved;
  }

  // Comments on notices/claims (owner, sender, staff, admin) and on lost/found reports.
  // Report comments: once posted, anyone who can see the post can read and add comments;
  // before that (pending, approved, declined), only the owner, staff, and admin ("private").
  function addComment(kind, id, text, opts) {
    var me = currentUser(), r = findRecord(kind, id);
    text = String(text || '').trim();
    if (!me || !r || !text) return null;
    var c = { id: uid('C'), by: displayName(me), byId: me.id, role: roleOf(me), text: text.slice(0, 1000), at: new Date().toISOString() };
    // Private: only the owner, staff, and admin see it (always before posting; by choice after).
    if (!isRequest(r) && (!isPublic(r) || (opts && opts.private))) c.private = true;
    return updateRecord(kind, id, { comments: (r.comments || []).concat(c) });
  }

  // Shows "Comment removed" instead of the text. The server checks who may do this.
  function removeComment(kind, id, commentId) {
    var me = currentUser(), r = findRecord(kind, id);
    if (!me || !r) return null;
    return updateRecord(kind, id, { comments: (r.comments || []).map(function (c) {
      return c.id === commentId ? Object.assign({}, c, { removed: true, text: '', removedBy: roleOf(me), removedAt: new Date().toISOString() }) : c;
    }) });
  }

  // Accepted IDs at sign up.
  var ID_TYPES = { student: 'Student ID', government: 'Government ID', other: 'Other valid ID' };
  function idTypeLabel(u) { return (u && ID_TYPES[u.idType]) || 'Valid ID'; }

  function isFinished(r) {
    var s = String(r.status || '').toLowerCase();
    return s === 'claimed' || s === 'disposed' || s === 'closed';
  }

  // Who may remove a comment: its writer, staff, admin, or the owner of the report it is on.
  function canRemoveComment(r, c) {
    var me = currentUser();
    if (!me || c.removed) return false;
    return c.byId === me.id || isAdmin(me) || isStaff(me) || (!isRequest(r) && r.ownerId === me.id);
  }

  function commenterLabel(r, c) {
    if (c.role === 'admin') return 'Admin';
    if (c.role === 'staff') return 'Staff';
    if (!isRequest(r)) return c.byId === r.ownerId ? (r.kind === 'lost' ? 'Owner' : 'Finder') : 'Member';
    if (c.byId === r.ownerId) return r.kind === 'notice' ? 'Finder' : 'Claimant';
    return 'Item owner';
  }

  function commentItemHTML(r, c) {
    var me = currentUser(), mine = me && c.byId === me.id;
    if (c.removed) {
      return '<li class="comment removed" data-cid="' + esc(c.id) + '"><p>Comment removed' +
        (c.removedBy === 'admin' ? ' by the admin' : c.removedBy === 'staff' ? ' by staff' : '') + '.</p></li>';
    }
    var privateTag = !isRequest(r) && c.private && isPublic(r)
      ? '<span class="c-private" title="Only the owner, staff, and admin can see this comment.">Private</span>' : '';
    return '<li class="comment' + (mine ? ' mine' : '') + ' role-' + esc(c.role || 'community') + '" data-cid="' + esc(c.id) + '">' +
      '<div class="c-head"><button type="button" class="c-author" data-profile="' + esc(c.byId) + '" data-name="' + esc(c.by) + '">' +
        esc(mine ? 'You' : c.by) + '</button><span class="c-role">' + commenterLabel(r, c) + '</span>' + privateTag +
      '<time>' + fmtDate(c.at) + ', ' + fmtTime(c.at) + '</time>' +
      (canRemoveComment(r, c) ? '<button type="button" class="c-del" data-cdel="' + esc(r.kind + ':' + r.id + ':' + c.id) + '">Delete</button>' : '') +
      '</div><p>' + esc(c.text) + '</p></li>';
  }

  function commentsHTML(r) {
    var cs = r.comments || [];
    if (!cs.length) return '<p class="comments-empty">No comments yet. Start the conversation below.</p>';
    return '<ul class="comments">' + cs.map(function (c) { return commentItemHTML(r, c); }).join('') + '</ul>';
  }

  function commentCount(r) { return (r.comments || []).filter(function (c) { return !c.removed; }).length; }

  // Comment section for a lost/found report (My Reports, Matching & Search, Staff, Admin).
  function reportCommentsHTML(r) {
    var me = currentUser();
    if (!r || isRequest(r)) return '';
    var pub = isPublic(r), office = isAdmin(me) || isStaff(me), owner = me && r.ownerId === me.id;
    var canPost = !!me && (office || owner || (pub && !isFinished(r)));
    var hint = pub
      ? 'Anyone who can see this post can read these comments. Don\'t share ID numbers, addresses, or other private details.'
      : 'This report isn\'t posted yet. Only ' + (owner ? 'you' : 'the owner') + ', staff, and the admin can see these comments.';
    var ph = office ? (pub ? 'Reply as ' + (isAdmin(me) ? 'admin' : 'staff') + ' (everyone who can see this post will see it).'
                           : 'Write to the owner (only they, staff, and the admin will see it).')
      : owner ? (pub ? 'Reply to people asking about your item.' : 'Reply to the staff or admin.')
      : 'Ask about this item or share a clue.';
    return '<div class="rq-section r-comments" data-rc="' + esc(r.kind + ':' + r.id) + '">' +
      '<h4>Comments (' + commentCount(r) + ')</h4><p class="rc-hint">' + hint + '</p>' + commentsHTML(r) +
      (canPost
        ? '<form class="rc-form" data-rckey="' + esc(r.kind + ':' + r.id) + '" novalidate>' +
            '<label class="sr-only" for="rc-' + esc(r.id) + '">Write a comment</label>' +
            '<textarea id="rc-' + esc(r.id) + '" rows="2" maxlength="1000" placeholder="' + esc(ph) + '"></textarea>' +
            '<div class="rc-actions">' +
            (pub && (office || owner)
              ? '<label class="rc-private"><input type="checkbox" name="private"> ' +
                  (office ? 'Private: only the owner can see it (and staff/admin)' : 'Private: only staff and the admin can see it') + '</label>'
              : '') +
            '<button type="submit" class="btn btn-primary btn-sm">Post comment</button></div></form>'
        : '<p class="rc-hint">Comments are closed because this item is already ' + esc(String(r.status || '').toLowerCase()) + '.</p>') +
      '</div>';
  }

  /* ---------- Email verification: a 6-digit code sent to the email (sign up, change of email) ---------- */
  // Resolves the code the person typed, '' if email isn't set up on the server (nothing to verify), or null if cancelled.
  function askEmailCode(email, purpose, name) {
    return apiAsync('auth.php', { action: 'email_code', email: email, purpose: purpose, name: name || '' }).then(function (r) {
      if (!r) { toast(NET_ERROR, true); return null; }
      if (!r.ok) { toast(r.error, true); return null; }
      if (r.skipped) return '';
      return new Promise(function (resolve) {
        var bd = document.createElement('div');
        bd.className = 'modal-backdrop center top';
        bd.setAttribute('data-static', '');
        bd.innerHTML = '<div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="evTitle">' +
          '<h3 id="evTitle" style="margin-right:0">Check your email</h3>' +
          '<p class="modal-lead">We sent a 6-digit code to <b>' + esc(email) + '</b>. Enter it to ' +
            (purpose === 'signup' ? 'finish signing up' : 'confirm your new email') + '. Check your spam folder too.</p>' +
          '<div class="field"><label for="evCode">6-digit code</label>' +
          '<input type="text" id="evCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" ' +
            'style="text-align:center;font-size:24px;letter-spacing:8px;font-weight:600"></div>' +
          '<p class="hint" id="evTimer" style="text-align:center"></p>' +
          '<p style="text-align:center;margin:4px 0 0"><button type="button" class="link-btn" id="evResend" disabled>Send a new code</button></p>' +
          '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-v="0">Cancel</button>' +
          '<button type="button" class="btn btn-primary" data-v="1">Confirm</button></div></div>';
        document.body.appendChild(bd);
        openModal(bd);
        var input = bd.querySelector('#evCode'), exp = r.expires, cool = Date.now() + 30000;
        setTimeout(function () { input.focus(); }, 50);
        input.addEventListener('input', function () { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); done(true); } });
        var timer = setInterval(function () {
          var left = Math.max(0, Math.ceil((exp - Date.now()) / 1000)), c = Math.max(0, Math.ceil((cool - Date.now()) / 1000));
          bd.querySelector('#evTimer').textContent = left ? 'Code expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'Code expired. Send a new one.';
          var rb = bd.querySelector('#evResend'); rb.disabled = c > 0; rb.textContent = c > 0 ? 'Send a new code (' + c + 's)' : 'Send a new code';
        }, 500);
        bd.querySelector('#evResend').addEventListener('click', function () {
          cool = Date.now() + 30000;
          apiAsync('auth.php', { action: 'email_code', email: email, purpose: purpose, name: name || '' }).then(function (x) {
            if (x && x.ok) { exp = x.expires || exp; toast('New code sent.'); } else toast((x && x.error) || NET_ERROR, true);
          });
        });
        function done(ok) {
          if (ok && !/^\d{6}$/.test(input.value)) { toast('Enter the 6-digit code.', true); input.focus(); return; }
          clearInterval(timer);
          closeModal(bd);
          setTimeout(function () { bd.remove(); }, 300);
          resolve(ok ? input.value : null);
        }
        bd.addEventListener('click', function (e) {
          var b = e.target.closest('[data-v]');
          if (b) done(b.getAttribute('data-v') === '1');
        });
      });
    });
  }

  /* ---------- "Surrendered to the office": the item is at the office, ready to claim ---------- */
  function surrenderInfo(r) { return r && !isRequest(r) && r.surrendered && !isFinished(r) ? r.surrendered : null; }

  function surrenderBadgeHTML(r) { return surrenderInfo(r) ? ' <span class="pill pill-office">At the office</span>' : ''; }

  function surrenderBoxHTML(r) {
    var s = surrenderInfo(r), me = currentUser();
    if (!s) return '';
    var owner = me && r.ownerId === me.id;
    var text = r.kind === 'lost'
      ? (owner ? 'An item that may be yours was surrendered to the Lost and Found office. Visit the office with your valid ID or student ID to check if it\'s yours and claim it.'
               : 'An item matching this report was surrendered to the Lost and Found office. The owner was asked to visit the office to confirm and claim it.')
      : (owner ? 'Thank you! The office received this item. The owner can now claim it at the office.'
               : 'This item is at the Lost and Found office. If it\'s yours, visit the office with your valid ID or student ID to claim it.');
    return '<div class="office-box"><b>At the Lost and Found office</b><p>' + text + '</p>' +
      (s.note ? '<p class="office-note">Note from the office: "' + esc(s.note) + '"</p>' : '') +
      '<small>Tagged by ' + esc(s.by || 'the office') + ' on ' + fmtDate(s.at) + ', ' + fmtTime(s.at) + '</small></div>';
  }

  // Staff/admin: tag (on = true) or untag a posted report. The owner is notified when it is tagged.
  function markSurrendered(kind, id, on, note) {
    var me = currentUser(), r = findRecord(kind, id);
    if (!me || !r || !(isAdmin(me) || isStaff(me))) return null;
    note = String(note || '').trim().slice(0, 300);
    var saved = updateRecord(kind, id, { surrendered: on ? { at: new Date().toISOString(), by: displayName(me), note: note } : null },
      on ? 'Surrendered to the office' : 'Removed "At the office" tag', note);
    if (!saved) return null;
    if (on) {
      notifyUser(r.ownerId, r.kind === 'lost'
        ? 'Good news: an item that may be your ' + r.itemName + ' (#' + r.caseNo + ') was surrendered to the Lost and Found office. ' +
          'Visit the office with your valid ID or student ID to check if it\'s yours and claim it.' + (note ? ' Note: "' + note + '"' : '')
        : 'Thank you! The office received the ' + r.itemName + ' you found (#' + r.caseNo + '). The owner can now claim it at the office.', r.caseNo);
    }
    logActivity(me.id, (on ? 'Tagged ' : 'Removed the tag on ') + r.kind + ' report #' + r.caseNo + ' as surrendered to the office');
    return saved;
  }

  // Asks for an optional note, then tags. Resolves the saved report, or null.
  function askSurrender(r) {
    return new Promise(function (resolve) {
      var bd = document.createElement('div');
      bd.className = 'modal-backdrop center top';
      bd.innerHTML = '<div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="srTitle">' +
        '<h3 id="srTitle" style="margin-right:0">Mark as surrendered to the office?</h3>' +
        '<p class="modal-lead">' + (r.kind === 'lost'
          ? 'Someone brought an item that may be "' + esc(r.itemName) + '" (#' + esc(r.caseNo) + ') to the office. The owner will be told to come and confirm if it\'s theirs.'
          : '"' + esc(r.itemName) + '" (#' + esc(r.caseNo) + ') is now at the office. The finder will be thanked, and the post will show it is ready to claim.') + '</p>' +
        '<div class="field"><label for="srNote">Note for the owner <span style="color:var(--muted);font-weight:400">(optional)</span></label>' +
        '<textarea id="srNote" rows="2" maxlength="300" placeholder="e.g. Brought by a student at 2 PM. Ask for it at Window 3."></textarea></div>' +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-v="0">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-v="1">Mark and notify</button></div></div>';
      document.body.appendChild(bd);
      openModal(bd);
      setTimeout(function () { bd.querySelector('#srNote').focus(); }, 50);
      function close(v) {
        closeModal(bd);
        setTimeout(function () { bd.remove(); }, 300);
        resolve(v);
      }
      bd.addEventListener('click', function (e) {
        var b = e.target.closest('[data-v]');
        if (e.target === bd || (b && b.getAttribute('data-v') === '0')) return close(null);
        if (b) close(markSurrendered(r.kind, r.id, true, bd.querySelector('#srNote').value));
      });
    });
  }

  function refreshReportComments(kind, id) {
    var r = findRecord(kind, id), key = kind + ':' + id;
    document.querySelectorAll('.r-comments').forEach(function (el) {
      if (el.getAttribute('data-rc') !== key || !r) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = reportCommentsHTML(r);
      el.replaceWith(tmp.firstChild);
    });
  }

  // Post and delete comments on any page.
  document.addEventListener('submit', function (e) {
    var f = e.target.closest && e.target.closest('.rc-form');
    if (!f) return;
    e.preventDefault();
    var ta = f.querySelector('textarea'), text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    var p = f.getAttribute('data-rckey').split(':');
    var priv = f.querySelector('input[name=private]'), isPriv = !!(priv && priv.checked);
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    var saved = addComment(p[0], p[1], text, { private: isPriv });
    btn.disabled = false;
    if (!saved) { toast(lastError || STORAGE_FULL, true); lastError = ''; return; }
    refreshReportComments(p[0], p[1]);
    toast(isPublic(saved) && !isPriv ? 'Comment posted.' : 'Private comment posted. Only the owner, staff, and the admin can see it.');
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-cdel]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    var p = b.getAttribute('data-cdel').split(':');
    confirmDialog({ title: 'Delete this comment?', message: 'Everyone will see "Comment removed" in its place.', confirmText: 'Delete' })
      .then(function (yes) {
        if (!yes) return;
        var saved = removeComment(p[0], p[1], p[2]);
        if (!saved) { toast(lastError || STORAGE_FULL, true); lastError = ''; return; }
        if (!isRequest(saved)) { refreshReportComments(p[0], p[1]); }
        else {
          var li = b.closest('li'), c = (saved.comments || []).find(function (x) { return x.id === p[2]; });
          if (li && c) { var tmp = document.createElement('div'); tmp.innerHTML = commentItemHTML(saved, c); li.replaceWith(tmp.firstChild); }
        }
        toast('Comment deleted.');
      });
  }, true);

  function commentFormHTML(key, placeholder) {
    return '<form class="c-form" data-ckey="' + esc(key) + '" novalidate>' +
      '<label class="sr-only" for="c-' + esc(key) + '">Write a comment</label>' +
      '<textarea id="c-' + esc(key) + '" rows="2" maxlength="1000" placeholder="' + esc(placeholder || 'Write a comment…') + '"></textarea>' +
      '<button type="submit" class="btn btn-primary btn-sm">Post comment</button></form>';
  }

  /* ===== 5. NOTIFICATIONS ===== */
  /* Office list (admin + staff, each with their own read state) and user updates. */

  // Updates for community users.
  function notifyUser(userId, text, caseNo) {
    if (!userId) return;
    var list = read('userNotes', []);
    list.push({ id: uid('UN'), userId: userId, text: text, caseNo: caseNo || '', at: new Date().toISOString(), read: false });
    write('userNotes', list.slice(-500));
  }

  function getUserNotes(userId) {
    return read('userNotes', []).filter(function (n) { return n.userId === userId; }).reverse();
  }

  function markUserNotesRead(userId) {
    write('userNotes', read('userNotes', []).map(function (n) { if (n.userId === userId) n.read = true; return n; }));
  }

  // Tells the sender a notice/claim was approved or declined.
  function notifyRequestDecision(q, approved, note) {
    var label = q.kind === 'claim' ? 'claim request' : 'found notice';
    notifyUser(q.ownerId, approved
      ? 'Your ' + label + ' #' + q.caseNo + ' for ' + q.itemName + ' was approved.' +
        (q.kind === 'claim' ? ' Bring a valid ID to the Lost and Found office to pick it up.' : ' Thank you!')
      : 'Your ' + label + ' #' + q.caseNo + ' for ' + q.itemName + ' was declined' + (note ? ': "' + note + '".' : ' (no comment).') +
        ' You can update it and send it again from My Reports.', q.caseNo);
  }

  // Office notifications (admin + staff).
  function notify(text, caseNo) {
    var list = read('notifications', []);
    list.push({ id: uid('N'), text: text, caseNo: caseNo || '', at: new Date().toISOString(), read: false });
    write('notifications', list.slice(-200));
  }

  function getNotifications() { return read('notifications', []).slice().reverse(); }

  function markNotificationsRead(u) {
    u = u || currentUser();
    if (u) {
      write('notifications', read('notifications', []).map(function (n) {
        if ((n.readBy || []).indexOf(u.id) === -1) n.readBy = (n.readBy || []).concat(u.id);
        return n;
      }));
      return;
    }
    write('notifications', read('notifications', []).map(function (n) { n.read = true; return n; }));
  }

  // Notifications for the logged-in user.
  function isOfficeUser(u) { return isAdmin(u) || isStaff(u); }

  function myNotes(u) {
    u = u || currentUser();
    if (!u) return [];
    return isOfficeUser(u)
      ? getNotifications().filter(function (n) { return (n.hiddenBy || []).indexOf(u.id) === -1; })
      : getUserNotes(u.id);
  }

  function isNoteRead(n, u) {
    u = u || currentUser();
    if (n.userId) return !!n.read;
    return !!(u && (n.readBy || []).indexOf(u.id) !== -1);
  }

  function unreadCount(u) { u = u || currentUser(); return myNotes(u).filter(function (n) { return !isNoteRead(n, u); }).length; }

  function markNoteRead(id, u) {
    u = u || currentUser();
    if (!u) return;
    ['notifications', 'userNotes'].forEach(function (key) {
      var list = read(key, []), changed = false;
      list.forEach(function (n) {
        if (n.id !== id) return;
        if (n.userId) { if (!n.read) { n.read = true; changed = true; } }
        else if ((n.readBy || []).indexOf(u.id) === -1) { n.readBy = (n.readBy || []).concat(u.id); changed = true; }
      });
      if (changed) write(key, list);
    });
    refreshBell();
  }

  function markAllMineRead(u) {
    u = u || currentUser();
    if (!u) return;
    if (isOfficeUser(u)) markNotificationsRead(u); else markUserNotesRead(u.id);
    refreshBell();
  }

  // Delete notifications (office ones are hidden only for you). Returns undo().
  function deleteNotes(ids, u) {
    u = u || currentUser();
    if (!u || !ids.length) return function () {};
    var removedUser = [], hiddenOffice = [];
    var un = read('userNotes', []);
    var keep = un.filter(function (n) {
      if (ids.indexOf(n.id) !== -1 && n.userId === u.id) { removedUser.push(n); return false; }
      return true;
    });
    if (removedUser.length) write('userNotes', keep);
    var on = read('notifications', []), changed = false;
    on.forEach(function (n) {
      if (ids.indexOf(n.id) !== -1 && (n.hiddenBy || []).indexOf(u.id) === -1) {
        n.hiddenBy = (n.hiddenBy || []).concat(u.id); hiddenOffice.push(n.id); changed = true;
      }
    });
    if (changed) write('notifications', on);
    refreshBell();
    return function undo() {
      if (removedUser.length) write('userNotes', read('userNotes', []).concat(removedUser)
        .sort(function (a, b) { return a.at.localeCompare(b.at); }));
      if (hiddenOffice.length) write('notifications', read('notifications', []).map(function (n) {
        if (hiddenOffice.indexOf(n.id) !== -1) n.hiddenBy = (n.hiddenBy || []).filter(function (x) { return x !== u.id; });
        return n;
      }));
      refreshBell();
    };
  }

  function deleteNote(id, u) { return deleteNotes([id], u); }

  function clearMyNotes(u, onlyRead) {
    u = u || currentUser();
    var ids = myNotes(u).filter(function (n) { return !onlyRead || isNoteRead(n, u); }).map(function (n) { return n.id; });
    return { count: ids.length, undo: deleteNotes(ids, u) };
  }

  // Where a notification opens.
  function noteLink(n, u) {
    u = u || currentUser();
    if (n.link && /^[A-Z]+\.html(\?[^"'<>]*)?$/.test(n.link)) return n.link;
    var q = n.caseNo ? encodeURIComponent(n.caseNo) : '';
    if (isAdmin(u)) return q ? 'ADMIN.html?q=' + q + '#reports' : 'ADMIN.html#home';
    if (isStaff(u)) return q ? 'STAFF.html?q=' + q : 'STAFF.html';
    return q ? 'MONITOR.html?q=' + q : 'MONITOR.html';
  }

  var NOTE_ICON = {
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
  };

  // One notification row (icon buttons on the Notifications page).
  function noteItemHTML(n, u, opts) {
    opts = opts || {};
    var read_ = isNoteRead(n, u);
    return '<li class="note' + (read_ ? '' : ' unread') + (opts.page ? ' has-tools' : '') + '" data-nid="' + esc(n.id) + '">' +
      '<span class="dot" aria-hidden="true"></span>' +
      '<a class="note-body" href="' + noteLink(n, u) + '" data-note-open="' + esc(n.id) + '">' +
        '<p>' + esc(n.text) + '</p>' +
        '<small>' + fmtDate(n.at) + ', ' + fmtTime(n.at) + (read_ ? '' : ' <span class="sr-only">(unread)</span>') + '</small></a>' +
      (opts.page ? '<div class="note-tools">' +
        (read_
          ? '<span class="icon-btn-sm is-done" title="Read" aria-hidden="true">' + NOTE_ICON.read + '</span>'
          : '<button type="button" class="icon-btn-sm" data-note-read="' + esc(n.id) + '" title="Mark as read" aria-label="Mark as read">' + NOTE_ICON.read + '</button>') +
        '<button type="button" class="icon-btn-sm danger" data-note-del="' + esc(n.id) + '" title="Delete" aria-label="Delete notification">' + NOTE_ICON.del + '</button>' +
      '</div>' : '') +
    '</li>';
  }

  // Latest few + "View all" (Home pages).
  function notesPreviewHTML(u, max, title) {
    u = u || currentUser();
    var list = myNotes(u), unread = unreadCount(u);
    return '<div class="notif-head"><h3>' + esc(title || 'Notifications') +
        (unread ? ' <span class="pill pill-red">' + unread + ' new</span>' : '') + '</h3>' +
        '<a class="link-btn" href="NOTIFICATIONS.html">View all' + (list.length ? ' (' + list.length + ')' : '') + '</a></div>' +
      (list.length ? '<ul class="note-list">' + list.slice(0, max || 3).map(function (n) { return noteItemHTML(n, u); }).join('') + '</ul>'
                   : '<p class="none" style="color:var(--muted);padding:8px 0">No notifications yet.</p>');
  }

  // Top bar bell count.
  /* ---------- Messages ---------- */
  function setChatBadge(n) {
    DB.meta.unreadMessages = n;
    var b = document.getElementById('lfChat');
    if (!b) return;
    var badge = b.querySelector('.bell-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
    b.setAttribute('aria-label', 'Messages' + (n ? ', ' + n + ' unread' : ''));
  }
  function refreshChatBadge() {
    return apiAsync('messages.php', { action: 'unread' }).then(function (r) { if (r && r.ok) setChatBadge(r.count); });
  }
  function messageLink(toId, caseNo) {
    return 'MESSAGES.html?to=' + encodeURIComponent(toId) + (caseNo ? '&case=' + encodeURIComponent(caseNo) : '');
  }
  // A "Message" button for any page (opens the chat with that person, about that report).
  function messageBtnHTML(toId, caseNo, label, cls) {
    var me = currentUser();
    if (!toId || !me || toId === me.id) return '';
    return '<button type="button" class="' + (cls || 'btn btn-ghost') + '" data-msg-to="' + esc(toId) + '" data-msg-case="' + esc(caseNo || '') + '">' +
      '<svg class="msg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>' +
      '<span>' + esc(label || 'Message') + '</span></button>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-msg-to]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    window.location.href = messageLink(b.getAttribute('data-msg-to'), b.getAttribute('data-msg-case'));
  }, true);

  function refreshBell() {
    var b = document.getElementById('lfBell');
    if (!b) return;
    var n = unreadCount();
    var badge = b.querySelector('.bell-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
    b.setAttribute('aria-label', 'Notifications' + (n ? ', ' + n + ' unread' : ''));
  }

  // Opening a notification marks it read.
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-note-open]');
    if (a) markNoteRead(a.getAttribute('data-note-open'));
  });

  /* ===== 6. EMAIL & PASSWORDS ===== */

  // Email is sent by the server (Gmail, set up in private/config.php). Nothing secret is kept in this file.
  var EMAIL = {};

  // Ready-to-send Gmail link. Not used for temporary passwords: the admin would see them.
  function gmailComposeLink(to, subject, body) {
    return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(to) +
      '&su=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  // SHA-256 (hex). Temporary passwords are saved only as a salted hash, never as text.
  function sha256(str) {
    var K = [], H = [], i, j, isP = function (n) { for (var f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
    for (i = 2, j = 0; j < 64; i++) if (isP(i)) {
      if (j < 8) H[j] = (Math.pow(i, 1 / 2) * 4294967296) | 0;
      K[j++] = (Math.pow(i, 1 / 3) * 4294967296) | 0;
    }
    var bytes = unescape(encodeURIComponent(str)), words = [], len = bytes.length * 8;
    for (i = 0; i < bytes.length; i++) words[i >> 2] |= bytes.charCodeAt(i) << (24 - (i % 4) * 8);
    words[len >> 5] |= 0x80 << (24 - len % 32);
    words[(((len + 64) >> 9) << 4) + 15] = len;
    function r(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (i = 0; i < words.length; i += 16) {
      var w = [], a = H.slice(0);
      for (j = 0; j < 64; j++) {
        if (j < 16) w[j] = words[i + j] | 0;
        else {
          var s0 = r(w[j - 15], 7) ^ r(w[j - 15], 18) ^ (w[j - 15] >>> 3), s1 = r(w[j - 2], 17) ^ r(w[j - 2], 19) ^ (w[j - 2] >>> 10);
          w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
        }
        var t1 = (a[7] + (r(a[4], 6) ^ r(a[4], 11) ^ r(a[4], 25)) + ((a[4] & a[5]) ^ (~a[4] & a[6])) + K[j] + w[j]) | 0;
        var t2 = ((r(a[0], 2) ^ r(a[0], 13) ^ r(a[0], 22)) + ((a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]))) | 0;
        a = [(t1 + t2) | 0, a[0], a[1], a[2], (a[3] + t1) | 0, a[4], a[5], a[6]];
      }
      for (j = 0; j < 8; j++) H[j] = (H[j] + a[j]) | 0;
    }
    return H.map(function (h) { return ('00000000' + (h >>> 0).toString(16)).slice(-8); }).join('');
  }


  function emailReady() { return !!DB.meta.emailReady; }

  // The browser no longer sends email itself; the server sends each email when the action happens.
  function sendEmail() { return Promise.resolve({ sent: false, demo: !emailReady() }); }

  // 8+ characters with upper, lower, number, and symbol.
  function isStrongPassword(v) {
    return v.length >= 8 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v);
  }

  // Random helpers for passwords and codes.
  function randInt(n) {
    var a = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return a[0] % n;
  }

  function pick(chars) { return chars.charAt(randInt(chars.length)); }

  // Temporary password, e.g. "Lf7kQm-4829!".
  function tempPassword() {
    var L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', l = 'abcdefghijkmnpqrstuvwxyz', d = '23456789';
    return pick(L) + pick(l) + pick(d) + pick(l) + pick(L) + pick(l) + '-' + pick(d) + pick(d) + pick(d) + pick(d) + '!';
  }

  function resetCode() { var c = ''; for (var i = 0; i < 6; i++) c += randInt(10); return c; }

  // Forgot-password codes and temporary passwords: 1 min 30 sec. Codes: 6 digits, 5 tries.
  var RESET_MS = 90 * 1000;              // codes + temporary passwords expire after 1 min 30 sec
  var RESET_LABEL = '1 min 30 sec';
  var CODE_MINUTES = RESET_MS / 60000;   // kept for older page code

  // Forgot password (FORGOT.html). The code is made, emailed, and checked on the server.
  // Resolves { ok, expires } or { ok: false, error }.
  function startPasswordReset(email) {
    return apiAsync('password.php', { action: 'forgot_start', email: email }).then(function (r) { return r || { ok: false, error: NET_ERROR }; });
  }

  // '' if the code is right, otherwise an error message.
  function checkResetCode(code) {
    var r = api('password.php', { action: 'forgot_check', code: code });
    return !r ? NET_ERROR : r.ok ? '' : r.error;
  }

  // Admin reset: emails a temporary password straight to the user. It is never shown to the admin,
  // and only a salted hash is saved, so nobody can copy it from the page or from storage.
  // The old password keeps working until the user signs in with the temporary one (before it expires).
  // Resolves { ok: true, expires } or { ok: false, reason: 'no-email' | 'failed' | 'missing' }.
  function sendAdminReset(userId) {
    if (!emailReady()) return Promise.resolve({ ok: false, reason: 'no-email' });
    return apiAsync('password.php', { action: 'admin_reset', id: userId }).then(function (r) {
      if (!r || !r.ok) return { ok: false, reason: 'failed', error: r && r.error };
      putUser(r.user);
      return { ok: true, expires: r.expires };
    });
  }
  // True if pw is the user's pending temporary password.
  // The server checks temporary passwords now; kept for older page code.
  function isTempPassword() { return false; }
  function cancelAdminReset(userId) {
    var r = api('password.php', { action: 'cancel_reset', id: userId });
    if (!r || !r.ok) return null;
    putUser(r.user);
    return r.user;
  }
  // Pending reset that can still be used (not expired, or already used to sign in)
  function activeReset(u) {
    var r = u && u.pendingReset;
    if (!r) return null;
    return (r.usedAt || Date.now() <= r.expires) ? r : null;
  }

  // New password after Forgot password, or after logging in with a temporary password.
  // Returns { ok, next } or { ok: false, error }.
  function setNewPassword(pw) {
    return api('password.php', { action: 'set_password', password: pw }) || { ok: false, error: NET_ERROR };
  }

  // Logged in with the admin's temporary password: { id, name } of the account, or null.
  function pwChangeUser() { return DB.pwChange; }

  // Google sign-in: same answers as login(), plus { status: 'no-account', email, first, last }.
  function googleLogin(credential) {
    var res = api('auth.php', { action: 'google', credential: credential });
    if (!res) return { ok: false, error: NET_ERROR };
    if (res.ok && res.approvedAt) setFlash('Your account was approved on ' + fmtDate(res.approvedAt) + '. Welcome to Lost & Found!', 'success');
    return res;
  }
  function googleClientId() { return DB.meta.googleClientId || ''; }

  // Change password from Account Settings. Returns '' when saved, or an error message. The server checks it.
  function changePassword(userId, current, next) {
    var res = api('auth.php', { action: 'change_password', current: current, next: next });
    if (!res) return NET_ERROR;
    if (!res.ok) return res.error;
    var list = getUsers(), i = list.findIndex(function (u) { return u.id === userId; });
    if (i >= 0) { list[i] = res.user; DB.data.users = list; DB.snap.users[userId] = JSON.stringify(res.user); }
    return '';                            // the server also emails a "password changed" notice
  }

  /* ===== 7. UI ===== */
  /* Forms, photos, toast, modals, profile popup, logo, page shell. */

  // Fills a <select> and greys out the empty choice.
  function fillSelect(select, placeholder, options) {
    select.innerHTML = '<option value="">' + esc(placeholder) + '</option>' +
      options.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('');
    markEmpty(select);
  }

  function markEmpty(select) { select.classList.toggle('is-empty', !select.value); }

  // Form field errors.
  function setFieldError(el, msg) {
    var f = el.closest('.field');
    f.classList.add('error');
    var m = f.querySelector('.error-msg');
    if (!m) { m = document.createElement('small'); m.className = 'error-msg'; f.appendChild(m); }
    m.textContent = msg;
  }

  function clearFieldError(el) {
    var f = el.closest('.field');
    if (!f) return;
    f.classList.remove('error');
    var m = f.querySelector('.error-msg');
    if (m) m.remove();
  }

  // Runs { inputId: rule } and returns the first invalid field (or null).
  function validate(rules, getEl) {
    var first = null;
    Object.keys(rules).forEach(function (id) {
      var el = getEl(id);
      if (!el || el.disabled || el.closest('[hidden]')) return;
      var res = rules[id](el.value.trim(), el);
      if (res === true) clearFieldError(el);
      else { setFieldError(el, res); if (!first) first = el; }
    });
    return first;
  }

  // Re-checks fields as the user types.
  function liveValidate(rules, getEl) {
    Object.keys(rules).forEach(function (id) {
      var el = getEl(id);
      if (!el) return;
      var evt = el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        if (!el.closest('.field').classList.contains('error')) return;
        var res = rules[id](el.value.trim(), el);
        if (res === true) clearFieldError(el); else setFieldError(el, res);
      });
    });
  }

  // Photo helpers: placeholder, resize, picker.
  function photoPlaceholder(text) {
    return '<span class="ph"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 7h3l2-2h6l2 2h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>' + esc(text || 'No photo') + '</span>';
  }

  // Resizes an image so it fits in storage.
  function readPhoto(file, maxDim) {
    maxDim = maxDim || 900;
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Choose an image file (JPG, PNG, or WEBP).'));
      if (file.size > 10 * 1024 * 1024) return reject(new Error('Photo is larger than 10 MB. Choose a smaller one.'));
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read that photo. Try another one.')); };
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.75));
        };
        img.onerror = function () { reject(new Error('This photo format isn\'t supported. Use JPG or PNG.')); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function photoPicker(preview, input, removeBtn, onChange) {
    var data = null;
    function show(d) {
      data = d || null;
      preview.style.backgroundImage = data ? 'url("' + data + '")' : '';
      preview.classList.toggle('has-image', !!data);
      if (onChange) onChange(data);
    }
    input.addEventListener('change', function () {
      var f = input.files[0];
      if (!f) return;
      readPhoto(f).then(show).catch(function (err) { toast(err.message, true); })
        .then(function () { input.value = ''; });
    });
    if (removeBtn) removeBtn.addEventListener('click', function () { show(null); });
    return { get: function () { return data; }, set: show };
  }

  /* ---------- Report photos: up to 4 per report ---------- */
  var MAX_PHOTOS = 4;

  // Photos of a report (older reports have only r.photo).
  function reportPhotos(r) {
    var a = r && Array.isArray(r.photos) && r.photos.length ? r.photos : (r && r.photo ? [r.photo] : []);
    return a.filter(Boolean).slice(0, MAX_PHOTOS);
  }

  // Picker with thumbnails, remove buttons, and an "Add photo" tile. box: element to fill.
  function multiPhotoPicker(box, onChange) {
    var list = [], uidp = 'mp' + Math.random().toString(36).slice(2, 7);
    function render() {
      box.innerHTML = '<div class="mp-grid">' + list.map(function (p, i) {
          return '<div class="mp-item" style="background-image:url(\'' + p + '\')">' +
            (i === 0 ? '<span class="mp-main">Main</span>' : '') +
            '<button type="button" class="mp-remove" data-mpdel="' + i + '" aria-label="Remove photo ' + (i + 1) + '">&times;</button></div>';
        }).join('') +
        (list.length < MAX_PHOTOS
          ? '<label class="mp-add" for="' + uidp + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h3l2-2h6l2 2h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>' +
            '<span>' + (list.length ? 'Add more' : 'Add photos') + '</span><small>' + list.length + ' of ' + MAX_PHOTOS + '</small></label>' +
            '<input type="file" id="' + uidp + '" accept="image/*" multiple hidden>'
          : '') + '</div>' +
        '<p class="hint mp-hint">' + (list.length >= MAX_PHOTOS ? 'That\'s the most (4). Remove one to add another.' : 'Up to 4 photos. The first one is the main photo.') + '</p>';
      var input = box.querySelector('input[type=file]');
      if (input) input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []), room = MAX_PHOTOS - list.length;
        if (files.length > room) toast('Only ' + room + ' more photo' + (room === 1 ? '' : 's') + ' can be added (4 in all).', true);
        Promise.all(files.slice(0, room).map(function (f) { return readPhoto(f).catch(function (err) { toast(err.message, true); return null; }); }))
          .then(function (res) { res.forEach(function (d) { if (d && list.length < MAX_PHOTOS) list.push(d); }); render(); if (onChange) onChange(list.slice()); });
      });
    }
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mpdel]');
      if (!b) return;
      list.splice(+b.getAttribute('data-mpdel'), 1);
      render();
      if (onChange) onChange(list.slice());
    });
    render();
    return { get: function () { return list.slice(); }, set: function (a) { list = (a || []).filter(Boolean).slice(0, MAX_PHOTOS); render(); } };
  }

  // Main photo + small thumbnails for the details windows. Tap a thumbnail to switch; tap the photo to see it full size.
  var GALLERIES = {};
  function photoGalleryHTML(r) {
    var ps = reportPhotos(r);
    if (!ps.length) return '<div class="modal-photo">' + photoPlaceholder() + '</div>';
    var gid = 'g' + Math.random().toString(36).slice(2, 8);
    GALLERIES[gid] = ps;
    return '<div class="pgal" data-gal="' + gid + '">' +
      '<button type="button" class="modal-photo has-image pg-main" data-pgopen="0" style="background-image:url(\'' + ps[0] + '\')" aria-label="Open photo full size">' +
        (ps.length > 1 ? '<span class="pg-count">1 / ' + ps.length + '</span>' : '') + '</button>' +
      (ps.length > 1 ? '<div class="pg-thumbs">' + ps.map(function (p, i) {
        return '<button type="button" class="pg-thumb' + (i ? '' : ' on') + '" data-pg="' + i + '" style="background-image:url(\'' + p + '\')" aria-label="Show photo ' + (i + 1) + '"></button>';
      }).join('') + '</div>' : '') + '</div>';
  }

  function openViewer(ps, i) {
    var v = document.createElement('div');
    v.className = 'pg-viewer';
    v.setAttribute('role', 'dialog');
    v.setAttribute('aria-label', 'Photo viewer');
    function draw() {
      v.innerHTML = '<img src="' + ps[i] + '" alt="Photo ' + (i + 1) + ' of ' + ps.length + '">' +
        '<button type="button" class="pgv-close" aria-label="Close">&times;</button>' +
        (ps.length > 1 ? '<button type="button" class="pgv-nav prev" aria-label="Previous photo">&#8249;</button>' +
          '<button type="button" class="pgv-nav next" aria-label="Next photo">&#8250;</button><span class="pgv-count">' + (i + 1) + ' / ' + ps.length + '</span>' : '');
    }
    function close() { v.remove(); document.removeEventListener('keydown', key, true); }
    function key(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'ArrowRight' && ps.length > 1) { i = (i + 1) % ps.length; draw(); }
      if (e.key === 'ArrowLeft' && ps.length > 1) { i = (i + ps.length - 1) % ps.length; draw(); }
    }
    v.addEventListener('click', function (e) {
      if (e.target.closest('.prev')) { i = (i + ps.length - 1) % ps.length; return draw(); }
      if (e.target.closest('.next')) { i = (i + 1) % ps.length; return draw(); }
      if (e.target.closest('.pgv-close') || e.target === v) close();
    });
    document.addEventListener('keydown', key, true);
    draw();
    document.body.appendChild(v);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-pg], [data-pgopen]');
    if (!t) return;
    var g = t.closest('[data-gal]'), ps = g && GALLERIES[g.getAttribute('data-gal')];
    if (!ps) return;
    if (t.hasAttribute('data-pgopen')) return openViewer(ps, +t.getAttribute('data-pgopen'));
    var i = +t.getAttribute('data-pg'), main = g.querySelector('.pg-main');
    main.style.backgroundImage = 'url("' + ps[i] + '")';
    main.setAttribute('data-pgopen', i);
    var c = main.querySelector('.pg-count'); if (c) c.textContent = (i + 1) + ' / ' + ps.length;
    g.querySelectorAll('.pg-thumb').forEach(function (x) { x.classList.toggle('on', x === t); });
  });

  // Toast message (optional action button, e.g. Undo).
  var toastTimer;

  function toast(msg, isError, action) {
    var el = document.getElementById('lfToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lfToast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.toggle('has-action', !!action);
    if (action) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label || 'Undo';
      b.addEventListener('click', function () { el.classList.remove('show'); clearTimeout(toastTimer); action.fn(); });
      el.appendChild(b);
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, action ? (action.ms || 10000) : 3500);
  }

  // Modals: Esc closes the top one unless it has data-static.
  var modalStack = [];

  function openModal(backdrop) {
    if (!modalStack.some(function (m) { return m.el === backdrop; })) {
      modalStack.push({ el: backdrop, focus: document.activeElement });
    }
    backdrop.classList.add('show');
    document.body.classList.add('no-scroll');
    var box = backdrop.querySelector('.modal');
    if (box) box.scrollTop = 0;
  }

  function closeModal(backdrop) {
    backdrop.classList.remove('show');
    var i = modalStack.findIndex(function (m) { return m.el === backdrop; });
    var entry = i >= 0 ? modalStack.splice(i, 1)[0] : null;
    if (!modalStack.length) document.body.classList.remove('no-scroll');
    if (entry && entry.focus && entry.focus.focus) entry.focus.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var top = modalStack[modalStack.length - 1];
    if (top) {
      if (!top.el.hasAttribute('data-static')) closeModal(top.el);
    } else if (shellMenu && shellMenu.isOpen()) {
      shellMenu.close();
    }
  });

  // Confirm dialog. Resolves true / false.
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var observer = null;
      var bd = document.createElement('div');
      bd.className = 'modal-backdrop top center';
      bd.innerHTML =
        '<div class="modal narrow" role="alertdialog" aria-modal="true" aria-labelledby="cdTitle">' +
          '<h3 id="cdTitle" style="margin-right:0">' + esc(opts.title || 'Are you sure?') + '</h3>' +
          (opts.message ? '<p class="modal-lead">' + esc(opts.message) + '</p>' : '') +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-ghost" data-v="0">' + esc(opts.cancelText || 'Cancel') + '</button>' +
            '<button type="button" class="btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger') + '" data-v="1">' +
              esc(opts.confirmText || 'Delete') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(bd);
      function done(v) {
        if (observer) observer.disconnect();
        closeModal(bd);
        setTimeout(function () { bd.remove(); }, 250);
        resolve(v);
      }
      bd.addEventListener('click', function (e) {
        var b = e.target.closest('[data-v]');
        if (b) done(b.getAttribute('data-v') === '1');
        else if (e.target === bd) done(false);
      });
      // Esc: handled by the stack; resolve false when it closes that way
      observer = new MutationObserver(function () {
        if (!bd.classList.contains('show') && document.body.contains(bd)) { observer.disconnect(); bd.remove(); resolve(false); }
      });
      requestAnimationFrame(function () {
        openModal(bd);
        observer.observe(bd, { attributes: true, attributeFilter: ['class'] });
        bd.querySelector('[data-v="1"]').focus();
      });
    });
  }

  // Profile popup.
  function showProfile(userId, fallbackName) {
    var u = userId ? getUser(userId) : null, me = currentUser();
    var p = (u && u.profile) || {};
    var name = u ? displayName(u) : (fallbackName || 'Unknown user');
    var role = !u ? 'Not a registered user' : isAdmin(u) ? 'Administrator' : u.accountType === 'staff' ? 'Staff' : 'Community user';
    var photo = p.photo;
    var ini = name.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    var mobile = p.mobile || '';
    var canSeeMore = me && (isAdmin(me) || isStaff(me));
    var bd = document.createElement('div');
    bd.className = 'modal-backdrop top center';
    bd.innerHTML =
      '<div class="modal narrow profile-pop" role="dialog" aria-modal="true" aria-labelledby="ppName">' +
        '<button type="button" class="modal-close" aria-label="Close">&times;</button>' +
        '<div class="pp-avatar"' + (photo ? ' style="background-image:url(\'' + photo + '\')"' : '') + '>' + (photo ? '' : esc(ini)) + '</div>' +
        '<h3 id="ppName">' + esc(name) + '</h3>' +
        '<p class="pp-role">' + esc(role) + (u && u.code ? ' • ' + esc(u.code) : '') + '</p>' +
        (u ? '<dl class="details pp-details">' +
          '<dt>Email</dt><dd><a href="mailto:' + esc(u.email) + '">' + esc(u.email) + '</a></dd>' +
          '<dt>Mobile</dt><dd>' + (mobile ? '<a href="tel:' + esc(mobile) + '">' + esc(mobile) + '</a>' : 'Not provided') + '</dd>' +
          (p.city ? '<dt>City</dt><dd>' + esc(p.city) + '</dd>' : '') +
          '<dt>Member since</dt><dd>' + fmtDate(u.createdAt) + '</dd>' +
          (canSeeMore ? '<dt>Account</dt><dd>' + esc(u.status === 'blocked' ? 'Blocked' : u.status === 'pending' ? 'Waiting for approval' : u.status === 'declined' ? 'Declined' : 'Active') + '</dd>' +
                        '<dt>ID</dt><dd>' + (u.validId ? idTypeLabel(u) + ' submitted' : 'Not submitted') + '</dd>' : '') +
        '</dl>' : '<p class="pp-none">This person doesn\'t have an account, so there\'s no profile to show.</p>') +
        '<div class="modal-actions" style="justify-content:center"><button type="button" class="btn btn-primary" data-pp-close>Close</button></div>' +
      '</div>';
    document.body.appendChild(bd);
    function close() { closeModal(bd); setTimeout(function () { bd.remove(); }, 250); }
    bd.addEventListener('click', function (e) {
      if (e.target === bd || e.target.closest('.modal-close') || e.target.closest('[data-pp-close]')) close();
    });
    requestAnimationFrame(function () { openModal(bd); bd.querySelector('[data-pp-close]').focus(); });
  }

  // Any element with data-profile opens the popup.
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-profile]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    showProfile(b.getAttribute('data-profile'), b.getAttribute('data-name'));
  }, true);

  // Site logo (admin can upload one on Admin Home).
  var DEFAULT_LOGO =
    '<svg viewBox="0 0 200 200" role="img" aria-label="Lost and Found logo">' +
      '<circle cx="100" cy="100" r="94" fill="#fff" stroke="#e04141" stroke-width="7"/>' +
      '<circle cx="100" cy="100" r="80" fill="none" stroke="#e04141" stroke-width="2"/>' +
      '<text x="100" y="94" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-weight="700" font-size="24" fill="#e04141">LOST &amp;</text>' +
      '<text x="100" y="122" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif" font-weight="700" font-size="24" fill="#e04141">FOUND</text>' +
    '</svg>';

  function getLogo() { return read('siteLogo', null); }

  function setLogo(data) { return data ? write('siteLogo', data) : (remove('siteLogo'), true); }

  function renderLogo(el) {
    if (!el) return;
    var src = getLogo();
    el.innerHTML = src ? '<img src="' + src + '" alt="Lost and Found logo">' : DEFAULT_LOGO;
  }

  // Contact email and footer.
  var CONTACT_EMAIL = 'minicapstonproject@gmail.com';

  var FOOTER_HTML = 'Lost and Found Management System | Web-Based Platform<br>' +
    'Need help? <a href="mailto:' + CONTACT_EMAIL + '">' + CONTACT_EMAIL + '</a>';

  // Side menu links per role.
  var ADMIN_NAV = [
    { href: 'ADMIN.html#home',     label: 'Home' },
    { href: 'ADMIN.html#reports',  label: 'Pending Reports' },
    { href: 'ADMIN.html#accounts', label: 'Account Management' },
    { href: 'MESSAGES.html',       label: 'Messages' },
    { href: 'NOTIFICATIONS.html',  label: 'Notifications' },
    { href: 'ACCOUNT.html',        label: 'Account Settings' }
  ];

  var STAFF_NAV = [
    { href: 'STAFFHOME.html', label: 'Home' },
    { href: 'STAFF.html',   label: 'Review Dashboard' },
    { href: 'MESSAGES.html', label: 'Messages' },
    { href: 'NOTIFICATIONS.html', label: 'Notifications' },
    { href: 'ACCOUNT.html', label: 'Account Settings' }
  ];

  var NAV = [
    { href: 'HOME.html',    label: 'Home' },
    { href: 'REPORT.html',  label: 'Report Lost Item' },
    { href: 'FOUND.html',   label: 'Report Found Item' },
    { href: 'SEEK.html',    label: 'Matching & Search' },
    { href: 'MONITOR.html', label: 'My Reports' },
    { href: 'MESSAGES.html', label: 'Messages' },
    { href: 'NOTIFICATIONS.html', label: 'Notifications' },
    { href: 'ACCOUNT.html', label: 'Account Settings' }
  ];

  // Page shell: top bar, bell, side menu, footer.
  var HOME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3L12 3z"/></svg>';

  var shellMenu = null;

  function mountShell(opts) {
    var me = currentUser();
    var navList = isAdmin(me) ? ADMIN_NAV : isStaff(me) ? STAFF_NAV : NAV;
    var homeHref = homeFor(me);
    var header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML =
      '<div class="topbar-left">' +
        '<button type="button" class="menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="sideMenu"><span></span><span></span><span></span></button>' +
        '<a href="' + homeHref + '" class="home-btn" aria-label="Home">' + HOME_ICON + '</a>' +
      '</div>' +
      '<h1 class="topbar-title">' + esc(opts.title) + '</h1>' +
      '<div class="topbar-right">' +
        '<a href="MESSAGES.html" class="bell-btn chat-btn' + (opts.active === 'MESSAGES.html' ? ' active' : '') + '" id="lfChat" aria-label="Messages">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>' +
          '<span class="bell-badge" hidden></span></a>' +
        '<a href="NOTIFICATIONS.html" class="bell-btn' + (opts.active === 'NOTIFICATIONS.html' ? ' active' : '') + '" id="lfBell" aria-label="Notifications">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>' +
          '<span class="bell-badge" hidden></span></a>' +
        '<button type="button" class="logout-btn">Log out</button></div>';

    var nav = document.createElement('nav');
    nav.className = 'side-menu';
    nav.id = 'sideMenu';
    nav.setAttribute('aria-label', 'Main menu');
    nav.innerHTML = '<div class="side-user" id="sideUser"></div>' + navList.map(function (n) {
      var active = n.href === opts.active;
      return '<a href="' + n.href + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + esc(n.label) + '</a>';
    }).join('');

    var overlay = document.createElement('div');
    overlay.className = 'menu-overlay';

    document.body.insertBefore(overlay, document.body.firstChild);
    document.body.insertBefore(nav, document.body.firstChild);
    setTimeout(function () {
      setChatBadge(DB.meta.unreadMessages || 0);
      setInterval(function () { if (!document.hidden) refreshChatBadge(); }, 45000);
    }, 0);
    document.body.insertBefore(header, document.body.firstChild);

    var footer = document.createElement('footer');
    footer.className = 'footer';
    footer.innerHTML = FOOTER_HTML;
    var main = document.querySelector('main');
    if (main && main.nextSibling) document.body.insertBefore(footer, main.nextSibling);
    else document.body.appendChild(footer);

    var menuBtn = header.querySelector('.menu-btn');
    function setMenu(open) {
      nav.classList.toggle('open', open);
      overlay.classList.toggle('show', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    shellMenu = {
      isOpen: function () { return nav.classList.contains('open'); },
      close: function () { setMenu(false); }
    };
    menuBtn.addEventListener('click', function () { setMenu(!shellMenu.isOpen()); });
    // Close the menu after picking a link (matters for same-page links like ADMIN.html#accounts)
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    overlay.addEventListener('click', function () { setMenu(false); });

    header.querySelector('.logout-btn').addEventListener('click', function () {
      if (opts.beforeLogout && opts.beforeLogout() === false) return;
      confirmDialog({ title: 'Log out?', message: 'You can log back in anytime while this tab stays open.',
                      confirmText: 'Log out', danger: true })
        .then(function (yes) {
          if (!yes) return;
          logout();
          window.location.href = 'LOGIN.html';
        });
    });

    refreshShellUser();
    refreshBell();

    // One-time message (e.g. "Your account was approved")
    var f = takeFlash();
    if (f && main) {
      var note = document.createElement('div');
      note.className = 'alert alert-' + (f.type || 'success') + ' shell-flash';
      note.setAttribute('role', 'status');
      note.innerHTML = '<span>' + esc(f.msg) + '</span><button type="button" class="shell-flash-x" aria-label="Dismiss">&times;</button>';
      main.insertBefore(note, main.firstChild);
      note.querySelector('button').addEventListener('click', function () { note.remove(); });
    }
  }

  function refreshShellUser() {
    var box = document.getElementById('sideUser');
    var u = currentUser();
    if (!box || !u) return;
    var name = displayName(u) || u.email;
    var photo = u.profile && u.profile.photo;
    var initials = name.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    box.innerHTML =
      '<div class="side-avatar"' + (photo ? ' style="background-image:url(\'' + photo + '\')"' : '') + '>' +
        (photo ? '' : esc(initials)) + '</div>' +
      '<div><strong>' + esc(name) + '</strong><small>' + (isAdmin(u) ? 'Administrator' : u.accountType === 'staff' ? 'Staff account' : 'Community user') + '</small></div>';
  }

  // Profile form (first visit + Account Settings). opts.simple = admin fields only.
  function profileForm(root, opts) {
    opts = opts || {};
    var P = 'pf-';
    function field(id, label, inner, cls) {
      return '<div class="field ' + (cls || '') + '"><label for="' + P + id + '">' + label + '</label>' + inner + '</div>';
    }
    function input(id, type, attrs) {
      return '<input type="' + type + '" id="' + P + id + '" ' + (attrs || '') + '>';
    }
    function select(id, attrs) {
      return '<div class="select"><select id="' + P + id + '" ' + (attrs || '') + '></select></div>';
    }
    function combo(id, ph) {
      return '<div class="combo"><input type="text" id="' + P + id + '" placeholder="' + ph + '"></div>';
    }

    root.innerHTML =
      '<fieldset id="' + P + 'fieldset">' +
      '<div class="form-section">' +
        '<h3 class="form-section-title">Personal details</h3>' +
        '<div class="grid g-4">' +
          field('firstName', 'First name', input('firstName', 'text', 'autocomplete="given-name"')) +
          field('middleName', 'Middle name <span>(optional)</span>', input('middleName', 'text', 'autocomplete="additional-name"')) +
          field('lastName', 'Last name', input('lastName', 'text', 'autocomplete="family-name"')) +
          field('suffix', 'Suffix <span>(optional)</span>', select('suffix')) +
        '</div>' +
        '<div class="grid g-4">' +
          field('birthdate', 'Birthdate', input('birthdate', 'date', 'autocomplete="bday"')) +
          field('age', 'Age', input('age', 'text', 'readonly tabindex="-1" placeholder="Auto"')) +
          field('gender', 'Gender', select('gender')) +
        '</div>' +
      '</div>' +
      '<div class="form-section">' +
        '<h3 class="form-section-title">Contact</h3>' +
        '<div class="grid g-2">' +
          field('mobile', 'Mobile number', input('mobile', 'tel', 'inputmode="numeric" maxlength="11" placeholder="09XXXXXXXXX" autocomplete="tel"')) +
          field('email', 'Email address', input('email', 'email', 'autocomplete="email"')) +
        '</div>' +
      '</div>' +
      '<div class="form-section">' +
        '<h3 class="form-section-title">Address</h3>' +
        '<div class="grid g-4">' +
          field('region', 'Region', combo('region', 'Loading list…')) +
          field('province', 'Province', combo('province', 'Choose region first')) +
          field('city', 'City / Municipality', combo('city', 'Choose province first')) +
          field('barangay', 'Barangay', combo('barangay', 'Choose city first')) +
        '</div>' +
        '<p class="hint addr-note" id="' + P + 'addrNote">Type to search, then pick from the list.</p>' +
        '<div class="grid g-4">' +
          field('house', 'House / Lot / Block no. / Name', input('house', 'text', 'autocomplete="address-line1" placeholder="Insert house / lot / block no. / name"'), 'span-2') +
          field('street', 'Street <span>(optional)</span>', input('street', 'text', 'autocomplete="address-line2" placeholder="Insert street"')) +
          field('zip', 'Zip code', input('zip', 'text', 'inputmode="numeric" maxlength="4" autocomplete="postal-code"') +
            '<p class="hint" id="' + P + 'zipHint" hidden></p>') +
        '</div>' +
      '</div>' +
      '<div class="form-section">' +
        '<h3 class="form-section-title">Profile photo <span>(optional)</span></h3>' +
        '<div class="photo-picker">' +
          '<div class="photo-preview" id="' + P + 'preview">' + photoPlaceholder() +
            '<button type="button" class="remove-photo" id="' + P + 'remove" aria-label="Remove photo">&times;</button></div>' +
          '<div class="photo-controls">' +
            '<label class="btn btn-ghost" for="' + P + 'photo">Add photo</label>' +
            '<p class="hint">JPG or PNG. Large photos are resized automatically.</p>' +
            '<input type="file" id="' + P + 'photo" accept="image/*" hidden>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</fieldset>';

    function $(id) { return root.querySelector('#' + P + id); }
    var fs = $('fieldset'), region = $('region'), province = $('province'), city = $('city'),
        barangay = $('barangay'), zip = $('zip'), birth = $('birthdate'), age = $('age');

    fillSelect($('suffix'), 'None', ['Jr.', 'Sr.', 'II', 'III', 'IV']);
    fillSelect($('gender'), 'Choose one', ['Male', 'Female', 'Prefer not to say']);
    /* ----- Address: Region > Province > City > Barangay (PSGC list in ph-address.js) ----- */
    var addrState = 'loading';            // loading | ready | failed
    var pendingAddr = null;               // saved address waiting for the list to load
    var zipHint = $('zipHint');

    function cityItems(arr) {
      return arr.map(function (c) {
        return { n: c.n, c: c.c, z: c.z || '', zm: !!c.zm, b: c.b };
      });
    }
    function barangayItems(c) {
      return c.b.map(function (s) {
        var p = s.split('|');
        return { n: p[0], z: p[1] || '', note: p[1] ? 'ZIP ' + p[1] : '' };
      });
    }
    function showZipHint(msg) { zipHint.textContent = msg || ''; zipHint.hidden = !msg; }
    function setZip(z, c) {
      zip.value = z || '';
      if (zip.value) clearFieldError(zip);
      if (!c) return showZipHint('');
      if (!z) return showZipHint('No ZIP code on file for ' + c.n + '. Type it in.');
      showZipHint(c.zm ? c.n + ' has more than one ZIP code. Check that ' + z + ' is yours.' : 'Filled in from ' + c.n + '.');
    }

    var cbRegion = comboBox(region, { onChange: onRegion });
    var cbProvince = comboBox(province, { onChange: onProvince });
    var cbCity = comboBox(city, { onChange: onCity });
    var cbBarangay = comboBox(barangay, { onChange: onBarangay });
    var combos = [cbRegion, cbProvince, cbCity, cbBarangay];

    function noProvince() { var r = cbRegion.get(); return !!(r && !r.p); }   // NCR
    function lockDependents() {
      if (fs.disabled) return;
      if (addrState === 'failed') { combos.forEach(function (c) { c.input.disabled = false; }); return; }
      region.disabled = addrState !== 'ready';
      province.disabled = !cbRegion.get() || noProvince();
      city.disabled = !cbRegion.get() || (!noProvince() && !cbProvince.get());
      barangay.disabled = !cbCity.get();
    }
    function onRegion() {
      var r = cbRegion.get();
      cbProvince.setItems(r && r.p ? r.p : []);
      province.placeholder = !r ? 'Choose region first' : r.p ? 'Search province' : 'None (NCR has no province)';
      cbCity.setItems(r && !r.p ? cityItems(r.m) : []);
      city.placeholder = r && !r.p ? 'Search city' : 'Choose province first';
      onCity();
    }
    function onProvince() {
      var p = cbProvince.get();
      if (!noProvince()) {
        cbCity.setItems(p ? cityItems(p.m) : []);
        city.placeholder = p ? 'Search city / municipality' : 'Choose province first';
      }
      onCity();
    }
    function onCity() {
      var c = cbCity.get();
      cbBarangay.setItems(c ? barangayItems(c) : []);
      barangay.placeholder = c ? 'Search barangay' : 'Choose city first';
      setZip(c ? c.z : '', c);
      lockDependents();
    }
    function onBarangay() {
      var c = cbCity.get(), b = cbBarangay.get();
      if (c) setZip((b && b.z) || c.z, b && b.z ? { n: b.n + ', ' + c.n } : c);
    }

    function applyAddress(d) {
      cbRegion.set(d.region); onRegion();
      if (!noProvince()) { cbProvince.set(d.province); onProvince(); }
      cbCity.set(d.city); onCity();
      cbBarangay.set(d.barangay);
      if (d.zip) { zip.value = d.zip; showZipHint(''); }
      else onBarangay();
      lockDependents();
    }

    var addrReady = (opts.simple ? new Promise(function () {}) : loadAddress()).then(function (data) {
      addrState = 'ready';
      cbRegion.setItems(data.regions);
      region.placeholder = 'Search region';
      if (pendingAddr) { applyAddress(pendingAddr); pendingAddr = null; }
      lockDependents();
    }, function () {
      // List missing: let people type their address instead of blocking them.
      addrState = 'failed';
      combos.forEach(function (c) { c.setFree(true); });
      region.placeholder = 'Type your region';
      province.placeholder = 'Type your province';
      city.placeholder = 'Type your city';
      barangay.placeholder = 'Type your barangay';
      $('addrNote').textContent = 'The address list (ph-address.js) did not load, so type your address.';
      $('addrNote').classList.add('invalid');
      if (pendingAddr) {
        region.value = pendingAddr.region || ''; province.value = pendingAddr.province || '';
        city.value = pendingAddr.city || ''; barangay.value = pendingAddr.barangay || '';
        pendingAddr = null;
      }
      lockDependents();
    }).then(function () { return api; });
    root.querySelectorAll('select').forEach(function (s) {
      s.addEventListener('change', function () { markEmpty(s); });
    });

    birth.max = todayISO();
    function updateAge() { age.value = ageFrom(birth.value); }
    birth.addEventListener('change', updateAge);
    digitsOnly($('mobile'), 11);
    digitsOnly(zip, 4);
    zip.addEventListener('input', function () { showZipHint(''); });

    var photo = photoPicker($('preview'), $('photo'), $('remove'));

    var KEYS = ['firstName', 'middleName', 'lastName', 'suffix', 'birthdate', 'gender', 'mobile', 'email',
                'region', 'province', 'city', 'barangay', 'house', 'street', 'zip'];

    // Simple mode (admin): name, email, optional mobile, optional photo only
    if (opts.simple) {
      ['middleName', 'suffix', 'birthdate', 'age', 'gender'].forEach(function (k) { $(k).closest('.field').hidden = true; });
      birth.closest('.grid').hidden = true;
      region.closest('.form-section').hidden = true;
      $('firstName').closest('.grid').className = 'grid g-2';
      root.querySelector('.form-section-title').textContent = 'Name';
      $('mobile').closest('.field').querySelector('label').innerHTML = 'Mobile number <span>(optional)</span>';
      KEYS = ['firstName', 'lastName', 'mobile', 'email'];
    }

    function addrOk(cb, v) {
      if (addrState === 'loading') return false;
      return addrState === 'failed' ? v.length >= 2 : !!cb.get() && cb.get().n === v;
    }
    var RULES = {
      firstName: function (v) { return v.length >= 2 || 'Enter your first name.'; },
      lastName:  function (v) { return v.length >= 2 || 'Enter your last name.'; },
      birthdate: function (v) {
        if (!v) return 'Enter your birthdate.';
        if (v > birth.max) return 'Birthdate can\'t be in the future.';
        return ageFrom(v) >= 18 || 'You must be at least 18 years old.';
      },
      gender:   function (v) { return !!v || 'Choose a gender.'; },
      mobile:   function (v) { return /^09\d{9}$/.test(v) || 'Use 11 digits starting with 09.'; },
      email:    function (v) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Enter a valid email.';
        var other = findUserByEmail(v);
        return !other || other.id === opts.userId || 'Another account already uses this email.';
      },
      region:   function (v) { return addrOk(cbRegion, v) || 'Choose a region from the list.'; },
      province: function (v) { return addrOk(cbProvince, v) || 'Choose a province from the list.'; },
      city:     function (v) { return addrOk(cbCity, v) || 'Choose a city or municipality from the list.'; },
      barangay: function (v) { return addrOk(cbBarangay, v) || 'Choose a barangay from the list.'; },
      house:    function (v) { return v.length >= 1 || 'Enter your house, lot, or block number, or the building name.'; },
      zip:      function (v) { return /^\d{4}$/.test(v) || 'Zip code has 4 digits.'; }
    };
    if (opts.simple) {
      ['birthdate', 'gender', 'region', 'province', 'city', 'barangay', 'house', 'zip'].forEach(function (k) { delete RULES[k]; });
      RULES.mobile = function (v) { return !v || /^09\d{9}$/.test(v) || 'Use 11 digits starting with 09, or leave it blank.'; };
    }
    liveValidate(RULES, $);

    var api = {
      read: function () {
        var d = {};
        if (addrState !== 'loading') combos.forEach(function (c) { c.commit(); });
        KEYS.forEach(function (k) { d[k] = $(k).value.trim(); });
        if (addrState === 'loading' && pendingAddr) {
          ['region', 'province', 'city', 'barangay', 'zip'].forEach(function (k) { d[k] = pendingAddr[k] || ''; });
        }
        d.photo = photo.get();
        return d;
      },
      write: function (d) {
        d = d || {};
        ['firstName', 'middleName', 'lastName', 'suffix', 'birthdate', 'gender', 'mobile', 'email', 'house', 'street']
          .forEach(function (k) { $(k).value = d[k] || ''; });
        var addr = { region: d.region || '', province: d.province || '', city: d.city || '', barangay: d.barangay || '', zip: d.zip || '' };
        if (addrState === 'ready') applyAddress(addr);
        else if (addrState === 'failed') {
          region.value = addr.region; province.value = addr.province; city.value = addr.city;
          barangay.value = addr.barangay; zip.value = addr.zip;
        } else { pendingAddr = addr; zip.value = addr.zip; }
        root.querySelectorAll('select').forEach(markEmpty);
        updateAge();
        photo.set(d.photo || null);
        root.querySelectorAll('.field.error input, .field.error select').forEach(clearFieldError);
        showZipHint('');
      },
      validate: function () { return validate(RULES, $); },
      setLocked: function (on) {
        fs.disabled = on;
        if (on) combos.forEach(function (c) { c.close(); });
        else lockDependents();
      },
      focus: function () { $('firstName').focus(); },
      ready: addrReady,          // resolves once the address list is in (saved address filled in)
      photo: photo
    };
    lockDependents();
    return api;
  }

  // Owner can edit a report (details + photo) while it is still open.
  function canEditReport(r) {
    var s = String(r.status || '').toLowerCase();
    return s !== 'claimed' && s !== 'disposed' && s !== 'closed';
  }

  // Edit window for a lost/found report. onSaved(updatedRecord) runs after saving.
  function openReportEditor(rec, onSaved, opts) {
    opts = opts || {};
    var isLost = rec.kind === 'lost';
    var bd = document.createElement('div');
    bd.className = 'modal-backdrop top';
    bd.innerHTML =
      '<div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="reTitle">' +
        '<button type="button" class="modal-close" aria-label="Close">&times;</button>' +
        '<h3 id="reTitle">Edit report</h3>' +
        '<p class="case">#' + esc(rec.caseNo) + ' • ' + (isLost ? 'Lost' : 'Found') + ' report</p>' +
        '<form id="reForm" novalidate>' +
          '<div class="re-grid">' +
            '<div class="re-photo">' +
              '<span class="field-label">Photos <span>(optional, up to 4)</span></span>' +
              '<div class="mp-box" id="rePhotos"></div>' +
            '</div>' +
            '<div>' +
              '<div class="grid g-2">' +
                '<div class="field"><label for="re-itemName">Item name</label><input type="text" id="re-itemName"></div>' +
                '<div class="field"><label for="re-category">Category</label><div class="select"><select id="re-category"></select></div></div>' +
              '</div>' +
              '<div class="field" hidden style="margin-bottom:14px"><label for="re-categoryDetail">Specify category</label><input type="text" id="re-categoryDetail"></div>' +
              '<div class="grid g-2">' +
                '<div class="field"><label for="re-date">Date ' + (isLost ? 'lost' : 'found') + '</label><input type="date" id="re-date"></div>' +
                '<div class="field"><label for="re-mobile">Mobile number</label><input type="tel" id="re-mobile" inputmode="numeric" maxlength="11"></div>' +
              '</div>' +
              '<div class="grid g-2">' +
                '<div class="field"><label for="re-location">Location ' + (isLost ? 'lost' : 'found') + '</label><div class="select"><select id="re-location"></select></div></div>' +
                '<div class="field" hidden><label for="re-locationDetail">Specify location</label><input type="text" id="re-locationDetail"></div>' +
              '</div>' +
              '<div class="field"><label for="re-description">Description</label><textarea id="re-description" style="min-height:120px"></textarea></div>' +
            '</div>' +
          '</div>' +
          '<p class="hint" id="reNote"></p>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-ghost" id="reCancel">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Save changes</button>' +
          '</div>' +
        '</form>' +
      '</div>';
    document.body.appendChild(bd);
    function $(id) { return bd.querySelector('#' + id); }
    function f(id) { return $('re-' + id); }

    fillSelect(f('category'), 'Choose category', CATEGORIES);
    fillSelect(f('location'), isLost ? 'Where did you lose it?' : 'Where did you find it?', LOCATIONS);
    f('date').max = todayISO();
    digitsOnly(f('mobile'), 11);
    ['itemName', 'category', 'categoryDetail', 'date', 'mobile', 'location', 'locationDetail', 'description'].forEach(function (k) {
      f(k).value = rec[k] || '';
    });
    [f('category'), f('location')].forEach(markEmpty);
    function toggle(sel, det) { det.closest('.field').hidden = sel.value !== 'Others'; }
    toggle(f('category'), f('categoryDetail')); toggle(f('location'), f('locationDetail'));
    f('category').addEventListener('change', function () { markEmpty(this); toggle(this, f('categoryDetail')); });
    f('location').addEventListener('change', function () { markEmpty(this); toggle(this, f('locationDetail')); });

    var photos = multiPhotoPicker($('rePhotos'));
    photos.set(reportPhotos(rec));

    $('reNote').textContent = rec.review === 'rejected'
      ? 'Saving sends this report back to staff for review.'
      : (!rec.review || rec.review === 'posted') ? 'Your changes show in Matching & Search right away. Staff will be notified.' : '';

    var RULES = {
      itemName: function (v) { return v.length >= 2 || 'Enter the item name.'; },
      category: function (v) { return !!v || 'Choose a category.'; },
      categoryDetail: function (v) { return v.length >= 2 || 'Type the category.'; },
      date: function (v) { return !v ? 'Enter the date.' : (v <= f('date').max || 'Date can\'t be in the future.'); },
      mobile: function (v) { return /^09\d{9}$/.test(v) || 'Use 11 digits starting with 09.'; },
      location: function (v) { return !!v || 'Choose a location.'; },
      locationDetail: function (v) { return v.length >= 2 || 'Type the location.'; },
      description: function (v) { return v.length >= 10 || 'Describe the item (at least 10 characters).'; }
    };
    liveValidate(RULES, f);

    function close() { closeModal(bd); setTimeout(function () { bd.remove(); }, 250); }
    bd.addEventListener('click', function (e) {
      if (e.target === bd || e.target.closest('.modal-close') || e.target.id === 'reCancel') close();
    });

    $('reForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var bad = validate(RULES, f);
      if (bad) { bad.focus(); toast('Fix the highlighted fields.', true); return; }
      var patch = {
        itemName: f('itemName').value.trim(), category: f('category').value,
        categoryDetail: f('category').value === 'Others' ? f('categoryDetail').value.trim() : '',
        date: f('date').value, mobile: f('mobile').value,
        location: f('location').value,
        locationDetail: f('location').value === 'Others' ? f('locationDetail').value.trim() : '',
        description: f('description').value.trim(), photos: photos.get(), photo: photos.get()[0] || null
      };
      // What changed (for history + notification)
      var changed = [], before = reportPhotos(rec);
      if (JSON.stringify(before) !== JSON.stringify(patch.photos)) {
        changed.push(!before.length ? 'added photos' : !patch.photos.length ? 'removed the photos' : 'changed the photos');
      }
      if (['itemName', 'category', 'categoryDetail', 'date', 'mobile', 'location', 'locationDetail', 'description']
            .some(function (k) { return (rec[k] || '') !== (patch[k] || ''); })) changed.push('edited the details');
      if (!changed.length) { close(); toast('No changes to save.'); return; }
      if (rec.review === 'rejected') { patch.review = 'pending'; patch.reviewNote = ''; }

      var saved = updateRecord(rec.kind, rec.id, patch, 'Edited by owner', changed.join(', '));
      if (!saved) { toast(STORAGE_FULL, true); return; }
      var me = currentUser();
      logActivity(me.id, 'Edited ' + rec.kind + ' report #' + rec.caseNo + ' (' + changed.join(', ') + ')');
      notify(displayName(me) + ' ' + changed.join(' and ') + ' on ' + rec.kind + ' report #' + rec.caseNo + ' (' + patch.itemName + ')' +
        (rec.review === 'rejected' ? ' and sent it back for review.' : '.'), rec.caseNo);
      close();
      toast('Report #' + rec.caseNo + ' updated.');
      if (onSaved) onSaved(saved);
    });

    requestAnimationFrame(function () {
      openModal(bd);
      // wait for the fade-in, otherwise the browser ignores focus
      setTimeout(function () { (opts.focusPhoto ? $('rePhotoBtn') : f('itemName')).focus(); }, 120);
    });
  }

  // Report Lost / Found page. kind: 'lost' | 'found'.
  function initReportPage(kind, user) {
    var isLost = kind === 'lost';
    var form = document.getElementById('reportForm');
    function $(id) { return document.getElementById(id); }
    var category = $('category'), catDetail = $('categoryDetail'),
        location = $('location'), locDetail = $('locationDetail'),
        date = $('date'), mobile = $('mobile');
    var submitBtn = form.querySelector('[type="submit"]');
    var submitLabel = submitBtn.textContent;

    fillSelect(category, 'Choose category', CATEGORIES);
    fillSelect(location, isLost ? 'Where did you lose it?' : 'Where did you find it?', LOCATIONS);
    date.max = todayISO();
    digitsOnly(mobile, 11);

    // Prefill mobile from the user's profile
    var profileMobile = user.profile && user.profile.mobile;
    if (profileMobile) mobile.value = profileMobile;

    function toggleDetail(select, detail) {
      var show = select.value === 'Others';
      detail.closest('.field').hidden = !show;
      if (show) detail.focus(); else { detail.value = ''; clearFieldError(detail); }
    }
    category.addEventListener('change', function () { markEmpty(category); toggleDetail(category, catDetail); });
    location.addEventListener('change', function () { markEmpty(location); toggleDetail(location, locDetail); });

    // Up to 4 photos (replaces the single-photo box in REPORT.html / FOUND.html)
    var pickBox = $('photoPreview').closest('.photo-picker');
    var label = pickBox.previousElementSibling;
    if (label && label.classList.contains('field-label')) label.innerHTML = 'Photos <span>(optional, up to 4)</span>';
    pickBox.className = 'mp-box';
    var photos = multiPhotoPicker(pickBox);

    var RULES = {
      itemName:       function (v) { return v.length >= 2 || 'Enter the item name.'; },
      category:       function (v) { return !!v || 'Choose a category.'; },
      categoryDetail: function (v) { return v.length >= 2 || 'Type the category.'; },
      date:           function (v) {
        if (!v) return isLost ? 'Enter the date you lost it.' : 'Enter the date you found it.';
        return v <= date.max || 'Date can\'t be in the future.';
      },
      mobile:         function (v) { return /^09\d{9}$/.test(v) || 'Use 11 digits starting with 09.'; },
      location:       function (v) { return !!v || (isLost ? 'Choose where you lost it.' : 'Choose where you found it.'); },
      locationDetail: function (v) { return v.length >= 2 || 'Type the location.'; },
      description:    function (v) { return v.length >= 10 || 'Describe the item (at least 10 characters).'; }
    };
    liveValidate(RULES, $);

    var sending = false;       // one submit at a time (double taps)
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return;
      var bad = validate(RULES, $);
      if (bad) { bad.focus(); toast('Fix the highlighted fields.', true); return; }

      var data = {
        itemName: $('itemName').value.trim(),
        category: category.value,
        categoryDetail: catDetail.value.trim(),
        location: location.value,
        locationDetail: locDetail.value.trim(),
        date: date.value,
        mobile: mobile.value,
        description: $('description').value.trim(),
        photos: photos.get(),
        photo: photos.get()[0] || null,
        status: isLost ? 'Pending' : 'Available for Claim',
        review: 'pending'      // staff approve + post it before others can see it
      };

      sending = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      setTimeout(function () {
        var rec = addRecord(kind, data);
        if (!rec) {
          sending = false;
          submitBtn.disabled = false;
          submitBtn.textContent = submitLabel;
          toast(lastError || STORAGE_FULL, true); lastError = '';
          return;
        }
        // (stays disabled while the next page opens)

        // Take them to My Reports with the new report open
        setFlash('Submitted as #' + rec.caseNo + '. Staff will review it, then it will be posted in Matching & Search.', 'success');
        window.location.href = 'MONITOR.html?open=' + encodeURIComponent(rec.id);
      }, 400);
    });

    /* Your reports list with delete */
    var list = $('myList');
    function renderMine() {
      var mine = getRecords(kind)
        .filter(function (r) { return r.ownerId === user.id; })
        .sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });

      if (!mine.length) {
        list.innerHTML = '<div class="empty">You have no ' + kind + ' reports yet. Fill in the form above to add one.</div>';
        return;
      }
      list.innerHTML = mine.map(function (r) {
        var reqs = requestsFor(r.caseNo).length;
        return '<article class="item-card">' +
          '<div class="item-title">' + esc(r.itemName) + ' <small>#' + esc(r.caseNo) + '</small></div>' +
          '<div class="item-meta">' + esc(locLabel(r)) + ' • ' + fmtDate(r.date) + ' • ' + esc(catLabel(r)) + '</div>' +
          '<div class="item-status">' + statusPill(r) +
            (reqs ? '<span class="pill pill-blue">' + reqs + (reqs > 1 ? ' requests' : ' request') + '</span>' : '') + '</div>' +
          '<div class="item-actions">' +
            '<a class="btn btn-primary" href="MONITOR.html?open=' + encodeURIComponent(r.id) + '">View</a>' +
            (canEditReport(r) ? '<button type="button" class="btn btn-ghost" data-edit="' + esc(r.id) + '">' + (r.photo ? 'Edit' : 'Add photo / Edit') + '</button>' : '') +
            '<button type="button" class="btn btn-danger-outline" data-del="' + esc(r.id) + '">Delete</button>' +
          '</div></article>';
      }).join('');
    }
    list.addEventListener('click', function (e) {
      var ed = e.target.closest('[data-edit]');
      if (ed) {
        var r0 = getRecords(kind).find(function (r) { return r.id === ed.getAttribute('data-edit'); });
        if (r0) openReportEditor(r0, renderMine);
        return;
      }
      var b = e.target.closest('[data-del]');
      if (!b) return;
      var rec = getRecords(kind).find(function (r) { return r.id === b.getAttribute('data-del'); });
      if (!rec) return;
      confirmDialog({
        title: 'Delete this report?',
        message: '"' + rec.itemName + '" (#' + rec.caseNo + ') will be removed, along with any requests sent for it. This can\'t be undone.',
        confirmText: 'Delete report'
      }).then(function (yes) {
        if (!yes) return;
        deleteRecord(kind, rec.id);
        renderMine();
        toast('Report #' + rec.caseNo + ' deleted.');
      });
    });
    renderMine();
  }

  // Show / hide password buttons (.pw-toggle[data-target]).
  var EYE_OPEN = '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>';

  var EYE_CLOSED = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.4 20.4 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a20.4 20.4 0 0 1-3.22 4.31M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>';

  function eye(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function drawToggles() {
    document.querySelectorAll('.pw-toggle').forEach(function (btn) {
      if (!btn.innerHTML.trim()) btn.innerHTML = eye(btn.getAttribute('aria-pressed') === 'true' ? EYE_CLOSED : EYE_OPEN);
    });
  }
  document.addEventListener('DOMContentLoaded', drawToggles);
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.pw-toggle');
    if (!btn) return;
    var input = document.getElementById(btn.getAttribute('data-target'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = eye(show ? EYE_CLOSED : EYE_OPEN);
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });

  /* ===== 8. SETUP ===== */
  /* Runs on every page load. */

  // Change this number to wipe saved data in every browser once.
  var DATA_VERSION = 3;

  function wipeOldData() {
    if (read('dataVersion', 0) === DATA_VERSION) return;
    try {
      var keys = [];
      for (var i = 0; i < (STORE.length || 0); i++) { var k = STORE.key(i); if (k && k.indexOf(PREFIX) === 0) keys.push(k); }
      keys.forEach(function (k) { STORE.removeItem(k); });
    } catch (e) { /* memory fallback: nothing saved anyway */ }
    write('dataVersion', DATA_VERSION);
  }

  // The admin account is created once on the server (setup.php). No passwords are kept in this file.

  // Favicon.
  function addFavicon() {
    if (document.querySelector('link[rel="icon"]')) return;
    var l = document.createElement('link');
    l.rel = 'icon';
    l.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#fff" stroke="#e04141" stroke-width="4"/><text x="32" y="40" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="20" fill="#e04141">L&amp;F</text></svg>');
    document.head.appendChild(l);
  }

  wipeOldData();

  addFavicon();

  /* ===== 9. PUBLIC API ===== */

  window.LF = {
    // storage
    read: read, write: write, remove: remove, STORAGE_FULL: STORAGE_FULL,
    // users
    getUsers: getUsers, getUser: getUser, findUserByEmail: findUserByEmail,
    createUser: createUser, updateUser: updateUser, deleteUser: deleteUser,
    getPendingUser: getPendingUser, clearPendingUser: clearPendingUser,
    login: login, logout: logout, currentUser: currentUser, requireLogin: requireLogin,
    displayName: displayName, setFlash: setFlash, takeFlash: takeFlash,
    // records
    HOLD_DAYS: HOLD_DAYS, daysSince: daysSince, holdInfo: holdInfo, isMonitored: isMonitored,
    KINDS: KINDS, isRequest: isRequest, isPublic: isPublic, findRecord: findRecord, updateRecord: updateRecord,
    ownerNameOf: ownerNameOf, clearDeclined: clearDeclined, reportOfRequest: reportOfRequest, itemStatusOf: itemStatusOf, showProfile: showProfile, requestPhotosHTML: requestPhotosHTML, requestPhotos: requestPhotos, canEditRequestPhotos: canEditRequestPhotos,
    setRequestPhotos: setRequestPhotos, MAX_REQ_PHOTOS: MAX_REQ_PHOTOS,
    addComment: addComment, removeComment: removeComment, reportCommentsHTML: reportCommentsHTML, commentCount: commentCount,
    apiAsync: apiAsync, messageLink: messageLink, messageBtnHTML: messageBtnHTML, setChatBadge: setChatBadge,
    surrenderInfo: surrenderInfo, surrenderBadgeHTML: surrenderBadgeHTML, surrenderBoxHTML: surrenderBoxHTML,
    markSurrendered: markSurrendered, askSurrender: askSurrender, askEmailCode: askEmailCode, ID_TYPES: ID_TYPES, idTypeLabel: idTypeLabel,
    commentsHTML: commentsHTML, commentFormHTML: commentFormHTML, commenterLabel: commenterLabel,
    resubmitRequest: resubmitRequest, notifyUser: notifyUser, getUserNotes: getUserNotes, markUserNotesRead: markUserNotesRead,
    notifyRequestDecision: notifyRequestDecision, postedAt: postedAt, myNotes: myNotes, isNoteRead: isNoteRead, unreadCount: unreadCount, markNoteRead: markNoteRead,
    markAllMineRead: markAllMineRead, deleteNote: deleteNote, deleteNotes: deleteNotes, clearMyNotes: clearMyNotes, noteLink: noteLink, noteItemHTML: noteItemHTML, notesPreviewHTML: notesPreviewHTML, refreshBell: refreshBell,
    notify: notify, getNotifications: getNotifications, markNotificationsRead: markNotificationsRead,
    ownerEmailOf: ownerEmailOf, contactHTML: contactHTML,
    CONTACT_EMAIL: CONTACT_EMAIL, FOOTER_HTML: FOOTER_HTML, logActivity: logActivity, UNDO_MS: UNDO_MS, changeRecord: changeRecord, undoLeft: undoLeft, undoChange: undoChange,
    getLogo: getLogo, setLogo: setLogo, renderLogo: renderLogo,
    EMAIL: EMAIL, emailReady: emailReady, sendEmail: sendEmail, gmailComposeLink: gmailComposeLink,
    isStrongPassword: isStrongPassword, tempPassword: tempPassword,
    startPasswordReset: startPasswordReset, sendAdminReset: sendAdminReset, cancelAdminReset: cancelAdminReset, activeReset: activeReset, isTempPassword: isTempPassword,
    pwChangeUser: pwChangeUser, googleLogin: googleLogin, googleClientId: googleClientId,
    RESET_MS: RESET_MS, RESET_LABEL: RESET_LABEL, changePassword: changePassword, checkResetCode: checkResetCode, setNewPassword: setNewPassword, CODE_MINUTES: CODE_MINUTES,
    TRASH_MS: TRASH_MS, getTrash: getTrash, markAccountDeleted: markAccountDeleted, sendDeletionEmails: sendDeletionEmails, deleteOwnAccount: deleteOwnAccount,
    deletedArchiveInfo: deletedArchiveInfo, checkArchivePassword: checkArchivePassword, restoreArchive: restoreArchive, ARCHIVE_DAYS: ARCHIVE_DAYS, trashRecord: trashRecord, trashUser: trashUser, restoreTrash: restoreTrash, roleOf: roleOf, isAdmin: isAdmin, statusBlockMessage: statusBlockMessage, timelineHTML: timelineHTML, isStaff: isStaff, homeFor: homeFor,
    statusInfo: statusInfo, statusPill: statusPill, getRecords: getRecords, addRecord: addRecord, deleteRecord: deleteRecord, requestsFor: requestsFor,
    // lists
    CATEGORIES: CATEGORIES, LOCATIONS: LOCATIONS, loadAddress: loadAddress, comboBox: comboBox,
    // helpers
    esc: esc, todayISO: todayISO, fmtDate: fmtDate, fmtTime: fmtTime, maskMobile: maskMobile,
    catLabel: catLabel, locLabel: locLabel, fillSelect: fillSelect, markEmpty: markEmpty, digitsOnly: digitsOnly,
    photoPlaceholder: photoPlaceholder, readPhoto: readPhoto, photoPicker: photoPicker,
    drawToggles: drawToggles, reportPhotos: reportPhotos, multiPhotoPicker: multiPhotoPicker, photoGalleryHTML: photoGalleryHTML, openPhotoViewer: openViewer,
    setFieldError: setFieldError, clearFieldError: clearFieldError, validate: validate, liveValidate: liveValidate,
    // ui
    toast: toast, openModal: openModal, closeModal: closeModal, confirm: confirmDialog,
    mountShell: mountShell, refreshShellUser: refreshShellUser,
    profileForm: profileForm, initReportPage: initReportPage, openReportEditor: openReportEditor, canEditReport: canEditReport
  };
  window.LF.VERSION = '6';   // must match the ?v=6 on the <script> tags in every page
  // Error text for failed saves: the server's reason when there is one.
  Object.defineProperty(window.LF, 'STORAGE_FULL', { get: function () { var m = lastError || STORAGE_FULL; lastError = ''; return m; } });
})(window, document);
