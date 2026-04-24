const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../narmir.db');

let _db = null;

async function initDb() {
  if (_db) return _db;

  _db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  await _db.exec('PRAGMA journal_mode = WAL');
  await _db.exec('PRAGMA foreign_keys = ON');
  await _db.exec('PRAGMA cache_size = -32000');     // 32MB page cache
  await _db.exec('PRAGMA synchronous = NORMAL');    // safe with WAL, much faster than FULL
  await _db.exec('PRAGMA temp_store = MEMORY');     // temp tables in RAM
  await _db.exec('PRAGMA mmap_size = 134217728');   // 128MB memory-mapped I/O

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      is_admin    INTEGER NOT NULL DEFAULT 0,
      is_banned   INTEGER NOT NULL DEFAULT 0,
      is_ai       INTEGER NOT NULL DEFAULT 0,
      ban_reason  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS kingdoms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id   INTEGER NOT NULL UNIQUE REFERENCES players(id),
      name        TEXT    NOT NULL,
      race        TEXT    NOT NULL DEFAULT 'human',
      gold        INTEGER NOT NULL DEFAULT 10000,
      land        INTEGER NOT NULL DEFAULT 500,
      population  INTEGER NOT NULL DEFAULT 50000,
      morale      INTEGER NOT NULL DEFAULT 100,
      tax         INTEGER NOT NULL DEFAULT 42,
      mana        INTEGER NOT NULL DEFAULT 5000,
      food        INTEGER NOT NULL DEFAULT 0,
      turn        INTEGER NOT NULL DEFAULT 0,
      last_turn_at INTEGER NOT NULL DEFAULT (unixepoch()),
      turns_stored INTEGER NOT NULL DEFAULT 200,
      res_economy       INTEGER NOT NULL DEFAULT 100,
      res_weapons       INTEGER NOT NULL DEFAULT 100,
      res_armor         INTEGER NOT NULL DEFAULT 100,
      res_military      INTEGER NOT NULL DEFAULT 100,
      res_spellbook     INTEGER NOT NULL DEFAULT 0,
      res_attack_magic  INTEGER NOT NULL DEFAULT 100,
      res_defense_magic INTEGER NOT NULL DEFAULT 100,
      res_entertainment INTEGER NOT NULL DEFAULT 100,
      res_construction  INTEGER NOT NULL DEFAULT 100,
      res_war_machines  INTEGER NOT NULL DEFAULT 100,
      bld_farms         INTEGER NOT NULL DEFAULT 200,
      bld_barracks      INTEGER NOT NULL DEFAULT 0,
      bld_outposts      INTEGER NOT NULL DEFAULT 0,
      bld_guard_towers  INTEGER NOT NULL DEFAULT 0,
      bld_schools       INTEGER NOT NULL DEFAULT 0,
      bld_armories      INTEGER NOT NULL DEFAULT 0,
      bld_vaults        INTEGER NOT NULL DEFAULT 0,
      bld_smithies      INTEGER NOT NULL DEFAULT 0,
      bld_markets       INTEGER NOT NULL DEFAULT 0,
      bld_cathedrals    INTEGER NOT NULL DEFAULT 0,
      bld_shrines       INTEGER NOT NULL DEFAULT 0,
      mage_tower_allocation TEXT NOT NULL DEFAULT '{}',
      shrine_allocation TEXT NOT NULL DEFAULT '{}',
      bld_training      INTEGER NOT NULL DEFAULT 0,
      bld_colosseums    INTEGER NOT NULL DEFAULT 0,
      bld_castles       INTEGER NOT NULL DEFAULT 0,
      bld_housing       INTEGER NOT NULL DEFAULT 100,
      fighters    INTEGER NOT NULL DEFAULT 0,
      rangers     INTEGER NOT NULL DEFAULT 0,
      clerics     INTEGER NOT NULL DEFAULT 0,
      mages       INTEGER NOT NULL DEFAULT 0,
      thieves     INTEGER NOT NULL DEFAULT 0,
      ninjas      INTEGER NOT NULL DEFAULT 0,
      researchers INTEGER NOT NULL DEFAULT 0,
      engineers   INTEGER NOT NULL DEFAULT 0,
      war_machines     INTEGER NOT NULL DEFAULT 0,
      weapons_stockpile INTEGER NOT NULL DEFAULT 0,
      armor_stockpile   INTEGER NOT NULL DEFAULT 0,
      research_allocation TEXT NOT NULL DEFAULT '{}',
      build_queue       TEXT NOT NULL DEFAULT '{}',
      build_progress    TEXT NOT NULL DEFAULT '{}',
      build_allocation  TEXT NOT NULL DEFAULT '{}',
      tools_hammers     INTEGER NOT NULL DEFAULT 0,
      tools_scaffolding INTEGER NOT NULL DEFAULT 0,
      tools_blueprints  INTEGER NOT NULL DEFAULT 0,
      xp                INTEGER NOT NULL DEFAULT 0,
      level             INTEGER NOT NULL DEFAULT 1,
      troop_levels      TEXT NOT NULL DEFAULT '{}',
      training_allocation TEXT NOT NULL DEFAULT '{}',
      scribes     INTEGER NOT NULL DEFAULT 0,
      bld_libraries     INTEGER NOT NULL DEFAULT 0,
      library_allocation TEXT NOT NULL DEFAULT '{}',
      library_progress   TEXT NOT NULL DEFAULT '{}',
      scrolls           TEXT NOT NULL DEFAULT '{}',
      maps              INTEGER NOT NULL DEFAULT 0,
      blueprints_stored INTEGER NOT NULL DEFAULT 0,
      active_effects    TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS alliances (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      leader_id   INTEGER NOT NULL REFERENCES kingdoms(id),
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS alliance_members (
      alliance_id INTEGER NOT NULL REFERENCES alliances(id),
      kingdom_id  INTEGER NOT NULL REFERENCES kingdoms(id),
      pledge      INTEGER NOT NULL DEFAULT 3,
      joined_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (alliance_id, kingdom_id)
    );
    CREATE TABLE IF NOT EXISTS news (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kingdom_id  INTEGER NOT NULL REFERENCES kingdoms(id),
      type        TEXT    NOT NULL,
      message     TEXT    NOT NULL,
      turn_num    INTEGER NOT NULL DEFAULT 0,
      is_read     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS war_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type     TEXT    NOT NULL,
      attacker_id     INTEGER REFERENCES kingdoms(id),
      attacker_name   TEXT,
      defender_id     INTEGER REFERENCES kingdoms(id),
      defender_name   TEXT,
      outcome         TEXT    NOT NULL,
      detail          TEXT,
      obscured        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_war_log_time ON war_log(created_at DESC);
    CREATE TABLE IF NOT EXISTS expeditions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kingdom_id  INTEGER NOT NULL REFERENCES kingdoms(id),
      type        TEXT    NOT NULL,
      turns_left  INTEGER NOT NULL,
      rangers     INTEGER NOT NULL DEFAULT 0,
      fighters    INTEGER NOT NULL DEFAULT 0,
      rewards     TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_exp_kingdom ON expeditions(kingdom_id);
    CREATE TABLE IF NOT EXISTS combat_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      attacker_id     INTEGER NOT NULL REFERENCES kingdoms(id),
      defender_id     INTEGER NOT NULL REFERENCES kingdoms(id),
      type            TEXT    NOT NULL,
      attacker_won    INTEGER NOT NULL DEFAULT 0,
      land_transferred INTEGER NOT NULL DEFAULT 0,
      detail          TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kingdom_id  INTEGER NOT NULL REFERENCES kingdoms(id),
      room        TEXT    NOT NULL DEFAULT 'global',
      message     TEXT    NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS server_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_kingdom    ON news(kingdom_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_combat_attacker ON combat_log(attacker_id);
    CREATE INDEX IF NOT EXISTS idx_combat_defender ON combat_log(defender_id);
    CREATE INDEX IF NOT EXISTS idx_chat_room       ON chat_messages(room, created_at);
    CREATE INDEX IF NOT EXISTS idx_kingdoms_player ON kingdoms(player_id);
    CREATE INDEX IF NOT EXISTS idx_kingdoms_land   ON kingdoms(land DESC);
    CREATE INDEX IF NOT EXISTS idx_expeditions_kingdom ON expeditions(kingdom_id, turns_left);
    CREATE INDEX IF NOT EXISTS idx_war_log_defender ON war_log(defender_id);
    CREATE INDEX IF NOT EXISTS idx_news_turn        ON news(kingdom_id, turn_num DESC);
  `);

  // ── Migrations — safe, idempotent, never crash on duplicate ─────────────────
  async function addColumn(table, col, def) {
    try {
      await _db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      console.log(`[db] Migration: added ${col} to ${table}`);
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }

  // Ensure key indexes exist
  await _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_kingdoms_player ON kingdoms(player_id);
    CREATE INDEX IF NOT EXISTS idx_kingdoms_land   ON kingdoms(land DESC);
    CREATE INDEX IF NOT EXISTS idx_news_created    ON news(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_exp_turns       ON expeditions(turns_left);
  `);

  const cols = (await _db.all('PRAGMA table_info(kingdoms)')).map(c => c.name);
  if (!cols.includes('turns_stored'))        await addColumn('kingdoms', 'turns_stored',        'INTEGER NOT NULL DEFAULT 200');
  if (!cols.includes('research_allocation')) await addColumn('kingdoms', 'research_allocation', "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('build_queue'))         await addColumn('kingdoms', 'build_queue',         "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('build_progress'))      await addColumn('kingdoms', 'build_progress',      "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('build_allocation'))    await addColumn('kingdoms', 'build_allocation',    "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('tools_hammers'))       await addColumn('kingdoms', 'tools_hammers',       'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('tools_scaffolding'))   await addColumn('kingdoms', 'tools_scaffolding',   'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('tools_blueprints'))    await addColumn('kingdoms', 'tools_blueprints',    'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('xp'))                  await addColumn('kingdoms', 'xp',                  'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('level'))               await addColumn('kingdoms', 'level',               'INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('troop_levels'))        await addColumn('kingdoms', 'troop_levels',        "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('training_allocation')) await addColumn('kingdoms', 'training_allocation', "TEXT NOT NULL DEFAULT '{}'"  );;
  if (!cols.includes('weapons_stockpile'))   await addColumn('kingdoms', 'weapons_stockpile',   'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('armor_stockpile'))     await addColumn('kingdoms', 'armor_stockpile',     'INTEGER NOT NULL DEFAULT 0');

  const pCols = (await _db.all('PRAGMA table_info(players)')).map(c => c.name);
  if (!pCols.includes('is_admin'))   await addColumn('players', 'is_admin',   'INTEGER NOT NULL DEFAULT 0');
  if (!pCols.includes('is_banned'))  await addColumn('players', 'is_banned',  'INTEGER NOT NULL DEFAULT 0');
  if (!pCols.includes('ban_reason')) await addColumn('players', 'ban_reason', 'TEXT');
  if (!pCols.includes('is_ai'))      await addColumn('players', 'is_ai',      'INTEGER NOT NULL DEFAULT 0');

  const nCols = (await _db.all('PRAGMA table_info(news)')).map(c => c.name);
  if (!nCols.includes('turn_num')) await addColumn('news', 'turn_num', 'INTEGER NOT NULL DEFAULT 0');

  if (!pCols.includes('is_chat_mod'))  await addColumn('players', 'is_chat_mod',  'INTEGER NOT NULL DEFAULT 0');
  if (!pCols.includes('chat_banned'))  await addColumn('players', 'chat_banned',  'INTEGER NOT NULL DEFAULT 0');
  if (!pCols.includes('chat_ban_reason')) await addColumn('players', 'chat_ban_reason', 'TEXT');

  const cmCols = (await _db.all('PRAGMA table_info(chat_messages)')).map(c => c.name);
  if (!cmCols.includes('username')) await addColumn('chat_messages', 'username', 'TEXT NOT NULL DEFAULT \'\'');
  if (!cmCols.includes('player_id')) await addColumn('chat_messages', 'player_id', 'INTEGER NOT NULL DEFAULT 0');
  if (!cmCols.includes('deleted'))  await addColumn('chat_messages', 'deleted',  'INTEGER NOT NULL DEFAULT 0');

  if (!cols.includes('hammer_turns_used'))    await addColumn('kingdoms', 'hammer_turns_used',    'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('smithy_allocation'))    await addColumn('kingdoms', 'smithy_allocation',    "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('bld_housing'))             await addColumn('kingdoms', 'bld_housing',             'INTEGER NOT NULL DEFAULT 100');
  if (!cols.includes('mage_tower_allocation'))   await addColumn('kingdoms', 'mage_tower_allocation',   "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('shrine_allocation'))       await addColumn('kingdoms', 'shrine_allocation',       "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('scribes'))             await addColumn('kingdoms', 'scribes',             'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('bld_libraries'))       await addColumn('kingdoms', 'bld_libraries',       'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('library_allocation'))  await addColumn('kingdoms', 'library_allocation',  "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('library_progress'))    await addColumn('kingdoms', 'library_progress',    "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('scrolls'))             await addColumn('kingdoms', 'scrolls',             "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('maps'))                await addColumn('kingdoms', 'maps',                'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('blueprints_stored'))   await addColumn('kingdoms', 'blueprints_stored',   'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('active_effects'))      await addColumn('kingdoms', 'active_effects',      "TEXT NOT NULL DEFAULT '{}'");

  // Ensure war_log table exists on older DBs
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS war_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type     TEXT    NOT NULL,
      attacker_id     INTEGER REFERENCES kingdoms(id),
      attacker_name   TEXT,
      defender_id     INTEGER REFERENCES kingdoms(id),
      defender_name   TEXT,
      outcome         TEXT    NOT NULL,
      detail          TEXT,
      obscured        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_war_log_time ON war_log(created_at DESC);
  `);

  // Seed default server_state row for regen tracking
  await _db.run(`
    INSERT OR IGNORE INTO server_state (key, value)
    VALUES ('last_regen_at', CAST(unixepoch() AS TEXT))
  `);

  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialised — call initDb() first');
  return _db;
}

module.exports = { initDb, getDb };
