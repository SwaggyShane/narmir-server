// src/routes/kingdom.js
const express = require('express');
const engine  = require('../game/engine');
const { requireAuth } = require('./middleware');

const router = express.Router();

module.exports = function(db) {

  router.get('/me', requireAuth, async (req, res) => {
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    res.json(k);
  });

  router.get('/rankings', requireAuth, async (_req, res) => {
    const rows = await db.all(`
      SELECT k.id, k.name, k.race, k.land, k.turn, p.username
      FROM kingdoms k JOIN players p ON k.player_id = p.id
      ORDER BY k.land DESC LIMIT 50
    `);
    res.json(rows.map((r, i) => ({ ...r, rank: i + 1 })));
  });

  router.get('/news/list', requireAuth, async (req, res) => {
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const items = await db.all(
      'SELECT * FROM news WHERE kingdom_id = ? ORDER BY created_at DESC LIMIT 50', [k.id]
    );
    await db.run('UPDATE news SET is_read = 1 WHERE kingdom_id = ?', [k.id]);
    res.json(items);
  });

  router.post('/turn', requireAuth, async (req, res) => {
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });

    const cooldown = process.env.NODE_ENV === 'production' ? 60 : 0;
    const elapsed  = Math.floor(Date.now() / 1000) - k.last_turn_at;
    if (elapsed < cooldown)
      return res.status(429).json({ error: `Turn cooldown: ${cooldown - elapsed}s remaining` });

    const { updates, events } = engine.processTurn(k);
    await applyUpdates(db, k.id, updates);
    for (const ev of events)
      await db.run('INSERT INTO news (kingdom_id, type, message) VALUES (?, ?, ?)', [k.id, ev.type || 'system', ev.message]);

    res.json({ ok: true, updates, events });
  });

  router.post('/hire', requireAuth, async (req, res) => {
    const { unit, amount } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const result = engine.hireUnits(k, unit, Number(amount));
    if (result.error) return res.status(400).json({ error: result.error });
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, updates: result.updates });
  });

  router.post('/research', requireAuth, async (req, res) => {
    const { discipline, researchers } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const result = engine.studyDiscipline(k, discipline, Number(researchers));
    if (result.error) return res.status(400).json({ error: result.error });
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, increment: result.increment, updates: result.updates });
  });

  router.post('/build', requireAuth, async (req, res) => {
    const { building, quantity } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const result = engine.buildStructure(k, building, Number(quantity));
    if (result.error) return res.status(400).json({ error: result.error });
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, piecesUsed: result.piecesUsed, updates: result.updates });
  });

  router.post('/options', requireAuth, async (req, res) => {
    const { tax, name } = req.body;
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const updates = { updated_at: Math.floor(Date.now() / 1000) };
    if (tax !== undefined) {
      const t = Number(tax);
      if (t < 0 || t > 100) return res.status(400).json({ error: 'Tax must be 0–100' });
      updates.tax = t;
    }
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.name = name.trim();
    }
    await applyUpdates(db, k.id, updates);
    res.json({ ok: true, updates });
  });

  return router;
};

async function applyUpdates(db, kingdomId, updates) {
  if (!updates || Object.keys(updates).length === 0) return;
  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(updates), kingdomId];
  await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, vals);
}
