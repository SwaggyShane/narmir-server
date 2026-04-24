// src/game/engine.js
// Pure game logic — no I/O, no socket calls.
// All functions take a kingdom row (or rows) and return mutations + events.

const RACE_BONUSES = {
  // High Elf: scholarly civilization — modest economy, excellent research and magic
  high_elf:  { research: 1.15, magic: 1.20, economy: 1.05, military: 0.90 },

  // Dwarf: master traders and builders — strong economy and construction
  dwarf:     { construction: 1.20, war_machines: 1.25, economy: 1.202, magic: 0.75, research: 0.90 },

  // Dire Wolf: savage raiders — economy is plunder-based, terrible long-term
  dire_wolf: { military: 1.30, covert: 1.10, research: 0.70, magic: 0.60, economy: 0.70 },

  // Dark Elf: shadow traders — modest economy, lethal covert
  dark_elf:  { covert: 1.25, stealth: 1.30, magic: 1.10, military: 0.85, economy: 0.90 },

  // Human: balanced — slight economic edge from adaptability
  human:     { economy: 1.05 },

  // Orc: raiders with a nose for loot — decent economy from conquest
  orc:       { military: 1.20, economy: 1.10, research: 0.80, magic: 0.65, construction: 0.90 },
};

const UNIT_COST = 250; // GC per unit, all types
const MAX_RESEARCHERS = 1_000_000;
const MAX_RESEARCH = 1000; // percent cap for most disciplines

// ── Helpers ──────────────────────────────────────────────────────────────────

function raceBonus(kingdom, stat) {
  const bonuses = RACE_BONUSES[kingdom.race] || {};
  return bonuses[stat] || 1.0;
}

