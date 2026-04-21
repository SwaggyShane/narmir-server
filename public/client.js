// public/client.js — Narmir frontend ↔ server connector

const API = '';

async function api(method, path, body) {
  try {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  } catch (err) {
    console.error('[api] fetch error:', method, path, err);
    return { error: err.message };
  }
}

async function bootstrap() {
  console.log('[narmir] bootstrap starting...');
  try {
    const me = await api('GET', '/api/auth/me');
    console.log('[narmir] auth/me:', me);
    if (me.error) {
      showLoginModal();
      return;
    }
    const kingdom = await api('GET', '/api/kingdom/me');
    console.log('[narmir] kingdom:', kingdom);
    if (kingdom.error) { showLoginModal(); return; }

    Object.assign(window.state, {
      gold:        kingdom.gold,
      pop:         kingdom.population,
      land:        kingdom.land,
      morale:      kingdom.morale,
      tax:         kingdom.tax,
      turn:        kingdom.turn,
      mana:        kingdom.mana,
      fighters:    kingdom.fighters,
      rangers:     kingdom.rangers,
      clerics:     kingdom.clerics,
      mages:       kingdom.mages,
      thieves:     kingdom.thieves,
      ninjas:      kingdom.ninjas,
      researchers: kingdom.researchers,
      engineers:   kingdom.engineers,
      kingdomId:   kingdom.id,
      kingdomName: kingdom.name,
    });

    window.syncUI();
    document.getElementById('kingdom-name').textContent = kingdom.name;
    document.getElementById('turn-num').textContent = kingdom.turn;

    loadRankings();
    connectSocket(me);
  } catch (err) {
    console.error('[narmir] bootstrap error:', err);
    showLoginModal();
  }
}

