const express = require('express');
const { requireAdmin } = require('./middleware');
const router = express.Router();

module.exports = function(db, io) {

  // All admin routes require admin JWT
  router.use(requireAdmin);

  // GET /api/admin/kingdoms — all kingdoms with player info
  router.get('/kingdoms', async (_req, res) => {
    const rows = await db.all(`
      SELECT k.id, k.name, k.race, k.land, k.gold, k.turn, k.turns_stored,
             k.fighters, k.mages, k.created_at,
             p.username, p.is_banned, p.ban_reason, p.is_admin, p.id AS player_id
      FROM kingdoms k JOIN players p ON k.player_id = p.id
      ORDER BY k.land DESC
    `);
    res.json(rows);
  });

  // GET /api/admin/stats — server overview
  router.get('/stats', async (_req, res) => {
    const playerCount   = await db.get('SELECT COUNT(*) as c FROM players');
    const kingdomCount  = await db.get('SELECT COUNT(*) as c FROM kingdoms');
    const bannedCount   = await db.get('SELECT COUNT(*) as c FROM players WHERE is_banned = 1');
    const combatCount   = await db.get('SELECT COUNT(*) as c FROM combat_log');
    const chatCount     = await db.get('SELECT COUNT(*) as c FROM chat_messages');
    const lastRegen     = await db.get("SELECT value FROM server_state WHERE key = 'last_regen_at'");
    res.json({
      players:    playerCount.c,
      kingdoms:   kingdomCount.c,
      banned:     bannedCount.c,
      combats:    combatCount.c,
      messages:   chatCount.c,
      lastRegen:  lastRegen ? Number(lastRegen.value) : null,
    });
  });

  // POST /api/admin/ban — ban a player
  router.post('/ban', async (req, res) => {
    const { playerId, reason } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });
    await db.run(
      'UPDATE players SET is_banned = 1, ban_reason = ? WHERE id = ?',
      [reason || 'Banned by admin', playerId]
    );
    res.json({ ok: true });
  });

  // POST /api/admin/unban — unban a player
  router.post('/unban', async (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });
    await db.run(
      'UPDATE players SET is_banned = 0, ban_reason = NULL WHERE id = ?', [playerId]
    );
    res.json({ ok: true });
  });

  // POST /api/admin/reset-turns — reset a kingdom's turns to 200
  router.post('/reset-turns', async (req, res) => {
    const { kingdomId } = req.body;
    if (!kingdomId) return res.status(400).json({ error: 'kingdomId required' });
    await db.run(
      'UPDATE kingdoms SET turns_stored = 200 WHERE id = ?', [kingdomId]
    );
    res.json({ ok: true });
  });

  // POST /api/admin/reset-turns-all — give all kingdoms full turns
  router.post('/reset-turns-all', async (_req, res) => {
    await db.run('UPDATE kingdoms SET turns_stored = 200');
    res.json({ ok: true });
  });

  // POST /api/admin/set-gold — set a kingdom's gold
  router.post('/set-gold', async (req, res) => {
    const { kingdomId, amount } = req.body;
    if (!kingdomId || amount === undefined) return res.status(400).json({ error: 'kingdomId and amount required' });
    await db.run('UPDATE kingdoms SET gold = ? WHERE id = ?', [Number(amount), kingdomId]);
    res.json({ ok: true });
  });

  // POST /api/admin/promote — make a player admin
  router.post('/promote', async (req, res) => {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });
    await db.run('UPDATE players SET is_admin = 1 WHERE id = ?', [playerId]);
    res.json({ ok: true });
  });

  // POST /api/admin/announce — broadcast a global message via Socket.io
  router.post('/announce', async (req, res) => {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    io.to('global').emit('chat:message', {
      room: 'global',
      from: '[ADMIN]',
      race: 'admin',
      message: message.trim(),
      ts: Date.now(),
    });
    res.json({ ok: true });
  });

  // DELETE /api/admin/kingdom/:id — delete a kingdom (soft — just wipes stats)
  router.delete('/kingdom/:id', async (req, res) => {
    await db.run('DELETE FROM kingdoms WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  return router;
};
