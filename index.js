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

const AI_KINGDOMS = [
  { username: 'ai_ironforge',   kingdomName: 'Ironforge Hold',     race: 'dwarf'     },
  { username: 'ai_shadowveil',  kingdomName: 'Shadowveil Enclave', race: 'dark_elf'  },
  { username: 'ai_stormfang',   kingdomName: 'Stormfang Warpack',  race: 'dire_wolf' },
  { username: 'ai_silverwind',  kingdomName: 'Silverwind Spire',   race: 'high_elf'  },
  { username: 'ai_grimtusk',    kingdomName: 'Grimtusk Horde',     race: 'orc'       },
  { username: 'ai_ashenvale',   kingdomName: 'Ashenvale Republic', race: 'human'     },
  { username: 'ai_deepdelve',   kingdomName: 'Deepdelve Citadel',  race: 'dwarf'     },
  { username: 'ai_nightshade',  kingdomName: 'Nightshade Court',   race: 'dark_elf'  },
  { username: 'ai_bloodmoon',   kingdomName: 'Bloodmoon Clan',     race: 'orc'       },
  { username: 'ai_crystalpeak', kingdomName: 'Crystalpeak Tower',  race: 'high_elf'  },
];

async function seedAiKingdoms(db) {
  const engine = require('./game/engine');
  let seeded = 0;
  for (const ai of AI_KINGDOMS) {
    const existing = await db.get('SELECT id FROM players WHERE username = ?', [ai.username]);
    if (existing) continue;
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(Math.random().toString(36), 8);
    const player = await db.run(
      'INSERT INTO players (username, password, is_ai) VALUES (?, ?, 1)',
      [ai.username, hash]
    );
    await db.run(
      `INSERT INTO kingdoms (player_id, name, race, gold, land, population,
        researchers, engineers, rangers, turns_stored, res_spellbook,
        bld_farms, bld_schools, bld_barracks, bld_armories, bld_housing)
       VALUES (?, ?, ?, 10000, 504, 50000, 100, 100, 50, 200, 0, 200, 1, 1, 1, 100)`,
      [player.lastID, ai.kingdomName, ai.race]
    );
    seeded++;
    console.log(`[ai] Seeded: ${ai.kingdomName} (${ai.race})`);
  }
  return seeded;
}

async function processAiTurns(db) {
  const engine = require('./game/engine');
  const aiPlayers = await db.all('SELECT id FROM players WHERE is_ai = 1');
  if (aiPlayers.length === 0) return;

  // Run all AI kingdoms in parallel
  await Promise.all(aiPlayers.map(p =>
    runAiKingdom(db, engine, p.id).catch(e =>
      console.error(`[ai] error for player ${p.id}:`, e.message)
    )
  ));
  console.log(`[ai] Processed ${aiPlayers.length} AI kingdoms`);
}

