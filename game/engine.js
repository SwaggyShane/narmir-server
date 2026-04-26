// src/game/engine.js
// Pure game logic — no I/O, no socket calls.
// All functions take a kingdom row (or rows) and return mutations + events.

const RACE_BONUSES = {
  high_elf:  { research: 1.15, magic: 1.20, economy: 1.05, military: 0.90 },
  dwarf:     { construction: 1.20, war_machines: 1.25, economy: 1.202, magic: 0.75, research: 0.90 },
  dire_wolf: { military: 1.30, covert: 1.10, research: 0.70, magic: 0.60, economy: 0.70 },
  dark_elf:  { covert: 1.25, stealth: 1.30, magic: 1.10, military: 0.85, economy: 0.90 },
  human:     { economy: 1.05 },
  orc:       { military: 1.20, economy: 1.10, research: 0.80, magic: 0.65, construction: 0.90 },
};

// Named regions — one per race, each with a passive bonus stacking on top of race bonuses
const REGION_DATA = {
  dwarf:     { name: 'The Iron Holds',      bonus: 'construction', mult: 0.05, lore: 'Ancient mountain citadels carved from living rock, where forge-fires have burned unbroken for a thousand years.' },
  high_elf:  { name: 'The Silverwood',      bonus: 'magic',        mult: 0.05, lore: 'A vast enchanted forest where moonlight pools in crystal streams and every leaf hums with residual arcane power.' },
  orc:       { name: 'The Bloodplains',     bonus: 'military',     mult: 0.05, lore: 'Endless scarred steppe where the ground itself is soaked with the memory of ten thousand wars.' },
  dark_elf:  { name: 'The Underspire',      bonus: 'stealth',      mult: 0.05, lore: 'A labyrinthine underground city of obsidian towers and shadow-markets, where every corridor hides a blade.' },
  human:     { name: 'The Heartlands',      bonus: 'economy',      mult: 0.05, lore: 'Fertile central plains criss-crossed by ancient trade roads, where every crossroads is a kingdom in miniature.' },
  dire_wolf: { name: 'The Ashfang Wilds',   bonus: 'military',     mult: 0.05, lore: 'Primal wilderness of ash-grey forest and howling ravines, where only the strong survive the first winter.' },
};

// Assign region to a kingdom by race
function assignRegion(race) {
  return REGION_DATA[race]?.name || 'The Unknown Lands';
}

const UNIT_COST = 250;
const MAX_RESEARCHERS = 1_000_000;
const MAX_RESEARCH = 1000; // percent cap for most disciplines

// ── Helpers ──────────────────────────────────────────────────────────────────

function raceBonus(kingdom, stat) {
  const bonuses = RACE_BONUSES[kingdom.race] || {};
  const base = bonuses[stat] || 1.0;
  // Region bonus — +5% to the region's designated stat
  const region = REGION_DATA[kingdom.race];
  const regionMult = (region && region.bonus === stat) ? (1 + region.mult) : 1.0;
  return base * regionMult;
}

function goldPerTurn(k) {
  const baseRate    = Math.floor((k.land||0) * ((k.tax||40) / 100) * ((k.res_economy||100) / 100));
  const castleBonus = Math.floor((k.bld_castles||0) / 500) * 500;
  const econBonus   = raceBonus(k, 'economy');
  const mktIncome   = marketIncomeFull(k);
  return Math.floor((baseRate + castleBonus) * econBonus * 2.25) + mktIncome;
}

function manaPerTurn(k) {
  // Base mana by race — everyone gets some, magic races get more
  const raceManaBase = {
    high_elf: 8, dark_elf: 6, human: 3, dwarf: 2, orc: 2, dire_wolf: 1,
  }[k.race] || 3;

  // Mage tower base: each tower = 5 base mana
  const towerMana = (k.bld_cathedrals || 0) * 5;

  // Mages allocated to tower: 1 mana per 5 mages
  let towerAlloc = {};
  try { towerAlloc = JSON.parse(k.mage_tower_allocation || '{}'); } catch { towerAlloc = {}; }
  const magesInTower = Math.min(Number(towerAlloc.mages) || 0, k.mages || 0);
  const capacity = (k.bld_cathedrals || 0) * 20;
  const effectiveMages = Math.min(magesInTower, capacity);
  const mageMana = Math.floor(effectiveMages / 5);

  return Math.floor((raceManaBase + towerMana + mageMana) * raceBonus(k, 'magic'));
}

function foodBalance(k) {
  return farmProduction(k) - foodConsumption(k);
}

// Race-specific population per housing building
const HOUSING_CAP_BY_RACE = {
  dwarf:     650,  // +30% — master builders, compact stone halls
  orc:       600,  // +20% — pack together, unbothered by cramped conditions
  human:     500,  // baseline
  dark_elf:  450,  // -10% — selective underground warrens
  high_elf:  350,  // -30% — require spacious dwellings
  dire_wolf: 700,  // +40% — den living, natural pack animals
};

function housingCapPerBuilding(race) {
  return HOUSING_CAP_BY_RACE[race] || 500;
}

function popGrowth(k) {
  if (k.morale < 30) return -Math.floor(k.population * 0.02);

  const capPerBuilding = housingCapPerBuilding(k.race);
  const housingCap = (k.bld_housing || 0) * capPerBuilding;
  const pop = k.population || 0;

  let growthMult = 1.0;
  if (housingCap > 0 && pop >= housingCap * 2) return 0;
  if (housingCap > 0 && pop > housingCap) growthMult = 0.10;

  const base = Math.floor(pop * 0.003);
  const entertainment = Math.floor(k.res_entertainment / 100) * 10;
  const raceGrowthMult = {
    high_elf: 0.80, dwarf: 0.90, dire_wolf: 1.00,
    dark_elf: 0.85, human: 1.15, orc: 1.10,
  }[k.race] || 1.0;
  return Math.floor((base + entertainment) * raceGrowthMult * growthMult);
}

function researchIncrement(k, discipline, researchersAssigned) {
  const schoolBonus    = 1 + (Math.floor(k.bld_schools / 5) * 0.02);
  const raceMulti      = discipline === 'spellbook' ? raceBonus(k, 'magic') : raceBonus(k, 'research');
  const resLevelMult   = unitLevelMult(k, 'researchers');
  const effective = Math.floor(researchersAssigned * schoolBonus * raceMulti * resLevelMult);
  if (effective >= 2000) return 5;
  if (effective >= 1200) return 3;
  if (effective >= 600)  return 2;
  if (effective >= 200)  return 1;
  return 0;
}

// ── Troop levelling ───────────────────────────────────────────────────────────

// XP needed to reach each troop level (1-100)
// Early levels fast, late levels very slow
function troopXpForLevel(level) {
  if (level <= 1)  return 0;
  if (level <= 10) return level * 100;
  if (level <= 25) return level * 300;
  if (level <= 50) return level * 800;
  if (level <= 75) return level * 2000;
  return level * 5000;
}

// Race training bonuses — which races train which troop types faster
// These can push effective level beyond 100 in combat calculations
const TROOP_RACE_BONUS = {
  high_elf:  { clerics: 1.5, mages: 1.5, researchers: 1.3 },
  dwarf:     { fighters: 1.3, engineers: 1.5 },
  dire_wolf: { fighters: 1.8, rangers: 1.5 },
  dark_elf:  { ninjas: 1.8, thieves: 1.5, rangers: 1.3 },
  human:     { fighters: 1.1, rangers: 1.1, clerics: 1.1, mages: 1.1, thieves: 1.1, ninjas: 1.1 },
  orc:       { fighters: 1.6, clerics: 1.2 },
};

// Get effective troop level including invisible race bonus (used in combat)
function effectiveTroopLevel(k, unit) {
  let troopLevels = {};
  try { troopLevels = JSON.parse(k.troop_levels || '{}'); } catch { troopLevels = {}; }
  const data = troopLevels[unit] || { level: 1 };
  const raceBonus = TROOP_RACE_BONUS[k.race]?.[unit] || 1.0;
  // Race bonus multiplies above level 100 — a Dark Elf ninja at level 100 acts as level 180
  const effectiveLevel = data.level < 100
    ? data.level
    : Math.floor(100 + (data.level - 100) * raceBonus);
  return Math.max(1, Math.floor(data.level * (data.level >= 100 ? raceBonus : 1 + (raceBonus - 1) * data.level / 100)));
}

// Award XP to a specific troop type — returns updated troop_levels JSON and any level-ups
function awardTroopXp(k, unit, xpAmount) {
  let troopLevels = {};
  try { troopLevels = JSON.parse(k.troop_levels || '{}'); } catch { troopLevels = {}; }
  const current = troopLevels[unit] || { level: 1, xp: 0, count: 0 };
  const cap = 100;
  if (current.level >= cap) return { troop_levels: JSON.stringify(troopLevels), levelUps: [] };

  const raceBonus = TROOP_RACE_BONUS[k.race]?.[unit] || 1.0;
  const earned = Math.floor(xpAmount * raceBonus);
  const newXp = current.xp + earned;
  const xpNeeded = troopXpForLevel(current.level + 1);
  const levelUps = [];

  if (newXp >= xpNeeded && current.level < cap) {
    troopLevels[unit] = { level: current.level + 1, xp: newXp - xpNeeded, count: current.count };
    levelUps.push(`${unit} reached Level ${current.level + 1}`);
  } else {
    // Store XP within current level only (mod the threshold to prevent overflow)
    troopLevels[unit] = { ...current, xp: Math.min(newXp, xpNeeded - 1) };
  }
  return { troop_levels: JSON.stringify(troopLevels), levelUps };
}

// ── Unit level scaling ────────────────────────────────────────────────────────
// Returns effectiveness multiplier: +0.5% per level above 1, caps at +50% at level 100
function unitLevelMult(k, unit) {
  const level = effectiveTroopLevel(k, unit);
  return 1 + Math.min(0.50, (level - 1) * 0.005);
}

// ── Racial unique bonuses (unlocked at unit level 5+) ─────────────────────────
function racialUnitBonus(k, unit) {
  const level = effectiveTroopLevel(k, unit);
  if (level < 5) return {};
  const race = k.race;
  // Dwarf: 1 engineer can solo-crew a war machine
  if (race === 'dwarf'     && unit === 'engineers') return { warMachineSoloCrew: true };
  // High Elf: scroll crafting produces 2 scrolls instead of 1
  if (race === 'high_elf'  && unit === 'mages')     return { doubleScrolls: true };
  // Orc: every 10 fighters trains 1 free fighter per turn
  if (race === 'orc'       && unit === 'fighters')  return { freeTrainees: Math.floor((k.fighters||0) / 10) };
  // Dark Elf: assassinations leave no trace — target gets no news
  if (race === 'dark_elf'  && unit === 'ninjas')    return { silentAssassination: true };
  // Dire Wolf: expeditions return 1 turn early
  if (race === 'dire_wolf' && unit === 'rangers')   return { earlyReturn: true };
  // Human: clerics restore 1 morale across all unit types per turn
  if (race === 'human'     && unit === 'clerics')   return { auraHeal: true };
  return {};
}

// ── Dilute troop XP when new units are hired ──────────────────────────────────
// new_avg_xp = (old_xp × old_count) / (old_count + hired)
function diluteTroopXp(k, unit, hired) {
  if (!hired || hired <= 0) return null;
  let troopLevels = {};
  try { troopLevels = JSON.parse(k.troop_levels || '{}'); } catch {}
  const current = troopLevels[unit] || { level: 1, xp: 0, count: k[unit] || 0 };
  const oldCount = Math.max(1, current.count || k[unit] || 1);
  const totalXp  = current.xp + troopXpForLevel(current.level); // total absolute XP
  const newCount = oldCount + hired;
  const newAvgXp = Math.floor((totalXp * oldCount) / newCount);
  // Recompute level from new average XP
  let newLevel = 1;
  while (newLevel < 100 && newAvgXp >= troopXpForLevel(newLevel + 1)) newLevel++;
  const xpIntoLevel = newAvgXp - troopXpForLevel(newLevel);
  troopLevels[unit] = { level: newLevel, xp: Math.max(0, xpIntoLevel), count: newCount };
  return JSON.stringify(troopLevels);
}

// ── Award activity XP to a unit type ─────────────────────────────────────────
// Wraps awardTroopXp, applies race bonus, returns updated troop_levels string
function awardUnitXp(k, unit, xpAmount) {
  if (!xpAmount || xpAmount <= 0 || !(k[unit] > 0)) return null;
  return awardTroopXp(k, unit, xpAmount).troop_levels;
}

// ── Economy system ────────────────────────────────────────────────────────────

const FARM_YIELD_MULT       = { human:1.00, dwarf:0.90, high_elf:1.15, orc:0.85, dark_elf:0.95, dire_wolf:0.80 };
const FARM_WORKERS_PER      = { human:10,   dwarf:8,    high_elf:12,   orc:15,   dark_elf:10,   dire_wolf:12   };
const FOOD_CONSUMPTION_MULT = { human:1.00, dwarf:0.85, high_elf:0.80, orc:1.35, dark_elf:0.95, dire_wolf:1.40 };
const MARKET_INCOME_MULT    = { human:1.00, dwarf:1.25, high_elf:1.10, orc:0.85, dark_elf:1.05, dire_wolf:0.75 };
const TRADE_RATE_MULT       = { human:1.00, dwarf:1.15, high_elf:1.20, orc:0.80, dark_elf:1.30, dire_wolf:0.70 };

const COMMODITY_VALUES = { food:2, weapons:6, armor:8, mana:4, maps:50, scrolls:200, blueprints:150 };
const COMMODITY_RACE_DISCOUNT = {
  dwarf:    { weapons:0.85, armor:0.85 },
  high_elf: { scrolls:0.80, mana:0.85 },
  dark_elf: { _all:0.90 },
  orc:      { food:1.20 },
  dire_wolf:{ maps:0.80 },
  human:    {},
};

const FARM_UPGRADES = {
  irrigated:  { name:'Irrigated Farm', cost:500,   yieldBonus:0.30, requires:null         },
  granary:    { name:'Granary',        cost:2000,  bufferTurns:10,  requires:null         },
  plantation: { name:'Plantation',     cost:10000, yieldBonus:0.60, requires:'irrigated'  },
};
const MARKET_UPGRADES = {
  trading_post: { name:'Trading Post', cost:5000,  unlocksTrade:true,      requires:null            },
  bazaar:       { name:'Bazaar',       cost:50000, incomeBonus:0.50,       requires:'trading_post'  },
  black_market: { name:'Black Market', cost:15000, raceOnly:'dark_elf',    requires:'trading_post'  },
};
const TAVERN_UPGRADES = {
  inn:        { name:'Inn',        cost:8000,  unlocksMercTier:'sellsword', requires:null  },
  guild_hall: { name:'Guild Hall', cost:30000, unlocksMercTier:'veteran',   requires:'inn' },
};
const MERC_TIERS = {
  rabble:    { levelMin:5,  levelMax:10, costPer:50,   duration:10, upkeepPct:0.25, requires:null         },
  sellsword: { levelMin:15, levelMax:25, costPer:150,  duration:20, upkeepPct:0.25, requires:'inn'        },
  veteran:   { levelMin:30, levelMax:45, costPer:400,  duration:30, upkeepPct:0.25, requires:'guild_hall' },
  elite:     { levelMin:50, levelMax:65, costPer:1000, duration:40, upkeepPct:0.25, requires:'guild_hall' },
};

function totalHiredUnits(k) {
  return (k.fighters||0)+(k.rangers||0)+(k.clerics||0)+(k.mages||0)+(k.thieves||0)+(k.ninjas||0)+(k.researchers||0)+(k.engineers||0)+(k.scribes||0);
}

function farmProduction(k) {
  const farms = k.bld_farms || 0;
  if (!farms) return 0;
  let upgrades = {};
  try { upgrades = JSON.parse(k.farm_upgrades || '{}'); } catch {}
  const race         = k.race || 'human';
  const workersNeeded = FARM_WORKERS_PER[race] || 10;
  const freePop       = Math.max(0, (k.population||0) - totalHiredUnits(k));
  const workedFarms   = Math.min(farms, Math.floor(freePop / workersNeeded));
  let   baseYield     = workedFarms * 10 * (FARM_YIELD_MULT[race] || 1.0);
  if (upgrades.irrigated)  baseYield *= 1.30;
  if (upgrades.plantation) baseYield *= 1.60;
  return Math.floor(baseYield);
}

function foodConsumption(k) {
  const race   = k.race || 'human';
  const mult   = FOOD_CONSUMPTION_MULT[race] || 1.0;
  const troops = totalHiredUnits(k);
  const pop    = Math.floor((k.population||0) / 100);
  return Math.floor((troops + pop) * mult);
}

function marketIncomeFull(k) {
  const markets = k.bld_markets || 0;
  if (!markets) return 0;
  let upgrades = {};
  try { upgrades = JSON.parse(k.market_upgrades || '{}'); } catch {}
  const race         = k.race || 'human';
  const mult         = MARKET_INCOME_MULT[race] || 1.0;
  const freePop      = Math.max(0, (k.population||0) - totalHiredUnits(k));
  const workedMarkets = Math.min(markets, Math.floor(freePop / 5));
  const tradeRoutes   = Math.min(k.maps || 0, markets);
  let   income        = (workedMarkets * 50 + tradeRoutes * 30) * mult;
  if (upgrades.bazaar)       income *= 1.50;
  if (upgrades.black_market) income *= 1.20;
  return Math.floor(income);
}

