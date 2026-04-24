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
    try { k.research_allocation    = JSON.parse(k.research_allocation    || '{}'); } catch { k.research_allocation    = {}; }
    try { k.mage_tower_allocation  = JSON.parse(k.mage_tower_allocation  || '{}'); } catch { k.mage_tower_allocation  = {}; }
    try { k.shrine_allocation      = JSON.parse(k.shrine_allocation      || '{}'); } catch { k.shrine_allocation      = {}; }
    try { k.library_allocation     = JSON.parse(k.library_allocation     || '{}'); } catch { k.library_allocation     = {}; }
    try { k.library_progress       = JSON.parse(k.library_progress       || '{}'); } catch { k.library_progress       = {}; }
    try { k.scrolls                = JSON.parse(k.scrolls                || '{}'); } catch { k.scrolls                = {}; }
    try { k.active_effects         = JSON.parse(k.active_effects         || '{}'); } catch { k.active_effects         = {}; }
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
      SELECT k.id, k.name, k.race, k.land, k.turn, k.population,
             k.fighters, k.mages, k.level, p.username, p.is_ai
      FROM kingdoms k JOIN players p ON k.player_id = p.id
      ORDER BY k.land DESC LIMIT 100
    `);
    res.json(rows.map((r, i) => ({ ...r, rank: i + 1 })));
  });

  router.get('/war-log', requireAuth, async (_req, res) => {
    const rows = await db.all(`
      SELECT id, action_type, attacker_id, attacker_name, defender_id, defender_name,
             outcome, detail, obscured, created_at
      FROM war_log
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  });

  router.get('/news/list', requireAuth, async (req, res) => {
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const [items] = await Promise.all([
      db.all('SELECT * FROM news WHERE kingdom_id = ? ORDER BY created_at DESC LIMIT 50', [k.id]),
      db.run('UPDATE news SET is_read = 1 WHERE kingdom_id = ? AND is_read = 0', [k.id]),
    ]);
    res.json(items);
  });

  router.delete('/news/clear', requireAuth, async (req, res) => {
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    await db.run('DELETE FROM news WHERE kingdom_id = ?', [k.id]);
    res.json({ ok: true });
  });

  // ── Shared turn runner — used by ALL routes that consume a turn ──────────────
  async function runTurn(db, k) {
    const { updates, events } = engine.processTurn(k);
    updates.turns_stored = (k.turns_stored || 0) - 1;

    await db.run('BEGIN');
    try {
      await applyUpdates(db, k.id, updates);
      const expeditionEvents = await engine.resolveExpeditions(db, { ...k, ...updates }, engine);
      const allEvents = [...events, ...expeditionEvents];
      if (allEvents.length > 0) {
        await bulkInsertNews(db, allEvents.map(ev => ({
          kingdom_id: k.id, type: ev.type || 'system',
          message: ev.message, turn_num: updates.turn || k.turn || 0,
        })));
        if (Math.random() < 0.05) await pruneNews(db, k.id, 200);
      }
      await db.run('COMMIT');
      // Refresh fields that resolveExpeditions may have updated via SQL
      const refreshed = await db.get(
        'SELECT rangers, fighters, gold, mana, land, scrolls, maps, blueprints_stored, troop_levels, library_progress FROM kingdoms WHERE id = ?',
        [k.id]
      );
      if (refreshed) Object.assign(updates, refreshed);
      return { updates, events: allEvents };
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }
  }

  // ── Take turn (advance game state) ───────────────────────────────────────────
  router.post('/turn', requireAuth, async (req, res) => {
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available — next 5 turns in 15 minutes' });
    try {
      const { updates, events } = await runTurn(db, k);
      res.json({ ok: true, updates, events, turns_stored: updates.turns_stored });
    } catch (err) {
      console.error('[turn] failed:', err.message);
      res.status(500).json({ error: 'Turn processing failed — please try again' });
    }
  });

  // ── Hire units ────────────────────────────────────────────────────────────────
  router.post('/hire', requireAuth, async (req, res) => {
    const { unit, amount } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    // Pre-validate hire against current state before running turn
    const hireCheck = engine.hireUnits(k, unit, Number(amount));
    if (hireCheck.error) return res.status(400).json({ error: hireCheck.error });

    try {
      const { updates, events } = await runTurn(db, k);
      // Apply hire on top of resolved turn state
      const kAfterTurn = { ...k, ...updates };
      const hireResult = engine.hireUnits(kAfterTurn, unit, Number(amount));
      if (hireResult.error) return res.status(400).json({ error: hireResult.error });
      const hireUpdates = hireResult.updates;
      await applyUpdates(db, k.id, hireUpdates);
      const finalUpdates = { ...updates, ...hireUpdates };
      res.json({ ok: true, updates: finalUpdates, events, turns_stored: finalUpdates.turns_stored });
    } catch (err) {
      console.error('[hire] failed:', err.message);
      res.status(500).json({ error: 'Hire failed — please try again' });
    }
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
    events.push({ type: 'system', message: `📚 Studied ${discipline} with ${Number(researchers).toLocaleString()} researchers · +${resResult.increment} → now ${newVal}${discipline !== 'spellbook' ? '%' : ''}.` });
    await bulkInsertNews(db, events.map(ev => ({ kingdom_id: k.id, type: ev.type || 'system', message: ev.message, turn_num: turnUpdates.turn || k.turn || 0 })));
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

  // ── Forge tools — costs 1 turn + gold for scaffolding ───────────────────────
  router.post('/forge-tools', requireAuth, async (req, res) => {
    const { toolType, quantity } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });
    const smithies = k.bld_smithies || 0;
    if (smithies === 0) return res.status(400).json({ error: 'Need at least 1 smithy' });
    // Validate caps and cost before running turn
    if (toolType === 'hammers') {
      const cap = smithies * 25;
      if ((k.tools_hammers || 0) >= cap) return res.status(400).json({ error: `Hammer storage full (${cap}/${cap})` });
    } else if (toolType === 'scaffolding') {
      const cap = smithies * 10;
      if ((k.tools_scaffolding || 0) >= cap) return res.status(400).json({ error: `Scaffolding storage full (${cap}/${cap})` });
      if ((k.gold || 0) < 2500) return res.status(400).json({ error: 'Need 2,500 gold to make scaffolding' });
    }
    try {
      const { updates, events } = await runTurn(db, k);
      const kAfterTurn = { ...k, ...updates };
      const toolResult = engine.forgeTools(kAfterTurn, toolType, Number(quantity) || 1);
      if (toolResult.error) return res.status(400).json({ error: toolResult.error });
      await applyUpdates(db, k.id, toolResult.updates);
      const finalUpdates = { ...updates, ...toolResult.updates };
      res.json({ ok: true, updates: finalUpdates, events, turns_stored: finalUpdates.turns_stored });
    } catch (err) {
      console.error('[forge-tools] failed:', err.message);
      res.status(500).json({ error: 'Forging failed — please try again' });
    }
  });

  router.post('/smithy-allocation', requireAuth, async (req, res) => {
    const { hammers, scaffolding } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    const smithies = k.bld_smithies || 0;
    if (smithies === 0) return res.status(400).json({ error: 'You need at least 1 smithy' });
    const h = Math.max(0, Math.min(smithies, Number(hammers) || 0));
    const s = Math.max(0, Math.min(smithies, Number(scaffolding) || 0));
    await db.run('UPDATE kingdoms SET smithy_allocation = ? WHERE id = ?',
      [JSON.stringify({ hammers: h, scaffolding: s }), k.id]);
    res.json({ ok: true, smithy_allocation: { hammers: h, scaffolding: s } });
  });
  router.post('/search', requireAuth, async (req, res) => {
    const { type, rangers } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    const r = Number(rangers) || 0;
    if (r <= 0) return res.status(400).json({ error: 'Send at least some rangers' });
    if (r > k.rangers) return res.status(400).json({ error: 'Not enough rangers' });

    try {
      const { updates, events } = await runTurn(db, k);
      const kAfterTurn = { ...k, ...updates };
      const tacticsMult = 1 + ((kAfterTurn.res_military || 0) / 1000);
      let searchResult = {};
      let searchMessage = '';

      if (type === 'land') {
        const found = Math.floor(r * 0.04 * tacticsMult);
        updates.land = (kAfterTurn.land || 0) + found;
        searchResult = { found, unit: 'acres' };
        searchMessage = `🗺️ Rangers discovered +${found.toLocaleString()} acres of unclaimed land.`;
      } else if (type === 'gold') {
        const found = Math.floor(r * 12 * tacticsMult);
        updates.gold = (updates.gold || kAfterTurn.gold || 0) + found;
        searchResult = { found, unit: 'GC' };
        searchMessage = `💰 Rangers returned with ${found.toLocaleString()} gold from foraging.`;
      } else if (type === 'targets') {
        const found = Math.floor(r * 0.002) + 2;
        searchResult = { found, unit: 'kingdoms' };
        searchMessage = `👁️ Rangers scouted ${found} new target kingdoms.`;
      } else {
        return res.status(400).json({ error: 'Invalid search type' });
      }

      await applyUpdates(db, k.id, { land: updates.land, gold: updates.gold });

      const turnNum = updates.turn || k.turn || 0;
      await bulkInsertNews(db, [{ kingdom_id: k.id, type: 'system', message: searchMessage, turn_num: turnNum }]);

      const xpResult = engine.awardXp(kAfterTurn, 'exploration', type === 'land' ? searchResult.found : (type === 'gold' ? Math.floor(searchResult.found / 1000) : 5));
      updates.xp = xpResult.xp; updates.level = xpResult.level;
      if (xpResult.levelled) {
        await bulkInsertNews(db, xpResult.events.map(ev => ({ kingdom_id: k.id, type: 'system', message: ev.message, turn_num: turnNum })));
        events.push(...xpResult.events);
      }
      await applyUpdates(db, k.id, { xp: updates.xp, level: updates.level });

      res.json({ ok: true, type, result: searchResult, message: searchMessage, updates, events: [...events, { type: 'system', message: searchMessage }], turns_stored: updates.turns_stored });
    } catch (err) {
      console.error('[search] failed:', err.message);
      res.status(500).json({ error: 'Search failed — please try again' });
    }
  });

  // ── Mage tower allocation ────────────────────────────────────────────────────
  router.post('/mage-tower-allocation', requireAuth, async (req, res) => {
    const { allocation } = req.body;
    if (!allocation || typeof allocation !== 'object') return res.status(400).json({ error: 'allocation required' });
    const k = await db.get('SELECT id, bld_cathedrals, mages FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if ((k.bld_cathedrals || 0) === 0) return res.status(400).json({ error: 'You need at least 1 Mage Tower first' });
    const magesAlloc = Math.min(Number(allocation.mages) || 0, k.mages || 0);
    const researchMages = Math.min(Number(allocation.research_mages) || 0, k.mages || 0);
    const save = {
      mages:                Math.min(magesAlloc + researchMages, k.mages || 0),
      research_mages:       researchMages,
      research_discipline:  allocation.research_discipline || null,
    };
    await db.run('UPDATE kingdoms SET mage_tower_allocation = ? WHERE id = ?', [JSON.stringify(save), k.id]);
    res.json({ ok: true, allocation: save });
  });

  // ── Shrine allocation ─────────────────────────────────────────────────────────
  router.post('/shrine-allocation', requireAuth, async (req, res) => {
    const { allocation } = req.body;
    if (!allocation || typeof allocation !== 'object') return res.status(400).json({ error: 'allocation required' });
    const k = await db.get('SELECT id, bld_shrines, clerics FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if ((k.bld_shrines || 0) === 0) return res.status(400).json({ error: 'You need at least 1 Shrine first' });
    const clericsAlloc = Math.min(Number(allocation.clerics) || 0, k.clerics || 0);
    await db.run('UPDATE kingdoms SET shrine_allocation = ? WHERE id = ?', [JSON.stringify({ clerics: clericsAlloc }), k.id]);
    res.json({ ok: true, allocation: { clerics: clericsAlloc } });
  });

  // ── Military attack ───────────────────────────────────────────────────────────
  router.post('/attack', requireAuth, async (req, res) => {
    const { targetId, fighters, mages } = req.body;
    const fightersSent = Math.max(0, parseInt(fighters) || 0);
    const magesSent    = Math.max(0, parseInt(mages)    || 0);

    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });
    if (fightersSent <= 0) return res.status(400).json({ error: 'Send at least 1 fighter' });
    if (fightersSent > k.fighters) return res.status(400).json({ error: 'Not enough fighters' });
    if (magesSent > k.mages) return res.status(400).json({ error: 'Not enough mages' });

    const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: 'Target kingdom not found' });
    if (target.id === k.id) return res.status(400).json({ error: 'Cannot attack yourself' });

    // Map requirement
    if ((k.maps || 0) < 1) return res.status(400).json({ error: 'You need a map to attack other kingdoms — craft one in your Library' });

    // Newbie protection — cannot attack kingdoms under turn 200
    if ((target.turn || 0) < 200) return res.status(400).json({ error: `${target.name} is under newbie protection until Turn 200 (currently Turn ${target.turn})` });

    const result = engine.resolveMilitaryAttack(k, target, fightersSent, magesSent);
    if (result.error) return res.status(400).json({ error: result.error });

    const VALID = new Set([
      'gold','mana','land','population','morale','food','fighters','rangers','clerics',
      'mages','thieves','ninjas','researchers','engineers','war_machines',
      'weapons_stockpile','armor_stockpile','xp','level','troop_levels',
      'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
      'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
    ]);

    async function applyBattle(kingdom, updates) {
      const safe = Object.fromEntries(Object.entries(updates).filter(([c,v]) =>
        VALID.has(c) && v !== undefined && v !== null && !isNaN(v)
      ));
      if (Object.keys(safe).length > 0) {
        const cols = Object.keys(safe).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safe), kingdom.id]);
      }
    }

    await applyBattle(k, result.attackerUpdates);
    await applyBattle(target, result.defenderUpdates);
    await db.run('UPDATE kingdoms SET turns_stored = turns_stored - 1 WHERE id = ?', [k.id]);

    // News for both kingdoms
    await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
      [k.id, 'attack', result.atkEvent, k.turn]);
    await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
      [target.id, 'attack', result.defEvent, target.turn]);

    // Global war log
    await db.run(`INSERT INTO war_log (action_type, attacker_id, attacker_name, defender_id, defender_name, outcome, detail, obscured)
      VALUES (?,?,?,?,?,?,?,0)`, [
      'attack',
      k.id, k.name,
      target.id, target.name,
      result.win ? 'victory' : 'repelled',
      `${result.report.fightersSent.toLocaleString()} fighters · ${result.report.landTransferred > 0 ? '+' + result.report.landTransferred + ' land' : 'no land taken'}`,
    ]);

    // XP event for level-up
    if (result.report.atkLevelUp) {
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
        [k.id, 'system', `🎉 Level up! You are now level ${result.attackerUpdates.level}!`, k.turn]);
    }

    res.json({
      ok: true,
      report: result.report,
      updates: result.attackerUpdates,
      event: result.atkEvent,
    });
  });

  // ── Cast spell ───────────────────────────────────────────────────────────────
  router.post('/spell', requireAuth, async (req, res) => {
    const { spellId, targetId, obscure } = req.body;
    if (!spellId) return res.status(400).json({ error: 'spellId required' });

    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if ((k.turns_stored || 0) < 1) return res.status(429).json({ error: 'No turns available' });

    const def = engine.SPELL_DEFS[spellId];
    if (!def) return res.status(400).json({ error: 'Unknown spell' });

    // Friendly spells target yourself; offensive spells require a target + map
    const isFriendly = def.effect === 'friendly';
    let target;

    if (isFriendly) {
      target = k; // cast on self
    } else {
      if (!targetId) return res.status(400).json({ error: 'targetId required for offensive spells' });
      if ((k.maps || 0) < 1) return res.status(400).json({ error: 'You need a map to cast on other kingdoms — craft one in your Library' });
      target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [targetId]);
      if (!target) return res.status(404).json({ error: 'Target kingdom not found' });
      if (target.player_id === k.player_id) return res.status(400).json({ error: 'Cannot cast offensive spells on yourself' });
      if ((target.turn || 0) < 200) return res.status(400).json({ error: `${target.name} is under newbie protection until Turn 200 (currently Turn ${target.turn})` });
    }

    const result = engine.castSpell(k, target, spellId, !!obscure);
    if (result.error) return res.status(400).json({ error: result.error });

    const VALID = new Set([
      'gold','mana','land','population','morale','food','fighters','rangers','clerics',
      'mages','thieves','ninjas','researchers','engineers','war_machines','scrolls',
      'bld_farms','bld_barracks','bld_guard_towers','bld_markets','bld_castles',
      'active_effects','res_economy','res_attack_magic','res_defense_magic','res_spellbook',
    ]);

    async function applySpell(kingdom, updates) {
      const safe = Object.fromEntries(
        Object.entries(updates).filter(([c, v]) => VALID.has(c) && v !== undefined && v !== null)
      );
      if (Object.keys(safe).length > 0) {
        const cols = Object.keys(safe).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safe), kingdom.id]);
      }
    }

    await applySpell(k, result.casterUpdates);
    if (!isFriendly) await applySpell(target, result.targetUpdates);
    await db.run('UPDATE kingdoms SET turns_stored = turns_stored - 1 WHERE id = ?', [k.id]);

    // News
    if (result.casterEvent) {
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
        [k.id, 'system', result.casterEvent, k.turn]);
    }
    if (!isFriendly && result.targetEvent) {
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
        [target.id, 'attack', result.targetEvent, target.turn]);
    }

    // War log for offensive spells
    if (!isFriendly) {
      await db.run(`INSERT INTO war_log (action_type, attacker_id, attacker_name, defender_id, defender_name, outcome, detail, obscured)
        VALUES (?,?,?,?,?,?,?,?)`, [
        'spell', k.id, k.name, target.id, target.name,
        'cast',
        `${spellId.replace(/_/g,' ')} — ${result.report.damageDesc || ''}`,
        obscure ? 1 : 0,
      ]);
    }

    // Consume map on cast (map is used up like a compass — one per interaction)
    if (!isFriendly) {
      await db.run('UPDATE kingdoms SET maps = MAX(0, maps - 1) WHERE id = ?', [k.id]);
    }

    const freshK = await db.get('SELECT mana, scrolls, maps, active_effects FROM kingdoms WHERE id = ?', [k.id]);
    res.json({
      ok: true,
      report: result.report,
      updates: {
        mana:           freshK.mana,
        scrolls:        JSON.parse(freshK.scrolls || '{}'),
        maps:           freshK.maps,
        active_effects: JSON.parse(freshK.active_effects || '{}'),
        ...result.casterUpdates,
      },
    });
  });

  // ── Covert operations ────────────────────────────────────────────────────────
  router.post('/covert', requireAuth, async (req, res) => {
    const { op, targetId, units, lootType, unitType, bldType } = req.body;
    const k = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });

    const target = await db.get('SELECT * FROM kingdoms WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: 'Target kingdom not found' });
    if (target.id === k.id) return res.status(400).json({ error: 'Cannot target your own kingdom' });

    // Check map requirement
    if ((k.maps || 0) < 1) return res.status(400).json({ error: 'You need a map to interact with other kingdoms — craft one in your Library' });

    // Newbie protection
    if ((target.turn || 0) < 200) return res.status(400).json({ error: `${target.name} is under newbie protection until Turn 200 (currently Turn ${target.turn})` });

    let result;
    const VALID_COLS = new Set([
      'gold','mana','land','population','morale','food','fighters','rangers','clerics',
      'mages','thieves','ninjas','researchers','engineers','war_machines',
      'weapons_stockpile','armor_stockpile',
      'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
      'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
      'bld_farms','bld_barracks','bld_schools','bld_armories','bld_vaults','bld_smithies',
      'bld_markets','bld_cathedrals','bld_colosseums','bld_castles','bld_libraries','bld_shrines',
    ]);

    async function applyCovert(kingdom, updates) {
      const safe = Object.fromEntries(Object.entries(updates).filter(([c,v]) => VALID_COLS.has(c) && v !== undefined && !isNaN(v)));
      if (Object.keys(safe).length > 0) {
        const cols = Object.keys(safe).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safe), kingdom.id]);
      }
    }

    if (op === 'spy') {
      const unitsSent = Math.max(1, parseInt(units) || 0);
      if (unitsSent > (k.thieves + k.ninjas)) return res.status(400).json({ error: 'Not enough thieves/ninjas' });
      result = engine.covertSpy(k, target, unitsSent);
      await applyCovert(k, result.spyUpdates || {});
      await db.run('UPDATE kingdoms SET turns_stored = turns_stored - 1 WHERE id = ?', [k.id]);
      if (result.spyEvent) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [k.id, 'covert', result.spyEvent, k.turn]);
      if (!result.success && result.targetEvent) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [target.id, 'covert', result.targetEvent, target.turn]);
      // War log: reveal attacker only on failure
      await db.run(`INSERT INTO war_log (action_type, attacker_id, attacker_name, defender_id, defender_name, outcome, detail, obscured) VALUES (?,?,?,?,?,?,?,?)`, [
        'spy', k.id, k.name, target.id, target.name,
        result.success ? 'success' : 'caught',
        'Intelligence gathering',
        result.success ? 1 : 0,
      ]);
      return res.json({ ok: true, success: result.success, report: result.report || null, event: result.spyEvent });

    } else if (op === 'loot') {
      const thievesSent = Math.max(1, parseInt(units) || 0);
      if (thievesSent > k.thieves) return res.status(400).json({ error: 'Not enough thieves' });
      const loot = lootType === 'wm' ? 'war_machines' : lootType;
      result = engine.covertLoot(k, target, loot, thievesSent);
      if (result.error) return res.status(400).json({ error: result.error });
      await applyCovert(k, result.thiefUpdates || {});
      await applyCovert(target, result.targetUpdates || {});
      await db.run('UPDATE kingdoms SET turns_stored = turns_stored - 1 WHERE id = ?', [k.id]);
      if (result.thiefEvent) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [k.id, 'covert', result.thiefEvent, k.turn]);
      if (result.targetEvent) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [target.id, 'covert', result.targetEvent, target.turn]);
      await db.run(`INSERT INTO war_log (action_type, attacker_id, attacker_name, defender_id, defender_name, outcome, detail, obscured) VALUES (?,?,?,?,?,?,?,?)`, [
        'loot', k.id, k.name, target.id, target.name,
        result.success ? 'success' : 'caught',
        result.success ? `Stole ${loot.replace('_',' ')}` : 'Thieves captured',
        result.success ? 1 : 0,
      ]);
      return res.json({ ok: true, success: result.success, stolen: result.stolen, lootType: result.lootType, event: result.thiefEvent });

    } else if (op === 'assassinate') {
      const ninjasSent = Math.max(1, parseInt(units) || 0);
      if (ninjasSent > k.ninjas) return res.status(400).json({ error: 'Not enough ninjas' });
      const validTargets = ['fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers','scribes'];
      if (!validTargets.includes(unitType)) return res.status(400).json({ error: 'Invalid target unit type' });
      result = engine.covertAssassinate(k, target, ninjasSent, unitType);
      if (result.error) return res.status(400).json({ error: result.error });
      await applyCovert(k, result.assassinUpdates || {});
      await applyCovert(target, result.targetUpdates || {});
      await db.run('UPDATE kingdoms SET turns_stored = turns_stored - 1 WHERE id = ?', [k.id]);
      if (result.assassinEvent) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [k.id, 'covert', result.assassinEvent, k.turn]);
      if (result.targetEvent) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [target.id, 'covert', result.targetEvent, target.turn]);
      await db.run(`INSERT INTO war_log (action_type, attacker_id, attacker_name, defender_id, defender_name, outcome, detail, obscured) VALUES (?,?,?,?,?,?,?,?)`, [
        'assassinate', k.id, k.name, target.id, target.name,
        result.success ? 'success' : 'caught',
        result.success ? `${(result.killed||0).toLocaleString()} ${unitType} eliminated` : 'Ninjas compromised',
        result.success ? 1 : 0,
      ]);
      return res.json({ ok: true, success: result.success, killed: result.killed, event: result.assassinEvent });

    } else if (op === 'sabotage') {
      const ninjasSent = Math.max(1, parseInt(units) || 0);
      if (ninjasSent > k.ninjas) return res.status(400).json({ error: 'Not enough ninjas' });
      const BLD_MAP = { farms:'bld_farms', smithies:'bld_smithies', cathedrals:'bld_cathedrals', barracks:'bld_barracks', libraries:'bld_libraries' };
      const col = BLD_MAP[bldType];
      if (!col) return res.status(400).json({ error: 'Invalid building type' });
      const stealthMulti = (engine.RACE_BONUSES[k.race]?.stealth || 1.0);
      const success = k.ninjas * stealthMulti * 1.2 > (target.fighters||0) * 0.01 + (target.bld_guard_towers||0) * 2;
      const ninjasLost = success ? 0 : Math.floor(ninjasSent * 0.2);
      const destroyed = success ? Math.floor(ninjasSent * (3 + Math.random() * 4)) : 0;
      const newBldVal = Math.max(0, (target[col] || 0) - destroyed);
      await db.run('UPDATE kingdoms SET turns_stored = turns_stored - 1 WHERE id = ?', [k.id]);
      if (ninjasLost > 0) await db.run('UPDATE kingdoms SET ninjas = MAX(0, ninjas - ?) WHERE id = ?', [ninjasLost, k.id]);
      if (success && destroyed > 0) await db.run(`UPDATE kingdoms SET ${col} = ? WHERE id = ?`, [newBldVal, target.id]);
      const sabMsg = success
        ? `Sabotaged ${destroyed} ${bldType.replace(/_/g,' ')} in ${target.name}.`
        : `Sabotage of ${bldType} in ${target.name} failed — ${ninjasLost} ninjas lost.`;
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [k.id, 'covert', sabMsg, k.turn]);
      if (success) await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)', [target.id, 'covert', `Enemy ninjas sabotaged ${destroyed} of your ${bldType.replace(/_/g,' ')}.`, target.turn]);
      await db.run(`INSERT INTO war_log (action_type, attacker_id, attacker_name, defender_id, defender_name, outcome, detail, obscured) VALUES (?,?,?,?,?,?,?,?)`, [
        'sabotage', k.id, k.name, target.id, target.name,
        success ? 'success' : 'caught',
        success ? `${destroyed} ${bldType.replace(/_/g,' ')} destroyed` : 'Ninjas caught',
        success ? 1 : 0,
      ]);
      return res.json({ ok: true, success, destroyed, ninjasLost, event: sabMsg });

    } else {
      return res.status(400).json({ error: 'Unknown covert operation' });
    }
  });

  // ── Library allocation ────────────────────────────────────────────────────────
  router.post('/library-allocation', requireAuth, async (req, res) => {
    const { allocation } = req.body;
    if (!allocation || typeof allocation !== 'object') return res.status(400).json({ error: 'allocation required' });
    const k = await db.get('SELECT id, bld_libraries, mages, scribes FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    if ((k.bld_libraries || 0) === 0) return res.status(400).json({ error: 'You need at least 1 library first' });
    const magesAlloc   = Math.min(Number(allocation.mages)   || 0, k.mages   || 0);
    const scribesAlloc = Math.min(Number(allocation.scribes) || 0, k.scribes || 0);
    const save = {
      mages:        magesAlloc,
      scribes:      scribesAlloc,
      scroll_craft: allocation.scroll_craft || null,
      scribe_craft: allocation.scribe_craft || null,
    };
    await db.run('UPDATE kingdoms SET library_allocation = ? WHERE id = ?', [JSON.stringify(save), k.id]);
    res.json({ ok: true, allocation: save });
  });

  // ── Fire units ────────────────────────────────────────────────────────────────
  router.post('/fire', requireAuth, async (req, res) => {
    const { unit, amount } = req.body;
    const validUnits = ['fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers','scribes'];
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
    if (k.turns_stored < 1) return res.status(429).json({ error: 'No turns available' });
    const r = Math.max(0, parseInt(rangers) || 0);
    const f = Math.max(0, parseInt(fighters) || 0);
    if (r < 1) return res.status(400).json({ error: 'Send at least 1 ranger' });
    if (type === 'dungeon' && f < 1) return res.status(400).json({ error: 'Dungeon raids require fighters' });
    if (r > k.rangers) return res.status(400).json({ error: 'Not enough rangers' });
    if (f > k.fighters) return res.status(400).json({ error: 'Not enough fighters' });
    const existing = await db.get('SELECT id FROM expeditions WHERE kingdom_id = ? AND type = ?', [k.id, type]);
    if (existing) return res.status(400).json({ error: `A ${type} expedition is already underway` });

    try {
      const { updates, events } = await runTurn(db, k);
      // Deduct troops from resolved state
      updates.rangers  = Math.max(0, (updates.rangers  !== undefined ? updates.rangers  : k.rangers)  - r);
      updates.fighters = Math.max(0, (updates.fighters !== undefined ? updates.fighters : k.fighters) - f);
      await applyUpdates(db, k.id, { rangers: updates.rangers, fighters: updates.fighters });

      await db.run('INSERT INTO expeditions (kingdom_id, type, turns_left, rangers, fighters) VALUES (?, ?, ?, ?, ?)',
        [k.id, type, EXP_TURNS[type], r, f]);

      const label  = { scout: 'Scout', deep: 'Deep', dungeon: 'Dungeon' }[type];
      const troops = `${r.toLocaleString()} rangers${f > 0 ? ', ' + f.toLocaleString() + ' fighters' : ''}`;

      res.json({
        ok: true, turns_left: EXP_TURNS[type],
        turns_stored: updates.turns_stored,
        updates, events,
        message: `🧭 ${label} expedition launched — ${troops} deployed for ${EXP_TURNS[type]} turns.`,
      });
    } catch (err) {
      console.error('[expedition/start] failed:', err.message);
      res.status(500).json({ error: 'Expedition failed — please try again' });
    }
  });

  router.get('/expedition/list', requireAuth, async (req, res) => {
    const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!k) return res.status(404).json({ error: 'Kingdom not found' });
    // Fetch completed ones (turns_left=0 with rewards) to return to frontend, then delete them
    const completed = await db.all('SELECT * FROM expeditions WHERE kingdom_id = ? AND turns_left = 0 AND rewards IS NOT NULL', [k.id]);
    if (completed.length > 0) {
      await db.run('DELETE FROM expeditions WHERE kingdom_id = ? AND turns_left = 0', [k.id]);
    }
    const active = await db.all('SELECT * FROM expeditions WHERE kingdom_id = ? AND turns_left > 0 ORDER BY created_at DESC', [k.id]);
    res.json({ active, completed });
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

// Insert multiple news rows in a single query — much faster than N sequential inserts
async function bulkInsertNews(db, rows) {
  if (!rows || rows.length === 0) return;
  const placeholders = rows.map(() => '(?,?,?,?)').join(',');
  const values = rows.flatMap(r => [r.kingdom_id, r.type || 'system', r.message, r.turn_num || 0]);
  await db.run(`INSERT INTO news (kingdom_id, type, message, turn_num) VALUES ${placeholders}`, values);
}

// Prune old news — keep only the most recent N rows per kingdom
async function pruneNews(db, kingdomId, keep = 200) {
  await db.run(`
    DELETE FROM news WHERE kingdom_id = ? AND id NOT IN (
      SELECT id FROM news WHERE kingdom_id = ? ORDER BY created_at DESC LIMIT ?
    )
  `, [kingdomId, kingdomId, keep]);
}