async function runAiKingdom(db, engine, playerId) {
  let ai = await db.get('SELECT * FROM kingdoms WHERE player_id = ?', [playerId]);
  if (!ai || ai.turns_stored < 1) return;

  const VALID_COLS = new Set([
    'gold','mana','land','population','morale','food','turn','turns_stored',
    'fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers','scribes',
    'war_machines','weapons_stockpile','armor_stockpile',
    'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
    'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
    'bld_farms','bld_barracks','bld_schools','bld_armories','bld_vaults','bld_smithies',
    'bld_markets','bld_cathedrals','bld_training','bld_colosseums','bld_castles',
    'bld_shrines','bld_libraries',
    'build_allocation','build_progress','research_allocation','mage_tower_allocation',
    'build_queue','xp','level','troop_levels','maps','scrolls','active_effects',
    'library_progress','library_allocation',
  ]);

  async function applyK(kingdom, updates) {
    const safe = Object.fromEntries(Object.entries(updates).filter(([c,v]) =>
      VALID_COLS.has(c) && v !== undefined && v !== null
    ));
    if (Object.keys(safe).length > 0) {
      const cols = Object.keys(safe).map(c => `${c} = ?`).join(', ');
      await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safe), kingdom.id]);
    }
    return safe;
  }

  const turnsToSpend = ai.turns_stored;
  for (let i = 0; i < turnsToSpend; i++) {
    if ((ai.turns_stored || 0) < 1) break;

    // ── Process base turn — use in-memory ai state, no re-read needed ──
    const { updates } = engine.processTurn(ai);
    updates.turns_stored = ai.turns_stored - 1;

    // ── Engineer allocation — race-aware ──
    const eng = ai.engineers || 0;
    if (eng > 0) {
      const needsFarms = (ai.bld_farms || 0) < Math.floor((ai.land || 0) / 4);
      const farmPct    = needsFarms ? 0.30 : 0.15;
      const barPct     = 0.15;
      const schoolPct  = 0.10;
      const restPct    = Math.max(0, 1 - farmPct - barPct - schoolPct);
      updates.build_allocation = JSON.stringify({
        farms:      Math.floor(eng * farmPct),
        barracks:   Math.floor(eng * barPct),
        schools:    Math.floor(eng * schoolPct),
        cathedrals: (ai.race === 'high_elf' || ai.race === 'dark_elf') ? Math.floor(eng * restPct) : 0,
        markets:    (ai.race === 'dwarf'    || ai.race === 'human')     ? Math.floor(eng * restPct) : 0,
        training:   (ai.race === 'dire_wolf'|| ai.race === 'orc')       ? Math.floor(eng * restPct) : 0,
      });
    }

    // ── Research allocation ──
    const researchers = ai.researchers || 0;
    if (researchers > 0) {
      const cap  = (ai.bld_schools || 0) * 100;
      const eff  = Math.min(researchers, cap);
      const base = Math.floor(eff / 10);
      const extra = eff - base * 10;
      const focus = {
        high_elf:  { spellbook:base+extra, attack_magic:base, defense_magic:base, economy:base, weapons:base, armor:base, military:base, entertainment:base, construction:base, war_machines:base },
        dwarf:     { economy:base+extra, construction:base, war_machines:base, weapons:base, armor:base, military:base, defense_magic:base, entertainment:base, spellbook:0, attack_magic:base },
        dire_wolf: { military:base+extra, weapons:base, armor:base, economy:base, construction:base, war_machines:base, entertainment:base, defense_magic:base, attack_magic:base, spellbook:0 },
        dark_elf:  { attack_magic:base+extra, spellbook:base, defense_magic:base, economy:base, weapons:base, armor:base, military:base, entertainment:base, construction:base, war_machines:base },
        human:     { economy:base, weapons:base, armor:base, military:base, attack_magic:base, defense_magic:base, entertainment:base+extra, construction:base, war_machines:base, spellbook:base },
        orc:       { military:base+extra, weapons:base, armor:base, economy:base, war_machines:base, construction:base, entertainment:base, defense_magic:base, attack_magic:base, spellbook:0 },
      };
      updates.research_allocation = JSON.stringify(focus[ai.race] || focus.human);
    }

    // ── Mage tower allocation ──
    const towers = ai.bld_cathedrals || 0;
    const mages  = ai.mages || 0;
    if (towers > 0 && mages > 0) {
      updates.mage_tower_allocation = JSON.stringify({ mages: Math.min(mages, towers * 20) });
    }

    // Apply updates and merge back into ai state (avoids re-read)
    const applied = await applyK(ai, updates);
    Object.assign(ai, applied);

    await engine.resolveExpeditions(db, ai, engine);

    // Hire and act using current in-memory state
    await aiHire(db, engine, ai);
    await aiAction(db, engine, ai);
  }
}

