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

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      is_admin    INTEGER NOT NULL DEFAULT 0,
      is_banned   INTEGER NOT NULL DEFAULT 0,
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
      bld_training      INTEGER NOT NULL DEFAULT 0,
      bld_colosseums    INTEGER NOT NULL DEFAULT 0,
      bld_castles       INTEGER NOT NULL DEFAULT 0,
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
      turns_stored      INTEGER NOT NULL DEFAULT 200,
      research_allocation TEXT NOT NULL DEFAULT '{}',
      build_queue       TEXT NOT NULL DEFAULT '{}',
      build_progress    TEXT NOT NULL DEFAULT '{}',
      build_allocation  TEXT NOT NULL DEFAULT '{}',
      tools_hammers     INTEGER NOT NULL DEFAULT 0,
      tools_scaffolding INTEGER NOT NULL DEFAULT 0,
      tools_blueprints  INTEGER NOT NULL DEFAULT 0,
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

  const cols = (await _db.all('PRAGMA table_info(kingdoms)')).map(c => c.name);
  if (!cols.includes('turns_stored'))        await addColumn('kingdoms', 'turns_stored',        'INTEGER NOT NULL DEFAULT 200');
  if (!cols.includes('research_allocation')) await addColumn('kingdoms', 'research_allocation', "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('build_queue'))         await addColumn('kingdoms', 'build_queue',         "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('build_progress'))      await addColumn('kingdoms', 'build_progress',      "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('build_allocation'))    await addColumn('kingdoms', 'build_allocation',    "TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('tools_hammers'))       await addColumn('kingdoms', 'tools_hammers',       'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('tools_scaffolding'))   await addColumn('kingdoms', 'tools_scaffolding',   'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('tools_blueprints'))    await addColumn('kingdoms', 'tools_blueprints',    'INTEGER NOT NULL DEFAULT 0');;
  if (!cols.includes('weapons_stockpile'))   await addColumn('kingdoms', 'weapons_stockpile',   'INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('armor_stockpile'))     await addColumn('kingdoms', 'armor_stockpile',     'INTEGER NOT NULL DEFAULT 0');

  const pCols = (await _db.all('PRAGMA table_info(players)')).map(c => c.name);
  if (!pCols.includes('is_admin'))   await addColumn('players', 'is_admin',   'INTEGER NOT NULL DEFAULT 0');
  if (!pCols.includes('is_banned'))  await addColumn('players', 'is_banned',  'INTEGER NOT NULL DEFAULT 0');
  if (!pCols.includes('ban_reason')) await addColumn('players', 'ban_reason', 'TEXT');

  const nCols = (await _db.all('PRAGMA table_info(news)')).map(c => c.name);
  if (!nCols.includes('turn_num')) await addColumn('news', 'turn_num', 'INTEGER NOT NULL DEFAULT 0');

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
