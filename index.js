const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cookieParser = require('cookie-parser');
const path         = require('path');

const { initDb }      = require('./db/schema');
const setupSockets    = require('./game/sockets');
const { requireAuth } = require('./routes/middleware');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', credentials: true } });

const PORT = process.env.PORT || 3000;

// ── Rate limiting ──────────────────────────────────────────────────────────────
function makeRateLimiter(maxRequests, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs);
  return function(req, res, next) {
    const key = req.ip || 'unknown';
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    if (count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}

const authLimiter   = makeRateLimiter(10, 60 * 1000);      // 10 auth attempts/min
const turnLimiter   = makeRateLimiter(300, 60 * 1000);     // 300 turn/action requests/min (5/sec)
const generalLimiter= makeRateLimiter(500, 60 * 1000);     // 500 general requests/min

app.use(express.json());
app.use(cookieParser());
app.use(generalLimiter);
app.use(express.static(path.join(__dirname, 'public')));

// ── Turn regen constants ───────────────────────────────────────────────────────
const REGEN_AMOUNT = 5;
const REGEN_MAX    = 200;
const REGEN_MS     = 15 * 60 * 1000;

async function runRegen(db) {
  await db.run(`
    UPDATE kingdoms
    SET turns_stored = MIN(?, turns_stored + ?)
    WHERE turns_stored < ?
  `, [REGEN_MAX, REGEN_AMOUNT, REGEN_MAX]);
  await db.run(
    "UPDATE server_state SET value = CAST(unixepoch() AS TEXT) WHERE key = 'last_regen_at'"
  );
  console.log('[turns] Regen complete — +' + REGEN_AMOUNT + ' turns to all kingdoms');
}

async function start() {
  const db = await initDb();
  console.log('[db] SQLite initialised');

  // ── Crash-safe regen on boot ─────────────────────────────────────────────────
  // Calculate how many 15-min windows passed since last regen and apply them now
  const regenRow = await db.get("SELECT value FROM server_state WHERE key = 'last_regen_at'");
  if (regenRow) {
    const lastRegen = Number(regenRow.value);
    const now       = Math.floor(Date.now() / 1000);
    const elapsed   = now - lastRegen;
    const windows   = Math.floor(elapsed / (REGEN_MS / 1000));
    if (windows > 0) {
      const catchUp = Math.min(windows * REGEN_AMOUNT, REGEN_MAX);
      await db.run(`
        UPDATE kingdoms SET turns_stored = MIN(?, turns_stored + ?)
      `, [REGEN_MAX, catchUp]);
      await db.run(
        "UPDATE server_state SET value = CAST(unixepoch() AS TEXT) WHERE key = 'last_regen_at'"
      );
      console.log('[turns] Boot catch-up: applied ' + windows + ' missed window(s), +'  + catchUp + ' turns');
    }
  }

  // Schedule ongoing regen
  setInterval(() => runRegen(db), REGEN_MS);
  console.log('[turns] Regen timer started — +' + REGEN_AMOUNT + ' every 15 min (max ' + REGEN_MAX + ')');

  // ── Routes ────────────────────────────────────────────────────────────────────
  app.use('/api/auth',    authLimiter,  require('./routes/auth')(db));
  app.use('/api/kingdom', turnLimiter,  require('./routes/kingdom')(db));
  app.use('/api/admin',                 require('./routes/admin')(db, io));

  app.post('/api/alliance/create', requireAuth, async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Alliance name required' });
    const kingdom = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!kingdom) return res.status(404).json({ error: 'Kingdom not found' });
    await db.run('DELETE FROM alliance_members WHERE kingdom_id = ?', [kingdom.id]);
    try {
      const result = await db.run('INSERT INTO alliances (name, leader_id) VALUES (?, ?)', [name.trim(), kingdom.id]);
      await db.run('INSERT INTO alliance_members (alliance_id, kingdom_id, pledge) VALUES (?, ?, 3)', [result.lastID, kingdom.id]);
      res.json({ ok: true, allianceId: result.lastID });
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Alliance name taken' });
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/alliance/invite', requireAuth, async (req, res) => {
    const kingdom = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    const membership = await db.get('SELECT * FROM alliance_members WHERE kingdom_id = ?', [kingdom.id]);
    if (!membership) return res.status(400).json({ error: 'You are not in an alliance' });
    const alliance = await db.get('SELECT * FROM alliances WHERE id = ?', [membership.alliance_id]);
    if (alliance.leader_id !== kingdom.id) return res.status(403).json({ error: 'Only the leader can invite' });
    try {
      await db.run('INSERT INTO alliance_members (alliance_id, kingdom_id) VALUES (?, ?)', [membership.alliance_id, req.body.targetKingdomId]);
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Already a member' });
    }
  });

  app.post('/api/alliance/leave', requireAuth, async (req, res) => {
    const kingdom = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    await db.run('DELETE FROM alliance_members WHERE kingdom_id = ?', [kingdom.id]);
    res.json({ ok: true });
  });

  app.get('/api/alliance/:id', requireAuth, async (req, res) => {
    const alliance = await db.get('SELECT * FROM alliances WHERE id = ?', [req.params.id]);
    if (!alliance) return res.status(404).json({ error: 'Not found' });
    const members = await db.all(`
      SELECT k.id, k.name, k.race, k.land, am.pledge
      FROM kingdoms k JOIN alliance_members am ON k.id = am.kingdom_id
      WHERE am.alliance_id = ?`, [req.params.id]);
    res.json({ ...alliance, members });
  });

  app.get('/api/chat/:room', requireAuth, async (req, res) => {
    const msgs = await db.all(`
      SELECT cm.message, cm.created_at, k.name AS kingdom_name, k.race
      FROM chat_messages cm JOIN kingdoms k ON cm.kingdom_id = k.id
      WHERE cm.room = ? ORDER BY cm.created_at DESC LIMIT 50`, [req.params.room]);
    res.json(msgs.reverse());
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

  // ── One-time admin promotion ───────────────────────────────────────────────
  // POST /api/setup-admin  body: { secret, username }
  // Set ADMIN_SECRET in Render environment variables before using.
  // Once you have an admin account this route still works but is harmless
  // since it requires the secret to do anything.
  app.post('/api/setup-admin', async (req, res) => {
    const { secret, username } = req.body;
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret) return res.status(500).json({ error: 'ADMIN_SECRET not set on server' });
    if (!secret || secret !== adminSecret) return res.status(403).json({ error: 'Invalid secret' });
    if (!username) return res.status(400).json({ error: 'username required' });
    const player = await db.get('SELECT id, username FROM players WHERE username = ?', [username]);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    await db.run('UPDATE players SET is_admin = 1 WHERE id = ?', [player.id]);
    res.json({ ok: true, message: username + ' is now an admin. Log out and back in to get the admin token.' });
  });

  // Admin panel HTML served at /admin
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  setupSockets(io, db);
  console.log('[socket.io] Real-time handlers registered');

  server.listen(PORT, () => {
    console.log('Narmir running on port ' + PORT);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