async function aiHire(db, engine, ai) {
  const gold = ai.gold || 0;
  const spendable = Math.floor(gold * 0.3); // spend up to 30% of gold on hiring
  if (spendable < 250) return;

  const UNIT_COST = 250;
  const barracksCap = (ai.bld_barracks || 0) * 500;
  const currentTroops = (ai.fighters||0) + (ai.rangers||0) + (ai.clerics||0) + (ai.thieves||0) + (ai.ninjas||0);
  const barracksRoom = Math.max(0, barracksCap - currentTroops);
  if (barracksRoom <= 0) return;

  const maxAffordable = Math.min(Math.floor(spendable / UNIT_COST), barracksRoom,
    Math.floor((ai.population || 0) * 0.1));
  if (maxAffordable <= 0) return;

  // Race-based unit preference
  const unitPref = {
    high_elf:  ['clerics','mages','rangers','fighters','thieves','ninjas'],
    dwarf:     ['fighters','engineers','rangers','clerics','thieves','ninjas'],
    dire_wolf: ['fighters','rangers','clerics','ninjas','thieves','mages'],
    dark_elf:  ['ninjas','thieves','rangers','fighters','clerics','mages'],
    human:     ['fighters','rangers','clerics','thieves','ninjas','mages'],
    orc:       ['fighters','rangers','clerics','ninjas','thieves','mages'],
  }[ai.race] || ['fighters','rangers'];

  let goldLeft = spendable;
  for (const unit of unitPref) {
    if (goldLeft < UNIT_COST) break;
    // Check school/barracks caps
    if (unit === 'researchers') continue; // AI doesn't hire researchers this way
    const BARRACKS_UNITS = ['fighters','rangers','clerics','thieves','ninjas'];
    if (BARRACKS_UNITS.includes(unit) && barracksCap === 0) continue;
    const canHire = Math.min(Math.floor(goldLeft / UNIT_COST), Math.floor(maxAffordable / unitPref.length));
    if (canHire <= 0) continue;
    const result = engine.hireUnits(ai, unit, canHire);
    if (!result.error && result.updates) {
      await db.run(`UPDATE kingdoms SET gold = ?, population = ?, ${unit} = ? WHERE id = ?`,
        [result.updates.gold, result.updates.population, result.updates[unit], ai.id]);
      ai.gold = result.updates.gold;
      ai.population = result.updates.population;
      ai[unit] = result.updates[unit];
      goldLeft = ai.gold * 0.3;
    }
    break; // hire one type per tick
  }
}