function tavernEntertainmentBonus(k) {
  const taverns = k.bld_taverns || 0;
  if (!taverns) return 0;
  let upgrades = {};
  try { upgrades = JSON.parse(k.tavern_upgrades || '{}'); } catch {}
  const base = taverns * 2;
  return Math.floor(upgrades.guild_hall ? base*1.5 : upgrades.inn ? base*1.2 : base);
}

function commodityPrice(item, race, supplyIndex) {
  const base     = COMMODITY_VALUES[item] || 1;
  const raceDisc = COMMODITY_RACE_DISCOUNT[race] || {};
  const discount = raceDisc[item] || raceDisc._all || 1.0;
  const supply   = (supplyIndex && supplyIndex[item]) || 1.0;
  return Math.max(1, Math.round(base * discount * supply));
}

function processFoodEconomy(k, events) {
  const updates   = {};
  const prod      = farmProduction(k);
  const cons      = foodConsumption(k);
  const balance   = prod - cons;
  let   food      = k.food || 0;
  let   upgrades  = {};
  try { upgrades = JSON.parse(k.farm_upgrades || '{}'); } catch {}
  const maxStore  = cons * (upgrades.granary ? 15 : 5);

  if (balance >= 0) {
    food = Math.min(food + balance, maxStore);
    const surpTurns = (k.food_surplus_turns || 0) + 1;
    updates.food              = food;
    updates.food_surplus_turns  = surpTurns;
    updates.food_shortage_turns = 0;
    if (surpTurns >= 5) {
      updates.morale = Math.min(200, (k.morale||100) + 2);
      events.push({ type:'system', message:`🌾 Food surplus: +${balance.toLocaleString()} units. Troops are well fed.` });
    } else {
      events.push({ type:'system', message:`🌾 Food: +${balance.toLocaleString()} surplus. Stores: ${food.toLocaleString()}.` });
    }
  } else {
    const shortage  = Math.abs(balance);
    const shortTurns = (k.food_shortage_turns || 0) + 1;
    updates.food_shortage_turns = shortTurns;
    updates.food_surplus_turns  = 0;

    if (food >= shortage) {
      food -= shortage;
      updates.food = food;
      events.push({ type:'system', message:`⚠️ Food deficit: drawing ${shortage.toLocaleString()} from stores. ${food.toLocaleString()} remaining.` });
    } else {
      updates.food = 0;
      events.push({ type:'system', message:`🚨 Food shortage! Turn ${shortTurns} — build more farms or reduce troops.` });
      if (shortTurns >= 3) {
        const hit = shortTurns >= 8 ? 20 : shortTurns >= 5 ? 10 : 5;
        updates.morale = Math.max(20, (k.morale||100) - hit);
        events.push({ type:'system', message:`😤 Starvation morale penalty: -${hit} morale.` });
      }
      if (shortTurns >= 5) {
        updates.population = Math.max(1000, (k.population||0) - 500);
        events.push({ type:'system', message:`👥 Population fleeing starvation: -500 people.` });
      }
      if (shortTurns >= 8) {
        const desert = Math.floor((k.fighters||0) * 0.02);
        if (desert > 0) {
          updates.fighters = Math.max(0, (k.fighters||0) - desert);
          events.push({ type:'system', message:`⚔️ ${desert.toLocaleString()} fighters deserted — starvation.` });
        }
      }
    }
  }
  return updates;
}

function processMercenaries(k, events) {
  const updates = {};
  let mercs = [];
  try { mercs = JSON.parse(k.mercenaries || '[]'); } catch {}
  if (!mercs.length) return updates;

  const currentTurn = k.turn || 0;
  let   gold        = k.gold || 0;
  const active      = [];

  for (const m of mercs) {
    const served = currentTurn - (m.hired_at_turn || 0);
    const upkeep = m.upkeep_per_turn || 0;
    if (served >= m.duration_turns) {
      updates[m.unit_type] = Math.max(0, (updates[m.unit_type] ?? (k[m.unit_type]||0)) - m.count);
      events.push({ type:'system', message:`⚔️ ${m.count} ${m.tier} ${m.unit_type} completed their contract and departed.` });
    } else if (gold >= upkeep) {
      gold -= upkeep;
      active.push(m);
    } else {
      updates[m.unit_type] = Math.max(0, (updates[m.unit_type] ?? (k[m.unit_type]||0)) - m.count);
      events.push({ type:'system', message:`⚔️ ${m.count} ${m.tier} ${m.unit_type} left — upkeep unpaid.` });
    }
  }
  updates.mercenaries = JSON.stringify(active);
  updates.gold        = gold;
  return updates;
}

function hireMercenaries(k, unitType, tier, count) {
  const tierDef = MERC_TIERS[tier];
  if (!tierDef) return { error:'Invalid tier' };
  let tavUpgrades = {};
  try { tavUpgrades = JSON.parse(k.tavern_upgrades||'{}'); } catch {}
  if (tierDef.requires && !tavUpgrades[tierDef.requires])
    return { error:`Requires ${tierDef.requires.replace('_',' ')} upgrade` };
  if (!(k.bld_taverns > 0)) return { error:'Need at least 1 tavern' };

  const level  = tierDef.levelMin + Math.floor(Math.random() * (tierDef.levelMax - tierDef.levelMin + 1));
  const cost   = tierDef.costPer * count;
  const upkeep = Math.ceil(cost * tierDef.upkeepPct / tierDef.duration);
  if ((k.gold||0) < cost) return { error:`Need ${cost.toLocaleString()} gold` };

  let mercs = [];
  try { mercs = JSON.parse(k.mercenaries||'[]'); } catch {}
  mercs.push({ unit_type:unitType, tier, level, count, hired_at_turn:k.turn||0, duration_turns:tierDef.duration, upkeep_per_turn:upkeep });

  return {
    updates: { gold:(k.gold||0)-cost, [unitType]:(k[unitType]||0)+count, mercenaries:JSON.stringify(mercs) },
    hired:   { tier, level, count, unitType, duration:tierDef.duration, upkeep, cost },
  };
}

function purchaseUpgrade(k, category, upgradeKey) {
  const defs    = { farm:FARM_UPGRADES, market:MARKET_UPGRADES, tavern:TAVERN_UPGRADES }[category];
  if (!defs) return { error:'Invalid category' };
  const def = defs[upgradeKey];
  if (!def) return { error:'Invalid upgrade' };
  const colName = `${category}_upgrades`;
  let upgrades = {};
  try { upgrades = JSON.parse(k[colName]||'{}'); } catch {}
  if (upgrades[upgradeKey])                        return { error:'Already purchased' };
  if (def.requires && !upgrades[def.requires])     return { error:`Requires ${def.requires.replace(/_/g,' ')} first` };
  if (def.raceOnly && k.race !== def.raceOnly)     return { error:`Only available to ${def.raceOnly.replace(/_/g,' ')}` };
  if ((k.gold||0) < def.cost)                     return { error:`Need ${def.cost.toLocaleString()} gold` };
  const bldCheck = { farm:'bld_farms', market:'bld_markets', tavern:'bld_taverns' };
  if (bldCheck[category] && !((k[bldCheck[category]]||0) > 0)) return { error:`Need at least 1 ${category}` };
  upgrades[upgradeKey] = true;
  return { updates:{ gold:(k.gold||0)-def.cost, [colName]:JSON.stringify(upgrades) } };
}

