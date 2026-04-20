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

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

async function start() {
  const db = await initDb();
  console.log('[db] SQLite initialised');

  app.use('/api/auth',    require('./routes/auth')(db));
  app.use('/api/kingdom', require('./routes/kingdom')(db));

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

  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  setupSockets(io, db);
  console.log('[socket.io] Real-time handlers registered');

  server.listen(PORT, () => {
    console.log(`Narmir running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
