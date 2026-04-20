// public/client.js
// Narmir frontend ↔ server connector.
// Paste a <script src="/client.js"></script> tag into narmir-dashboard.html
// (just before the closing </body>) once the server is running.
//
// This file bridges the existing frontend UI to the real server:
//   - Authenticates via JWT stored in cookie
//   - Replaces mock state with live API data on load
//   - Wires attack / spell / covert buttons to Socket.io events
//   - Receives real-time push events and updates the UI

(function () {
  const API = '';  // same origin — change to 'http://localhost:3000' if serving separately

  // ── Utilities ───────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  async function bootstrap() {
    // Check if already logged in
    const me = await api('GET', '/api/auth/me');
    if (me.error) {
      showLoginModal();
      return;
    }

    // Load kingdom state from server
    const kingdom = await api('GET', '/api/kingdom/me');
    if (kingdom.error) { showLoginModal(); return; }

    // Hydrate the frontend state object with real data
    Object.assign(window.state, {
      gold:       kingdom.gold,
      pop:        kingdom.population,
      land:       kingdom.land,
      morale:     kingdom.morale,
      tax:        kingdom.tax,
      turn:       kingdom.turn,
      mana:       kingdom.mana,
      fighters:   kingdom.fighters,
      rangers:    kingdom.rangers,
      clerics:    kingdom.clerics,
      mages:      kingdom.mages,
      thieves:    kingdom.thieves,
      ninjas:     kingdom.ninjas,
      researchers:kingdom.researchers,
      engineers:  kingdom.engineers,
      kingdomId:  kingdom.id,
      kingdomName:kingdom.name,
    });

    // Update all visible UI elements
    window.syncUI();
    document.getElementById('kingdom-name').textContent = kingdom.name;
    document.getElementById('turn-num').textContent = kingdom.turn;

    // Load rankings as target list
    loadRankings();

    // Connect Socket.io
    connectSocket(me);
  }

  // ── Socket.io ────────────────────────────────────────────────────────────────
  let socket;

  function connectSocket(player) {
    // socket.io client script must be loaded from the server
    if (typeof io === 'undefined') {
      const s = document.createElement('script');
      s.src = API + '/socket.io/socket.io.js';
      s.onload = () => initSocket(player);
      document.head.appendChild(s);
    } else {
      initSocket(player);
    }
  }

  function initSocket(player) {
    socket = io(API, { withCredentials: true });

    socket.on('connect', () => {
      console.log('[socket] connected as', player.username);
    });

    // Real-time attack notification
    socket.on('event:attack_received', (data) => {
      window.toast(`⚔ ATTACK! ${data.message}`, 'error');
      addNewsItem('attack', data.message);
      showBattleNotification(data);
    });

    // Spell hit
    socket.on('event:spell_received', (data) => {
      window.toast(`✨ Spell! ${data.message}`, 'warn');
      addNewsItem('spell', data.message);
    });

    // Covert op
    socket.on('event:covert', (data) => {
      window.toast(`🕵 Covert! ${data.message}`, 'warn');
      addNewsItem('covert', data.message);
    });

    // Alliance flare
    socket.on('event:alliance_flare', (data) => {
      window.toast(`🚨 ${data.message}`, 'warn');
      addNewsItem('alliance', data.message);
    });

    // Unread news count
    socket.on('unread_news', (data) => {
      if (data.count > 0) {
        const badge = document.getElementById('news-badge') || document.getElementById('bnav-news-badge');
        if (badge) badge.textContent = data.count;
      }
    });

    // Global chat messages
    socket.on('chat:message', (data) => {
      if (data.room === 'global') appendChatMessage(data);
      if (data.room === 'alliance') appendAllianceChatMessage(data);
    });

    socket.on('disconnect', () => console.log('[socket] disconnected'));
  }

  // ── Override frontend actions to hit the real server ────────────────────────

  // Override takeTurn
  window._takeTurn_original = window.takeTurn;
  window.takeTurn = async function () {
    const result = await api('POST', '/api/kingdom/turn');
    if (result.error) return window.toast(result.error, 'error');
    Object.assign(window.state, result.updates);
    window.syncUI();
    document.getElementById('turn-num').textContent = window.state.turn;
    window.toast(`Turn ${window.state.turn} complete`, 'success');
    if (result.events?.length) {
      result.events.forEach(ev => addNewsItem(ev.type, ev.message));
    }
  };

  // Override hire
  window._hire_original = window.hire;
  window.hire = async function (unit) {
    const n = parseInt(document.getElementById('hire-' + unit)?.value) || 0;
    if (n <= 0) return window.toast('Enter an amount', 'error');
    const result = await api('POST', '/api/kingdom/hire', { unit, amount: n });
    if (result.error) return window.toast(result.error, 'error');
    Object.assign(window.state, result.updates);
    window.syncUI();
    document.getElementById('hire-' + unit).value = 0;
    document.getElementById('h-' + unit).textContent = window.fmt(window.state[unit]);
    window.toast(`Hired ${window.fmt(n)} ${unit}`, 'success');
  };

  // Override study
  window._study_original = window.study;
  window.study = async function (name) {
    const idMap = { Economy:'r-eco', Weapons:'r-wep', Armor:'r-arm', 'Military tactics':'r-mil', Spellbook:'r-spell', 'Attack magic':'r-atk', 'Defense magic':'r-def', Entertainment:'r-ent', 'Construction skills':'r-con', 'War machines':'r-wm' };
    const disciplineMap = { Economy:'economy', Weapons:'weapons', Armor:'armor', 'Military tactics':'military', Spellbook:'spellbook', 'Attack magic':'attack_magic', 'Defense magic':'defense_magic', Entertainment:'entertainment', 'Construction skills':'construction', 'War machines':'war_machines' };
    const n = parseInt(document.getElementById(idMap[name])?.value) || 0;
    if (n <= 0) return window.toast('Enter a number of researchers', 'error');
    const result = await api('POST', '/api/kingdom/research', { discipline: disciplineMap[name], researchers: n });
    if (result.error) return window.toast(result.error, 'error');
    window.toast(`+${result.increment} to ${name} this turn`, 'success');
  };

  // Override attack
  window._launchAttack_original = window.launchAttack;
  window.launchAttack = async function () {
    if (!window.selectedTarget) return window.toast('Select a target first', 'error');
    const fighters = parseInt(document.getElementById('atk-fighters')?.value) || 0;
    const mages    = parseInt(document.getElementById('atk-mages')?.value)    || 0;
    if (!socket) return window.toast('Not connected to server', 'error');

    socket.emit('action:attack', {
      targetId: window.selectedTarget.id,
      fighters, mages,
    }, (response) => {
      if (response.error) return window.toast(response.error, 'error');
      const r = response.report;
      window.state.fighters -= r.atkFightersLost;
      window.state.mages    -= r.atkMagesLost;
      if (r.win) window.state.land += r.landTransferred;
      window.syncUI();
      window.showBattleReport({
        type: 'Military attack',
        target: window.selectedTarget.name,
        win: r.win,
        rows: [
          ['Fighters sent', window.fmt(fighters)],
          ['Mages sent', window.fmt(mages)],
          ['Fighters lost', window.fmt(r.atkFightersLost)],
          ['Mages lost', window.fmt(r.atkMagesLost)],
          ['Land ' + (r.win ? 'captured' : 'lost'), r.win ? '+' + window.fmt(r.landTransferred) + ' acres' : '0'],
        ],
      });
    });
  };

  // Override castSpell
  window._castSpell_original = window.castSpell;
  window.castSpell = async function () {
    if (!window.selectedSpell) return window.toast('Select a spell first', 'error');
    const targetName = document.getElementById('cast-target-name')?.textContent;
    if (!targetName || targetName.includes('none')) return window.toast('Select a target first', 'error');
    if (!socket) return window.toast('Not connected to server', 'error');

    const power    = parseInt(document.getElementById('sl-power')?.value)    || 1000;
    const duration = parseInt(document.getElementById('sl-duration')?.value) || 1;
    const obscure  = parseInt(document.getElementById('sl-obscure')?.value)  === 1;
    const total    = power + (obscure ? Math.floor(power * 0.5) : 0);

    const target = window.targets?.find(t => t.name === targetName);
    if (!target) return window.toast('Target not found in list', 'error');

    socket.emit('action:spell', {
      targetId: target.id,
      spellId: window.selectedSpell.id,
      power, duration, obscure,
    }, (response) => {
      if (response.error) return window.toast(response.error, 'error');
      window.state.mana -= total;
      window.syncUI();
      document.getElementById('spell-mana-disp').textContent = window.fmt(window.state.mana);
      window.toast(`${window.selectedSpell.name} cast — ${window.fmt(total)} mana used`, 'success');
    });
  };

  // ── Rankings as target list ──────────────────────────────────────────────────
  async function loadRankings() {
    const rankings = await api('GET', '/api/kingdom/rankings');
    if (rankings.error || !Array.isArray(rankings)) return;

    // Remap to the shape the frontend target list expects
    window.targets = rankings
      .filter(r => r.id !== window.state.kingdomId)
      .map(r => ({
        id:       r.id,
        name:     r.name,
        race:     r.race,
        rank:     r.rank,
        land:     r.land,
        fighters: 0,   // not exposed publicly — spy to find out
        mages:    0,
        status:   'unknown',
      }));

    if (typeof window.renderTargets === 'function') {
      window.renderTargets(window.targets, 'target-list',       'selectTarget');
      window.renderTargets(window.targets, 'covert-target-list','selectCovertTarget');
    }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────
  function addNewsItem(type, message) {
    const container = document.querySelector('#news .card');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'news-item';
    const typeClass = { attack:'news-attack', spell:'news-magic', alliance:'news-hl' }[type] || 'news-hl';
    el.innerHTML = `<span class="time">Just now</span><span class="${typeClass}">${message}</span>`;
    container.insertBefore(el, container.firstChild.nextSibling);

    // Badge
    ['news-badge','bnav-news-badge'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.textContent = (parseInt(b.textContent) || 0) + 1;
    });
  }

  function showBattleNotification(data) {
    // Flashes a red border on the topbar briefly
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    topbar.style.borderBottom = '2px solid var(--red)';
    setTimeout(() => topbar.style.borderBottom = '', 3000);
  }

  function appendChatMessage(data) {
    // Hook into a global chat panel if it exists in future
    console.log(`[chat:global] ${data.from}: ${data.message}`);
  }

  function appendAllianceChatMessage(data) {
    const el = document.getElementById('alliance-chat');
    if (!el) return;
    const div = document.createElement('div');
    div.style.fontSize = '13px';
    div.innerHTML = `<span style="color:var(--purple);font-weight:600">${data.from}</span>: <span style="color:var(--text2)">${data.message}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ── Login modal ──────────────────────────────────────────────────────────────
  function showLoginModal() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(13,14,20,.97);z-index:500;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius-lg);padding:28px 32px;width:90%;max-width:360px;">
        <div style="font-size:22px;font-weight:700;color:var(--gold);margin-bottom:4px">NARMIR</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:22px">Land of Magic and Conquest</div>
        <div id="auth-error" style="font-size:13px;color:var(--red);margin-bottom:12px;min-height:18px"></div>
        <input id="auth-user" type="text" placeholder="Username" style="width:100%;margin-bottom:10px;text-align:left;padding:10px 12px;font-size:16px">
        <input id="auth-pass" type="password" placeholder="Password" style="width:100%;margin-bottom:10px;text-align:left;padding:10px 12px;font-size:16px">
        <input id="auth-kingdom" type="text" placeholder="Kingdom name (new players only)" style="width:100%;margin-bottom:18px;text-align:left;padding:10px 12px;font-size:16px">
        <div style="display:flex;gap:10px">
          <button id="btn-login" class="btn btn-purple" style="flex:1;padding:10px;font-size:14px">Login</button>
          <button id="btn-register" class="btn btn-gold" style="flex:1;padding:10px;font-size:14px">Register</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    async function attempt(endpoint) {
      const username    = document.getElementById('auth-user').value.trim();
      const password    = document.getElementById('auth-pass').value;
      const kingdomName = document.getElementById('auth-kingdom').value.trim();
      const errEl       = document.getElementById('auth-error');
      if (!username || !password) { errEl.textContent = 'Username and password required'; return; }

      const body = endpoint === '/api/auth/register'
        ? { username, password, kingdomName: kingdomName || username + "'s Kingdom" }
        : { username, password };

      const result = await api('POST', endpoint, body);
      if (result.error) { errEl.textContent = result.error; return; }

      overlay.remove();
      bootstrap();
    }

    document.getElementById('btn-login').onclick    = () => attempt('/api/auth/login');
    document.getElementById('btn-register').onclick = () => attempt('/api/auth/register');
    document.getElementById('auth-pass').addEventListener('keydown', e => {
      if (e.key === 'Enter') attempt('/api/auth/login');
    });
  }

  // ── Kick off ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

})();