async function aiAction(db, engine, ai) {
  // Only act occasionally — roughly 1 in 4 ticks to avoid spam
  if (Math.random() > 0.25) return;

  // Get potential targets — other kingdoms with land to take
  const targets = await db.all(`
    SELECT k.* FROM kingdoms k
    JOIN players p ON k.player_id = p.id
    WHERE k.id != ? AND k.land > 100
    ORDER BY RANDOM() LIMIT 5
  `, [ai.id]);

  if (targets.length === 0) return;
  const target = targets[0];

  // Give AI a map if it doesn't have one
  if ((ai.maps || 0) < 1) {
    await db.run('UPDATE kingdoms SET maps = 1 WHERE id = ?', [ai.id]);
    ai.maps = 1;
  }

  const fighters = ai.fighters || 0;
  const mages    = ai.mages    || 0;
  const ninjas   = ai.ninjas   || 0;
  const thieves  = ai.thieves  || 0;

  // Decide action based on race personality + available units
  const roll = Math.random();

  // Military attack — needs fighters
  if (fighters >= 50 && roll < 0.5) {
    const sendFighters = Math.floor(fighters * (0.4 + Math.random() * 0.3));
    const sendMages    = Math.floor(mages    * (0.3 + Math.random() * 0.2));
    const result = engine.resolveMilitaryAttack(ai, target, sendFighters, sendMages);
    if (!result.error) {
      const VALID_ATK = new Set(['gold','mana','land','fighters','mages','weapons_stockpile','xp','level','troop_levels']);
      const aSafe = Object.fromEntries(Object.entries(result.attackerUpdates).filter(([c,v]) => VALID_ATK.has(c) && v !== undefined && !isNaN(v)));
      const dSafe = Object.fromEntries(Object.entries(result.defenderUpdates).filter(([c,v]) => VALID_ATK.has(c) && v !== undefined && !isNaN(v)));
      if (Object.keys(aSafe).length) {
        const ac = Object.keys(aSafe).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${ac} WHERE id = ?`, [...Object.values(aSafe), ai.id]);
      }
      if (Object.keys(dSafe).length) {
        const dc = Object.keys(dSafe).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${dc} WHERE id = ?`, [...Object.values(dSafe), target.id]);
      }
      // News for defender only (no spam for AI attacker)
      if (result.defEvent) {
        await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
          [target.id, 'attack', result.defEvent, target.turn]);
      }
    }

  // Covert loot — needs thieves
  } else if (thieves >= 20 && roll < 0.7) {
    const lootTypes = ['gold','research','war_machines'];
    const lootType = lootTypes[Math.floor(Math.random() * lootTypes.length)];
    const result = engine.covertLoot(ai, target, lootType, Math.floor(thieves * 0.5));
    if (!result.error && result.success && result.targetUpdates) {
      const VALID_LOOT = new Set(['gold','res_economy','res_weapons','war_machines']);
      const tSafe = Object.fromEntries(Object.entries(result.targetUpdates).filter(([c,v]) => VALID_LOOT.has(c) && v !== undefined && !isNaN(v)));
      if (Object.keys(tSafe).length) {
        const tc = Object.keys(tSafe).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${tc} WHERE id = ?`, [...Object.values(tSafe), target.id]);
      }
      if (result.targetEvent) {
        await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
          [target.id, 'covert', result.targetEvent, target.turn]);
      }
    }

  // Assassination — needs ninjas
  } else if (ninjas >= 20 && roll < 0.9) {
    const unitTypes = ['fighters','researchers','engineers'];
    const unitType = unitTypes[Math.floor(Math.random() * unitTypes.length)];
    const result = engine.covertAssassinate(ai, target, Math.floor(ninjas * 0.4), unitType);
    if (!result.error && result.success && result.targetUpdates) {
      const col = unitType;
      const newVal = result.targetUpdates[col];
      if (newVal !== undefined) {
        await db.run(`UPDATE kingdoms SET ${col} = ? WHERE id = ?`, [Math.max(0, newVal), target.id]);
      }
      if (result.targetEvent) {
        await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?,?,?,?)',
          [target.id, 'covert', result.targetEvent, target.turn]);
      }
    }
  }
}

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
  // Process AI turns after regen
  try { await processAiTurns(db); } catch(e) { console.error('[ai] turn error:', e.message); }
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

  // Auto-seed AI kingdoms on boot if they don't exist
  try {
    const seeded = await seedAiKingdoms(db);
    if (seeded > 0) console.log(`[ai] Seeded ${seeded} new AI kingdoms`);
    else console.log('[ai] AI kingdoms already exist');
  } catch(e) { console.error('[ai] Seed error:', e.message); }

  // Schedule ongoing regen
  setInterval(() => runRegen(db), REGEN_MS);
  console.log('[turns] Regen timer started — +' + REGEN_AMOUNT + ' every 15 min (max ' + REGEN_MAX + ')');

  // ── Routes ────────────────────────────────────────────────────────────────────
  app.use('/api/auth',    authLimiter,  require('./routes/auth')(db));
  app.use('/api/kingdom', turnLimiter,  require('./routes/kingdom')(db));
  app.use('/api/admin',                 require('./routes/admin')(db, io));

  app.get('/api/alliance/list', requireAuth, async (req, res) => {
    const rows = await db.all(`
      SELECT a.id, a.name, k.name AS leader_name, COUNT(am.kingdom_id) as member_count
      FROM alliances a
      JOIN kingdoms k ON a.leader_id = k.id
      JOIN alliance_members am ON am.alliance_id = a.id
      GROUP BY a.id ORDER BY member_count DESC, a.name ASC
    `);
    res.json(rows);
  });

  app.get('/api/alliance/my', requireAuth, async (req, res) => {
    const kingdom = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    if (!kingdom) return res.status(404).json({ error: 'Kingdom not found' });
    const membership = await db.get('SELECT * FROM alliance_members WHERE kingdom_id = ?', [kingdom.id]);
    if (!membership) return res.json({ alliance: null });
    const alliance = await db.get('SELECT * FROM alliances WHERE id = ?', [membership.alliance_id]);
    const members = await db.all(`
      SELECT k.id, k.name, k.race, k.land, k.fighters, k.level, am.pledge
      FROM kingdoms k JOIN alliance_members am ON k.id = am.kingdom_id
      WHERE am.alliance_id = ? ORDER BY k.land DESC`, [membership.alliance_id]);
    res.json({ alliance, members, myPledge: membership.pledge, isLeader: alliance.leader_id === kingdom.id });
  });

  app.post('/api/alliance/pledge', requireAuth, async (req, res) => {
    const kingdom = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    const { pledge } = req.body;
    const p = Math.max(0, Math.min(10, Number(pledge) || 3));
    await db.run('UPDATE alliance_members SET pledge = ? WHERE kingdom_id = ?', [p, kingdom.id]);
    res.json({ ok: true, pledge: p });
  });

  app.post('/api/alliance/dismiss', requireAuth, async (req, res) => {
    const kingdom = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [req.player.playerId]);
    const alliance = await db.get('SELECT * FROM alliances WHERE leader_id = ?', [kingdom.id]);
    if (!alliance) return res.status(403).json({ error: 'Only leader can dismiss members' });
    const { targetKingdomId } = req.body;
    if (targetKingdomId === kingdom.id) return res.status(400).json({ error: 'Cannot dismiss yourself' });
    await db.run('DELETE FROM alliance_members WHERE kingdom_id = ? AND alliance_id = ?', [targetKingdomId, alliance.id]);
    res.json({ ok: true });
  });

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
      SELECT cm.id, cm.message, cm.created_at, cm.username,
             p.is_chat_mod, p.is_admin, k.race
      FROM chat_messages cm
      JOIN players p ON cm.player_id = p.id
      JOIN kingdoms k ON cm.kingdom_id = k.id
      WHERE cm.room = ? AND cm.deleted = 0
      ORDER BY cm.created_at DESC LIMIT 80`, [req.params.room]);
    res.json(msgs.reverse());
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

  // Admin: seed or reset AI kingdoms
  app.post('/api/admin/seed-ai', async (req, res) => {
    try {
      const seeded = await seedAiKingdoms(db);
      res.json({ ok: true, seeded, message: seeded > 0 ? `Seeded ${seeded} AI kingdoms` : 'All AI kingdoms already exist' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/reset-ai', async (req, res) => {
    try {
      const aiPlayers = await db.all('SELECT id FROM players WHERE is_ai = 1');
      for (const p of aiPlayers) {
        const k = await db.get('SELECT id FROM kingdoms WHERE player_id = ?', [p.id]);
        if (k) await db.run(`UPDATE kingdoms SET
          gold=10000, mana=0, land=504, population=50000, food=0, morale=100,
          turn=0, turns_stored=200, fighters=0, rangers=50, clerics=0, mages=0,
          thieves=0, ninjas=0, researchers=100, engineers=100, scribes=0,
          war_machines=0, weapons_stockpile=0, armor_stockpile=0,
          bld_farms=200, bld_barracks=1, bld_schools=1, bld_armories=1,
          bld_housing=100, bld_outposts=0, bld_guard_towers=0, bld_vaults=0,
          bld_smithies=0, bld_markets=0, bld_cathedrals=0, bld_training=0,
          bld_colosseums=0, bld_castles=0, bld_shrines=0, bld_libraries=0,
          res_economy=100, res_weapons=100, res_armor=100, res_military=100,
          res_attack_magic=100, res_defense_magic=100, res_entertainment=100,
          res_construction=100, res_war_machines=100, res_spellbook=0,
          xp=0, level=1, research_allocation='{}', build_allocation='{}',
          build_queue='{}', scrolls='{}', maps=0, blueprints_stored=0, active_effects='{}'
          WHERE id = ?`, [k.id]);
      }
      res.json({ ok: true, reset: aiPlayers.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

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
