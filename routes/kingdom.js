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
    // Parse JSON allocation
    try { k.research_allocation = JSON.parse(k.research_allocation || '{}'); } catch { k.research_allocation = {}; }
    res.json(k);
  });

  // ── Save research allocation ───────────────────────────────────────────────
  router.post('/research-allocation', requireAuth, async (req, res) => {
    const { allocation } = req.body;
    if (!allocation || typeof allocation !== 'object') return res.status(400).json({ error: 'allocation object required' });
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const total = Object.values(allocation).reduce((s, v) => s + (Number(v) || 0), 0);
    if (total > k.researchers) return res.status(400).json({ error: `Total allocated (${total.toLocaleString()}) exceeds researchers (${k.researchers.toLocaleString()})` });
    await db.run('UPDATE kingdoms SET research_allocation = ? WHERE id = ?', [JSON.stringify(allocation), k.id]);
    res.json({ ok: true });
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

  router.delete('/news/clear', requireAuth, async (req, res) => {
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    await db.run('DELETE FROM news WHERE kingdom_id = ?', [k.id]);
    res.json({ ok: true });
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
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, ev.type || 'system', ev.message, updates.turn || k.turn || 0]);

    res.json({ ok: true, updates, events, turns_stored: updates.turns_stored });
  });

  // ── Hire units ────────────────────────────────────────────────────────────────
  router.post('/hire', requireAuth, async (req, res) => {
    const { unit, amount } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    // Run full turn first
    const { updates: turnUpdates, events } = engine.processTurn(k);
    turnUpdates.turns_stored = k.turns_stored - 1;

    // Apply hire on top of turn state
    const kAfterTurn = { ...k, ...turnUpdates };
    const hireResult = engine.hireUnits(kAfterTurn, unit, Number(amount));
    if (hireResult.error) return res.status(400).json({ error: hireResult.error });

    const finalUpdates = { ...turnUpdates, ...hireResult.updates };
    await applyUpdates(db, k.id, finalUpdates);
    for (const ev of events)
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, ev.type || 'system', ev.message, turnUpdates.turn || k.turn || 0]);

    res.json({ ok: true, updates: finalUpdates, events, turns_stored: finalUpdates.turns_stored });
  });

  // ── Research ──────────────────────────────────────────────────────────────────
  router.post('/research', requireAuth, async (req, res) => {
    const { discipline, researchers } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    // Run full turn first
    const { updates: turnUpdates, events } = engine.processTurn(k);
    turnUpdates.turns_stored = k.turns_stored - 1;

    // Apply research on top of turn state
    const kAfterTurn = { ...k, ...turnUpdates };
    const resResult = engine.studyDiscipline(kAfterTurn, discipline, Number(researchers));
    if (resResult.error) return res.status(400).json({ error: resResult.error });

    const finalUpdates = { ...turnUpdates, ...resResult.updates };
    await applyUpdates(db, k.id, finalUpdates);

    const resCol = Object.keys(resResult.updates).find(k => k.startsWith('res_'));
    const newVal = resCol ? finalUpdates[resCol] : '?';
    const resEvent = { type: 'system', message: `📚 Studied ${discipline} with ${Number(researchers).toLocaleString()} researchers · +${resResult.increment} → now ${newVal}${discipline !== 'spellbook' ? '%' : ''}.` };
    events.push(resEvent);

    for (const ev of events)
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, ev.type || 'system', ev.message, turnUpdates.turn || k.turn || 0]);

    res.json({ ok: true, increment: resResult.increment, updates: finalUpdates, events, turns_stored: finalUpdates.turns_stored });
  });

  // ── Build ─────────────────────────────────────────────────────────────────────
  router.post('/build', requireAuth, async (req, res) => {
    const { building, quantity } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    // Run full turn first
    const { updates: turnUpdates, events } = engine.processTurn(k);
    turnUpdates.turns_stored = k.turns_stored - 1;

    // Apply build on top of turn state
    const kAfterTurn = { ...k, ...turnUpdates };
    const buildResult = engine.buildStructure(kAfterTurn, building, Number(quantity));
    if (buildResult.error) return res.status(400).json({ error: buildResult.error });

    const finalUpdates = { ...turnUpdates, ...buildResult.updates };
    await applyUpdates(db, k.id, finalUpdates);

    const buildLabels = {
      farms:'Farms', barracks:'Barracks', outposts:'Outposts', guard_towers:'Guard Towers',
      schools:'Schools', armories:'Armories', vaults:'Vaults', smithies:'Smithies',
      markets:'Market Places', cathedrals:'Cathedrals', training:'Training Fields',
      colosseums:'Colosseums', castles:'Castles', weapons:'Weapons', armor:'Armor'
    };
    const buildEvent = { type: 'system', message: `🔨 Built ${Number(quantity).toLocaleString()} ${buildLabels[building] || building}. Engineers used: ${buildResult.piecesUsed.toLocaleString()} turns.` };
    events.push(buildEvent);

    for (const ev of events)
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, ev.type || 'system', ev.message, turnUpdates.turn || k.turn || 0]);

    res.json({ ok: true, piecesUsed: buildResult.piecesUsed, updates: finalUpdates, events, turns_stored: finalUpdates.turns_stored });
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

    // Run full turn first
    const { updates: turnUpdates, events } = engine.processTurn(k);
    turnUpdates.turns_stored = k.turns_stored - 1;

    // Apply search on top of turn state
    const kAfterTurn = { ...k, ...turnUpdates };
    const tacticsMult = 1 + ((kAfterTurn.res_military || 0) / 1000);
    let searchResult = {};
    let searchMessage = '';

    if (type === 'land') {
      const found = Math.floor(r * 0.04 * tacticsMult);
      turnUpdates.land = (kAfterTurn.land || 0) + found;
      searchResult = { found, unit: 'acres' };
      searchMessage = `🗺️ Rangers discovered +${found.toLocaleString()} acres of unclaimed land.`;
    } else if (type === 'gold') {
      const found = Math.floor(r * 12 * tacticsMult);
      turnUpdates.gold = (turnUpdates.gold || kAfterTurn.gold || 0) + found;
      searchResult = { found, unit: 'GC' };
      searchMessage = `💰 Rangers returned with ${found.toLocaleString()} GC from foraging.`;
    } else if (type === 'targets') {
      const found = Math.floor(r * 0.002) + 2;
      searchResult = { found, unit: 'kingdoms' };
      searchMessage = `👁️ Rangers scouted ${found} new target kingdoms.`;
    } else {
      return res.status(400).json({ error: 'Invalid search type' });
    }

    await applyUpdates(db, k.id, turnUpdates);
    for (const ev of events)
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, ev.type || 'system', ev.message, turnUpdates.turn || k.turn || 0]);
    await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, 'system', searchMessage, turnUpdates.turn || k.turn || 0]);

    const allEvents = [...events, { type: 'system', message: searchMessage }];
    res.json({ ok: true, type, result: searchResult, message: searchMessage, updates: turnUpdates, events: allEvents, turns_stored: turnUpdates.turns_stored });
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