function processTurn(k) {
  const events = [];
  const updates = { turn: k.turn + 1, updated_at: Math.floor(Date.now() / 1000) };

  // ── 1. Gold income ───────────────────────────────────────────────────────────
  const income = goldPerTurn(k);
  updates.gold = k.gold + income;
  events.push({ type: 'system', message: `💰 Turn ${updates.turn}: +${income.toLocaleString()} gold earned. Treasury: ${updates.gold.toLocaleString()} gold.` });

  // ── 2. Mana regeneration ─────────────────────────────────────────────────────
  const manaGain = manaPerTurn(k);
  updates.mana = k.mana + manaGain;
  events.push({ type: 'system', message: `✨ Mana: +${manaGain.toLocaleString()} restored. Total: ${updates.mana.toLocaleString()}.` });

  // ── 3. Population growth ─────────────────────────────────────────────────────
  const growth = popGrowth(k);
  updates.population = Math.max(0, k.population + growth);
  if (growth > 0) {
    events.push({ type: 'system', message: `👥 Population grew by ${growth.toLocaleString()} to ${updates.population.toLocaleString()}.` });
  } else if (growth < 0) {
    events.push({ type: 'system', message: `👥 Population declined by ${Math.abs(growth).toLocaleString()} to ${updates.population.toLocaleString()} due to low morale.` });
  }

  // ── 4. Food economy — farms, consumption, shortage consequences ──────────────
  const foodUpdates = processFoodEconomy({ ...k, ...updates }, events);
  Object.assign(updates, foodUpdates);

  // ── 4b. Tavern entertainment bonus ────────────────────────────────────────────
  const entBonus = tavernEntertainmentBonus(k);
  if (entBonus > 0) {
    updates.res_entertainment = Math.min(500, (k.res_entertainment||0) + Math.floor(entBonus / 10));
  }

  // ── 4c. Mercenary upkeep and expiry ───────────────────────────────────────────
  const mercUpdates = processMercenaries({ ...k, ...updates }, events);
  Object.assign(updates, mercUpdates);

  // ── 5. Troop upkeep ───────────────────────────────────────────────────────────
  // Researchers, engineers, scribes are exempt if housed in their buildings.
  // Overflow (unhomed) units pay normal upkeep.

  // Racial capacity multipliers for support buildings
  const SUPPORT_CAP_RACE = {
    high_elf:  { researcher: 1.5, engineer: 1.0, scribe: 1.5 },
    dwarf:     { researcher: 0.9, engineer: 1.5, scribe: 1.0 },
    dire_wolf: { researcher: 0.7, engineer: 1.0, scribe: 0.7 },
    dark_elf:  { researcher: 1.2, engineer: 0.9, scribe: 1.3 },
    human:     { researcher: 1.0, engineer: 1.0, scribe: 1.0 },
    orc:       { researcher: 0.8, engineer: 1.2, scribe: 0.8 },
  };
  const capRace = SUPPORT_CAP_RACE[k.race] || { researcher: 1.0, engineer: 1.0, scribe: 1.0 };

  // Capacity per building (base × race multiplier)
  const researcherCap = Math.floor((k.bld_schools    || 0) * 100 * capRace.researcher);
  const engineerCap   = Math.floor((k.bld_smithies   || 0) * 50  * capRace.engineer);
  const scribeCap     = Math.floor((k.bld_libraries  || 0) * 20  * capRace.scribe);

  // Overflow = units beyond capacity → pay upkeep; housed units are free
  const researcherOverflow = Math.max(0, (k.researchers || 0) - researcherCap);
  const engineerOverflow   = Math.max(0, (k.engineers   || 0) - engineerCap);
  const scribeOverflow     = Math.max(0, (k.scribes     || 0) - scribeCap);

  // Combat/support troops always pay upkeep
  const upkeepMult = {
    high_elf: 1.00, dwarf: 0.85, dire_wolf: 1.20,
    dark_elf: 1.10, human: 1.00, orc: 1.15,
  }[k.race] || 1.0;

  const combatTroops = (k.fighters||0) + (k.rangers||0) + (k.clerics||0) +
                       (k.mages||0) + (k.thieves||0) + (k.ninjas||0);
  const supportOverflow = researcherOverflow + engineerOverflow + scribeOverflow;
  const totalTroops = combatTroops + supportOverflow;

  const barrackDiscount = Math.min(0.5, Math.floor((k.bld_barracks||0) / 2) * 0.01);
  const upkeep = Math.floor(totalTroops * upkeepMult * (1 - barrackDiscount));

  // Build housing status message for support units
  const housedResearchers = Math.min(k.researchers||0, researcherCap);
  const housedEngineers   = Math.min(k.engineers  ||0, engineerCap);
  const housedScribes     = Math.min(k.scribes    ||0, scribeCap);
  const totalHoused = housedResearchers + housedEngineers + housedScribes;

  if (upkeep > 0) {
    updates.gold = (updates.gold || k.gold) - upkeep;
    if (updates.gold < 0) updates.gold = 0;
    let msg = `⚔️ Troop upkeep: -${upkeep.toLocaleString()} gold (${totalTroops.toLocaleString()} billable`;
    if (totalHoused > 0) msg += `, ${totalHoused.toLocaleString()} support units housed free`;
    if (barrackDiscount > 0) msg += `, barracks discount applied`;
    msg += `).`;
    events.push({ type: 'system', message: msg });
  } else if (totalHoused > 0) {
    events.push({ type: 'system', message: `✅ All support units housed — no upkeep cost this turn.` });
  }

  // ── 6. Morale ─────────────────────────────────────────────────────────────────
  {
    const capPerBuilding = housingCapPerBuilding(k.race);
    const housingCap = (k.bld_housing || 0) * capPerBuilding;
    const overcrowded = housingCap > 0 && (k.population || 0) > housingCap;

    // Race overcrowding penalty modifiers
    const overcrowdMult = { dire_wolf: 0.5, high_elf: 2.0 }[k.race] || 1.0;
    const overcrowdPenalty = overcrowded
      ? Math.max(0, Math.floor(((k.population || 0) - housingCap) / 1000 * overcrowdMult))
      : 0;

    if (k.tax > 50) {
      const penalty = Math.floor((k.tax - 50) * 0.5) + overcrowdPenalty;
      updates.morale = Math.max(0, (k.morale||100) - penalty);
      events.push({ type: 'system', message: `😡 Morale fell by ${penalty} to ${updates.morale} — citizens angry over ${k.tax}% taxation.` });
    } else {
      const tavernBonus = Math.floor((k.bld_colosseums||0) / 25);
      const recovery = 1 + Math.floor((k.res_entertainment||0) / 200) + tavernBonus;
      let newMorale = Math.min(200, (k.morale||100) + recovery);
      if (overcrowdPenalty > 0) {
        newMorale = Math.max(0, newMorale - overcrowdPenalty);
        events.push({ type: 'system', message: `🏚️ Overcrowding penalty: -${overcrowdPenalty} morale (${(((k.population||0) - housingCap)/1000).toFixed(1)}k over housing cap).` });
      }
      if (newMorale !== k.morale) {
        updates.morale = newMorale;
      }
    }
  }

  // ── 7. Auto-research — use per-discipline allocation ──────────────────────────
  const schoolBonus = 1 + (Math.floor((k.bld_schools||0) / 5) * 0.02);
  const raceResearch = raceBonus(k, 'research');
  const raceMagic    = raceBonus(k, 'magic');
  const researchers  = k.researchers || 0;
  let allocation = {};
  try { allocation = typeof k.research_allocation === 'string' ? JSON.parse(k.research_allocation || '{}') : (k.research_allocation || {}); } catch { allocation = {}; }

  if (researchers > 0) {
    const DISCIPLINES = [
      { col: 'res_economy',       key: 'economy',        label: 'Economy',          multi: raceResearch },
      { col: 'res_weapons',       key: 'weapons',        label: 'Weapons',          multi: raceResearch },
      { col: 'res_armor',         key: 'armor',          label: 'Armor',            multi: raceResearch },
      { col: 'res_military',      key: 'military',       label: 'Military tactics', multi: raceResearch },
      { col: 'res_attack_magic',  key: 'attack_magic',   label: 'Attack magic',     multi: raceMagic    },
      { col: 'res_defense_magic', key: 'defense_magic',  label: 'Defense magic',    multi: raceMagic    },
      { col: 'res_entertainment', key: 'entertainment',  label: 'Entertainment',    multi: raceResearch },
      { col: 'res_construction',  key: 'construction',   label: 'Construction',     multi: raceResearch },
      { col: 'res_war_machines',  key: 'war_machines',   label: 'War machines',     multi: raceResearch },
    ];

    // Fallback: if no allocation set, split evenly
    const totalAllocated = Object.values(allocation).reduce((s, v) => s + (Number(v) || 0), 0);
    const perDisciplineDefault = Math.floor(researchers / (DISCIPLINES.length + 1));

    const advances = [];
    DISCIPLINES.forEach(function(d) {
      const assigned = totalAllocated > 0 ? (Number(allocation[d.key]) || 0) : perDisciplineDefault;
      const effective = Math.floor(assigned * schoolBonus * d.multi);
      let inc = 0;
      if (effective >= 2000) inc = 5;
      else if (effective >= 1200) inc = 3;
      else if (effective >= 600)  inc = 2;
      else if (effective >= 200)  inc = 1;
      if (inc > 0) {
        const current = updates[d.col] !== undefined ? updates[d.col] : (k[d.col] || 0);
        const cap = getCap(d.col, k.level || 1);
        const newVal = Math.min(cap, current + inc);
        if (newVal !== current) {
          updates[d.col] = newVal;
          advances.push(`${d.label} → ${newVal}%`);
        }
      }
    });

    // Spellbook
    const spellAssigned = totalAllocated > 0 ? (Number(allocation['spellbook']) || 0) : perDisciplineDefault;
    const spellEffective = Math.floor(spellAssigned * schoolBonus * raceMagic);
    let spellInc = 0;
    if (spellEffective >= 2000) spellInc = 5;
    else if (spellEffective >= 1200) spellInc = 3;
    else if (spellEffective >= 600)  spellInc = 2;
    else if (spellEffective >= 200)  spellInc = 1;
    if (spellInc > 0) {
      const current = updates.res_spellbook !== undefined ? updates.res_spellbook : (k.res_spellbook||0);
      const cap = getCap('res_spellbook', k.level || 1);
      updates.res_spellbook = Math.min(cap, current + spellInc);
      advances.push(`Spellbook → ${updates.res_spellbook}`);
    }

    if (advances.length > 0) {
      events.push({ type: 'system', message: `📚 Research advanced: ${advances.join(', ')}.` });
      const resXp = awardXp({ ...k, xp: updates.xp || (k.xp||0), level: updates.level || (k.level||1) }, 'research', advances.length);
      updates.xp    = resXp.xp;
      updates.level = resXp.level;
      if (resXp.levelled) events.push(...resXp.events);
      // Award researcher unit XP
      const rXp = awardTroopXp({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'researchers', advances.length * 5);
      updates.troop_levels = rXp.troop_levels;
      if (rXp.levelUps.length) events.push({ type: 'system', message: `📚 Researchers grew more skilled!` });
    } else if (researchers > 0) {
      events.push({ type: 'system', message: `📚 ${researchers.toLocaleString()} researchers studying — allocate more per discipline for advancement.` });
    }
  } else {
    events.push({ type: 'system', message: `📚 No researchers — hire researchers and allocate them to advance your kingdom's knowledge.` });
  }

  // ── 8. Build queue — engineers work on queued buildings each turn ─────────────
  const buildUpdates = processBuildQueue(k, events);
  Object.assign(updates, buildUpdates);

  // ── 8b. Library — mages produce mana, scribes craft maps/blueprints, mages craft scrolls ──
  const libUpdates = processLibrary({ ...k, ...updates }, events);
  Object.assign(updates, libUpdates);

  // ── 8c. Smithy production — hammers, scaffolding, degradation ────────────────
  const smithyUpdates = processSmithyProduction({ ...k, ...updates }, events);
  Object.assign(updates, smithyUpdates);

  // ── 8c. Mage tower research — research from mages in towers ──────────────────
  const towerUpdates = processMageTower({ ...k, ...updates }, events);
  Object.assign(updates, towerUpdates);

  // ── 8d. Shrines — clerics boost morale and prepare to heal ───────────────────
  const shrineUpdates = processShrine({ ...k, ...updates }, events);
  Object.assign(updates, shrineUpdates);

  // ── 8e. Active effects — tick down debuffs/buffs ─────────────────────────────
  const effectUpdates = processActiveEffects({ ...k, ...updates }, events);
  Object.assign(updates, effectUpdates);

  // ── 9. Training fields — passive troop XP each turn ──────────────────────────
  if ((k.bld_training||0) > 0) {
    let troopLevels = {};
    try { troopLevels = JSON.parse(updates.troop_levels || k.troop_levels || '{}'); } catch { troopLevels = {}; }
    let allocation = {};
    try { allocation = JSON.parse(k.training_allocation || '{}'); } catch { allocation = {}; }

    const TROOP_TYPES = ['fighters','rangers','clerics','mages','thieves','ninjas'];
    const trainingFields   = k.bld_training || 0;
    const trainingCapacity = trainingFields * 50;
    let advancedTroops = [];

    TROOP_TYPES.forEach(function(unit) {
      const assigned = Number(allocation[unit]) || 0;
      if (assigned <= 0) return;
      const currentData = troopLevels[unit] || { level: 1, xp: 0, count: 0 };
      if (currentData.level >= 100) return;
      const weaponsEquipped = Math.min(assigned, k.weapons_stockpile || 0);
      const armorEquipped   = Math.min(assigned, k.armor_stockpile   || 0);
      const equipBonus = 1 + (weaponsEquipped / Math.max(assigned, 1)) * 0.5
                           + (armorEquipped   / Math.max(assigned, 1)) * 0.5;
      const raceTrainBonus = TROOP_RACE_BONUS[k.race]?.[unit] || 1.0;
      const xpGain = Math.floor(trainingCapacity * equipBonus * raceTrainBonus / TROOP_TYPES.length);
      const newXp  = currentData.xp + xpGain;
      const xpNeeded = troopXpForLevel(currentData.level + 1);
      if (newXp >= xpNeeded) {
        troopLevels[unit] = { level: currentData.level + 1, xp: newXp - xpNeeded, count: assigned };
        advancedTroops.push(`${unit} → Level ${currentData.level + 1}`);
      } else {
        troopLevels[unit] = { ...currentData, xp: newXp, count: assigned };
      }
    });

    updates.troop_levels = JSON.stringify(troopLevels);
    if (advancedTroops.length > 0) {
      events.push({ type: 'system', message: `⚔️ Troop training advanced: ${advancedTroops.join(', ')}.` });
    } else if (trainingFields > 0 && Object.keys(allocation).length > 0) {
      events.push({ type: 'system', message: `⚔️ ${trainingFields} training field(s) active — troops gaining experience.` });
    }
  }

  // ── 9b. Racial passive bonuses ────────────────────────────────────────────────
  // Orc: every 10 fighters (level 5+) trains 1 free fighter per turn
  const orcBonus = racialUnitBonus({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'fighters');
  if (orcBonus.freeTrainees > 0) {
    updates.fighters = (updates.fighters || k.fighters || 0) + orcBonus.freeTrainees;
    events.push({ type: 'system', message: `⚔️ Orcish war culture: ${orcBonus.freeTrainees} new fighter${orcBonus.freeTrainees > 1 ? 's' : ''} trained this turn.` });
  }
  // Human: level 5+ clerics restore 1 morale per turn
  const humanBonus = racialUnitBonus({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'clerics');
  if (humanBonus.auraHeal && (k.clerics || 0) > 0) {
    updates.morale = Math.min(200, (updates.morale || k.morale || 100) + 1);
    events.push({ type: 'system', message: `✨ Human clerics radiate healing aura — +1 morale.` });
  }

  // ── 10. Rangers auto-explore — level scales land discovery, diminishing returns on high land ──
  const rangers = k.rangers || 0;
  if (rangers > 0) {
    const scoutMult    = raceBonus(k, 'military');
    const rangerLvMult = unitLevelMult({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'rangers');
    // Diminishing returns — more land = less free land per turn
    const currentLand  = updates.land || k.land || 0;
    const diminish     = Math.max(0.05, 1 / Math.log10(Math.max(10, currentLand)));
    const autoLand     = Math.floor(rangers * 0.001 * scoutMult * rangerLvMult * diminish);
    if (autoLand > 0) {
      updates.land = currentLand + autoLand;
      events.push({ type: 'system', message: `🗺️ Rangers explored and claimed ${autoLand} acre(s) of new land. Total: ${updates.land.toLocaleString()} acres.` });
      // Passive ranger XP for exploring
      const rangerXp = awardTroopXp({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'rangers', 3);
      updates.troop_levels = rangerXp.troop_levels;
    }
  }

  // ── XP awards this turn ───────────────────────────────────────────────────────
  let totalXp = k.xp || 0;
  let currentLevel = k.level || 1;

  // Turn XP
  const turnXp = awardXp({ ...k, xp: totalXp, level: currentLevel }, 'turn', 1);
  totalXp = turnXp.xp;
  currentLevel = turnXp.level;
  if (turnXp.levelled) events.push(...turnXp.events);

  // Gold income XP
  const goldXp = awardXp({ ...k, xp: totalXp, level: currentLevel }, 'gold_earned', income);
  totalXp = goldXp.xp;
  currentLevel = goldXp.level;
  if (goldXp.levelled) events.push(...goldXp.events);

  // Research XP (awarded after research section runs)
  // (handled below after DISCIPLINES loop)

  updates.xp    = totalXp;
  updates.level = currentLevel;

  // ── Racial bonus unlock check — fires once when signature unit hits level 5 ──
  const RACIAL_UNITS = { dwarf:'engineers', high_elf:'mages', orc:'fighters', dark_elf:'ninjas', dire_wolf:'rangers', human:'clerics' };
  const keyUnit = RACIAL_UNITS[k.race];
  if (keyUnit) {
    // Use already-set updates value if present, else fall back to k
    let racialData = {};
    try { racialData = JSON.parse(updates.racial_bonuses_unlocked || k.racial_bonuses_unlocked || '{}'); } catch {}
    if (!racialData[keyUnit]) {
      const tls = typeof (updates.troop_levels || k.troop_levels) === 'string'
        ? JSON.parse(updates.troop_levels || k.troop_levels || '{}')
        : (updates.troop_levels || k.troop_levels || {});
      const unitLevel = tls[keyUnit]?.level || 1;
      if (unitLevel >= 5) {
        racialData[keyUnit] = true;
        updates.racial_bonuses_unlocked = JSON.stringify(racialData);
        const RACIAL_MSGS = {
          dwarf:     '⚒️ Your engineers have reached mastery — Dwarven war machines now need only 1 engineer to crew.',
          high_elf:  '✨ Your mages have reached mastery — High Elf scrolls now produce 2 per craft.',
          orc:       '⚔️ Your fighters have reached mastery — Orcish war culture now trains 1 free fighter per 10 each turn.',
          dark_elf:  '🕵️ Your ninjas have reached mastery — Dark Elf assassinations now leave no trace.',
          dire_wolf: '🐺 Your rangers have reached mastery — Dire Wolf expeditions now return 1 turn early.',
          human:     '💚 Your clerics have reached mastery — Human healing aura now restores +1 morale per turn.',
        };
        if (RACIAL_MSGS[k.race]) events.push({ type: 'system', message: RACIAL_MSGS[k.race] });
      }
    }
  }

  updates.last_turn_at = Math.floor(Date.now() / 1000);
  return { updates, events };
}

// ── Level-based caps ──────────────────────────────────────────────────────────
// All caps scale linearly from base (level 1) to max (level 1000)
// Formula: Math.floor(base + (max - base) * (level - 1) / 999)

function levelCap(base, max, level) {
  const lv = Math.max(1, Math.min(1000, level || 1));
  return Math.floor(base + (max - base) * (lv - 1) / 999);
}

const CAPS = {
  // Combat troops: level 1 → level 1000
  fighters:  { base: 500,    max: 5000000  },
  rangers:   { base: 250,    max: 2000000  },
  clerics:   { base: 100,    max: 1000000  },
  mages:     { base: 100,    max: 1000000  },
  thieves:   { base: 100,    max: 500000   },
  ninjas:    { base: 50,     max: 250000   },
  // No cap on researchers or engineers

  // Buildings: small kingdoms start with low limits
  bld_farms:        { base: 500,   max: 1000000 },
  bld_barracks:     { base: 10,    max: 50000   },
  bld_outposts:     { base: 10,    max: 25000   },
  bld_guard_towers: { base: 10,    max: 25000   },
  bld_schools:      { base: 5,     max: 10000   },
  bld_armories:     { base: 5,     max: 10000   },
  bld_vaults:       { base: 5,     max: 10000   },
  bld_smithies:     { base: 5,     max: 5000    },
  bld_markets:      { base: 3,     max: 5000    },
  bld_cathedrals:   { base: 3,     max: 5000    },
  bld_training:     { base: 2,     max: 2000    },
  bld_colosseums:   { base: 2,     max: 2000    },
  bld_castles:      { base: 1,     max: 500     },
  war_machines:     { base: 5,     max: 10000   },

  // Research: starts at 100% base, scales to 1000% max
  res_economy:       { base: 100,  max: 10000 },
  res_weapons:       { base: 100,  max: 10000 },
  res_armor:         { base: 100,  max: 10000 },
  res_military:      { base: 100,  max: 10000 },
  res_spellbook:     { base: 500,  max: 500000 },
  res_attack_magic:  { base: 100,  max: 10000 },
  res_defense_magic: { base: 100,  max: 10000 },
  res_entertainment: { base: 100,  max: 10000 },
  res_construction:  { base: 100,  max: 10000 },
  res_war_machines:  { base: 100,  max: 10000 },
};

function getCap(field, level) {
  const c = CAPS[field];
  if (!c) return Infinity;
  return levelCap(c.base, c.max, level);
}

// ── Hire units ────────────────────────────────────────────────────────────────

function hireUnits(k, unit, amount) {
  const validUnits = ['fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers','scribes'];
  if (!validUnits.includes(unit)) return { error: 'Invalid unit type' };
  if (amount <= 0) return { error: 'Amount must be positive' };

  // School cap — researchers need schools (100 per school)
  if (unit === 'researchers') {
    const schoolCap = (k.bld_schools || 0) * 100;
    const currentResearchers = k.researchers || 0;
    if (schoolCap === 0) return { error: 'You need at least 1 school to hire researchers' };
    if (currentResearchers >= schoolCap) return { error: `School capacity full — ${schoolCap.toLocaleString()} researchers max with ${k.bld_schools} school${k.bld_schools > 1 ? 's' : ''} (100 per school)` };
    if (currentResearchers + amount > schoolCap) return { error: `Only room for ${(schoolCap - currentResearchers).toLocaleString()} more researchers — build more schools (100 per school)` };
  }

  // Barracks cap — military troops need barracks (500 per barracks)
  const BARRACKS_TROOPS = ['fighters','rangers','clerics','thieves','ninjas'];
  if (BARRACKS_TROOPS.includes(unit)) {
    const barracksCap = (k.bld_barracks || 0) * 500;
    const currentTroops = BARRACKS_TROOPS.reduce((s, u) => s + (k[u] || 0), 0);
    if (barracksCap === 0) return { error: 'You need at least 1 barracks to hire troops' };
    if (currentTroops >= barracksCap) return { error: `Barracks full — ${barracksCap.toLocaleString()} troops max with ${k.bld_barracks} barracks (500 per barracks)` };
    if (currentTroops + amount > barracksCap) return { error: `Only room for ${(barracksCap - currentTroops).toLocaleString()} more troops — build more barracks (500 per barracks)` };
  }

  // Level cap check (researchers, engineers, scribes have no level cap)
  if (!['researchers','engineers','scribes'].includes(unit)) {
    const cap = getCap(unit, k.level || 1);
    const current = k[unit] || 0;
    if (current >= cap) return { error: `Level ${k.level||1} cap reached for ${unit} (max ${cap.toLocaleString()}) — gain levels to increase` };
    if (current + amount > cap) return { error: `Level ${k.level||1} cap: can only hire ${(cap - current).toLocaleString()} more ${unit} (max ${cap.toLocaleString()})` };
  }

  const cost = amount * UNIT_COST;
  if (k.gold < cost) return { error: `Not enough gold — need ${cost.toLocaleString()} gold` };
  if (amount > k.population) return { error: 'Not enough population available' };

  // Dilute unit XP pool when new recruits join — new troops lower the average
  const dilutedLevels = diluteTroopXp(k, unit, amount);

  return {
    updates: {
      gold: k.gold - cost,
      population: k.population - amount,
      [unit]: (k[unit]||0) + amount,
      ...(dilutedLevels ? { troop_levels: dilutedLevels } : {}),
      updated_at: Math.floor(Date.now() / 1000),
    }
  };
}

// ── Research ──────────────────────────────────────────────────────────────────

const RESEARCH_MAP = {
  economy:      'res_economy',
  weapons:      'res_weapons',
  armor:        'res_armor',
  military:     'res_military',
  spellbook:    'res_spellbook',
  attack_magic: 'res_attack_magic',
  defense_magic:'res_defense_magic',
  entertainment:'res_entertainment',
  construction: 'res_construction',
  war_machines: 'res_war_machines',
};

function studyDiscipline(k, discipline, researchersAssigned) {
  const col = RESEARCH_MAP[discipline];
  if (!col) return { error: 'Unknown discipline' };
  if (researchersAssigned > k.researchers) return { error: 'Not enough researchers' };

  const increment = researchIncrement(k, discipline, researchersAssigned);
  if (increment === 0) return { error: 'Need more researchers for any progress (min ~200)' };

  const cap = discipline === 'spellbook' ? Infinity : MAX_RESEARCH;
  const newVal = Math.min(cap, k[col] + increment);

  return {
    updates: { [col]: newVal, updated_at: Math.floor(Date.now() / 1000) },
    increment,
  };
}

// ── Experience & Levelling ────────────────────────────────────────────────────

// XP required to reach each level (cumulative from level 1)
// Formula: level 1-10: 100*L^2, 11-50: 150*L^2, 51-200: 200*L^2, 201-500: 300*L^2, 501-1000: 500*L^2
function xpForLevel(level) {
  if (level <= 1)   return 0;
  if (level <= 10)  return Math.floor(100  * Math.pow(level - 1, 2));
  if (level <= 50)  return Math.floor(150  * Math.pow(level - 1, 2));
  if (level <= 200) return Math.floor(200  * Math.pow(level - 1, 2));
  if (level <= 500) return Math.floor(300  * Math.pow(level - 1, 2));
  return              Math.floor(500  * Math.pow(level - 1, 2));
}

function xpToNextLevel(level) {
  return xpForLevel(level + 1) - xpForLevel(level);
}

function levelFromXp(totalXp) {
  let lo = 1, hi = 1000;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xpForLevel(mid) <= totalXp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Race XP multipliers per activity type
const XP_RACE_BONUS = {
  high_elf:  { research: 1.5, magic: 1.5 },
  dwarf:     { construction: 1.5, economy: 1.25 },
  dire_wolf: { combat: 1.5, exploration: 1.25 },
  dark_elf:  { covert: 1.5, magic: 1.25 },
  human:     { all: 1.10 },
  orc:       { combat: 1.25, economy: 1.25 },
};

function xpRaceBonus(k, activity) {
  const bonuses = XP_RACE_BONUS[k.race] || {};
  const base = bonuses.all || 1.0;
  return Math.max(base, bonuses[activity] || base);
}

// XP base values per activity
const XP_BASE = {
  turn:         10,    // per turn taken
  gold_earned:  0.001, // per GC of income
  combat_win:   500,   // per combat victory
  combat_loss:  100,   // per combat defeat
  research:     50,    // per discipline that advanced
  construction: 20,    // per building unit completed
  exploration:  5,     // per acre found
  spell_cast:   0.01,  // per mana spent
  covert_op:    150,   // per covert operation
};

// Award XP and check for level up — returns { xp, level, levelled, events }
function awardXp(k, activity, amount) {
  const mult    = xpRaceBonus(k, activity);
  const earned  = Math.max(1, Math.floor((XP_BASE[activity] || 10) * amount * mult));
  const newXp   = (k.xp || 0) + earned;
  const newLevel = levelFromXp(newXp);
  const levelled = newLevel > (k.level || 1);
  const events  = [];
  if (levelled) {
    events.push({ type: 'system', message: `🌟 Kingdom reached Level ${newLevel}! (${earned.toLocaleString()} XP earned)` });
  }
  return { xp: newXp, level: newLevel, earned, levelled, events };
}

// ── Construction ──────────────────────────────────────────────────────────────

// Engineer-turns required to complete one unit of each building
const BUILDING_COST = {
  farms: 2500, barracks: 5000, outposts: 7500, guard_towers: 2500,
  schools: 7500, armories: 2500, vaults: 10000, smithies: 10000,
  markets: 10000, cathedrals: 15000, shrines: 5000, training: 20000, colosseums: 5000,
  castles: 100000, libraries: 10000, housing: 5000,
  war_machine: 200, weapons: 10, armor: 10,
};

const BUILDING_COL = {
  farms: 'bld_farms', barracks: 'bld_barracks', outposts: 'bld_outposts',
  guard_towers: 'bld_guard_towers', schools: 'bld_schools', armories: 'bld_armories',
  vaults: 'bld_vaults', smithies: 'bld_smithies', markets: 'bld_markets',
  cathedrals: 'bld_cathedrals', shrines: 'bld_shrines', training: 'bld_training',
  colosseums: 'bld_colosseums', castles: 'bld_castles', libraries: 'bld_libraries',
  housing: 'bld_housing',
  war_machine: 'war_machines', weapons: 'weapons_stockpile', armor: 'armor_stockpile',
};

const BUILDING_GOLD_COST = {
  farms: 50, barracks: 200, outposts: 150, guard_towers: 150,
  schools: 500, armories: 400, vaults: 400, smithies: 800,
  markets: 2000, cathedrals: 3000, shrines: 1000, training: 10000, colosseums: 1500,
  castles: 25000, libraries: 2000, housing: 500,
  war_machine: 5000, weapons: 100, armor: 150,
};

// Land cost per building unit completed
const BUILDING_LAND_COST = {
  farms: 1, barracks: 1, outposts: 1, guard_towers: 1, armories: 1, vaults: 1,
  schools: 2, smithies: 2, markets: 2, colosseums: 2, shrines: 2, libraries: 2,
  housing: 1,
  cathedrals: 5, training: 5,
  castles: 10,
  war_machine: 0, weapons: 0, armor: 0,
};
const TOOL_COL       = { hammers: 'tools_hammers', scaffolding: 'tools_scaffolding', blueprints: 'tools_blueprints' };
const TOOL_GOLD_COST = { hammers: 0, scaffolding: 2500, blueprints: 0 }; // hammers cost 1 turn via smithy; blueprints from library

// Buildings requiring blueprint (base cost >= 100 turns @ 100 engineers)
const BLUEPRINT_REQUIRED = new Set(['vaults','smithies','markets','cathedrals','training','colosseums','castles','libraries']);
// Buildings requiring scaffolding (base cost > 100 turns)
const SCAFFOLDING_REQUIRED = new Set(['cathedrals','training','castles']);
// Scaffolding also gives a bonus for buildings under 100 turns (consumed on completion)
const SCAFFOLDING_BONUS_BUILDINGS = new Set(['farms','barracks','outposts','guard_towers','schools','armories','shrines','housing','colosseums']);

// Scaffolding bonus scales inversely with building difficulty: smaller buildings get bigger % boost
function scaffoldingBonus(building) {
  const cost = BUILDING_COST[building] || 10000;
  return Math.max(0.05, Math.floor(50 / (cost / 100)) / 100); // e.g. farm=2.0, barracks=1.0, school=0.67
}

// ── Smithy production — runs each turn ───────────────────────────────────────
function processSmithyProduction(k, events) {
  const updates = {};
  const smithies = k.bld_smithies || 0;
  if (smithies === 0) return updates;

  let alloc = {};
  try { alloc = JSON.parse(k.smithy_allocation || '{}'); } catch {}

  const hammerAlloc    = Math.min(Number(alloc.hammers)    || 0, smithies); // max 1 per smithy per turn
  const scaffoldAlloc  = Math.min(Number(alloc.scaffolding) || 0, smithies);

  const hammerCap   = smithies * 25;
  const scaffoldCap = smithies * 10;

  // Produce hammers (1 per allocated engineer slot, max 1 per smithy, cap 25/smithy)
  if (hammerAlloc > 0 && (k.tools_hammers || 0) < hammerCap) {
    const canAdd = Math.min(hammerAlloc, hammerCap - (k.tools_hammers || 0));
    if (canAdd > 0) {
      updates.tools_hammers = (k.tools_hammers || 0) + canAdd;
      events.push({ type: 'system', message: `⚒️ Smithy produced ${canAdd} hammer${canAdd > 1 ? 's' : ''}.` });
    }
  }

  // Produce scaffolding (costs 2500 gold each, 1 per allocated engineer slot)
  if (scaffoldAlloc > 0 && (k.tools_scaffolding || 0) < scaffoldCap) {
    const goldAvail = updates.gold !== undefined ? updates.gold : (k.gold || 0);
    const canAfford = Math.floor(goldAvail / 2500);
    const canAdd    = Math.min(scaffoldAlloc, scaffoldCap - (k.tools_scaffolding || 0), canAfford);
    if (canAdd > 0) {
      updates.tools_scaffolding = (k.tools_scaffolding || 0) + canAdd;
      updates.gold = goldAvail - (canAdd * 2500);
      events.push({ type: 'system', message: `⚒️ Smithy produced ${canAdd} scaffolding for ${(canAdd * 2500).toLocaleString()} gold.` });
    } else if (canAfford === 0 && scaffoldAlloc > 0) {
      events.push({ type: 'system', message: `⚠️ Not enough gold to produce scaffolding (need 2,500 GC each).` });
    }
  }

  // ── Hammer degradation — each active hammer decays 1 turn of durability ──────
  const hammerCount = updates.tools_hammers !== undefined ? updates.tools_hammers : (k.tools_hammers || 0);
  if (hammerCount > 0) {
    const used = (k.hammer_turns_used || 0) + hammerCount; // each hammer used this turn
    const breaks = Math.floor(used / 20); // 1 hammer breaks every 20 turns of use
    if (breaks > 0) {
      const newCount = Math.max(0, hammerCount - breaks);
      updates.tools_hammers = newCount;
      updates.hammer_turns_used = used - (breaks * 20);
      events.push({ type: 'system', message: `🔨 ${breaks} hammer${breaks > 1 ? 's' : ''} wore out and broke.` });
    } else {
      updates.hammer_turns_used = used;
    }
  }

  return updates;
}

// Add buildings to the queue — charges gold, no turn cost
function queueBuildings(k, orders) {
  let queue = {};
  try { queue = JSON.parse(k.build_queue || '{}'); } catch { queue = {}; }

  let totalCost = 0;
  for (const [building, qty] of Object.entries(orders)) {
    if (!BUILDING_COST[building]) continue;
    const n = Number(qty);
    if (n <= 0) continue;
    const goldPerUnit = BUILDING_GOLD_COST[building] || 100;
    totalCost += goldPerUnit * n;
  }

  if (totalCost > k.gold) {
    return { error: `Need ${totalCost.toLocaleString()} gold but only have ${k.gold.toLocaleString()} gold` };
  }

  for (const [building, qty] of Object.entries(orders)) {
    if (!BUILDING_COST[building]) continue;
    const n = Number(qty);
    if (n <= 0) continue;
    queue[building] = (queue[building] || 0) + n;
  }

  return {
    updates: {
      build_queue: JSON.stringify(queue),
      gold: k.gold - totalCost,
    },
    totalCost,
  };
}

// Process build queue each turn — engineers work on allocated buildings continuously
function processBuildQueue(k, events) {
  const updates = {};
  let progress = {};
  try { progress = JSON.parse(k.build_progress || '{}'); } catch { progress = {}; }

  // Tool bonuses
  const hammerBonus  = 1 + (k.tools_hammers || 0) * 0.05;
  const smithyBonus  = 1 + (Math.floor((k.bld_smithies||0) / 15) * 0.02);
  const raceConstr   = raceBonus(k, 'construction');
  const engLevelMult = unitLevelMult(k, 'engineers');
  const baseToolMult = hammerBonus * smithyBonus * raceConstr * engLevelMult;

  // Consumable tool pools — tracked across the building loop this turn
  let blueprintsLeft  = k.blueprints_stored || 0;
  let scaffoldingLeft = k.tools_scaffolding  || 0;
  let blueprintsUsed  = 0;
  let scaffoldingUsed = 0;

  // Smithy caps
  const smithies     = k.bld_smithies || 0;
  const blueprintCap = smithies * 25;
  const scaffoldCap  = smithies * 10;

  // Get engineer allocation
  let allocation = {};
  try { allocation = JSON.parse(k.build_allocation || '{}'); } catch { allocation = {}; }

  // Also check legacy build_queue for any manually queued items
  let queue = {};
  try { queue = JSON.parse(k.build_queue || '{}'); } catch { queue = {}; }

  // Merge: allocation drives continuous building, queue adds on top
  const activeBuildings = new Set([...Object.keys(allocation).filter(b => Number(allocation[b]) > 0), ...Object.keys(queue).filter(b => (queue[b]||0) > 0)]);
  if (activeBuildings.size === 0) return updates;

  const completedItems = [];

  for (const building of activeBuildings) {
    const engAssigned = Number(allocation[building]) || 0;
    if (engAssigned <= 0 && !(queue[building] > 0)) continue;

    const cost = BUILDING_COST[building];
    if (!cost) continue;

    // ── Blueprint gate — required for buildings with base cost >= 100 turns ──
    if (BLUEPRINT_REQUIRED.has(building) && blueprintsLeft <= 0) {
      updates._blueprint_needed = updates._blueprint_needed || [];
      if (!updates._blueprint_needed.includes(building)) updates._blueprint_needed.push(building);
      continue; // skip this building entirely this turn
    }

    // ── Scaffolding gate — required for buildings > 100 turns base ──────────
    if (SCAFFOLDING_REQUIRED.has(building) && scaffoldingLeft <= 0) {
      updates._scaffolding_needed = updates._scaffolding_needed || [];
      if (!updates._scaffolding_needed.includes(building)) updates._scaffolding_needed.push(building);
      continue;
    }

    // ── Per-building tool multiplier ─────────────────────────────────────────
    let toolMult = baseToolMult;
    // Scaffolding bonus for sub-100-turn buildings (optional, stacks)
    if (SCAFFOLDING_BONUS_BUILDINGS.has(building) && scaffoldingLeft > 0) {
      toolMult = toolMult * (1 + scaffoldingBonus(building));
    }

    const workDone = Math.floor(engAssigned * toolMult);
    if (workDone <= 0) continue;

    const prevProgress  = progress[building] || 0;
    const totalProgress = prevProgress + workDone;
    const completed     = Math.floor(totalProgress / cost);

    if (completed > 0) {
      const col = BUILDING_COL[building];
      if (col) {
        const current = updates[col] !== undefined ? updates[col] : (k[col] || 0);
        const cap     = getCap(col, k.level || 1);
        const canAdd  = Math.max(0, Math.min(completed, cap - current));
        updates[col]  = current + canAdd;
        if (canAdd < completed && canAdd === 0) {
          events.push({ type: 'system', message: `⚠️ ${building} cap reached at level ${k.level||1} (max ${cap.toLocaleString()}) — level up to build more.` });
        }
        if (canAdd > 0) {
          completedItems.push(`${canAdd.toLocaleString()} ${building.replace(/_/g, ' ')}`);
          const landCost = (BUILDING_LAND_COST[building] || 0) * canAdd;
          if (landCost > 0) {
            updates.land = Math.max(0, (updates.land !== undefined ? updates.land : (k.land || 0)) - landCost);
          }

          // ── Consume blueprint on completion ─────────────────────────────
          if (BLUEPRINT_REQUIRED.has(building)) {
            const consume = Math.min(canAdd, blueprintsLeft);
            blueprintsLeft  -= consume;
            blueprintsUsed  += consume;
          }

          // ── Consume scaffolding on completion ───────────────────────────
          if (SCAFFOLDING_REQUIRED.has(building) || SCAFFOLDING_BONUS_BUILDINGS.has(building)) {
            const consume = Math.min(canAdd, scaffoldingLeft);
            scaffoldingLeft -= consume;
            scaffoldingUsed += consume;
          }
        }
      }
      progress[building] = totalProgress - (completed * cost);
      if (queue[building] > 0) {
        queue[building] = Math.max(0, queue[building] - completed);
        if (queue[building] <= 0) delete queue[building];
      }
    } else {
      progress[building] = totalProgress;
    }
  }

  // Persist consumable tool totals
  if (blueprintsUsed  > 0) updates.blueprints_stored = Math.max(0, (k.blueprints_stored || 0) - blueprintsUsed);
  if (scaffoldingUsed > 0) updates.tools_scaffolding  = Math.max(0, scaffoldingLeft);

  // News notices for missing tools
  if (updates._blueprint_needed) {
    events.push({ type: 'system', message: `📐 Blueprint required to build: ${updates._blueprint_needed.join(', ')}. Craft one in your Library using scribes.` });
    delete updates._blueprint_needed;
  }
  if (updates._scaffolding_needed) {
    events.push({ type: 'system', message: `🪜 Scaffolding required to build: ${updates._scaffolding_needed.join(', ')}. Produce it in your Smithy.` });
    delete updates._scaffolding_needed;
  }

  // Clean up zero progress entries for inactive buildings
  for (const b of Object.keys(progress)) {
    if (!allocation[b] && !queue[b]) delete progress[b];
  }

  updates.build_queue    = JSON.stringify(queue);
  updates.build_progress = JSON.stringify(progress);

  if (completedItems.length > 0) {
    const landUsed = (updates.land !== undefined) ? (k.land || 0) - updates.land : 0;
    const landStr = landUsed > 0 ? ` · ${landUsed} land used` : '';
    events.push({ type: 'system', message: `🔨 Construction: ${completedItems.join(', ')} built${landStr}.` });
    const totalCompleted = completedItems.reduce(function(s, item) {
      const match = item.match(/^(\d[\d,]*)/);
      return s + (match ? parseInt(match[1].replace(/,/g,'')) : 1);
    }, 0);
    const conXp = awardXp(k, 'construction', totalCompleted);
    updates.xp    = conXp.xp;
    updates.level = conXp.level;
    if (conXp.levelled) events.push(...conXp.events);
    // Award engineer unit XP per building completed
    const engXpRes = awardTroopXp({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'engineers', totalCompleted * 10);
    updates.troop_levels = engXpRes.troop_levels;
    if (engXpRes.levelUps.length) events.push({ type: 'system', message: `⚒️ Your engineers grew more skilled — Level ${JSON.parse(engXpRes.troop_levels).engineers?.level || ''}!` });
    // Dwarf racial bonus: level 5+ engineers can solo-crew war machines
    // (one-time news handled by racial unlock in processTurn — no repeated message here)
  } else if (activeBuildings.size > 0) {
    events.push({ type: 'system', message: `🔨 Engineers making progress on ${activeBuildings.size} building type${activeBuildings.size > 1 ? 's' : ''}.` });
  }

  return updates;
}

// Forge construction tools — costs gold, no engineer requirement
function forgeTools(k, toolType, quantity) {
  const cost = TOOL_GOLD_COST[toolType];
  const col  = TOOL_COL[toolType];
  if (!cost || !col) return { error: 'Unknown tool type' };
  const totalCost = cost * quantity;
  if (totalCost > k.gold) return { error: `Need ${totalCost.toLocaleString()} gold but only have ${k.gold.toLocaleString()} gold` };
  return {
    updates: {
      [col]: (k[col]||0) + quantity,
      gold: k.gold - totalCost,
      updated_at: Math.floor(Date.now()/1000),
    },
    totalCost,
  };
}

// ── Military combat ───────────────────────────────────────────────────────────

// War machine crew requirements by race
const WM_CREW_REQUIRED = {
  dwarf: 2, human: 3, high_elf: 4, dark_elf: 4, orc: 5, dire_wolf: 6,
};

function wmCrewRequired(race, engineerLevel) {
  let base = WM_CREW_REQUIRED[race] || 3;
  // Dwarf racial unique — solo crew at engineer level 5+
  if (race === 'dwarf' && engineerLevel >= 5) base = 1;
  return base;
}

function moraleMult(morale) {
  if (morale < 50)  return 0.80 + (morale / 50) * 0.10;  // 0.80–0.90
  if (morale < 100) return 0.90 + (morale / 100) * 0.10; // 0.90–1.00
  return Math.min(1.10, 1.00 + ((morale - 100) / 100) * 0.10); // 1.00–1.10
}

function resolveMilitaryAttack(attacker, defender, sentUnits, db_unused) {
  // sentUnits: { fighters, rangers, mages, warMachines, ninjas, thieves }
  const sent = {
    fighters:    Math.min(sentUnits.fighters    || 0, attacker.fighters    || 0),
    rangers:     Math.min(sentUnits.rangers     || 0, attacker.rangers     || 0),
    mages:       Math.min(sentUnits.mages       || 0, attacker.mages       || 0),
    warMachines: Math.min(sentUnits.warMachines || 0, attacker.war_machines|| 0),
    ninjas:      Math.min(sentUnits.ninjas      || 0, attacker.ninjas      || 0),
    thieves:     Math.min(sentUnits.thieves     || 0, attacker.thieves     || 0),
  };
  if (sent.fighters <= 0 && sent.rangers <= 0 && sent.mages <= 0)
    return { error: 'Send at least some troops' };

  // ── Anti-bully penalty ────────────────────────────────────────────────────
  const landRatio    = (attacker.land || 1) / Math.max(1, defender.land || 1);
  const fighterRatio = (attacker.fighters || 1) / Math.max(1, defender.fighters || 1);
  const bullyRatio   = Math.max(landRatio, fighterRatio * 0.5);
  let bullyPenalty   = 1.0;
  let bullyMsg       = null;
  let shameEvent     = null;
  if (bullyRatio >= 8) {
    bullyPenalty = 0.40;
    bullyMsg     = '⚠️ Your kingdom is disgraced attacking such a weak foe.';
    shameEvent   = `👑 ${attacker.name} has attacked the much weaker ${defender.name}. The world watches in disgust.`;
  } else if (bullyRatio >= 4) {
    bullyPenalty = 0.60;
    bullyMsg     = '⚠️ Morale suffers — this is slaughter, not war.';
  } else if (bullyRatio >= 2) {
    bullyPenalty = 0.80;
    bullyMsg     = '⚠️ Your troops lack motivation fighting a weaker foe.';
  }

  // ── Morale multipliers ────────────────────────────────────────────────────
  const atkMoraleMult = moraleMult(attacker.morale || 100);
  const defMoraleMult = moraleMult(defender.morale || 100);

  // ── Research, race and level helpers ──────────────────────────────────────
  const atkFighterLvl = effectiveTroopLevel(attacker, 'fighters') / 50;
  const atkRangerLvl  = effectiveTroopLevel(attacker, 'rangers')  / 50;
  const atkMageLvl    = effectiveTroopLevel(attacker, 'mages')    / 50;
  const atkNinjaLvl   = effectiveTroopLevel(attacker, 'ninjas')   / 50;
  const atkThiefLvl   = effectiveTroopLevel(attacker, 'thieves')  / 50;
  const defFighterLvl = effectiveTroopLevel(defender, 'fighters') / 50;
  const defRangerLvl  = effectiveTroopLevel(defender, 'rangers')  / 50;
  const defMageLvl    = effectiveTroopLevel(defender, 'mages')    / 50;
  const defNinjaLvl   = effectiveTroopLevel(defender, 'ninjas')   / 50;

  // ── Step 1: Thief sabotage — disable some defender war machines ───────────
  let defWmActive = defender.war_machines || 0;
  let thiefSabotage = 0;
  if (sent.thieves > 0) {
    const sabotageChance = Math.min(0.40, sent.thieves * 0.001 * atkThiefLvl * raceBonus(attacker, 'stealth'));
    const disabledWm = Math.floor(defWmActive * sabotageChance);
    defWmActive = Math.max(0, defWmActive - disabledWm);
    thiefSabotage = disabledWm;
  }

  // ── Step 2: Ninja pre-battle strike ───────────────────────────────────────
  let ninjaKills = 0;
  let ninjaIntercepted = 0;
  if (sent.ninjas > 0) {
    const strikeRate  = 0.01 + Math.min(0.03, sent.ninjas * 0.0001 * atkNinjaLvl * raceBonus(attacker, 'stealth'));
    const rawKills    = Math.floor((defender.fighters || 0) * strikeRate);
    // Defender ninjas intercept at 50% effectiveness
    const interceptRate = Math.min(0.50, ((defender.ninjas||0) * 0.001 * defNinjaLvl));
    ninjaIntercepted  = Math.floor(rawKills * interceptRate);
    ninjaKills        = Math.max(0, rawKills - ninjaIntercepted);
  }
  const defFightersAfterNinja = Math.max(0, (defender.fighters || 0) - ninjaKills);

  // ── Step 3: Ranger opening volley ─────────────────────────────────────────
  const rangerVolleyRate = (0.02 + Math.min(0.05, sent.rangers * 0.00005)) * atkRangerLvl * raceBonus(attacker, 'military');
  const rangerKills      = Math.floor(defFightersAfterNinja * rangerVolleyRate);
  const defFightersAfterVolley = Math.max(0, defFightersAfterNinja - rangerKills);

  // ── Step 4: Attack power ──────────────────────────────────────────────────
  const weaponsEquipped   = Math.min(sent.fighters, attacker.weapons_stockpile || 0);
  const weaponBonus       = 1 + (weaponsEquipped / Math.max(sent.fighters, 1)) * 0.25;
  const atkWeapon         = ((attacker.res_weapons || 100) / 100) * weaponBonus;
  const atkTactics        = (attacker.res_military || 100) / 100;
  const atkRaceMil        = raceBonus(attacker, 'military');
  const atkRaceMag        = raceBonus(attacker, 'magic');
  const atkRangerRace     = raceBonus(attacker, 'military'); // rangers share military bonus

  // Fighter power — front line
  const atkFighterPower = sent.fighters * atkWeapon * atkTactics * atkRaceMil * atkFighterLvl;
  // Ranger power — always ranged, lower per-unit than fighters
  const atkRangerPower  = sent.rangers * 0.7 * atkTactics * atkRangerRace * atkRangerLvl;
  // Mage power — back line, high per-unit
  const atkMagePower    = sent.mages * 2.5 * ((attacker.res_attack_magic || 100) / 100) * atkRaceMag * atkMageLvl;
  // War machines — scaled by crew sufficiency
  const engLvl          = effectiveTroopLevel(attacker, 'engineers');
  const crewNeeded      = wmCrewRequired(attacker.race, engLvl);
  const engAvail        = Math.max(0, (attacker.engineers || 0));
  const wmCrewable      = Math.min(sent.warMachines, Math.floor(engAvail / crewNeeded));
  const wmPower         = wmCrewable * 500 * ((attacker.res_war_machines || 100) / 100) * raceBonus(attacker, 'war_machines');

  const atkPowerRaw = (atkFighterPower + atkRangerPower + atkMagePower + wmPower) * atkMoraleMult * bullyPenalty;
  const atkPower    = atkPowerRaw;

  // ── Step 5: Defence power ─────────────────────────────────────────────────
  const armorEquipped   = Math.min(defFightersAfterVolley, defender.armor_stockpile || 0);
  const armorBonus      = 1 + (armorEquipped / Math.max(defFightersAfterVolley, 1)) * 0.25;
  const defArmor        = ((defender.res_armor || 100) / 100) * armorBonus;
  const defTactics      = (defender.res_military || 100) / 100;
  const defRaceMil      = raceBonus(defender, 'military');
  const defRaceMag      = raceBonus(defender, 'magic');

  // Fighter wall
  const defFighterPower = defFightersAfterVolley * defArmor * defTactics * defRaceMil * defFighterLvl;
  // Ranger fire from outposts/towers — rangers defend from walls, scaled by structures
  const outpostBonus    = (defender.bld_outposts || 0) * 0.1 + (defender.bld_guard_towers || 0) * 0.05;
  const defRangerPower  = (defender.rangers || 0) * 0.8 * defTactics * raceBonus(defender,'military') * defRangerLvl * Math.max(1, outpostBonus);
  // Mage barrier
  const defMagePower    = (defender.mages||0) * 1.5 * ((defender.res_defense_magic||100)/100) * defRaceMag * defMageLvl;
  // War machine garrison — crewed by engineers at home
  const defEngLvl       = effectiveTroopLevel(defender, 'engineers');
  const defCrewNeeded   = wmCrewRequired(defender.race, defEngLvl);
  const defWmCrewable   = Math.min(defWmActive, Math.floor((defender.engineers||0) / defCrewNeeded));
  const defWmPower      = defWmCrewable * 500 * ((defender.res_war_machines||100)/100) * raceBonus(defender,'war_machines');
  // Engineer garrison repair bonus
  const defEngBonus     = Math.floor((defender.engineers||0) / 10) * 50;
  // Structure defence
  const defStructures   = (Math.floor((defender.bld_guard_towers||0) / 2) * 200)
                        + (Math.floor((defender.bld_castles||0) / 500) * 5000);

  const defPower = (defFighterPower + defRangerPower + defMagePower + defWmPower + defEngBonus + defStructures) * defMoraleMult;

  // ── Step 6: Battle resolution ─────────────────────────────────────────────
  const variance = 0.8 + Math.random() * 0.4;
  const win      = (atkPower * variance) > defPower;
  const powerRatio = atkPower / Math.max(1, defPower);

  // ── Step 7: Casualties ────────────────────────────────────────────────────
  // Clerics reduce own-side losses
  const atkClericHeal = Math.min(0.35, (attacker.clerics||0) / Math.max(sent.fighters+sent.rangers, 1) * 0.08 * raceBonus(attacker,'magic'));
  const defClericHeal = Math.min(0.35, (defender.clerics||0) / Math.max(defender.fighters||1, 1)       * 0.08 * raceBonus(defender,'magic'));

  // Dark Elf stealth reduces attacker losses
  const atkStealthBonus = raceBonus(attacker, 'stealth') > 1 ? 0.85 : 1.0;

  const atkFighterLossPct = win ? (0.04 + Math.random()*0.08) : (0.20 + Math.random()*0.25);
  const atkRangerLossPct  = win ? (0.02 + Math.random()*0.04) : (0.10 + Math.random()*0.12); // ranged = safer
  const atkMageLossPct    = win ? (0.01 + Math.random()*0.03) : (0.05 + Math.random()*0.08); // back line = safest
  const defFighterLossPct = win ? (0.15 + Math.random()*0.20) : (0.05 + Math.random()*0.08);

  const atkFightersLost = Math.floor(sent.fighters * atkFighterLossPct * atkStealthBonus * (1 - atkClericHeal));
  const atkRangersLost  = Math.floor(sent.rangers  * atkRangerLossPct  * atkStealthBonus * (1 - atkClericHeal));
  const atkMagesLost    = Math.floor(sent.mages     * atkMageLossPct   * atkStealthBonus);
  const atkNinjasLost   = sent.ninjas > 0 ? Math.floor(sent.ninjas * (win ? 0.05 : 0.15)) : 0;
  const defFightersLost = Math.floor(defFightersAfterVolley * defFighterLossPct * (1 - defClericHeal));

  // War machine destruction — low rates
  const atkWmLost = win ? 0 : Math.floor(sent.warMachines * (0.02 + Math.random()*0.06));
  const defWmLost = win ? Math.floor(defWmActive * (0.03 + Math.random()*0.07)) : 0;

  // Land transfer
  const landTransferred = win ? Math.floor(defender.land * 0.10) : 0;

  // ── Step 8: Morale changes ────────────────────────────────────────────────
  const victoryMargin = Math.min(2.0, Math.max(0.1, powerRatio));
  let atkMoraleChange, defMoraleChange;
  if (win) {
    atkMoraleChange = Math.floor(5  + Math.min(10, victoryMargin * 5));
    defMoraleChange = -Math.max(5, Math.floor(Math.min(20, victoryMargin * 10)));
    // Bully shame — attacker loses morale too at high ratios
    if (bullyRatio >= 8)  atkMoraleChange -= 15;
    if (bullyRatio >= 4)  atkMoraleChange -= 5;
  } else {
    atkMoraleChange = -Math.floor(5 + Math.min(15, (1/Math.max(0.1,powerRatio)) * 8));
    defMoraleChange = Math.floor(5 + Math.min(10, (1/Math.max(0.1,powerRatio)) * 5));
  }
  const MORALE_FLOOR = 20;
  const newAtkMorale = Math.max(MORALE_FLOOR, Math.min(200, (attacker.morale||100) + atkMoraleChange));
  const newDefMorale = Math.max(MORALE_FLOOR, Math.min(200, (defender.morale||100) + defMoraleChange));

  // ── Build updates ─────────────────────────────────────────────────────────
  const attackerUpdates = {
    fighters:          Math.max(0, attacker.fighters - atkFightersLost),
    rangers:           Math.max(0, attacker.rangers  - atkRangersLost),
    mages:             Math.max(0, attacker.mages    - atkMagesLost),
    ninjas:            Math.max(0, attacker.ninjas   - atkNinjasLost),
    war_machines:      Math.max(0, (attacker.war_machines||0) - atkWmLost),
    land:              attacker.land + landTransferred,
    morale:            newAtkMorale,
    weapons_stockpile: Math.max(0, (attacker.weapons_stockpile||0) - Math.floor(weaponsEquipped * atkFighterLossPct)),
  };
  const defenderUpdates = {
    fighters:     Math.max(0, defender.fighters - defFightersLost - ninjaKills - rangerKills),
    war_machines: Math.max(0, (defender.war_machines||0) - defWmLost),
    land:         Math.max(0, defender.land - landTransferred),
    morale:       newDefMorale,
  };

  // XP
  const atkTroopXpF = awardTroopXp(attacker, 'fighters', win ? 30 : 10);
  const atkTroopXpR = awardTroopXp({ ...attacker, troop_levels: atkTroopXpF.troop_levels }, 'rangers', win ? 20 : 8);
  const defTroopXp  = awardTroopXp(defender, 'fighters', win ? 10 : 20);
  attackerUpdates.troop_levels = atkTroopXpR.troop_levels;
  defenderUpdates.troop_levels = defTroopXp.troop_levels;

  const atkXp = awardXp(attacker, win ? 'combat_win' : 'combat_loss', 1);
  const defXp = awardXp(defender, win ? 'combat_loss' : 'combat_win', 1);
  attackerUpdates.xp    = atkXp.xp;
  attackerUpdates.level = atkXp.level;
  defenderUpdates.xp    = defXp.xp;
  defenderUpdates.level = defXp.level;

  // ── Battle report ─────────────────────────────────────────────────────────
  const report = {
    win, landTransferred, powerRatio: Math.round(powerRatio * 100) / 100,
    atkPower: Math.round(atkPower), defPower: Math.round(defPower),
    sent, atkFightersLost, atkRangersLost, atkMagesLost, atkNinjasLost, atkWmLost,
    defFightersLost: defFightersLost + ninjaKills + rangerKills, defWmLost,
    ninjaKills, rangerKills, thiefSabotage,
    atkMoraleChange, defMoraleChange,
    bullyMsg, shameEvent,
  };

  // ── Event messages ────────────────────────────────────────────────────────
  const atkLines = [];
  if (ninjaKills > 0)    atkLines.push(`Ninjas eliminated ${ninjaKills} defenders before the battle.`);
  if (rangerKills > 0)   atkLines.push(`Rangers volley killed ${rangerKills} defenders.`);
  if (thiefSabotage > 0) atkLines.push(`Thieves disabled ${thiefSabotage} enemy war machines.`);
  if (bullyMsg)          atkLines.push(bullyMsg);

  const atkEvent = win
    ? `⚔️ You attacked ${defender.name} and won! Captured ${landTransferred} acres. Lost ${atkFightersLost} fighters, ${atkRangersLost} rangers, ${atkMagesLost} mages. ${atkLines.join(' ')}`
    : `⚔️ Attack on ${defender.name} was repelled. Lost ${atkFightersLost} fighters, ${atkRangersLost} rangers. ${atkLines.join(' ')}`;

  const defEvent = win
    ? `⚔️ ${attacker.name} attacked and broke through! Lost ${landTransferred} acres. ${defFightersLost + ninjaKills + rangerKills} defenders fell.`
    : `⚔️ ${attacker.name} attacked but was repelled. You lost ${defFightersLost} fighters defending.${ninjaKills > 0 ? ` ${ninjaKills} fighters were killed in a pre-battle ninja strike.` : ''}`;

  return { win, report, attackerUpdates, defenderUpdates, atkEvent, defEvent, shameEvent };
}

// ── Magic ─────────────────────────────────────────────────────────────────────

const SPELL_DEFS = {
  // Tier 1 — Spellbook 100–400
  spark:      { minSB: 100,  tier: 1, effect: 'buildings',   damageType: 'fire',    desc: 'Burns a small number of enemy farms' },
  fog_of_war: { minSB: 150,  tier: 1, effect: 'debuff',      damageType: 'illusion',desc: 'Blinds enemy rangers for 3 turns', duration: 3 },
  mend:       { minSB: 200,  tier: 1, effect: 'friendly',    damageType: 'none',    desc: 'Heals your own troop casualties from last battle' },
  blight:     { minSB: 250,  tier: 1, effect: 'debuff',      damageType: 'poison',  desc: 'Poisons enemy food supply for 5 turns', duration: 5 },
  rain:       { minSB: 300,  tier: 1, effect: 'buildings',   damageType: 'cool',    desc: 'Floods enemy farms — more damage than Spark' },
  dispel:     { minSB: 400,  tier: 1, effect: 'friendly',    damageType: 'none',    desc: 'Removes all active curses and debuffs from your kingdom' },
  // Tier 2 — Spellbook 500–900
  lightning:  { minSB: 500,  tier: 2, effect: 'troops',      damageType: 'strike',  desc: 'Strikes down enemy fighters' },
  bless:      { minSB: 600,  tier: 2, effect: 'friendly',    damageType: 'none',    desc: 'Boosts morale and population growth for 5 turns', duration: 5 },
  silence:    { minSB: 700,  tier: 2, effect: 'debuff',      damageType: 'mental',  desc: 'Suppresses enemy research progress for 3 turns', duration: 3 },
  amnesia:    { minSB: 800,  tier: 2, effect: 'research',    damageType: 'mental',  desc: 'Permanently wipes a chunk of enemy economy research' },
  drain:      { minSB: 900,  tier: 2, effect: 'mana',        damageType: 'arcane',  desc: 'Siphons mana from enemy kingdom to yours' },
  // Tier 3 — Spellbook 1000–1500
  plague:     { minSB: 1000, tier: 3, effect: 'population',  damageType: 'disease', desc: 'Kills enemy population over 5 turns', duration: 5 },
  earthquake: { minSB: 1200, tier: 3, effect: 'buildings',   damageType: 'force',   desc: 'Destroys buildings across all types' },
  tempest:    { minSB: 1400, tier: 3, effect: 'troops',      damageType: 'storm',   desc: 'Kills all troop types simultaneously' },
  shield:     { minSB: 1500, tier: 3, effect: 'friendly',    damageType: 'none',    desc: 'Reduces incoming spell damage by 50% for 5 turns', duration: 5 },
  // Tier 4 — Spellbook 2000+
  armageddon: { minSB: 2000, tier: 4, effect: 'catastrophic',damageType: 'void',    desc: 'Destroys land, buildings, and population simultaneously. One cast, total devastation.' },
};

// Scroll crafting requirements: { mages needed, turns to complete }
const SCROLL_REQUIREMENTS = {
  spark:      { mages: 5,   turns: 5  },
  fog_of_war: { mages: 8,   turns: 8  },
  mend:       { mages: 8,   turns: 10 },
  blight:     { mages: 10,  turns: 12 },
  rain:       { mages: 10,  turns: 15 },
  dispel:     { mages: 12,  turns: 15 },
  lightning:  { mages: 15,  turns: 20 },
  bless:      { mages: 15,  turns: 20 },
  silence:    { mages: 20,  turns: 25 },
  amnesia:    { mages: 20,  turns: 30 },
  drain:      { mages: 25,  turns: 30 },
  plague:     { mages: 30,  turns: 40 },
  earthquake: { mages: 35,  turns: 50 },
  tempest:    { mages: 40,  turns: 60 },
  shield:     { mages: 40,  turns: 60 },
  armageddon: { mages: 100, turns: 200 },
};

// Map/blueprint crafting requirements (scribes)
const SCRIBE_ITEMS = {
  map:       { scribes: 3,  turns: 10, desc: 'Required to interact with another kingdom' },
  blueprint: { scribes: 5,  turns: 20, desc: 'Boosts construction speed by 10% when used' },
};

function castSpell(caster, target, spellId, obscure) {
  const def = SPELL_DEFS[spellId];
  if (!def) return { error: 'Unknown spell' };
  if ((caster.res_spellbook || 0) < def.minSB)
    return { error: `Spellbook too low — need ${def.minSB}, have ${caster.res_spellbook}` };

  // Scroll check — must have a crafted scroll to cast
  let scrolls = {};
  try { scrolls = JSON.parse(caster.scrolls || '{}'); } catch {}
  if ((scrolls[spellId] || 0) < 1)
    return { error: `No ${spellId.replace(/_/g,' ')} scroll in your library — craft one first` };

  // Mana cost: base cost scales with tier
  const TIER_MANA = { 1: 500, 2: 2000, 3: 8000, 4: 50000 };
  const baseMana   = TIER_MANA[def.tier] || 500;
  const obscureCost = obscure ? Math.floor(baseMana * 0.5) : 0;
  const totalMana   = baseMana + obscureCost;
  if ((caster.mana || 0) < totalMana)
    return { error: `Not enough mana — need ${totalMana.toLocaleString()}, have ${(caster.mana||0).toLocaleString()}` };

  // Consume scroll and mana
  scrolls[spellId] = (scrolls[spellId] || 0) - 1;
  if (scrolls[spellId] <= 0) delete scrolls[spellId];
  const casterUpdates = {
    mana:    caster.mana - totalMana,
    scrolls: JSON.stringify(scrolls),
  };

  // Attack/defense magic modifiers
  const atkMagic = ((caster.res_attack_magic || 100) / 100) * raceBonus(caster, 'magic');
  const defMagic = ((target.res_defense_magic || 100) / 100) * raceBonus(target, 'magic');
  const magicRatio = Math.max(0.2, atkMagic / Math.max(0.5, defMagic));

  // Check shield active effect on target
  let targetEffects = {};
  try { targetEffects = JSON.parse(target.active_effects || '{}'); } catch {}
  const shielded = targetEffects.shield ? 0.5 : 1.0;

  const targetUpdates = {};
  let damageDesc = '';
  let activeEffect = null; // { key, turns_left, ...data } to apply to target

  // ── Friendly spells (target = caster) ────────────────────────────────────
  if (def.effect === 'friendly') {
    if (spellId === 'mend') {
      // Restore 10% of fighters (simulates healing recent casualties)
      const healed = Math.floor((caster.fighters || 0) * 0.10 * magicRatio);
      casterUpdates.fighters = (caster.fighters || 0) + healed;
      damageDesc = `${healed.toLocaleString()} fighters restored`;
    } else if (spellId === 'dispel') {
      // Clear all active debuffs from caster
      let effects = {};
      try { effects = JSON.parse(caster.active_effects || '{}'); } catch {}
      const debuffs = ['fog_of_war','blight','silence','plague'];
      let cleared = 0;
      debuffs.forEach(d => { if (effects[d]) { delete effects[d]; cleared++; } });
      casterUpdates.active_effects = JSON.stringify(effects);
      damageDesc = cleared > 0 ? `${cleared} active curse${cleared > 1 ? 's' : ''} dispelled` : 'no active curses to dispel';
    } else if (spellId === 'bless') {
      const moraleGain = Math.min(50, Math.floor(10 * magicRatio));
      casterUpdates.morale = Math.min(200, (caster.morale || 100) + moraleGain);
      // Apply bless buff for 5 turns
      let effects = {};
      try { effects = JSON.parse(caster.active_effects || '{}'); } catch {}
      effects.bless = { turns_left: def.duration || 5, morale_bonus: moraleGain };
      casterUpdates.active_effects = JSON.stringify(effects);
      damageDesc = `+${moraleGain} morale and pop growth boosted for ${def.duration||5} turns`;
    } else if (spellId === 'shield') {
      let effects = {};
      try { effects = JSON.parse(caster.active_effects || '{}'); } catch {}
      effects.shield = { turns_left: def.duration || 5 };
      casterUpdates.active_effects = JSON.stringify(effects);
      damageDesc = `magic shield active for ${def.duration||5} turns — incoming spell damage halved`;
    }
    return {
      casterUpdates,
      targetUpdates: {},
      report: { spellId, friendly: true, damageDesc, manaCost: totalMana, obscure },
      casterEvent: `✨ Cast ${spellId.replace(/_/g,' ')} — ${damageDesc}.`,
    };
  }

  // ── Offensive / debuff spells ─────────────────────────────────────────────

  if (spellId === 'spark') {
    // Burns a small number of farms
    const farmsLost = Math.max(1, Math.floor(5 * magicRatio * shielded));
    targetUpdates.bld_farms = Math.max(0, (target.bld_farms || 0) - farmsLost);
    damageDesc = `${farmsLost} farm${farmsLost > 1 ? 's' : ''} burned`;

  } else if (spellId === 'rain') {
    // Floods more farms than Spark
    const farmsLost = Math.max(1, Math.floor(20 * magicRatio * shielded));
    targetUpdates.bld_farms = Math.max(0, (target.bld_farms || 0) - farmsLost);
    damageDesc = `${farmsLost} farm${farmsLost > 1 ? 's' : ''} flooded`;

  } else if (spellId === 'fog_of_war') {
    // Debuff: blinds rangers for duration turns
    activeEffect = { turns_left: def.duration || 3, type: 'fog_of_war' };
    damageDesc = `rangers blinded for ${def.duration||3} turns`;

  } else if (spellId === 'blight') {
    // Debuff: poison food supply for duration turns
    const foodDamage = Math.floor(500 * magicRatio * shielded);
    activeEffect = { turns_left: def.duration || 5, type: 'blight', damage: foodDamage };
    damageDesc = `food supply poisoned for ${def.duration||5} turns (-${foodDamage.toLocaleString()} food/turn)`;

  } else if (spellId === 'lightning') {
    // Kills enemy fighters
    const fightersLost = Math.max(1, Math.floor((target.fighters || 0) * 0.05 * magicRatio * shielded));
    targetUpdates.fighters = Math.max(0, (target.fighters || 0) - fightersLost);
    damageDesc = `${fightersLost.toLocaleString()} fighters struck down`;

  } else if (spellId === 'silence') {
    // Debuff: suppresses research for duration turns
    activeEffect = { turns_left: def.duration || 3, type: 'silence' };
    damageDesc = `research suppressed for ${def.duration||3} turns`;

  } else if (spellId === 'amnesia') {
    // Permanently wipes economy research
    const resLost = Math.max(1, Math.floor(15 * magicRatio * shielded));
    targetUpdates.res_economy = Math.max(0, (target.res_economy || 0) - resLost);
    damageDesc = `economy research reduced by ${resLost}%`;

  } else if (spellId === 'drain') {
    // Siphons mana from target to caster
    const manaDrained = Math.max(10, Math.floor((target.mana || 0) * 0.15 * magicRatio * shielded));
    targetUpdates.mana = Math.max(0, (target.mana || 0) - manaDrained);
    casterUpdates.mana = (casterUpdates.mana || caster.mana - totalMana) + manaDrained;
    damageDesc = `${manaDrained.toLocaleString()} mana drained`;

  } else if (spellId === 'plague') {
    // Debuff: kills population each turn for duration
    activeEffect = { turns_left: def.duration || 5, type: 'plague' };
    damageDesc = `plague spreading — population will die each turn for ${def.duration||5} turns`;

  } else if (spellId === 'earthquake') {
    // Destroys buildings across all types
    const dmg = Math.max(1, Math.floor(8 * magicRatio * shielded));
    targetUpdates.bld_farms       = Math.max(0, (target.bld_farms       || 0) - Math.floor(dmg * 1.5));
    targetUpdates.bld_barracks    = Math.max(0, (target.bld_barracks    || 0) - dmg);
    targetUpdates.bld_guard_towers= Math.max(0, (target.bld_guard_towers|| 0) - dmg);
    targetUpdates.bld_markets     = Math.max(0, (target.bld_markets     || 0) - Math.floor(dmg * 0.5));
    targetUpdates.bld_castles     = Math.max(0, (target.bld_castles     || 0) - Math.floor(dmg * 0.1));
    damageDesc = `buildings destroyed across the kingdom (farms, barracks, towers)`;

  } else if (spellId === 'tempest') {
    // Kills all troop types
    const troopKill = Math.max(1, Math.floor((target.fighters || 0) * 0.08 * magicRatio * shielded));
    const rangerKill = Math.max(0, Math.floor((target.rangers || 0) * 0.06 * magicRatio * shielded));
    const clericKill = Math.max(0, Math.floor((target.clerics || 0) * 0.06 * magicRatio * shielded));
    targetUpdates.fighters = Math.max(0, (target.fighters || 0) - troopKill);
    targetUpdates.rangers  = Math.max(0, (target.rangers  || 0) - rangerKill);
    targetUpdates.clerics  = Math.max(0, (target.clerics  || 0) - clericKill);
    damageDesc = `${troopKill.toLocaleString()} fighters, ${rangerKill.toLocaleString()} rangers, ${clericKill.toLocaleString()} clerics killed`;

  } else if (spellId === 'armageddon') {
    // Catastrophic — land, buildings, population
    const landLost  = Math.floor((target.land || 0) * 0.20 * magicRatio * shielded);
    const popLost   = Math.floor((target.population || 0) * 0.25 * magicRatio * shielded);
    const farmLost  = Math.floor((target.bld_farms || 0) * 0.30 * magicRatio * shielded);
    const fightLost = Math.floor((target.fighters || 0) * 0.20 * magicRatio * shielded);
    targetUpdates.land       = Math.max(0, (target.land       || 0) - landLost);
    targetUpdates.population = Math.max(0, (target.population || 0) - popLost);
    targetUpdates.bld_farms  = Math.max(0, (target.bld_farms  || 0) - farmLost);
    targetUpdates.fighters   = Math.max(0, (target.fighters   || 0) - fightLost);
    damageDesc = `ARMAGEDDON — ${landLost} acres scorched, ${popLost.toLocaleString()} killed, ${farmLost} farms razed, ${fightLost.toLocaleString()} fighters slain`;
  }

  // Apply active effect to target if this is a debuff spell
  if (activeEffect) {
    targetEffects[spellId] = activeEffect;
    targetUpdates.active_effects = JSON.stringify(targetEffects);
  }

  const source = obscure ? 'An unknown sorcerer' : caster.name;
  const targetEvent = obscure
    ? `⚡ A mysterious ${spellId.replace(/_/g,' ')} spell struck your kingdom — ${damageDesc}.`
    : `⚡ ${caster.name} cast ${spellId.replace(/_/g,' ')} on your kingdom — ${damageDesc}.`;

  const casterEvent = `✨ You cast ${spellId.replace(/_/g,' ')} on ${target.name}. Effect: ${damageDesc}.`;

  return {
    casterUpdates,
    targetUpdates,
    report: { spellId, damageDesc, manaCost: totalMana, obscure, magicRatio: Math.round(magicRatio * 100) },
    casterEvent,
    targetEvent,
  };
}

// ── Covert ops ────────────────────────────────────────────────────────────────

function covertSpy(spy, target, unitsSent) {
  const stealthMulti = raceBonus(spy, 'stealth') * unitLevelMult(spy, 'thieves');
  const success = (spy.thieves + spy.ninjas) * stealthMulti > target.fighters * 0.02 + target.bld_guard_towers * 5;

  if (!success) {
    const caught = Math.floor(unitsSent * 0.3);
    return {
      success: false,
      spyUpdates:    { thieves: spy.thieves - caught },
      targetUpdates: {},
      spyEvent:      `Spy mission on ${target.name} failed — ${caught} thieves caught.`,
      targetEvent:   `${spy.name} attempted to spy on you — caught ${caught} thieves.`,
    };
  }

  function noise(n) { return Math.floor(n * (0.85 + Math.random() * 0.30)); }
  const report = {
    name: target.name, race: target.race,
    land: noise(target.land), fighters: noise(target.fighters),
    mages: noise(target.mages), gold: noise(target.gold),
  };

  // Award thief XP for successful spy
  const tXp = awardTroopXp(spy, 'thieves', 12);
  return {
    success: true, report,
    spyUpdates: { troop_levels: tXp.troop_levels },
    targetUpdates: {},
    spyEvent: `Spy report on ${target.name} retrieved successfully.`,
    targetEvent: null,
  };
}

function covertLoot(thief, target, lootType, thievesSent) {
  if (thievesSent > thief.thieves) return { error: 'Not enough thieves' };
  const thiefLvMult  = unitLevelMult(thief, 'thieves');
  const stealthMulti = raceBonus(thief, 'stealth') * thiefLvMult;
  const success = thief.thieves * stealthMulti > target.fighters * 0.015 + target.bld_guard_towers * 3
                                                                          + target.bld_armories * 10
                                                                          + target.bld_vaults * 10;
  if (!success) {
    return {
      success: false,
      thiefUpdates:  { thieves: thief.thieves - Math.floor(thievesSent * 0.25) },
      targetUpdates: {},
      event: `Loot attempt on ${target.name} failed. Thieves captured.`,
    };
  }

  const targetUpdates = {};
  let stolen = 0, desc = '';

  // Level scales loot amount
  if (lootType === 'gold') {
    stolen = Math.floor(thievesSent * (50 + Math.random() * 50) * thiefLvMult);
    stolen = Math.min(stolen, Math.floor(target.gold * 0.05));
    targetUpdates.gold = target.gold - stolen;
    desc = `${stolen.toLocaleString()} gold`;
  } else if (lootType === 'research') {
    stolen = Math.floor(thievesSent * 0.2 * thiefLvMult);
    targetUpdates.res_economy = Math.max(0, target.res_economy - stolen);
    desc = `${stolen} economy research points`;
  } else if (lootType === 'weapons') {
    stolen = Math.floor(thievesSent * 0.3 * thiefLvMult);
    targetUpdates.res_weapons = Math.max(0, target.res_weapons - stolen);
    desc = `${stolen} weapon research points`;
  } else if (lootType === 'war_machines') {
    stolen = Math.floor(thievesSent * 0.01 * thiefLvMult);
    targetUpdates.war_machines = Math.max(0, target.war_machines - stolen);
    desc = `${stolen} war machine(s)`;
  }

  const tXp = awardTroopXp(thief, 'thieves', 20);
  return {
    success: true, stolen, lootType,
    thiefUpdates:  { troop_levels: tXp.troop_levels },
    targetUpdates,
    thiefEvent:  `Looted ${desc} from ${target.name}.`,
    targetEvent: `Thieves infiltrated your kingdom and stole ${desc}.`,
  };
}

function covertAssassinate(assassin, target, ninjasSent, unitType) {
  if (ninjasSent > assassin.ninjas) return { error: 'Not enough ninjas' };
  const ninjaLvMult  = unitLevelMult(assassin, 'ninjas');
  const stealthMulti = raceBonus(assassin, 'stealth') * ninjaLvMult;
  const success = assassin.ninjas * stealthMulti * 1.2 > target[unitType] * 0.01 + target.bld_guard_towers * 2;

  if (!success) {
    return {
      success: false,
      assassinUpdates: { ninjas: assassin.ninjas - Math.floor(ninjasSent * 0.2) },
      targetUpdates: {},
      event: `Assassination of ${unitType} in ${target.name} failed. Ninjas compromised.`,
    };
  }

  const killed = Math.floor(ninjasSent * (10 + Math.random() * 10) * ninjaLvMult);
  const targetUpdates = { [unitType]: Math.max(0, target[unitType] - killed) };

  // Dark Elf racial bonus: level 5+ ninjas leave no trace
  const darkElfBonus = racialUnitBonus(assassin, 'ninjas');
  const silent = darkElfBonus.silentAssassination;

  const nXp = awardTroopXp(assassin, 'ninjas', 30);
  return {
    success: true, killed, silent,
    assassinUpdates: { troop_levels: nXp.troop_levels },
    targetUpdates,
    assassinEvent: `Assassinated ${killed.toLocaleString()} ${unitType} in ${target.name}.${silent ? ' No trace left.' : ''}`,
    targetEvent:   silent ? null : `${assassin.name}'s ninjas assassinated ${killed.toLocaleString()} of your ${unitType}.`,
  };
}

// ── Alliance pledge defence ───────────────────────────────────────────────────

function resolveAllianceDefence(attackResult, allies) {
  // When a kingdom is attacked, allied kingdoms send pledge % of their fighters
  if (!attackResult.win) return [];
  return allies.map(ally => {
    const sent = Math.floor(ally.fighters * (ally.pledge / 100));
    return { allyId: ally.id, sent };
  });
}

// ── Expedition rewards ──────────────────────────────────────────────────────
// ── Expedition helpers ──────────────────────────────────────────────────────
function roll(chance) { return Math.random() < chance; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const JUNK_PRIZES = [
  'a suspiciously damp sock',
  'a map to a location that no longer exists',
  'a very confident fortune cookie with no fortune inside',
  'a half-eaten ration bar of unknown vintage',
  'a decorative rock (it does nothing)',
  'a pamphlet titled "10 Reasons Orcs Are Actually Quite Misunderstood"',
  'a jar of mysterious grey paste (do not eat)',
  'a slightly bent sword that the previous owner called "Destiny"',
  'a tiny flag from a kingdom that fell 300 years ago',
  'a love letter addressed to someone named Grimbold',
  'a collection of 47 different types of dirt',
  'a boot (just the one)',
  'a certificate of participation from the Third Annual Swamp Festival',
  'a wheel of cheese that has achieved sentience (probably)',
  'a bag of magic beans that are, on closer inspection, just beans',
  'a very thorough guide to knitting (no one in your kingdom knows how to read)',
  'a suspicious smell that follows rangers home',
  'a crystal ball showing only static',
  'an extremely detailed painting of a cloud',
  'a dwarf\'s shopping list (mostly cheese)',
  'a torch that only works in daylight',
  'a book called "How To Stop Being Poor" — all pages blank',
  'a rusty key to an unknown lock',
  'a proclamation declaring your kingdom "pretty good, probably"',
  'a coupon for 10% off at an inn that burned down decades ago',
];

// ── Ultra-rare expedition prizes ─────────────────────────────────────────────
const ULTRA_RARE_PRIZES = [
  {
    id: 'ancient_dragon_egg',
    text: '🥚 An ancient dragon egg, still warm — it pulses with primordial magic',
    effect: (k, updates) => {
      updates.res_attack_magic = (k.res_attack_magic || 0) + 75;
      updates.res_spellbook    = (k.res_spellbook    || 0) + 50;
      updates.mana             = (k.mana             || 0) + 5000;
    },
  },
  {
    id: 'tome_of_forgotten_kings',
    text: "📖 The Tome of Forgotten Kings — ancient military wisdom permanently inscribed in your kingdom's history",
    effect: (k, updates) => {
      updates.res_military = (k.res_military || 0) + 80;
      updates.res_weapons  = (k.res_weapons  || 0) + 50;
      updates.res_armor    = (k.res_armor    || 0) + 50;
    },
  },
  {
    id: 'crystalline_mana_heart',
    text: '💎 A crystalline mana heart — it hums with a frequency older than the world itself',
    effect: (k, updates) => {
      updates.mana              = (k.mana              || 0) + 20000;
      updates.res_defense_magic = (k.res_defense_magic || 0) + 60;
      updates.res_spellbook     = (k.res_spellbook     || 0) + 100;
    },
  },
  {
    id: 'vault_of_the_ancients',
    text: '💰 A sealed vault of the Ancient Ones — untold riches beyond imagining',
    effect: (k, updates) => {
      updates.gold        = (k.gold        || 0) + 500000;
      updates.res_economy = (k.res_economy || 0) + 60;
    },
  },
  {
    id: 'lost_legion_banner',
    text: '⚔️ The Banner of the Lost Legion — ten thousand warriors emerge from the mist and pledge their eternal service',
    effect: (k, updates) => {
      updates.fighters     = (k.fighters     || 0) + 10000;
      updates.res_military = (k.res_military || 0) + 40;
    },
  },
  {
    id: 'seed_of_the_world_tree',
    text: '🌳 The Seed of the World Tree — your lands bloom with ancient fertility',
    effect: (k, updates) => {
      updates.land       = (k.land       || 0) + 500;
      updates.bld_farms  = (k.bld_farms  || 0) + 100;
      updates.population = (k.population || 0) + 50000;
    },
  },
];

// ── The Throne of Nazdreg Grishnak — unique, exists once in the entire world ──
const THRONE_OF_NAZDREG = {
  id: 'throne_of_nazdreg',
  unique: true,
  text: [
    '👑 The Throne of Nazdreg Grishnak',
    '',
    'Your rangers stumble upon a clearing unlike any other.',
    'Vines have claimed it, but beneath the green — a throne of obsidian and iron,',
    'carved with the fury and grace of a warrior who loved deeply and lived fully.',
    '',
    'Inscribed in the stone, worn smooth by years of wilderness rain:',
    '',
    '    Nazdreg Grishnak',
    '    August 13, 1975 — August 19, 2012',
    '',
    'An orc who sat upon this throne once commanded armies and shaped the world.',
    'His name is remembered. His legacy endures.',
    '',
    'Your people carry the throne home with reverence.',
    'They say the land itself feels stronger for it.',
  ].join('\n'),
  effect: (k, updates) => {
    updates.res_military      = (k.res_military      || 0) + 100;
    updates.res_economy       = (k.res_economy       || 0) + 100;
    updates.res_construction  = (k.res_construction  || 0) + 100;
    updates.res_weapons       = (k.res_weapons       || 0) + 100;
    updates.res_armor         = (k.res_armor         || 0) + 100;
    updates.res_entertainment = (k.res_entertainment || 0) + 100;
    updates.gold              = (k.gold              || 0) + 1000000;
    updates.land              = (k.land              || 0) + 1000;
    updates.population        = (k.population        || 0) + 100000;
    updates.morale            = Math.min(200, (k.morale || 100) + 50);
    updates.fighters          = (k.fighters          || 0) + 50000;
  },
};

function junkPrize() {
  return JUNK_PRIZES[Math.floor(Math.random() * JUNK_PRIZES.length)];
}

const RARITY = {
  common:    { label: 'Common',    color: '#9a9bb5' },
  uncommon:  { label: 'Uncommon',  color: '#4caf82' },
  rare:      { label: 'Rare',      color: '#7c6af5' },
  epic:      { label: 'Epic',      color: '#e8b84b' },
  legendary: { label: 'Legendary', color: '#e05c5c' },
};

function expeditionRewards(type, rangers, fighters, k, db) {
  const tacBonus = 1 + ((k.res_military || 0) / 2000);

  // Race exploration bonus — affects all reward quantities
  const exploreBonus = {
    dire_wolf: 1.40, dark_elf: 1.25, human: 1.10,
    orc: 1.05, dwarf: 0.90, high_elf: 0.95,
  }[k.race] || 1.0;

  // Ranger level bonus — higher level rangers are better scouts
  const rangerLvBonus = unitLevelMult(k, 'rangers');

  // Attrition reduced for skilled explorer races
  const attritionMult = { dire_wolf: 0.5, dark_elf: 0.6 }[k.race] || 1.0;
  const rewards = [];
  const events  = [];
  const updates = {};

  // Attrition — skilled explorer races lose fewer rangers
  const attritionPct = type === 'dungeon' ? rand(0, 3) : rand(0, 2);
  const lost = Math.floor(rangers * attritionPct / 100 * attritionMult);
  const returned = rangers - lost;
  if (lost > 0) rewards.push({ text: `${lost} ranger${lost > 1 ? 's' : ''} did not return from the expedition` });
  // Rangers returned stored separately so resolveExpeditions can use SQL increment
  updates._rangers_returned = returned;

  // Expedition turn counts — used to calculate gold from foraging rate
  const EXPEDITION_TURNS = { scout: 10, deep: 25, dungeon: 50 };
  const expTurns = EXPEDITION_TURNS[type] || 10;

  // Gold base = forage rate (rangers × 12 × tacBonus) × turns × race bonus × random 5–30% bonus
  const foragePerTurn = rangers * 2 * tacBonus * exploreBonus * rangerLvBonus;
  const randomBonus   = 1 + (rand(5, 30) / 100);
  const goldBase      = Math.floor(foragePerTurn * expTurns * randomBonus);

  if (type === 'scout') {
    rewards.push({ text: `+${goldBase.toLocaleString()} gold from foraging` });
    updates.gold = (k.gold || 0) + goldBase;

    const land = Math.max(1, Math.floor(rand(rangers * 0.01, rangers * 0.03) * exploreBonus));
    rewards.push({ text: `+${land} acre${land > 1 ? 's' : ''} of unclaimed land` });
    updates.land = (k.land || 0) + land;

    if (roll(0.30)) {
      const mana = rand(Math.floor(rangers * 0.2 * exploreBonus), Math.floor(rangers * 0.8 * exploreBonus));
      rewards.push({ text: `+${mana} mana from a hidden shrine` });
      updates.mana = (k.mana || 0) + mana;
    }
    if (roll(0.10)) {
      const troops = rand(2, Math.max(3, Math.floor(rangers * 0.02 * exploreBonus)));
      rewards.push({ text: `${troops} wandering fighter${troops > 1 ? 's' : ''} pledge allegiance to your kingdom` });
      updates.fighters = (k.fighters || 0) + troops;
    }
    if (roll(0.03)) {
      const bonus = rand(Math.floor(rangers * 0.03 * exploreBonus), Math.floor(rangers * 0.08 * exploreBonus));
      rewards.push({ text: `An ancient map reveals ${bonus} additional acres — scouts claim them!` });
      updates.land = (updates.land || k.land || 0) + bonus;
    }
    if (roll(0.45)) rewards.push({ text: `Your rangers also found ${junkPrize()}` });

    // Map drop — 5% chance on scout
    if (roll(0.05)) {
      updates.maps = (k.maps || 0) + 1;
      rewards.push({ text: `🗺️ A map was found — you can now interact with other kingdoms` });
    }

  } else if (type === 'deep') {
    rewards.push({ text: `+${goldBase.toLocaleString()} gold from deep wilderness caches` });
    updates.gold = (k.gold || 0) + goldBase;

    const land = Math.max(2, Math.floor(rand(rangers * 0.04, rangers * 0.10) * exploreBonus));
    rewards.push({ text: `+${land} acres of fertile territory` });
    updates.land = (k.land || 0) + land;

    if (roll(0.55)) {
      const mana = rand(Math.floor(rangers * 0.5 * exploreBonus), Math.floor(rangers * 2 * exploreBonus));
      rewards.push({ text: `+${mana} mana from ley lines discovered deep in the wilderness` });
      updates.mana = (k.mana || 0) + mana;
    }
    if (roll(0.25)) {
      const disc = ['res_economy','res_weapons','res_armor','res_military','res_entertainment'][rand(0,4)];
      const boost = rand(1, Math.max(2, Math.floor(5 * exploreBonus)));
      const discLabel = disc.replace('res_','').replace('_',' ');
      rewards.push({ text: `A research scroll found — ${discLabel} +${boost}%` });
      updates[disc] = (k[disc] || 0) + boost;
    }
    if (roll(0.20)) {
      const troops = rand(Math.floor(rangers * 0.03 * exploreBonus), Math.floor(rangers * 0.08 * exploreBonus));
      const ttype = roll(0.5) ? 'fighters' : 'rangers';
      if (troops > 0) {
        rewards.push({ text: `${troops} mercenary ${ttype} join your cause` });
        updates[ttype] = (k[ttype] || 0) + troops;
      }
    }
    if (roll(0.08)) {
      const bonus = rand(Math.floor(rangers * 0.05 * exploreBonus), Math.floor(rangers * 0.15 * exploreBonus));
      rewards.push({ text: `Ruins of an abandoned kingdom found — you claim ${bonus} acres of its former territory` });
      updates.land = (updates.land || k.land || 0) + bonus;
    }
    if (roll(0.02)) {
      const disc = ['res_spellbook','res_attack_magic','res_defense_magic','res_war_machines','res_construction'][rand(0,4)];
      const boost = rand(Math.floor(5 * exploreBonus), Math.floor(15 * exploreBonus));
      const discLabel = disc.replace('res_','').replace('_',' ');
      rewards.push({ text: `⚡ An ancient artifact of ${discLabel} — permanent +${boost}%` });
      updates[disc] = (k[disc] || 0) + boost;
    }
    if (roll(0.60)) rewards.push({ text: `Hidden deep in the wilderness, your rangers also discovered ${junkPrize()}` });

    // Map drop — 15% chance on deep
    if (roll(0.15)) {
      updates.maps = (updates.maps || k.maps || 0) + 1;
      rewards.push({ text: `🗺️ A map was discovered in the deep wilderness` });
    }

  } else if (type === 'dungeon') {
    const power = (rangers + fighters * 2) * tacBonus * exploreBonus;
    const successChance = Math.min(0.90, 0.25 + (power / 24000));
    const success = roll(successChance);

    if (!success) {
      const fLost = Math.min(fighters, rand(Math.floor(fighters * 0.05), Math.floor(fighters * 0.15)));
      const fReturned = fighters - fLost;
      if (fReturned > 0) updates._fighters_returned = fReturned;
      rewards.push({ text: `The dungeon proved too dangerous — ${fLost} fighters lost in retreat` });
      events.push({ type: 'attack', message: `💀 Dungeon raid FAILED — your forces were overwhelmed. ${fLost.toLocaleString()} fighters lost.` });
    } else {
      updates._fighters_returned = fighters;

      const dungeonGold = Math.floor(fighters * rand(8, 12) * tacBonus * exploreBonus * randomBonus);
      rewards.push({ text: `+${dungeonGold.toLocaleString()} gold plundered from the dungeon` });
      updates.gold = (k.gold || 0) + dungeonGold;

      const mana = rand(Math.floor(rangers * 1 * exploreBonus), Math.floor(rangers * 4 * exploreBonus));
      rewards.push({ text: `+${mana} mana from dungeon ley stones` });
      updates.mana = (k.mana || 0) + mana;

      const disc = ['res_weapons','res_armor','res_military','res_attack_magic','res_spellbook'][rand(0,4)];
      const boost = rand(3, Math.floor(12 * exploreBonus));
      const discLabel = disc.replace('res_','').replace('_',' ');
      rewards.push({ text: `Dungeon tome found — ${discLabel} permanently +${boost}%` });
      updates[disc] = (k[disc] || 0) + boost;

      if (roll(0.12)) {
        const wm = rand(1, Math.max(2, Math.floor(fighters / 500 * exploreBonus)));
        rewards.push({ text: `⚡ Ancient war machine${wm > 1 ? 's' : ''} recovered from the dungeon depths — +${wm}` });
        updates.war_machines = (k.war_machines || 0) + wm;
      }
      if (roll(0.06)) {
        const boost2 = rand(10, Math.floor(40 * exploreBonus));
        rewards.push({ text: `⚡ The dungeon's heart pulsed with ancient magic — spellbook permanently +${boost2}` });
        updates.res_spellbook = (updates.res_spellbook || k.res_spellbook || 0) + boost2;
      }
      if (roll(0.5)) rewards.push({ text: `Amid the carnage, someone pocketed ${junkPrize()}` });

      // Map drop — 25% chance on dungeon
      if (roll(0.25)) {
        updates.maps = (updates.maps || k.maps || 0) + 1;
        rewards.push({ text: `🗺️ A map was found among the dungeon spoils` });
      }
      // Blueprint drop — 20% chance on dungeon
      if (roll(0.20)) {
        const smithyCap = (k.bld_smithies || 0) * 25;
        const curBP = updates.blueprints_stored !== undefined ? updates.blueprints_stored : (k.blueprints_stored || 0);
        if (smithyCap === 0 || curBP < smithyCap) {
          updates.blueprints_stored = curBP + 1;
          rewards.push({ text: `📐 A blueprint was recovered from the dungeon depths` });
        }
      }
    }
  }

  // ── Ultra-rare prizes (deep: 0.5%, dungeon success: 1%) ──────────────────────
  const ultraChance = type === 'dungeon' ? 0.01 : type === 'deep' ? 0.005 : 0;
  if (ultraChance > 0 && roll(ultraChance)) {
    const prize = ULTRA_RARE_PRIZES[Math.floor(Math.random() * ULTRA_RARE_PRIZES.length)];
    prize.effect(k, updates);
    rewards.push({ text: `✨✨✨ ULTRA RARE: ${prize.text}` });
    updates._ultra_rare = prize.id;
  }

  // ── Throne of Nazdreg (0.1% on deep/dungeon, unique forever) ────────────────
  const throneChance = (type === 'deep' || type === 'dungeon') ? 0.001 : 0;
  if (throneChance > 0 && roll(throneChance)) {
    updates._check_throne = true; // resolveExpeditions will check server_state and apply if unclaimed
  }

  return { rewards, updates, events };
}

async function resolveExpeditions(db, k, engine) {
  const exps = await db.all('SELECT * FROM expeditions WHERE kingdom_id = ? AND turns_left > 0', [k.id]);
  console.log(`[expedition] kingdom=${k.id} active: ${exps.map(e => `${e.type}(${e.turns_left}t)`).join(', ') || 'none'}`);
  const expeditionEvents = [];
  for (const exp of exps) {
    // Fetch fresh k for racial bonus check
    const freshKCheck = await db.get('SELECT race, troop_levels FROM kingdoms WHERE id = ?', [k.id]) || k;
    const direWolfBonus = racialUnitBonus(freshKCheck, 'rangers');
    const tickDown = direWolfBonus.earlyReturn ? 2 : 1;
    const newTurns = exp.turns_left - tickDown;
    console.log(`[expedition] kingdom=${k.id} id=${exp.id} type=${exp.type} turns_left=${exp.turns_left} → ${newTurns}`);

    if (newTurns > 0) {
      await db.run('UPDATE expeditions SET turns_left = ? WHERE id = ?', [newTurns, exp.id]);
      continue;
    }
    // newTurns <= 0 means this expedition completes now
    console.log(`[expedition] COMPLETING kingdom=${k.id} id=${exp.id} type=${exp.type}`);

    // Mark expedition complete FIRST so it can never get stuck at turns_left=1
    await db.run('UPDATE expeditions SET turns_left = 0 WHERE id = ?', [exp.id]);

    try {
      // Fetch fresh kingdom state to avoid stale merged values
      const freshK = await db.get('SELECT * FROM kingdoms WHERE id = ?', [k.id]) || k;
      const { rewards, updates, events } = expeditionRewards(exp.type, exp.rangers, exp.fighters, freshK, db);

      // ── Throne of Nazdreg check ──────────────────────────────────────────────
      if (updates._check_throne) {
        delete updates._check_throne;
        const throneState = await db.get("SELECT value FROM server_state WHERE key = 'throne_found'");
        if (!throneState || throneState.value !== '1') {
          THRONE_OF_NAZDREG.effect(freshK, updates);
          await db.run("INSERT OR REPLACE INTO server_state (key, value) VALUES ('throne_found', '1')");
          rewards.unshift({ text: THRONE_OF_NAZDREG.text });
          events.push({ type: 'system', message: `👑 ${freshK.name} has found the Throne of Nazdreg Grishnak. May his memory endure forever.` });
          updates._server_announce = `👑 The Throne of Nazdreg Grishnak has been found by ${freshK.name}. His name is remembered.`;
        }
      }

      const serverAnnounce = updates._server_announce || null;
      delete updates._server_announce;
      delete updates._ultra_rare;

      const label = { scout: '🔭 Scout', deep: '🌲 Deep', dungeon: '⚔️ Dungeon' }[exp.type];

      // Apply kingdom updates
      const rangersReturned  = updates._rangers_returned  !== undefined ? updates._rangers_returned  : 0;
      const fightersReturned = updates._fighters_returned !== undefined ? updates._fighters_returned : 0;
      delete updates._rangers_returned;
      delete updates._fighters_returned;

      const VALID_KINGDOM_COLS = new Set([
        'gold','mana','land','population','morale','food',
        'fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers',
        'war_machines','weapons_stockpile','armor_stockpile',
        'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
        'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
        'bld_farms','bld_barracks','bld_markets','bld_cathedrals','blueprints_stored','maps',
        'troop_levels','xp','level',
      ]);

      // Award XP
      const expXpAmount = { scout: 8, deep: 20, dungeon: 40 }[exp.type] || 8;
      const rXp = awardTroopXp(freshK, 'rangers', expXpAmount * exp.rangers);
      updates.troop_levels = rXp.troop_levels;
      if (exp.type === 'dungeon' && exp.fighters > 0) {
        const fXp = awardTroopXp({ ...freshK, troop_levels: updates.troop_levels }, 'fighters', 40 * exp.fighters);
        updates.troop_levels = fXp.troop_levels;
      }

      const safeUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k2, v]) => VALID_KINGDOM_COLS.has(k2) && v !== undefined && v !== null && !isNaN(Number(v)))
      );
      if (Object.keys(safeUpdates).length > 0) {
        const cols = Object.keys(safeUpdates).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safeUpdates), k.id]);
      }
      if (rangersReturned  > 0) await db.run('UPDATE kingdoms SET rangers  = rangers  + ? WHERE id = ?', [rangersReturned,  k.id]);
      if (fightersReturned > 0) await db.run('UPDATE kingdoms SET fighters = fighters + ? WHERE id = ?', [fightersReturned, k.id]);

      // ONE news line only — rewards go to expedition log, not news feed
      const completionMsg = `${label} expedition returned — check the Explore tab for rewards.`;
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
        [k.id, 'system', completionMsg, k.turn || 0]);
      expeditionEvents.push({ type: 'system', message: completionMsg });

      // Throne broadcast only
      if (serverAnnounce) {
        const allKingdoms = await db.all('SELECT id FROM kingdoms');
        for (const ak of allKingdoms) {
          await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
            [ak.id, 'system', serverAnnounce, k.turn || 0]);
        }
        if (engine.io) engine.io.emit('chat:system', { message: serverAnnounce, ts: Date.now() });
      }

      // Save rewards to expedition row for log display
      const rewardJson = JSON.stringify(rewards.map(r => r.text));
      await db.run('UPDATE expeditions SET rewards = ? WHERE id = ?', [rewardJson, exp.id]);
      console.log(`[expedition] completed kingdom=${k.id} type=${exp.type} rewards=${rewards.length}`);

    } catch (err) {
      // Rewards failed — expedition is already marked complete (turns_left=0), troops return, no reward
      console.error(`[expedition] reward error kingdom=${k.id} id=${exp.id} type=${exp.type}:`, err.message, err.stack);
      // Still return troops so they're not lost
      await db.run('UPDATE kingdoms SET rangers = rangers + ? WHERE id = ?', [exp.rangers, k.id]);
      if (exp.fighters > 0) await db.run('UPDATE kingdoms SET fighters = fighters + ? WHERE id = ?', [exp.fighters, k.id]);
      const errMsg = `${exp.type} expedition returned — an error occurred calculating rewards (troops returned safely).`;
      await db.run('UPDATE expeditions SET rewards = ? WHERE id = ?', [JSON.stringify([errMsg]), exp.id]);
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
        [k.id, 'system', errMsg, k.turn || 0]);
      expeditionEvents.push({ type: 'system', message: errMsg });
    }
  }
  return expeditionEvents;
}