function showLoginModal() {
  console.log('[narmir] showing login modal');
  const existing = document.getElementById('login-overlay');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = 'login-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(13,14,20,.97);z-index:9999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#13141d;border:1px solid #363a52;border-radius:12px;padding:28px 32px;width:90%;max-width:360px;">
      <div style="font-size:22px;font-weight:700;color:#e8b84b;margin-bottom:4px">NARMIR</div>
      <div style="font-size:13px;color:#9a9bb5;margin-bottom:22px">Land of Magic and Conquest</div>
      <div id="auth-error" style="font-size:13px;color:#e05c5c;margin-bottom:12px;min-height:18px"></div>
      <input id="auth-user" type="text" placeholder="Username" style="width:100%;margin-bottom:10px;padding:10px 12px;font-size:16px;background:#1a1c27;border:1px solid #363a52;border-radius:8px;color:#e8e9f0;box-sizing:border-box;">
      <input id="auth-pass" type="password" placeholder="Password" style="width:100%;margin-bottom:10px;padding:10px 12px;font-size:16px;background:#1a1c27;border:1px solid #363a52;border-radius:8px;color:#e8e9f0;box-sizing:border-box;">
      <input id="auth-kingdom" type="text" placeholder="Kingdom name (new players only)" style="width:100%;margin-bottom:18px;padding:10px 12px;font-size:16px;background:#1a1c27;border:1px solid #363a52;border-radius:8px;color:#e8e9f0;box-sizing:border-box;">
      <div style="display:flex;gap:10px">
        <button id="btn-login" style="flex:1;padding:10px;font-size:14px;font-weight:600;background:#7c6af5;border:none;border-radius:8px;color:#fff;cursor:pointer;">Login</button>
        <button id="btn-register" style="flex:1;padding:10px;font-size:14px;font-weight:600;background:#c49535;border:none;border-radius:8px;color:#0d0e14;cursor:pointer;">Register</button>
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
    console.log('[narmir] auth result:', result);
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

let socket;

function connectSocket(player) {
  const s = document.createElement('script');
  s.src = '/socket.io/socket.io.js';
  s.onload = () => initSocket(player);
  s.onerror = () => console.warn('[narmir] socket.io script failed to load');
  document.head.appendChild(s);
}

function initSocket(player) {
  try {
    socket = io('', { withCredentials: true });
    socket.on('connect', () => console.log('[socket] connected as', player.username));
    socket.on('event:attack_received', (data) => {
      window.toast && window.toast('ATTACK! ' + data.message, 'error');
      addNewsItem('attack', data.message);
    });
    socket.on('event:spell_received', (data) => {
      window.toast && window.toast('Spell! ' + data.message, 'warn');
      addNewsItem('spell', data.message);
    });
    socket.on('event:covert', (data) => {
      window.toast && window.toast('Covert! ' + data.message, 'warn');
      addNewsItem('covert', data.message);
    });
    socket.on('unread_news', (data) => {
      if (data.count > 0) {
        ['news-badge','bnav-news-badge'].forEach(id => {
          const b = document.getElementById(id);
          if (b) b.textContent = data.count;
        });
      }
    });
    socket.on('chat:message', (data) => {
      if (data.room === 'alliance') appendAllianceChatMessage(data);
    });
    socket.on('disconnect', () => console.log('[socket] disconnected'));
  } catch (err) {
    console.warn('[narmir] socket init failed:', err);
  }
}

window.takeTurn = async function () {
  const result = await api('POST', '/api/kingdom/turn');
  if (result.error) return window.toast && window.toast(result.error, 'error');
  Object.assign(window.state, result.updates);
  window.syncUI && window.syncUI();
  document.getElementById('turn-num').textContent = window.state.turn;
  window.toast && window.toast('Turn ' + window.state.turn + ' complete', 'success');
};

window.hire = async function (unit) {
  const n = parseInt(document.getElementById('hire-' + unit)?.value) || 0;
  if (n <= 0) return window.toast && window.toast('Enter an amount', 'error');
  const result = await api('POST', '/api/kingdom/hire', { unit, amount: n });
  if (result.error) return window.toast && window.toast(result.error, 'error');
  Object.assign(window.state, result.updates);
  window.syncUI && window.syncUI();
  document.getElementById('hire-' + unit).value = 0;
  const hEl = document.getElementById('h-' + unit);
  if (hEl) hEl.textContent = window.fmt(window.state[unit]);
  window.toast && window.toast('Hired ' + window.fmt(n) + ' ' + unit, 'success');
};

window.launchAttack = async function () {
  if (!window.selectedTarget) return window.toast && window.toast('Select a target first', 'error');
  if (!socket) return window.toast && window.toast('Not connected to server', 'error');
  const fighters = parseInt(document.getElementById('atk-fighters')?.value) || 0;
  const mages    = parseInt(document.getElementById('atk-mages')?.value)    || 0;
  socket.emit('action:attack', { targetId: window.selectedTarget.id, fighters, mages }, (response) => {
    if (response.error) return window.toast && window.toast(response.error, 'error');
    const r = response.report;
    window.state.fighters -= r.atkFightersLost;
    window.state.mages    -= r.atkMagesLost;
    if (r.win) window.state.land += r.landTransferred;
    window.syncUI && window.syncUI();
    window.showBattleReport && window.showBattleReport({
      type: 'Military attack', target: window.selectedTarget.name, win: r.win,
      rows: [
        ['Fighters sent', window.fmt(fighters)],
        ['Mages sent', window.fmt(mages)],
        ['Fighters lost', window.fmt(r.atkFightersLost)],
        ['Land ' + (r.win ? 'captured' : 'lost'), r.win ? '+' + window.fmt(r.landTransferred) + ' acres' : '0'],
      ],
    });
  });
};

async function loadRankings() {
  const rankings = await api('GET', '/api/kingdom/rankings');
  if (!Array.isArray(rankings)) return;
  window.targets = rankings
    .filter(r => r.id !== window.state?.kingdomId)
    .map(r => ({ id: r.id, name: r.name, race: r.race, rank: r.rank, land: r.land, fighters: 0, mages: 0, status: 'unknown' }));
  if (typeof window.renderTargets === 'function') {
    window.renderTargets(window.targets, 'target-list', 'selectTarget');
    window.renderTargets(window.targets, 'covert-target-list', 'selectCovertTarget');
  }
}

function addNewsItem(type, message) {
  const container = document.querySelector('#news .card');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'news-item';
  const cls = { attack:'news-attack', spell:'news-magic', alliance:'news-hl' }[type] || 'news-hl';
  el.innerHTML = '<span class="time">Just now</span><span class="' + cls + '">' + message + '</span>';
  container.insertBefore(el, container.children[1]);
}

function appendAllianceChatMessage(data) {
  const el = document.getElementById('alliance-chat');
  if (!el) return;
  const div = document.createElement('div');
  div.style.fontSize = '13px';
  div.innerHTML = '<span style="color:var(--purple);font-weight:600">' + data.from + '</span>: <span style="color:var(--text2)">' + data.message + '</span>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

console.log('[narmir] client.js loaded, readyState:', document.readyState);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
