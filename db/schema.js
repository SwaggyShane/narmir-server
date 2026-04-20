// src/db/schema.js
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
      res_economy       INTEGER NOT NULL DEFAULT 100,
      res_weapons       INTEGER NOT NULL DEFAULT 100,
      res_armor         INTEGER NOT NULL DEFAULT 100,
      res_military      INTEGER NOT NULL DEFAULT 100,
      res_spellbook     INTEGER NOT NULL DEFAULT 500,
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
      war_machines INTEGER NOT NULL DEFAULT 0,
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
    CREATE INDEX IF NOT EXISTS idx_news_kingdom    ON news(kingdom_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_combat_attacker ON combat_log(attacker_id);
    CREATE INDEX IF NOT EXISTS idx_combat_defender ON combat_log(defender_id);
    CREATE INDEX IF NOT EXISTS idx_chat_room       ON chat_messages(room, created_at);
  `);

  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialised — call initDb() first');
  return _db;
}

module.exports = { initDb, getDb };