// ── Mage Tower — research allocation from mages ──────────────────────────────
function processMageTower(k, events) {
  const updates = {};
  const towers = k.bld_cathedrals || 0;
  if (towers === 0) return updates;

  // Mage towers are for mana production only — research is done by researchers
  // manaPerTurn() already handles the mage allocation mana bonus
  // Nothing additional to do here — mana is added in processTurn step 2
  return updates;
}

// ── Shrine — clerics boost morale and prepare healing ────────────────────────
function processShrine(k, events) {
  const updates = {};
  const shrines = k.bld_shrines || 0;
  if (shrines === 0) return updates;

  let shrineAlloc = {};
  try { shrineAlloc = JSON.parse(k.shrine_allocation || '{}'); } catch { shrineAlloc = {}; }

  const clericsInShrine = Math.min(Number(shrineAlloc.clerics) || 0, k.clerics || 0);
  const capacity = shrines * 15; // 15 clerics per shrine
  const effectiveClerics = Math.min(clericsInShrine, capacity);
  if (effectiveClerics <= 0) return updates;

  // Each 10 clerics in shrine = +1 morale per turn
  const moraleGain = Math.max(1, Math.floor(effectiveClerics / 10));
  const currentMorale = updates.morale !== undefined ? updates.morale : (k.morale || 0);
  if (currentMorale < 200) {
    updates.morale = Math.min(200, currentMorale + moraleGain);
    if (moraleGain > 0) {
      events.push({ type: 'system', message: `⛩️ Shrine: ${effectiveClerics.toLocaleString()} clerics praying — morale +${moraleGain}.` });
    }
  }

  return updates;
}

