// src/game/engine.js
// Pure game logic — no I/O, no socket calls.
// All functions take a kingdom row (or rows) and return mutations + events.

const RACE_BONUSES = {
  // High Elf: masters of research and magic, fragile in direct combat
  high_elf:  { research: 1.15, magic: 1.20, military: 0.90 },

  // Dwarf: unmatched builders and engineers, slow to learn magic
  dwarf:     { construction: 1.20, war_machines: 1.25, economy: 1.10, magic: 0.75, research: 0.90 },

  // Dire Wolf: savage fighters, terrible scholars
  dire_wolf: { military: 1.30, covert: 1.10, research: 0.70, magic: 0.60, economy: 0.85 },

  // Dark Elf: lethal covert operatives, poor open combat
  dark_elf:  { covert: 1.25, stealth: 1.30, magic: 1.10, military: 0.85, economy: 0.90 },

  // Human: no bonuses or penalties — jack of all trades
  human:     {},

  // Orc: powerful fighters and good economy from raiding, poor research
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
  return Math.floor((baseRate + marketBonus + castleBonus) * econBonus);
}

function manaPerTurn(k) {
  const base = 10 + (k.bld_cathedrals / 25) * 50;
  // Magic races regenerate mana faster
  return Math.floor(base * raceBonus(k, 'magic'));
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

function popGrowth(k) {
  if (k.morale < 30) return -Math.floor(k.population * 0.02);
  const base = Math.floor(k.population * 0.003);
  const entertainment = Math.floor(k.res_entertainment / 100) * 10;
  // High elves grow slowly (long-lived), humans grow fastest
  const raceGrowthMult = {
    high_elf: 0.80, dwarf: 0.90, dire_wolf: 1.00,
    dark_elf: 0.85, human: 1.15, orc: 1.10,
  }[k.race] || 1.0;
  return Math.floor((base + entertainment) * raceGrowthMult);
}

function researchIncrement(k, discipline, researchersAssigned) {
  const schoolBonus = 1 + (Math.floor(k.bld_schools / 5) * 0.02);
  const raceMulti = discipline === 'spellbook' ? raceBonus(k, 'magic') : raceBonus(k, 'research');
  const effective = Math.floor(researchersAssigned * schoolBonus * raceMulti);
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

// ── Turn processor ────────────────────────────────────────────────────────────

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
  // Aggressive races cost more to maintain; dwarves are disciplined and cost less
  const upkeepMult = {
    high_elf: 1.00, dwarf: 0.85, dire_wolf: 1.20,
    dark_elf: 1.10, human: 1.00, orc: 1.15,
  }[k.race] || 1.0;
  const totalTroops = (k.fighters||0) + (k.rangers||0) + (k.clerics||0) + (k.mages||0) +
                      (k.thieves||0) + (k.ninjas||0);
  const barrackDiscount = Math.min(0.5, Math.floor((k.bld_barracks||0) / 2) * 0.01);
  const upkeep = Math.floor(totalTroops * upkeepMult * (1 - barrackDiscount));
  if (upkeep > 0) {
    updates.gold = (updates.gold || k.gold) - upkeep;
    if (updates.gold < 0) updates.gold = 0;
    events.push({ type: 'system', message: `⚔️ Troop upkeep: -${upkeep.toLocaleString()} gold (${totalTroops.toLocaleString()} troops${barrackDiscount > 0 ? ', barracks discount applied' : ''}).` });
  }

  // ── 6. Morale ─────────────────────────────────────────────────────────────────
  if (k.tax > 50) {
    const penalty = Math.floor((k.tax - 50) * 0.5);
    updates.morale = Math.max(0, (k.morale||100) - penalty);
    events.push({ type: 'system', message: `😡 Morale fell by ${penalty} to ${updates.morale} — citizens angry over ${k.tax}% taxation.` });
  } else {
    // Morale recovers based on entertainment research + taverns (formerly colosseums)
    const tavernBonus = Math.floor((k.bld_colosseums||0) / 25);
    const recovery = 1 + Math.floor((k.res_entertainment||0) / 200) + tavernBonus;
    const newMorale = Math.min(200, (k.morale||100) + recovery);
    if (newMorale !== k.morale) {
      updates.morale = newMorale;
      events.push({ type: 'system', message: `😊 Morale recovered by ${recovery} to ${newMorale}${tavernBonus > 0 ? ' (tavern bonus applied)' : ''}.` });
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
      // XP for research advances
      const resXp = awardXp({ ...k, xp: updates.xp || (k.xp||0), level: updates.level || (k.level||1) }, 'research', advances.length);
      updates.xp    = resXp.xp;
      updates.level = resXp.level;
      if (resXp.levelled) events.push(...resXp.events);
    } else if (researchers > 0) {
      events.push({ type: 'system', message: `📚 ${researchers.toLocaleString()} researchers studying — allocate more per discipline for advancement.` });
    }
  } else {
    events.push({ type: 'system', message: `📚 No researchers — hire researchers and allocate them to advance your kingdom's knowledge.` });
  }

  // ── 8. Build queue — engineers work on queued buildings each turn ─────────────
  const buildUpdates = processBuildQueue(k, events);
  Object.assign(updates, buildUpdates);

  // ── 9. Training fields — passive troop XP each turn ──────────────────────────
  if ((k.bld_training||0) > 0) {
    let troopLevels = {};
    try { troopLevels = JSON.parse(k.troop_levels || '{}'); } catch { troopLevels = {}; }
    let allocation = {};
    try { allocation = JSON.parse(k.training_allocation || '{}'); } catch { allocation = {}; }

    const TROOP_TYPES = ['fighters','rangers','clerics','mages','thieves','ninjas'];
    const trainingFields = k.bld_training || 0;
    const trainingCapacity = trainingFields * 50; // each field trains 50 units per turn
    let advancedTroops = [];

    TROOP_TYPES.forEach(function(unit) {
      const assigned = Number(allocation[unit]) || 0;
      if (assigned <= 0) return;

      const currentData = troopLevels[unit] || { level: 1, xp: 0, count: 0 };
      const capLevel = 100;
      if (currentData.level >= capLevel) return; // at visible cap

      // XP gain per turn based on training fields, weapons/armor equipped
      const weaponsEquipped = Math.min(assigned, k.weapons_stockpile || 0);
      const armorEquipped   = Math.min(assigned, k.armor_stockpile   || 0);
      const equipBonus = 1 + (weaponsEquipped / Math.max(assigned, 1)) * 0.5
                           + (armorEquipped   / Math.max(assigned, 1)) * 0.5;
      const raceTrainBonus = TROOP_RACE_BONUS[k.race]?.[unit] || 1.0;
      const xpGain = Math.floor(trainingCapacity * equipBonus * raceTrainBonus / TROOP_TYPES.length);

      const newXp = currentData.xp + xpGain;
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

  // ── 10. Rangers auto-explore — military race bonus improves scouting ─────────
  const rangers = k.rangers || 0;
  if (rangers > 0) {
    const scoutMult = raceBonus(k, 'military');
    const autoLand = Math.floor(rangers * 0.001 * scoutMult);
    if (autoLand > 0) {
      updates.land = (k.land||0) + autoLand;
      events.push({ type: 'system', message: `🗺️ Rangers explored and claimed ${autoLand} acre(s) of new land. Total: ${updates.land.toLocaleString()} acres.` });
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
  const validUnits = ['fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers'];
  if (!validUnits.includes(unit)) return { error: 'Invalid unit type' };
  if (amount <= 0) return { error: 'Amount must be positive' };

  // Level cap check (researchers and engineers have no cap)
  if (!['researchers','engineers'].includes(unit)) {
    const cap = getCap(unit, k.level || 1);
    const current = k[unit] || 0;
    if (current >= cap) return { error: `Level ${k.level||1} cap reached for ${unit} (max ${cap.toLocaleString()}) — gain levels to increase` };
    if (current + amount > cap) return { error: `Level ${k.level||1} cap: can only hire ${(cap - current).toLocaleString()} more ${unit} (max ${cap.toLocaleString()})` };
  }

  const cost = amount * UNIT_COST;
  if (k.gold < cost) return { error: `Not enough gold — need ${cost.toLocaleString()} gold` };
  if (amount > k.population) return { error: 'Not enough population available' };

  return {
    updates: {
      gold: k.gold - cost,
      population: k.population - amount,
      [unit]: (k[unit]||0) + amount,
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
  let level = 1;
  while (level < 1000 && totalXp >= xpForLevel(level + 1)) level++;
  return level;
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
  farms: 10, barracks: 20, outposts: 20, guard_towers: 20,
  schools: 50, armories: 50, vaults: 50, smithies: 150,
  markets: 300, cathedrals: 250, training: 800, colosseums: 250, castles: 5000,
  war_machine: 200, weapons: 10, armor: 10,
};

const BUILDING_COL = {
  farms: 'bld_farms', barracks: 'bld_barracks', outposts: 'bld_outposts',
  guard_towers: 'bld_guard_towers', schools: 'bld_schools', armories: 'bld_armories',
  vaults: 'bld_vaults', smithies: 'bld_smithies', markets: 'bld_markets',
  cathedrals: 'bld_cathedrals', training: 'bld_training', colosseums: 'bld_colosseums',
  castles: 'bld_castles',
  war_machine: 'war_machines', weapons: 'weapons_stockpile', armor: 'armor_stockpile',
};

// Gold cost per unit to queue each building
const BUILDING_GOLD_COST = {
  farms: 50, barracks: 200, outposts: 150, guard_towers: 150,
  schools: 500, armories: 400, vaults: 400, smithies: 800,
  markets: 2000, cathedrals: 1500, training: 10000, colosseums: 1500, castles: 25000,
  war_machine: 5000, weapons: 100, armor: 150,
};

// Gold cost per tool
const TOOL_GOLD_COST = { hammers: 500, scaffolding: 2000, blueprints: 5000 };
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

// Process build queue each turn — engineers work on queued buildings
function processBuildQueue(k, events) {
  const updates = {};
  let queue    = {};
  let progress = {};
  try { queue    = JSON.parse(k.build_queue    || '{}'); } catch { queue = {}; }
  try { progress = JSON.parse(k.build_progress || '{}'); } catch { progress = {}; }

  if (Object.keys(queue).length === 0) return updates;

  // Tool bonuses
  const hammerBonus     = 1 + (k.tools_hammers     || 0) * 0.05;
  const scaffoldBonus   = 1 + (k.tools_scaffolding  || 0) * 0.15;
  const blueprintBonus  = 1 + (k.tools_blueprints   || 0) * 0.25;
  const smithyBonus     = 1 + (Math.floor((k.bld_smithies||0) / 15) * 0.02);
  const raceConstr      = raceBonus(k, 'construction');
  const toolMult        = hammerBonus * scaffoldBonus * blueprintBonus * smithyBonus * raceConstr;

  // Allocated engineers per building from build_allocation JSON
  let allocation = {};
  try { allocation = JSON.parse(k.build_allocation || '{}'); } catch { allocation = {}; }

  const totalEngineers = k.engineers || 0;
  const totalAllocated = Object.values(allocation).reduce((s,v) => s + (Number(v)||0), 0);
  // If no allocation set, spread evenly across queued buildings
  const queueKeys = Object.keys(queue);
  const defaultPer = queueKeys.length > 0 ? Math.floor(totalEngineers / queueKeys.length) : 0;

  const completedItems = [];

  for (const building of queueKeys) {
    const qty = queue[building];
    if (!qty || qty <= 0) continue;
    const cost = BUILDING_COST[building];
    if (!cost) continue;

    const engAssigned = totalAllocated > 0 ? (Number(allocation[building]) || 0) : defaultPer;
    const workDone    = Math.floor(engAssigned * toolMult);

    const prevProgress = progress[building] || 0;
    const totalProgress = prevProgress + workDone;
    const costPerUnit   = cost;
    const completed     = Math.floor(totalProgress / costPerUnit);
    const actualCompleted = Math.min(completed, qty);
    const remainder     = totalProgress - (actualCompleted * costPerUnit);

    if (actualCompleted > 0) {
      const col = BUILDING_COL[building];
      if (col) {
        const current = updates[col] !== undefined ? updates[col] : (k[col] || 0);
        const cap = getCap(col, k.level || 1);
        const canAdd = Math.max(0, Math.min(actualCompleted, cap - current));
        updates[col] = current + canAdd;
        if (canAdd < actualCompleted) {
          events.push({ type: 'system', message: `⚠️ ${building} cap reached at level ${k.level||1} (max ${cap.toLocaleString()}) — level up to build more.` });
        }
      }
      queue[building] = qty - actualCompleted;
      if (queue[building] <= 0) delete queue[building];
      progress[building] = queue[building] > 0 ? remainder : 0;
      completedItems.push(`${actualCompleted.toLocaleString()} ${building.replace('_', ' ')}`);
    } else {
      progress[building] = totalProgress;
    }
  }

  // Clean up zero entries
  for (const k2 of Object.keys(queue)) {
    if ((queue[k2] || 0) <= 0) delete queue[k2];
  }
  for (const k2 of Object.keys(progress)) {
    if (!queue[k2]) delete progress[k2];
  }

  updates.build_queue    = JSON.stringify(queue);
  updates.build_progress = JSON.stringify(progress);

  if (completedItems.length > 0) {
    events.push({ type: 'system', message: `🔨 Construction completed: ${completedItems.join(', ')}.` });
    // XP for completed buildings
    const totalCompleted = completedItems.reduce(function(s, item) {
      const match = item.match(/^(\d[\d,]*)/);
      return s + (match ? parseInt(match[1].replace(/,/g,'')) : 1);
    }, 0);
    const conXp = awardXp(k, 'construction', totalCompleted);
    updates.xp    = conXp.xp;
    updates.level = conXp.level;
    if (conXp.levelled) events.push(...conXp.events);
  } else if (Object.keys(queue).length > 0) {
    events.push({ type: 'system', message: `🔨 Engineers making progress on ${Object.keys(queue).length} project(s) in queue.` });
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
  fire:       { minSB: 200,  effect: 'buildings', damageType: 'warm' },
  rain:       { minSB: 300,  effect: 'buildings', damageType: 'cool' },
  lightning:  { minSB: 500,  effect: 'troops',    damageType: 'strike' },
  amnesia:    { minSB: 800,  effect: 'research',  damageType: 'mental' },
  plague:     { minSB: 1000, effect: 'population',damageType: 'disease' },
  dispel:     { minSB: 400,  effect: 'friendly',  damageType: 'none' },
  bless:      { minSB: 600,  effect: 'friendly',  damageType: 'none' },
  earthquake: { minSB: 1200, effect: 'buildings', damageType: 'force' },
  shield:     { minSB: 1500, effect: 'friendly',  damageType: 'none' },
};

function castSpell(caster, target, spellId, power, duration, obscure) {
  const def = SPELL_DEFS[spellId];
  if (!def) return { error: 'Unknown spell' };
  if (caster.res_spellbook < def.minSB) {
    return { error: `Spellbook too low — need ${def.minSB}, have ${caster.res_spellbook}` };
  }

  const obscureCost = obscure ? Math.floor(power * 0.5) : 0;
  const totalMana   = power + obscureCost;

  if (caster.mana < totalMana) {
    return { error: `Not enough mana — need ${totalMana.toLocaleString()}, have ${caster.mana.toLocaleString()}` };
  }

  // Spellbook degrades slightly each cast
  const sbDecay = Math.floor(power * 0.001);
  const casterUpdates = {
    mana: caster.mana - totalMana,
    res_spellbook: Math.max(0, caster.res_spellbook - sbDecay),
    updated_at: Math.floor(Date.now() / 1000),
  };

  // Power per turn spread over duration, modified by race magic bonuses
  const powerPerTurn  = Math.floor(power / duration);
  const atkMagic      = (caster.res_attack_magic / 100) * raceBonus(caster, 'magic');
  const defMagic      = (target.res_defense_magic / 100) * raceBonus(target, 'magic');
  const effectivePower = Math.floor(powerPerTurn * atkMagic / Math.max(0.5, defMagic));

  // Friendly spells
  if (def.effect === 'friendly') {
    const targetUpdates = {};
    if (spellId === 'bless')  { targetUpdates.morale = Math.min(200, target.morale + Math.floor(effectivePower / 100)); }
    if (spellId === 'dispel') { /* clears active debuffs — tracked server-side in real impl */ }
    return {
      casterUpdates,
      targetUpdates,
      report: { spellId, obscure, power, duration, effectivePower, win: true },
      targetEvent: `${obscure ? 'An unknown caster' : caster.name} cast ${spellId} on your kingdom.`,
    };
  }

  // Offensive spells — compute damage
  const targetUpdates = {};
  let damageDesc = '';

  if (def.effect === 'buildings') {
    const farmsLost = Math.min(target.bld_farms, Math.floor(effectivePower / 500));
    targetUpdates.bld_farms = target.bld_farms - farmsLost;
    damageDesc = `${farmsLost} farms destroyed`;
  } else if (def.effect === 'troops') {
    const fightersLost = Math.min(target.fighters, Math.floor(effectivePower / 10));
    targetUpdates.fighters = target.fighters - fightersLost;
    damageDesc = `${fightersLost.toLocaleString()} fighters struck down`;
  } else if (def.effect === 'research') {
    const resLost = Math.floor(effectivePower / 200);
    targetUpdates.res_economy = Math.max(0, target.res_economy - resLost);
    damageDesc = `${resLost}% economy research wiped`;
  } else if (def.effect === 'population') {
    const popLost = Math.floor(target.population * (effectivePower / 1_000_000));
    targetUpdates.population = Math.max(0, target.population - popLost);
    damageDesc = `${popLost.toLocaleString()} citizens perished`;
  }

  targetUpdates.updated_at = Math.floor(Date.now() / 1000);

  const targetEventSource = obscure ? 'An unknown caster' : caster.name;
  const targetEvent = obscure
    ? `A mysterious ${spellId} spell struck your kingdom — ${damageDesc}.`
    : `${caster.name} cast ${spellId} on your kingdom — ${damageDesc}.`;

  return {
    casterUpdates,
    targetUpdates,
    report: { spellId, obscure, power, duration, effectivePower, damageDesc, win: true },
    casterEvent: `You cast ${spellId} on ${target.name}. Effect: ${damageDesc}.`,
    targetEvent,
  };
}

// ── Covert ops ────────────────────────────────────────────────────────────────

function covertSpy(spy, target, unitsSent) {
  const stealthMulti = raceBonus(spy, 'stealth');
  const success = (spy.thieves + spy.ninjas) * stealthMulti > target.fighters * 0.02 + target.bld_guard_towers * 5;

  if (!success) {
    const caught = Math.floor(unitsSent * 0.3);
    return {
      success: false,
      spyUpdates:    { thieves: spy.thieves - caught, updated_at: Math.floor(Date.now() / 1000) },
      targetUpdates: {},
      spyEvent:      `Spy mission on ${target.name} failed — ${caught} thieves caught and exposed your location.`,
      targetEvent:   `${spy.name} attempted to spy on you — caught ${caught} thieves.`,
    };
  }

  // Approximate report with ±15% noise
  function noise(n) { return Math.floor(n * (0.85 + Math.random() * 0.30)); }
  const report = {
    name: target.name, race: target.race,
    land: noise(target.land), fighters: noise(target.fighters),
    mages: noise(target.mages), gold: noise(target.gold),
  };

  return {
    success: true, report,
    spyUpdates: {},
    targetUpdates: {},
    spyEvent: `Spy report on ${target.name} retrieved successfully.`,
    targetEvent: null,
  };
}

function covertLoot(thief, target, lootType, thievesSent) {
  if (thievesSent > thief.thieves) return { error: 'Not enough thieves' };
  const stealthMulti = raceBonus(thief, 'stealth');
  const success = thief.thieves * stealthMulti > target.fighters * 0.015 + target.bld_guard_towers * 3
                                                                          + target.bld_armories * 10
                                                                          + target.bld_vaults * 10;

  if (!success) {
    return {
      success: false,
      thiefUpdates:  { thieves: thief.thieves - Math.floor(thievesSent * 0.25), updated_at: Math.floor(Date.now() / 1000) },
      targetUpdates: {},
      event: `Loot attempt on ${target.name} failed. Thieves captured and location revealed.`,
    };
  }

  const targetUpdates = { updated_at: Math.floor(Date.now() / 1000) };
  let stolen = 0, desc = '';

  if (lootType === 'gold') {
    stolen = Math.floor(thievesSent * (50 + Math.random() * 50));
    stolen = Math.min(stolen, Math.floor(target.gold * 0.05));
    targetUpdates.gold = target.gold - stolen;
    desc = `${stolen.toLocaleString()} gold`;
  } else if (lootType === 'research') {
    stolen = Math.floor(thievesSent * 0.2);
    targetUpdates.res_economy = Math.max(0, target.res_economy - stolen);
    desc = `${stolen} economy research points`;
  } else if (lootType === 'weapons') {
    stolen = Math.floor(thievesSent * 0.3);
    targetUpdates.res_weapons = Math.max(0, target.res_weapons - stolen);
    desc = `${stolen} weapon research points`;
  } else if (lootType === 'war_machines') {
    stolen = Math.floor(thievesSent * 0.01);
    targetUpdates.war_machines = Math.max(0, target.war_machines - stolen);
    desc = `${stolen} war machine(s)`;
  }

  return {
    success: true, stolen, lootType,
    thiefUpdates: {},
    targetUpdates,
    thiefEvent:  `Looted ${desc} from ${target.name}.`,
    targetEvent: `Thieves infiltrated your kingdom and stole ${desc}.`,
  };
}

function covertAssassinate(assassin, target, ninjasSent, unitType) {
  if (ninjasSent > assassin.ninjas) return { error: 'Not enough ninjas' };
  const stealthMulti = raceBonus(assassin, 'stealth');
  const success = assassin.ninjas * stealthMulti * 1.2 > target[unitType] * 0.01 + target.bld_guard_towers * 2;

  if (!success) {
    return {
      success: false,
      assassinUpdates: { ninjas: assassin.ninjas - Math.floor(ninjasSent * 0.2), updated_at: Math.floor(Date.now() / 1000) },
      targetUpdates: {},
      event: `Assassination of ${unitType} in ${target.name} failed. Ninjas compromised.`,
    };
  }

  const killed = Math.floor(ninjasSent * (10 + Math.random() * 10));
  const targetUpdates = {
    [unitType]: Math.max(0, target[unitType] - killed),
    updated_at: Math.floor(Date.now() / 1000),
  };

  return {
    success: true, killed,
    assassinUpdates: {},
    targetUpdates,
    assassinEvent: `Assassinated ${killed.toLocaleString()} ${unitType} in ${target.name}.`,
    targetEvent:   `${assassin.name}'s ninjas assassinated ${killed.toLocaleString()} of your ${unitType}.`,
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

function expeditionRewards(type, rangers, fighters, k) {
  const tacBonus = 1 + ((k.res_military || 0) / 2000); // softer bonus
  const rewards = [];
  const events  = [];
  const updates = {};

  // Ranger attrition — 1–5% don't return (hazards, desertion, accidents)
  const attritionPct = type === 'dungeon' ? rand(2, 8) : rand(1, 5);
  const lost = Math.max(1, Math.floor(rangers * attritionPct / 100));
  const returned = rangers - lost;
  if (lost > 0) rewards.push({ text: `${lost} ranger${lost > 1 ? 's' : ''} did not return from the expedition` });
  updates.rangers = (k.rangers || 0) + returned;

  if (type === 'scout') {
    // Gold: modest, ranger-scaled
    const gold = Math.floor(rand(rangers * 3, rangers * 8) * tacBonus);
    rewards.push({ text: `+${gold.toLocaleString()} gold from foraging` });
    updates.gold = (k.gold || 0) + gold;

    // Land: small find
    const land = Math.max(1, Math.floor(rand(rangers * 0.01, rangers * 0.03)));
    rewards.push({ text: `+${land} acre${land > 1 ? 's' : ''} of unclaimed land` });
    updates.land = (k.land || 0) + land;

    // Mana cache — 30% chance
    if (roll(0.30)) {
      const mana = rand(Math.floor(rangers * 0.2), Math.floor(rangers * 0.8));
      rewards.push({ text: `+${mana} mana from a hidden shrine` });
      updates.mana = (k.mana || 0) + mana;
    }
    // Wandering fighters — 10% chance, small group
    if (roll(0.10)) {
      const troops = rand(2, Math.max(3, Math.floor(rangers * 0.02)));
      rewards.push({ text: `${troops} wandering fighter${troops > 1 ? 's' : ''} pledge allegiance to your kingdom` });
      updates.fighters = (k.fighters || 0) + troops;
    }
    // Ancient map — 3% chance
    if (roll(0.03)) {
      const bonus = rand(Math.floor(rangers * 0.03), Math.floor(rangers * 0.08));
      rewards.push({ text: `An ancient map reveals ${bonus} additional acres — scouts claim them!` });
      updates.land = (updates.land || k.land || 0) + bonus;
    }
    // Junk
    if (roll(0.45)) {
      rewards.push({ text: `Your rangers also found ${junkPrize()}` });
    }

  } else if (type === 'deep') {
    // Gold: better, still ranger-scaled
    const gold = Math.floor(rand(rangers * 10, rangers * 30) * tacBonus);
    rewards.push({ text: `+${gold.toLocaleString()} gold from deep wilderness caches` });
    updates.gold = (k.gold || 0) + gold;

    // Land: meaningful
    const land = Math.max(2, Math.floor(rand(rangers * 0.04, rangers * 0.10)));
    rewards.push({ text: `+${land} acres of fertile territory` });
    updates.land = (k.land || 0) + land;

    // Mana — 55% chance
    if (roll(0.55)) {
      const mana = rand(Math.floor(rangers * 0.5), Math.floor(rangers * 2));
      rewards.push({ text: `+${mana} mana from ley lines discovered deep in the wilderness` });
      updates.mana = (k.mana || 0) + mana;
    }
    // Research scroll — 25% chance, modest boost
    if (roll(0.25)) {
      const disc = ['res_economy','res_weapons','res_armor','res_military','res_entertainment'][rand(0,4)];
      const boost = rand(1, 5);
      const discLabel = disc.replace('res_','').replace('_',' ');
      rewards.push({ text: `A research scroll found — ${discLabel} +${boost}%` });
      updates[disc] = (k[disc] || 0) + boost;
    }
    // Mercenaries — 20% chance
    if (roll(0.20)) {
      const troops = rand(Math.floor(rangers * 0.03), Math.floor(rangers * 0.08));
      const ttype = roll(0.5) ? 'fighters' : 'rangers';
      if (troops > 0) {
        rewards.push({ text: `${troops} mercenary ${ttype} join your cause` });
        updates[ttype] = (k[ttype] || 0) + troops;
      }
    }
    // Ruins land — 8% chance
    if (roll(0.08)) {
      const bonus = rand(Math.floor(rangers * 0.05), Math.floor(rangers * 0.15));
      rewards.push({ text: `Ruins of an abandoned kingdom found — you claim ${bonus} acres of its former territory` });
      updates.land = (updates.land || k.land || 0) + bonus;
    }
    // Legendary artifact — 2% chance
    if (roll(0.02)) {
      const disc = ['res_spellbook','res_attack_magic','res_defense_magic','res_war_machines','res_construction'][rand(0,4)];
      const boost = rand(5, 15);
      const discLabel = disc.replace('res_','').replace('_',' ');
      rewards.push({ text: `⚡ An ancient artifact of ${discLabel} — permanent +${boost}%` });
      updates[disc] = (k[disc] || 0) + boost;
    }
    // Junk
    if (roll(0.60)) {
      rewards.push({ text: `Hidden deep in the wilderness, your rangers also discovered ${junkPrize()}` });
    }

  } else if (type === 'dungeon') {
    const power = (rangers + fighters * 2) * tacBonus;
    const successChance = Math.min(0.85, 0.25 + (power / 80000));
    const success = roll(successChance);

    if (!success) {
      // Failed — lose some fighters, all rangers still return (minus attrition already applied)
      const fLost = Math.min(fighters, rand(Math.floor(fighters * 0.15), Math.floor(fighters * 0.40)));
      updates.fighters = Math.max(0, (k.fighters || 0) + fighters - fLost);
      rewards.push({ text: `The dungeon proved too dangerous — ${fLost} fighters lost in retreat` });
      events.push({ type: 'attack', message: `💀 Dungeon raid FAILED — your forces were overwhelmed. ${fLost.toLocaleString()} fighters lost.` });
    } else {
      // Success — return all fighters
      updates.fighters = (k.fighters || 0) + fighters;

      const gold = Math.floor(rand(fighters * 20, fighters * 80) * tacBonus);
      rewards.push({ text: `+${gold.toLocaleString()} gold plundered from the dungeon` });
      updates.gold = (k.gold || 0) + gold;

      const mana = rand(Math.floor(rangers * 1), Math.floor(rangers * 4));
      rewards.push({ text: `+${mana} mana from dungeon ley stones` });
      updates.mana = (k.mana || 0) + mana;

      // Research boost — always on success
      const disc = ['res_weapons','res_armor','res_military','res_attack_magic','res_spellbook'][rand(0,4)];
      const boost = rand(3, 12);
      const discLabel = disc.replace('res_','').replace('_',' ');
      rewards.push({ text: `Dungeon tome found — ${discLabel} permanently +${boost}%` });
      updates[disc] = (k[disc] || 0) + boost;

      // War machines — 12% chance
      if (roll(0.12)) {
        const wm = rand(1, Math.max(2, Math.floor(fighters / 500)));
        rewards.push({ text: `⚡ Ancient war machine${wm > 1 ? 's' : ''} recovered from the dungeon depths — +${wm}` });
        updates.war_machines = (k.war_machines || 0) + wm;
      }
      // Spellbook legendary — 6% chance
      if (roll(0.06)) {
        const boost2 = rand(10, 40);
        rewards.push({ text: `⚡ The dungeon's heart pulsed with ancient magic — spellbook permanently +${boost2}` });
        updates.res_spellbook = (updates.res_spellbook || k.res_spellbook || 0) + boost2;
      }
      if (roll(0.5)) {
        rewards.push({ text: `Amid the carnage, someone pocketed ${junkPrize()}` });
      }
    }
  }

  return { rewards, updates, events };
}

async function resolveExpeditions(db, k, engine) {
  const exps = await db.all('SELECT * FROM expeditions WHERE kingdom_id = ? AND turns_left > 0', [k.id]);
  for (const exp of exps) {
    const newTurns = exp.turns_left - 1;
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
      const { rewards, updates, events } = expeditionRewards(exp.type, exp.rangers, exp.fighters, freshK);
      const label = { scout: '🔭 Scout', deep: '🌲 Deep', dungeon: '⚔️ Dungeon' }[exp.type];

      // Apply kingdom updates
      const VALID_KINGDOM_COLS = new Set([
        'gold','mana','land','population','morale','food',
        'fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers',
        'war_machines','weapons_stockpile','armor_stockpile',
        'res_economy','res_weapons','res_armor','res_military','res_attack_magic',
        'res_defense_magic','res_entertainment','res_construction','res_war_machines','res_spellbook',
        'xp','level',
      ]);
      const safeUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k2, v]) => VALID_KINGDOM_COLS.has(k2) && v !== undefined && v !== null && !isNaN(v))
      );
      if (Object.keys(safeUpdates).length > 0) {
        const cols = Object.keys(safeUpdates).map(c => `${c} = ?`).join(', ');
        await db.run(`UPDATE kingdoms SET ${cols} WHERE id = ?`, [...Object.values(safeUpdates), k.id]);
      }

      // Single news line — no reward detail in news
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
        [k.id, 'system', `${label} expedition returned — see expedition log for rewards.`, k.turn || 0]);
      for (const ev of events) {
        await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
          [k.id, ev.type || 'system', ev.message, k.turn || 0]);
      }

      // Store rewards JSON on the row so frontend can show them in the log, then mark completed (turns_left=0)
      const rewardJson = JSON.stringify(rewards.map(r => r.text));
      await db.run('UPDATE expeditions SET turns_left = 0, rewards = ? WHERE id = ?', [rewardJson, exp.id]);

    } catch (err) {
      console.error(`[expedition] reward error for id=${exp.id} type=${exp.type}:`, err.message);
      await db.run('DELETE FROM expeditions WHERE id = ?', [exp.id]);
      await db.run('INSERT INTO news (kingdom_id, type, message, turn_num) VALUES (?, ?, ?, ?)',
        [k.id, 'system', `An expedition returned but the scouts lost their notes.`, k.turn || 0]);
    }
  }
}

module.exports = {
  goldPerTurn, manaPerTurn, foodBalance, popGrowth,
  processTurn, hireUnits, studyDiscipline,
  queueBuildings, processBuildQueue, forgeTools,
  resolveMilitaryAttack, castSpell,
  covertSpy, covertLoot, covertAssassinate,
  resolveAllianceDefence, resolveExpeditions,
  awardXp, xpForLevel, xpToNextLevel, levelFromXp,
  awardTroopXp, troopXpForLevel, effectiveTroopLevel,
  TROOP_RACE_BONUS, RACE_BONUSES, UNIT_COST, BUILDING_COST, BUILDING_GOLD_COST, BUILDING_COL, SPELL_DEFS,
};
