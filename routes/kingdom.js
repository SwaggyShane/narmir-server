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

    // Tick active expeditions
    await engine.resolveExpeditions(db, { ...k, ...updates }, engine);

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

  // ── Queue buildings — charges gold, no turn cost ──────────────────────────────
  router.post('/build-queue', requireAuth, async (req, res) => {
    const { orders } = req.body;
    if (!orders || typeof orders !== 'object') return res.status(400).json({ error: 'orders required' });
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    try { k.build_queue = JSON.parse(k.build_queue || '{}'); } catch { k.build_queue = {}; }
    const result = engine.queueBuildings(k, orders);
    if (result.error) return res.status(400).json({ error: result.error });
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, queue: JSON.parse(result.updates.build_queue), gold: result.updates.gold, totalCost: result.totalCost });
  });

  // ── Save training allocation ───────────────────────────────────────────────
  router.post('/training-allocation', requireAuth, async (req, res) => {
    const { allocation } = req.body;
    if (!allocation || typeof allocation !== 'object') return res.status(400).json({ error: 'allocation required' });
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    await db.run('UPDATE kingdoms SET training_allocation = ? WHERE id = ?', [JSON.stringify(allocation), k.id]);
    res.json({ ok: true });
  });
  router.post('/build-allocation', requireAuth, async (req, res) => {
    const { allocation } = req.body;
    if (!allocation || typeof allocation !== 'object') return res.status(400).json({ error: 'allocation required' });
    const k = await db.get('SELECT id, engineers FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const total = Object.values(allocation).reduce((s, v) => s + (Number(v)||0), 0);
    if (total > k.engineers) return res.status(400).json({ error: `Allocated ${total.toLocaleString()} but only have ${k.engineers.toLocaleString()} engineers` });
    await db.run('UPDATE kingdoms SET build_allocation = ? WHERE id = ?', [JSON.stringify(allocation), k.id]);
    res.json({ ok: true });
  });

  // ── Forge tools — costs gold only, no turn ───────────────────────────────────
  router.post('/forge-tools', requireAuth, async (req, res) => {
    const { toolType, quantity } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const result = engine.forgeTools(k, toolType, Number(quantity));
    if (result.error) return res.status(400).json({ error: result.error });
    await applyUpdates(db, k.id, result.updates);
    res.json({ ok: true, updates: result.updates, totalCost: result.totalCost });
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
      searchMessage = `💰 Rangers returned with ${found.toLocaleString()} gold from foraging.`;
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

    // Award exploration XP
    const kForXp = { ...k, ...turnUpdates };
    const xpAmount = type === 'land' ? searchResult.found : (type === 'gold' ? Math.floor(searchResult.found / 1000) : 5);
    const xpResult = engine.awardXp(kForXp, 'exploration', xpAmount);
    turnUpdates.xp    = xpResult.xp;
    turnUpdates.level = xpResult.level;
    if (xpResult.levelled) {
      for (const ev of xpResult.events)
        await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)', [k.id, 'system', ev.message, turnUpdates.turn||k.turn||0]);
    }
    await applyUpdates(db, k.id, { xp: turnUpdates.xp, level: turnUpdates.level });

    const allEvents = [...events, { type: 'system', message: searchMessage }];
    if (xpResult.levelled) allEvents.push(...xpResult.events);
    res.json({ ok: true, type, result: searchResult, message: searchMessage, updates: turnUpdates, events: allEvents, turns_stored: turnUpdates.turns_stored });
  });

  // ── Fire units ────────────────────────────────────────────────────────────────
  router.post('/fire', requireAuth, async (req, res) => {
    const { unit, amount } = req.body;
    const validUnits = ['fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers'];
    if (!validUnits.includes(unit)) return res.status(400).json({ error: 'Invalid unit type' });
    const n = Math.max(0, parseInt(amount) || 0);
    if (n <= 0) return res.status(400).json({ error: 'Amount must be positive' });
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (n > (k[unit] || 0)) return res.status(400).json({ error: `Only have ${(k[unit]||0).toLocaleString()} ${unit}` });
    const updates = {
      [unit]: (k[unit] || 0) - n,
      population: (k.population || 0) + n,
    };
    await applyUpdates(db, k.id, updates);
    res.json({ ok: true, updates });
  });
  const EXP_TURNS = { scout: 10, deep: 25, dungeon: 50 };

  router.post('/expedition/start', requireAuth, async (req, res) => {
    const { type, rangers, fighters } = req.body;
    if (!EXP_TURNS[type]) return res.status(400).json({ error: 'Invalid expedition type' });
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const r = Math.max(0, parseInt(rangers) || 0);
    const f = Math.max(0, parseInt(fighters) || 0);
    if (r < 1) return res.status(400).json({ error: 'Send at least 1 ranger' });
    if (type === 'dungeon' && f < 1) return res.status(400).json({ error: 'Dungeon raids require fighters' });
    if (r > k.rangers) return res.status(400).json({ error: 'Not enough rangers' });
    if (f > k.fighters) return res.status(400).json({ error: 'Not enough fighters' });
    const existing = await db.get('SELECT id FROM expeditions WHERE kingdom_id = ? AND type = ?', [k.id, type]);
    if (existing) return res.status(400).json({ error: `A ${type} expedition is already underway` });

    await db.run('INSERT INTO expeditions (kingdom_id, type, turns_left, rangers, fighters) VALUES (?, ?, ?, ?, ?)',
      [k.id, type, EXP_TURNS[type], r, f]);
    await db.run('UPDATE kingdoms SET rangers = rangers - ?, fighters = fighters - ? WHERE id = ?', [r, f, k.id]);

    const label = { scout: 'Scout', deep: 'Deep', dungeon: 'Dungeon' }[type];
    const troops = `${r.toLocaleString()} rangers${f > 0 ? ', ' + f.toLocaleString() + ' fighters' : ''}`;
    await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
      [k.id, 'system', `🧭 ${label} expedition launched — ${troops} deployed for ${EXP_TURNS[type]} turns.`, k.turn || 0]);

    const updated = await db.get('SELECT rangers, fighters FROM kingdoms WHERE id = ?', [k.id]);
    res.json({ ok: true, turns_left: EXP_TURNS[type], updated });
  });

  router.get('/expedition/list', requireAuth, async (req, res) => {
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    // Clean up any stuck zero-turn expeditions
    await db.run('DELETE FROM expeditions WHERE kingdom_id = ? AND turns_left <= 0', [k.id]);
    const exps = await db.all('SELECT * FROM expeditions WHERE kingdom_id = ? AND turns_left > 0 ORDER BY created_at DESC', [k.id]);
    res.json(exps);
  });

  router.post('/expedition/cancel', requireAuth, async (req, res) => {
    const { id } = req.body;
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const exp = await db.get('SELECT * FROM expeditions WHERE id = ? AND kingdom_id = ?', [id, k.id]);
    if (!exp) return res.status(404).json({ error: 'Expedition not found' });
    // Return troops
    await db.run('UPDATE kingdoms SET rangers = rangers + ?, fighters = fighters + ? WHERE id = ?', [exp.rangers, exp.fighters, k.id]);
    await db.run('DELETE FROM expeditions WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  // Admin: clear ALL expeditions for a kingdom (debug tool)
  router.delete('/expedition/clear-all', requireAuth, async (req, res) => {
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const exps = await db.all('SELECT * FROM expeditions WHERE kingdom_id = ?', [k.id]);
    let rangers = 0, fighters = 0;
    exps.forEach(e => { rangers += e.rangers; fighters += e.fighters; });
    await db.run('UPDATE kingdoms SET rangers = rangers + ?, fighters = fighters + ? WHERE id = ?', [rangers, fighters, k.id]);
    await db.run('DELETE FROM expeditions WHERE kingdom_id = ?', [k.id]);
    res.json({ ok: true, cleared: exps.length });
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