// ── Library processing — runs each turn ──────────────────────────────────────
function processLibrary(k, events) {
  const updates = {};
  const libs = k.bld_libraries || 0;
  if (libs === 0) return updates;

  let alloc = {};
  try { alloc = JSON.parse(k.library_allocation || '{}'); } catch { alloc = {}; }
  let progress = {};
  try { progress = JSON.parse(k.library_progress || '{}'); } catch { progress = {}; }
  let scrolls = {};
  try { scrolls = JSON.parse(k.scrolls || '{}'); } catch { scrolls = {}; }

  const magesInLib   = Math.min(k.mages   || 0, Number(alloc.mages)   || 0);
  const scribesInLib = Math.min(k.scribes || 0, Number(alloc.scribes) || 0);

  const capacity       = libs * 20;
  const effectiveMages   = Math.min(magesInLib,   capacity);
  const effectiveScribes = Math.min(scribesInLib, capacity);

  // Level multipliers
  const mageLvlMult   = unitLevelMult(k, 'mages');
  const scribeLvlMult = unitLevelMult(k, 'scribes');

  // Mages produce mana (scaled by level)
  if (effectiveMages > 0) {
    const manaGain = Math.floor((effectiveMages / 10) * mageLvlMult);
    if (manaGain > 0) {
      updates.mana = (k.mana || 0) + manaGain;
      // Passive mage XP for mana production
      const mXp = awardTroopXp({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'mages', 2);
      updates.troop_levels = mXp.troop_levels;
    }
  }

  // Scribes craft maps/blueprints (scaled by level)
  const scribeQueue = alloc.scribe_craft || null;
  if (effectiveScribes > 0 && scribeQueue && SCRIBE_ITEMS[scribeQueue]) {
    const req = SCRIBE_ITEMS[scribeQueue];
    const effective = Math.min(effectiveScribes, req.scribes);
    const progressKey = 'scribe_' + scribeQueue;
    const workDone = (effective >= req.scribes ? 1 : effective / req.scribes) * scribeLvlMult;
    const newProg = (progress[progressKey] || 0) + workDone;
    if (newProg >= req.turns) {
      progress[progressKey] = 0;
      if (scribeQueue === 'map') {
        updates.maps = (k.maps || 0) + 1;
        events.push({ type: 'system', message: `📜 Your scribes completed a map — you can now interact with other kingdoms.` });
      } else {
        updates.blueprints_stored = (k.blueprints_stored || 0) + 1;
        events.push({ type: 'system', message: `📐 Your scribes completed a blueprint — construction speed bonus applied.` });
      }
      // Scribe XP for completing an item
      const sXp = awardTroopXp({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'scribes', 15);
      updates.troop_levels = sXp.troop_levels;
    } else {
      progress[progressKey] = newProg;
    }
  }

  // Mages craft scrolls (scaled by level)
  const scrollCraft = alloc.scroll_craft || null;
  if (effectiveMages > 0 && scrollCraft && SCROLL_REQUIREMENTS[scrollCraft]) {
    const req = SCROLL_REQUIREMENTS[scrollCraft];
    const effectiveMagesForScroll = Math.min(effectiveMages, req.mages);
    const workDone = (effectiveMagesForScroll >= req.mages ? 1 : effectiveMagesForScroll / req.mages) * mageLvlMult;
    const progKey = 'scroll_' + scrollCraft;
    const newProg = (progress[progKey] || 0) + workDone;
    if (newProg >= req.turns) {
      progress[progKey] = 0;
      // High Elf racial bonus: level 5+ mages produce 2 scrolls
      const helfBonus = racialUnitBonus(k, 'mages');
      const scrollsProduced = helfBonus.doubleScrolls ? 2 : 1;
      scrolls[scrollCraft] = (scrolls[scrollCraft] || 0) + scrollsProduced;
      updates.scrolls = JSON.stringify(scrolls);
      const bonusMsg = helfBonus.doubleScrolls ? ' (High Elf mastery — 2 scrolls produced!)' : '';
      events.push({ type: 'system', message: `✨ A ${scrollCraft.replace(/_/g,' ')} scroll has been completed.${bonusMsg}` });
      // Mage XP for scroll completion
      const mXp2 = awardTroopXp({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'mages', 20);
      updates.troop_levels = mXp2.troop_levels;
    } else {
      progress[progKey] = newProg;
    }
  }

  updates.library_progress = JSON.stringify(progress);
  return updates;
}

// ── Active effects processing — runs each turn ────────────────────────────────
function processActiveEffects(k, events) {
  let effects = {};
  try { effects = JSON.parse(k.active_effects || '{}'); } catch { effects = {}; }
  if (Object.keys(effects).length === 0) return {};

  const updates = {};
  const expired = [];

  for (const [effect, data] of Object.entries(effects)) {
    const remaining = (data.turns_left || 1) - 1;
    if (remaining <= 0) {
      expired.push(effect);
      events.push({ type: 'system', message: `The ${effect.replace('_',' ')} effect on your kingdom has expired.` });
    } else {
      // Apply ongoing effect
      if (effect === 'blight') {
        updates.food = Math.max(0, (updates.food !== undefined ? updates.food : k.food || 0) - (data.damage || 500));
      } else if (effect === 'plague') {
        const lost = Math.floor((k.population || 0) * 0.02);
        updates.population = Math.max(0, (k.population || 0) - lost);
        events.push({ type: 'attack', message: `☠️ Plague ravages your kingdom — ${lost.toLocaleString()} citizens have perished.` });
      } else if (effect === 'silence') {
        // Research suppressed — handled in processTurn by checking for silence
      }
      effects[effect] = { ...data, turns_left: remaining };
    }
  }

  expired.forEach(e => delete effects[e]);
  updates.active_effects = JSON.stringify(effects);
  return updates;
}

module.exports = {
  goldPerTurn, manaPerTurn, foodBalance, farmProduction, foodConsumption,
  marketIncomeFull, tavernEntertainmentBonus, commodityPrice,
  processFoodEconomy, processMercenaries, hireMercenaries, purchaseUpgrade,
  FARM_UPGRADES, MARKET_UPGRADES, TAVERN_UPGRADES, MERC_TIERS, COMMODITY_VALUES,
  FARM_YIELD_MULT, FOOD_CONSUMPTION_MULT, MARKET_INCOME_MULT, TRADE_RATE_MULT,
  processTurn, hireUnits, studyDiscipline,
  queueBuildings, processBuildQueue, processLibrary, processMageTower, processShrine, processActiveEffects, forgeTools,
  resolveMilitaryAttack, castSpell,
  covertSpy, covertLoot, covertAssassinate,
  resolveAllianceDefence, resolveExpeditions,
  awardXp, xpForLevel, xpToNextLevel, levelFromXp,
  awardTroopXp, awardUnitXp, diluteTroopXp, unitLevelMult, racialUnitBonus,
  troopXpForLevel, effectiveTroopLevel,
  WM_CREW_REQUIRED, wmCrewRequired, moraleMult,
  TROOP_RACE_BONUS, RACE_BONUSES, REGION_DATA, assignRegion,
  UNIT_COST, BUILDING_COST, BUILDING_GOLD_COST, BUILDING_LAND_COST, BUILDING_COL,
  SPELL_DEFS, SCROLL_REQUIREMENTS, SCRIBE_ITEMS, HOUSING_CAP_BY_RACE,
  TOOL_COL, TOOL_GOLD_COST, BLUEPRINT_REQUIRED, SCAFFOLDING_REQUIRED, SCAFFOLDING_BONUS_BUILDINGS,
  processSmithyProduction,
};