function goldPerTurn(k) {
  const baseRate = Math.floor(k.land * (k.tax / 100) * (k.res_economy / 100));
  const marketBonus = Math.floor(k.bld_markets / 30) * 200;
  const castleBonus = Math.floor(k.bld_castles / 500) * 500;
  const econBonus = raceBonus(k, 'economy');
  return Math.floor((baseRate + marketBonus + castleBonus) * econBonus * 2.25);
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
  const totalTroops = k.fighters + k.rangers + k.clerics + k.mages +
                      k.thieves + k.ninjas + k.researchers + k.engineers;
  const production = Math.floor(k.bld_farms / 10) * 100;
  // Aggressive races (dire wolf, orc) eat more
  const consumptionMult = raceBonus(k, 'military') > 1.1 ? 1.15 : 1.0;
  const consumption = Math.floor((totalTroops + Math.floor(k.population / 50)) * consumptionMult);
  return production - consumption;
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
    troopLevels[unit] = { ...current, xp: newXp };
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

  // ── 4. Food balance ───────────────────────────────────────────────────────────
  const food = foodBalance(k);
  updates.food = food;
  if (food >= 0) {
    events.push({ type: 'system', message: `🌾 Food surplus: +${food.toLocaleString()} units. Troops are well fed.` });
  } else {
    events.push({ type: 'system', message: `🌾 Food shortage: ${food.toLocaleString()} units deficit. Troops are starving!` });
    const totalTroops = (k.fighters||0) + (k.rangers||0) + (k.clerics||0) + (k.mages||0) +
                        (k.thieves||0) + (k.ninjas||0) + (k.researchers||0) + (k.engineers||0);
    const starvePct = Math.min(0.05, Math.abs(food) / Math.max(totalTroops, 1) * 0.005);
    if (starvePct > 0) {
      const lost = Math.floor(totalTroops * starvePct);
      updates.fighters    = Math.max(0, Math.floor((k.fighters||0)    * (1 - starvePct)));
      updates.rangers     = Math.max(0, Math.floor((k.rangers||0)     * (1 - starvePct)));
      updates.clerics     = Math.max(0, Math.floor((k.clerics||0)     * (1 - starvePct)));
      updates.mages       = Math.max(0, Math.floor((k.mages||0)       * (1 - starvePct)));
      updates.thieves     = Math.max(0, Math.floor((k.thieves||0)     * (1 - starvePct)));
      updates.ninjas      = Math.max(0, Math.floor((k.ninjas||0)      * (1 - starvePct)));
      updates.researchers = Math.max(0, Math.floor((k.researchers||0) * (1 - starvePct)));
      updates.engineers   = Math.max(0, Math.floor((k.engineers||0)   * (1 - starvePct)));
      events.push({ type: 'system', message: `💀 ${lost.toLocaleString()} units deserted due to starvation (${Math.floor(starvePct * 100)}% losses across all troops).` });
    }
  }

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

  // ── 10. Rangers auto-explore — level scales land discovery ───────────────────
  const rangers = k.rangers || 0;
  if (rangers > 0) {
    const scoutMult    = raceBonus(k, 'military');
    const rangerLvMult = unitLevelMult({ ...k, troop_levels: updates.troop_levels || k.troop_levels }, 'rangers');
    const autoLand = Math.floor(rangers * 0.001 * scoutMult * rangerLvMult);
    if (autoLand > 0) {
      updates.land = (updates.land || k.land || 0) + autoLand;
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
  const hammerBonus     = 1 + (k.tools_hammers     || 0) * 0.05;
  const scaffoldBonus   = 1 + (k.tools_scaffolding  || 0) * 0.15;
  const blueprintBonus  = 1 + (k.tools_blueprints   || 0) * 0.25;
  const smithyBonus     = 1 + (Math.floor((k.bld_smithies||0) / 15) * 0.02);
  const raceConstr   = raceBonus(k, 'construction');
  const engLevelMult = unitLevelMult(k, 'engineers');
  const toolMult     = hammerBonus * scaffoldBonus * blueprintBonus * smithyBonus * raceConstr * engLevelMult;

  // Get engineer allocation — keys are building types like 'farm', 'barracks', etc.
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

    const workDone = Math.floor(engAssigned * toolMult);
    if (workDone <= 0) continue;

    const prevProgress = progress[building] || 0;
    const totalProgress = prevProgress + workDone;
    const completed = Math.floor(totalProgress / cost);

    if (completed > 0) {
      const col = BUILDING_COL[building];
      if (col) {
        const current = updates[col] !== undefined ? updates[col] : (k[col] || 0);
        const cap = getCap(col, k.level || 1);
        const canAdd = Math.max(0, Math.min(completed, cap - current));
        updates[col] = current + canAdd;
        if (canAdd < completed && canAdd === 0) {
          events.push({ type: 'system', message: `⚠️ ${building} cap reached at level ${k.level||1} (max ${cap.toLocaleString()}) — level up to build more.` });
        }
        if (canAdd > 0) {
          completedItems.push(`${canAdd.toLocaleString()} ${building.replace(/_/g, ' ')}`);
          // Deduct land
          const landCost = (BUILDING_LAND_COST[building] || 0) * canAdd;
          if (landCost > 0) {
            updates.land = Math.max(0, (updates.land !== undefined ? updates.land : (k.land || 0)) - landCost);
          }
        }
      }
      progress[building] = totalProgress - (completed * cost);
      // Reduce queue count if this was a queued item
      if (queue[building] > 0) {
        queue[building] = Math.max(0, queue[building] - completed);
        if (queue[building] <= 0) delete queue[building];
      }
    } else {
      progress[building] = totalProgress;
    }
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
    const dwarfBonus = racialUnitBonus(k, 'engineers');
    if (dwarfBonus.warMachineSoloCrew && (k.war_machines || 0) > 0) {
      if (!updates._dwarf_wm_noted) {
        updates._dwarf_wm_noted = true;
        events.push({ type: 'system', message: `🔥 Dwarven master engineers (Lv 5+) can now crew war machines solo — 1 engineer per machine.` });
      }
    }
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

function resolveMilitaryAttack(attacker, defender, fightersSent, magesSent) {
  if (fightersSent > attacker.fighters) return { error: 'Not enough fighters' };
  if (magesSent > attacker.mages)       return { error: 'Not enough mages' };

  // Attack power — race military and magic bonuses + troop level bonus
  // Weapons stockpile: each weapon equips one fighter, up to fighters sent
  const weaponsEquipped = Math.min(fightersSent, attacker.weapons_stockpile || 0);
  const weaponBonus     = 1 + (weaponsEquipped / Math.max(fightersSent, 1)) * 0.25;
  const atkTroopLvl  = Math.max(1, effectiveTroopLevel(attacker, 'fighters')) / 50; // level 50 = 1.0x, 100 = 2.0x
  const atkMageLvl   = Math.max(1, effectiveTroopLevel(attacker, 'mages')) / 50;
  const atkWeapon  = (attacker.res_weapons / 100) * weaponBonus;
  const atkTactics = attacker.res_military / 100;
  const atkRace    = raceBonus(attacker, 'military');
  const atkMagic   = raceBonus(attacker, 'magic');
  const atkFighterPower = fightersSent * atkWeapon * atkTactics * atkRace * atkTroopLvl;
  const atkMagePower    = magesSent * 2.5 * (attacker.res_attack_magic / 100) * atkMagic * atkMageLvl;
  // War machines: each adds 500 attack power, scaled by war machines research and race
  const wmCount    = Math.min(attacker.war_machines || 0, attacker.engineers || 0);
  const wmBonus    = wmCount * 500 * (attacker.res_war_machines / 100) * raceBonus(attacker, 'war_machines');
  const atkPower = atkFighterPower + atkMagePower + wmBonus;

  // Defence power — armor stockpile + troop level bonus
  const armorEquipped = Math.min(defender.fighters, defender.armor_stockpile || 0);
  const armorBonus    = 1 + (armorEquipped / Math.max(defender.fighters, 1)) * 0.25;
  const defTroopLvl  = Math.max(1, effectiveTroopLevel(defender, 'fighters')) / 50;
  const defMageLvl   = Math.max(1, effectiveTroopLevel(defender, 'mages')) / 50;
  const defArmor   = (defender.res_armor / 100) * armorBonus;
  const defTactics = defender.res_military / 100;
  const defRace    = raceBonus(defender, 'military');
  const defMagic   = raceBonus(defender, 'magic');
  const defFighterPower = defender.fighters * defArmor * defTactics * defRace * defTroopLvl;
  const defMagePower    = (defender.mages||0) * 1.5 * (defender.res_defense_magic / 100) * defMagic * defMageLvl;
  const defStructures   = (Math.floor((defender.bld_guard_towers||0) / 2) * 200)
                        + (Math.floor((defender.bld_castles||0) / 500) * 5000);
  const defPower = defFighterPower + defMagePower + defStructures;

  // Clerics reduce attacker casualties — high elves have stronger clerics
  const clericEfficiency = raceBonus(attacker, 'research'); // elves' scholarly nature helps clerics
  const clericSave = 1 - Math.min(0.35, (attacker.clerics||0) / (fightersSent + 1) * 0.05 * clericEfficiency);

  // Random variance ±20%
  const variance = 0.8 + Math.random() * 0.4;
  const win = (atkPower * variance) > defPower;

  // Casualties — dark elves take fewer losses on failure (escape bonus from stealth)
  const atkStealthBonus = raceBonus(attacker, 'stealth') > 1 ? 0.85 : 1.0;
  const atkLossPct  = win
    ? (0.04 + Math.random() * 0.08) * atkStealthBonus
    : (0.20 + Math.random() * 0.25) * atkStealthBonus;
  const defLossPct  = win ? (0.15 + Math.random() * 0.20) : (0.05 + Math.random() * 0.08);

  const atkFightersLost = Math.floor(fightersSent * atkLossPct * clericSave);
  const atkMagesLost    = Math.floor(magesSent    * atkLossPct * 0.5);
  const defFightersLost = Math.floor(defender.fighters * defLossPct);
  const landTransferred = win ? Math.floor(defender.land * 0.10) : 0;

  const attackerUpdates = {
    fighters: attacker.fighters - atkFightersLost,
    mages:    attacker.mages    - atkMagesLost,
    land:     attacker.land + landTransferred,
    // Weapons lost proportional to fighters lost
    weapons_stockpile: Math.max(0, (attacker.weapons_stockpile||0) - Math.floor(weaponsEquipped * atkLossPct)),
    updated_at: Math.floor(Date.now() / 1000),
  };
  const defenderUpdates = {
    fighters: defender.fighters - defFightersLost,
    land:     defender.land     - landTransferred,
    updated_at: Math.floor(Date.now() / 1000),
  };

  // Award troop XP from combat
  const atkTroopXp = awardTroopXp(attacker, 'fighters', win ? 30 : 10);
  const defTroopXp = awardTroopXp(defender, 'fighters', win ? 10 : 20); // defenders learn more from repelling
  attackerUpdates.troop_levels = atkTroopXp.troop_levels;
  defenderUpdates.troop_levels = defTroopXp.troop_levels;
  if (atkTroopXp.levelUps.length) attackerUpdates.troop_levels = atkTroopXp.troop_levels;
  if (defTroopXp.levelUps.length) defenderUpdates.troop_levels = defTroopXp.troop_levels;

  const atkXp = awardXp(attacker, win ? 'combat_win' : 'combat_loss', 1);
  const defXp = awardXp(defender, win ? 'combat_loss' : 'combat_win', 1);

  attackerUpdates.xp    = atkXp.xp;
  attackerUpdates.level = atkXp.level;
  defenderUpdates.xp    = defXp.xp;
  defenderUpdates.level = defXp.level;

  const report = {
    win, fightersSent, magesSent,
    atkFightersLost, atkMagesLost, defFightersLost, landTransferred,
    atkPower: Math.round(atkPower), defPower: Math.round(defPower),
    atkXpEarned: atkXp.earned, atkLevelUp: atkXp.levelled,
  };

  const atkEvent = win
    ? `You attacked ${defender.name} and won! Captured ${landTransferred} acres. Lost ${atkFightersLost} fighters, ${atkMagesLost} mages.`
    : `Attack on ${defender.name} was repelled. Lost ${atkFightersLost} fighters, ${atkMagesLost} mages.`;

  const defEvent = win
    ? `${attacker.name} attacked your kingdom and broke through! Lost ${landTransferred} acres and ${defFightersLost} fighters.`
    : `${attacker.name} attacked but was repelled. You lost ${defFightersLost} fighters defending.`;

  return { win, report, attackerUpdates, defenderUpdates, atkEvent, defEvent };
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
  const foragePerTurn = rangers * 12 * tacBonus * exploreBonus * rangerLvBonus;
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

  } else if (type === 'deep') {
    rewards.push({ text: `+${goldBase.toLocaleString()} gold from deep wilderness caches` });
    updates.gold = (k.gold || 0) + goldBase;
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

  } else if (type === 'dungeon') {
    const power = (rangers + fighters * 2) * tacBonus * exploreBonus;
    const successChance = Math.min(0.85, 0.25 + (power / 80000));
    const success = roll(successChance);

    if (!success) {
      const fLost = Math.min(fighters, rand(Math.floor(fighters * 0.15), Math.floor(fighters * 0.40)));
      const fReturned = fighters - fLost;
      if (fReturned > 0) updates._fighters_returned = fReturned;
      rewards.push({ text: `The dungeon proved too dangerous — ${fLost} fighters lost in retreat` });
      events.push({ type: 'attack', message: `💀 Dungeon raid FAILED — your forces were overwhelmed. ${fLost.toLocaleString()} fighters lost.` });
    } else {
      updates._fighters_returned = fighters;

      const dungeonGold = Math.floor(fighters * 12 * tacBonus * exploreBonus * expTurns * randomBonus);
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
  const expeditionEvents = [];
  for (const exp of exps) {
    // Fetch fresh k for racial bonus check
    const freshKCheck = await db.get('SELECT race, troop_levels FROM kingdoms WHERE id = ?', [k.id]) || k;
    const direWolfBonus = racialUnitBonus(freshKCheck, 'rangers');
    const tickDown = direWolfBonus.earlyReturn ? 2 : 1; // Dire Wolf rangers return 1 turn early
    const newTurns = exp.turns_left - tickDown;
    console.log(`[expedition] id=${exp.id} turns_left=${exp.turns_left} newTurns=${newTurns} completing=${newTurns <= 0}`);
    if (newTurns > 0) {
      await db.run('UPDATE expeditions SET turns_left = ? WHERE id = ?', [newTurns, exp.id]);
      continue;
    }

    // Expedition complete — always delete it first so it never gets stuck
    console.log(`[expedition] COMPLETING id=${exp.id} type=${exp.type}`);

    try {
      // Fetch fresh kingdom state to avoid stale merged values
      const freshK = await db.get('SELECT * FROM kingdoms WHERE id = ?', [k.id]) || k;
      const { rewards, updates, events } = expeditionRewards(exp.type, exp.rangers, exp.fighters, freshK, db);

      // ── Throne of Nazdreg check ──────────────────────────────────────────────
      if (updates._check_throne) {
        delete updates._check_throne;
        const throneState = await db.get("SELECT value FROM server_state WHERE key = 'throne_found'");
        if (!throneState || throneState.value !== '1') {
          // Throne not yet found — award it
          THRONE_OF_NAZDREG.effect(freshK, updates);
          await db.run("INSERT OR REPLACE INTO server_state (key, value) VALUES ('throne_found', '1')");
          rewards.unshift({ text: THRONE_OF_NAZDREG.text });
          // Broadcast server-wide announcement
          events.push({ type: 'system', message: `👑 ${freshK.name} has found the Throne of Nazdreg Grishnak. May his memory endure forever.` });
          updates._server_announce = `👑 The Throne of Nazdreg Grishnak has been found by ${freshK.name}. His name is remembered.`;
        }
      }
      // Strip internal-only flags before applying
      const serverAnnounce = updates._server_announce || null;
      const ultraRareId    = updates._ultra_rare || null;
      delete updates._server_announce;
      delete updates._ultra_rare;

      const label = { scout: '🔭 Scout', deep: '🌲 Deep', dungeon: '⚔️ Dungeon' }[exp.type];

      // Apply kingdom updates — use SQL INCREMENT for rangers/fighters to avoid race conditions
      const rangersReturned = updates._rangers_returned !== undefined ? updates._rangers_returned : 0;
      const fightersReturned = updates._fighters_returned !== undefined ? updates._fighters_returned : 0;
      delete updates._rangers_returned;
      delete updates._fighters_returned;

      const VALID_KINGDOM_COLS = new Set([
        'gold','mana','land','population','morale','food',
        'fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers',
        'war_machines','weapons_stockpile','armor_stockpile',
        'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
        'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
        'bld_farms','bld_barracks','bld_markets','bld_cathedrals',
        'troop_levels','xp','level',
      ]);

      // Award ranger XP for completing expedition (difficulty-scaled)
      const expXpAmount = { scout: 8, deep: 20, dungeon: 40 }[exp.type] || 8;
      const rXp = awardTroopXp(freshK, 'rangers', expXpAmount * exp.rangers);
      updates.troop_levels = rXp.troop_levels;
      // Award fighter XP for dungeon
      if (exp.type === 'dungeon' && exp.fighters > 0) {
        const fXp = awardTroopXp({ ...freshK, troop_levels: updates.troop_levels }, 'fighters', 40 * exp.fighters);
        updates.troop_levels = fXp.troop_levels;
      }
      const safeUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k2, v]) => VALID_KINGDOM_COLS.has(k2) && v !== undefined && v !== null && !isNaN(v))
      );
      if (Object.keys(safeUpdates).length > 0) {
        const cols = Object.keys(safeUpdates).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safeUpdates), k.id]);
      }
      // Return rangers and fighters using INCREMENT to avoid overwriting concurrent turn updates
      if (rangersReturned > 0) {
        await db.run('UPDATE kingdoms SET rangers = rangers + ? WHERE id = ?', [rangersReturned, k.id]);
      }
      if (fightersReturned > 0) {
        await db.run('UPDATE kingdoms SET fighters = fighters + ? WHERE id = ?', [fightersReturned, k.id]);
      }

      // Single news line — no reward detail in news
      const completionMsg = `${label} expedition returned — see expedition log for rewards.`;
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
        [k.id, 'system', completionMsg, k.turn || 0]);
      expeditionEvents.push({ type: 'system', message: completionMsg });
      for (const ev of events) {
        await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
          [k.id, ev.type || 'system', ev.message, k.turn || 0]);
        expeditionEvents.push(ev);
      }

      // Server-wide throne announcement — news to ALL kingdoms
      if (serverAnnounce) {
        const allKingdoms = await db.all('SELECT id FROM kingdoms');
        for (const ak of allKingdoms) {
          await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
            [ak.id, 'system', serverAnnounce, k.turn || 0]);
        }
        if (engine.io) engine.io.emit('chat:system', { message: serverAnnounce, ts: Date.now() });
      }

      // Store rewards JSON on the row so frontend can show them in the log, then mark completed (turns_left=0)
      const rewardJson = JSON.stringify(rewards.map(r => r.text));
      await db.run('UPDATE expeditions SET turns_left = 0, rewards = ? WHERE id = ?', [rewardJson, exp.id]);

    } catch (err) {
      console.error(`[expedition] reward error for id=${exp.id} type=${exp.type}:`, err.message);
      await db.run('DELETE FROM expeditions WHERE id = ?', [exp.id]);
      const errMsg = `An expedition returned but the scouts lost their notes.`;
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
  goldPerTurn, manaPerTurn, foodBalance, popGrowth,
  processTurn, hireUnits, studyDiscipline,
  queueBuildings, processBuildQueue, processLibrary, processMageTower, processShrine, processActiveEffects, forgeTools,
  resolveMilitaryAttack, castSpell,
  covertSpy, covertLoot, covertAssassinate,
  resolveAllianceDefence, resolveExpeditions,
  awardXp, xpForLevel, xpToNextLevel, levelFromXp,
  awardTroopXp, awardUnitXp, diluteTroopXp, unitLevelMult, racialUnitBonus,
  troopXpForLevel, effectiveTroopLevel,
  TROOP_RACE_BONUS, RACE_BONUSES, UNIT_COST, BUILDING_COST, BUILDING_GOLD_COST, BUILDING_LAND_COST, BUILDING_COL, SPELL_DEFS, SCROLL_REQUIREMENTS, SCRIBE_ITEMS, HOUSING_CAP_BY_RACE,
};
