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

  // POST /api/admin/reset-all-kingdoms — wipe all kingdoms back to starting stats
  router.post('/reset-all-kingdoms', async (_req, res) => {
    await db.run(`UPDATE kingdoms SET
      gold = 10000, mana = 0, land = 504, population = 50000, food = 0, morale = 100,
      turn = 0, turns_stored = 200,
      fighters = 0, rangers = 50, clerics = 0, mages = 0, thieves = 0, ninjas = 0,
      researchers = 100, engineers = 100, scribes = 0,
      war_machines = 0, weapons_stockpile = 0, armor_stockpile = 0,
      bld_farms = 200, bld_barracks = 1, bld_outposts = 0, bld_guard_towers = 0,
      bld_schools = 1, bld_armories = 1, bld_vaults = 0, bld_smithies = 0,
      bld_markets = 0, bld_cathedrals = 0, bld_training = 0, bld_colosseums = 0,
      bld_castles = 0, bld_shrines = 0, bld_libraries = 0, bld_housing = 100,
      res_economy = 100, res_weapons = 100, res_armor = 100, res_military = 100,
      res_attack_magic = 100, res_defense_magic = 100, res_entertainment = 100,
      res_construction = 100, res_war_machines = 100, res_spellbook = 0,
      xp = 0, level = 1,
      research_allocation = '{}', build_allocation = '{}', build_queue = '{}',
      mage_tower_allocation = '{}', shrine_allocation = '{}', library_allocation = '{}',
      library_progress = '{}', scrolls = '{}', active_effects = '{}',
      maps = 0, blueprints_stored = 0,
      tools_hammers = 0, tools_scaffolding = 0, tools_blueprints = 0
    `);
    await db.run('DELETE FROM expeditions');
    await db.run('DELETE FROM news');
    await db.run('DELETE FROM combat_log');
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
  router.post('/set-kingdom', async (req, res) => {
    const { kingdomId, fields } = req.body;
    if (!kingdomId || !fields || typeof fields !== 'object') return res.status(400).json({ error: 'kingdomId and fields required' });

    // Whitelist every settable kingdom column
    const ALLOWED = new Set([
      'gold','mana','land','population','morale','food','turn','turns_stored',
      'fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers','scribes',
      'war_machines','weapons_stockpile','armor_stockpile','maps','blueprints_stored',
      'bld_farms','bld_barracks','bld_outposts','bld_guard_towers','bld_schools',
      'bld_armories','bld_vaults','bld_smithies','bld_markets','bld_cathedrals',
      'bld_training','bld_colosseums','bld_castles','bld_libraries','bld_shrines','bld_housing',
      'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
      'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
      'xp','level',
    ]);

    const safe = Object.fromEntries(
      Object.entries(fields)
        .filter(([k, v]) => ALLOWED.has(k) && v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => [k, Number(v)])
        .filter(([k, v]) => !isNaN(v))
    );

    if (Object.keys(safe).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    const cols = Object.keys(safe).map(c => `${c} = ?`).join(', ');
    await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safe), kingdomId]);
    res.json({ ok: true, updated: Object.keys(safe) });
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

  // GET /api/admin/ai-synopsis — snapshot of all AI kingdom states
  router.get('/ai-synopsis', async (_req, res) => {
    const aiPlayers = await db.all('SELECT id, username FROM players WHERE is_ai = 1');
    if (aiPlayers.length === 0) return res.json([]);

    const rows = [];
    for (const p of aiPlayers) {
      const k = await db.get(`
        SELECT k.*, p.username
        FROM kingdoms k JOIN players p ON k.player_id = p.id
        WHERE k.player_id = ?`, [p.id]);
      if (!k) continue;

      // Count war log actions by this AI as attacker
      const attacks   = await db.get('SELECT COUNT(*) as c FROM war_log WHERE attacker_id = ? AND action_type = ?', [k.id, 'attack']);
      const coverts   = await db.get('SELECT COUNT(*) as c FROM war_log WHERE attacker_id = ? AND action_type IN (?,?,?)', [k.id, 'spy','loot','assassinate','sabotage']);
      const wins      = await db.get('SELECT COUNT(*) as c FROM war_log WHERE attacker_id = ? AND outcome = ?', [k.id, 'victory']);
      const losses    = await db.get('SELECT COUNT(*) as c FROM war_log WHERE attacker_id = ? AND action_type = ? AND outcome = ?', [k.id, 'attack', 'repelled']);
      const timesHit  = await db.get('SELECT COUNT(*) as c FROM war_log WHERE defender_id = ?', [k.id]);

      // Parse JSON fields safely
      let buildAlloc = {};
      let resAlloc = {};
      try { buildAlloc = JSON.parse(k.build_allocation || '{}'); } catch {}
      try { resAlloc   = JSON.parse(k.research_allocation || '{}'); } catch {}

      const topBuild = Object.entries(buildAlloc)
        .filter(([,v]) => v > 0)
        .sort((a,b) => b[1]-a[1])
        .slice(0,3)
        .map(([k,v]) => `${k}:${v}`)
        .join(', ') || 'none';

      const topResearch = Object.entries(resAlloc)
        .filter(([,v]) => v > 0)
        .sort((a,b) => b[1]-a[1])
        .slice(0,3)
        .map(([k,v]) => `${k}:${v}`)
        .join(', ') || 'none';

      rows.push({
        id: k.id, name: k.name, race: k.race, level: k.level || 1,
        land: k.land, gold: k.gold, population: k.population,
        turns_stored: k.turns_stored, morale: k.morale, food: k.food,
        fighters: k.fighters, rangers: k.rangers, mages: k.mages,
        thieves: k.thieves, ninjas: k.ninjas,
        bld_farms: k.bld_farms, bld_barracks: k.bld_barracks,
        bld_housing: k.bld_housing, bld_schools: k.bld_schools,
        res_military: k.res_military, res_economy: k.res_economy,
        res_spellbook: k.res_spellbook,
        top_build: topBuild, top_research: topResearch,
        attacks: attacks?.c || 0, covert_ops: coverts?.c || 0,
        wins: wins?.c || 0, losses: losses?.c || 0,
        times_hit: timesHit?.c || 0,
      });
    }
    res.json(rows);
  });

  // DELETE /api/admin/kingdom/:id — delete a kingdom (soft — just wipes stats)
  router.delete('/kingdom/:id', async (req, res) => {
    await db.run('DELETE FROM kingdoms WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  return router;
};
