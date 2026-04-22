const express = require('express');
const engine  = require('../game/engine');
const { requireAuth } = require('./middleware');

const router = express.Router();

module.exports = function(db) {

  router.get('/me', requireAuth, async (req, res) => {
    const k = await db.get(
      'SELECT k.*, p.username FROM kingdoms k JOIN players p ON k.player_id = p.id WHERE k.player_id = ?',
      [req.player.playerId]
    );
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

  // ── Take turn (advance game state) ───────────────────────────────────────────
  router.post('/turn', requireAuth, async (req, res) => {
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available — next 5 turns in 15 minutes' });

    const { updates, events } = engine.processTurn(k);
    updates.turns_stored = k.turns_stored - 1;
    await applyUpdates(db, k.id, updates);
    for (const ev of events)
      await db.run('INSERT INTO news (kingdom_id, type, message) VALUES (?, ?, ?)', [k.id, ev.type || 'system', ev.message]);

    res.json({ ok: true, updates, events, turns_stored: updates.turns_stored });
  });

  // ── Hire units ────────────────────────────────────────────────────────────────
  router.post('/hire', requireAuth, async (req, res) => {
    const { unit, amount } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });
    const result = engine.hireUnits(k, unit, Number(amount));
    if (result.error) return res.status(400).json({ error: result.error });
    result.updates.turns_stored = k.turns_stored - 1;
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, updates: result.updates, turns_stored: result.updates.turns_stored });
  });

  // ── Research ──────────────────────────────────────────────────────────────────
  router.post('/research', requireAuth, async (req, res) => {
    const { discipline, researchers } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });
    const result = engine.studyDiscipline(k, discipline, Number(researchers));
    if (result.error) return res.status(400).json({ error: result.error });
    result.updates.turns_stored = k.turns_stored - 1;
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, increment: result.increment, updates: result.updates, turns_stored: result.updates.turns_stored });
  });

  // ── Build ─────────────────────────────────────────────────────────────────────
  router.post('/build', requireAuth, async (req, res) => {
    const { building, quantity } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const result = engine.buildStructure(k, building, Number(quantity));
    if (result.error) return res.status(400).json({ error: result.error });
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, piecesUsed: result.piecesUsed, updates: result.updates });
  });

  // ── Search (exploration) — costs 1 turn ───────────────────────────────────────
  router.post('/search', requireAuth, async (req, res) => {
    const { type, rangers } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    const r = Number(rangers) || 0;
    if (r <= 0) return res.status(400).json({ error: 'Send at least some rangers' });
    if (r > k.rangers) return res.status(400).json({ error: 'Not enough rangers' });

    const tacticsMult = 1 + (k.res_military / 1000);
    let result = {};
    let message = '';
    const updates = { turns_stored: k.turns_stored - 1, updated_at: Math.floor(Date.now() / 1000) };

    if (type === 'land') {
      const found = Math.floor(r * 0.04 * tacticsMult);
      updates.land = k.land + found;
      result = { found, unit: 'acres' };
      message = `Rangers discovered +${found.toLocaleString()} acres of unclaimed land.`;
    } else if (type === 'gold') {
      const found = Math.floor(r * 12 * tacticsMult);
      updates.gold = k.gold + found;
      result = { found, unit: 'GC' };
      message = `Rangers returned with ${found.toLocaleString()} GC from foraging.`;
    } else if (type === 'targets') {
      const found = Math.floor(r * 0.002) + 2;
      result = { found, unit: 'kingdoms' };
      message = `Rangers scouted ${found} new target kingdoms.`;
    } else {
      return res.status(400).json({ error: 'Invalid search type' });
    }

    await applyUpdates(db, k.id, updates);
    await db.run('INSERT INTO news (kingdom_id, type, message) VALUES (?, ?, ?)', [k.id, 'system', message]);

    res.json({ ok: true, type, result, message, turns_stored: updates.turns_stored });
  });

  // ── Options ───────────────────────────────────────────────────────────────────
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
