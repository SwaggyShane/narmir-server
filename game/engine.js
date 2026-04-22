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

// ── Turn processor ────────────────────────────────────────────────────────────

function processTurn(k) {
  const events = [];
  const updates = { turn: k.turn + 1, updated_at: Math.floor(Date.now() / 1000) };

  // ── 1. Gold income ───────────────────────────────────────────────────────────
  const income = goldPerTurn(k);
  updates.gold = k.gold + income;
  events.push({ type: 'system', message: `💰 Turn ${updates.turn}: +${income.toLocaleString()} GC earned. Treasury: ${updates.gold.toLocaleString()} GC.` });

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
    events.push({ type: 'system', message: `⚔️ Troop upkeep: -${upkeep.toLocaleString()} GC (${totalTroops.toLocaleString()} troops${barrackDiscount > 0 ? ', barracks discount applied' : ''}).` });
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
        const newVal = Math.min(MAX_RESEARCH, current + inc);
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
      updates.res_spellbook = current + spellInc;
      advances.push(`Spellbook → ${updates.res_spellbook}`);
    }

    if (advances.length > 0) {
      events.push({ type: 'system', message: `📚 Research advanced: ${advances.join(', ')}.` });
    } else if (researchers > 0) {
      events.push({ type: 'system', message: `📚 ${researchers.toLocaleString()} researchers studying — allocate more per discipline for advancement.` });
    }
  } else {
    events.push({ type: 'system', message: `📚 No researchers — hire researchers and allocate them to advance your kingdom's knowledge.` });
  }

  // ── 8. Build queue — engineers work on queued buildings each turn ─────────────
  const buildUpdates = processBuildQueue(k, events);
  Object.assign(updates, buildUpdates);

  // ── 9. Training fields ────────────────────────────────────────────────────────
  if ((k.bld_training||0) > 0) {
    const trainingGain = Math.floor(k.bld_training / 50);
    if (trainingGain > 0) {
      const current = updates.res_military !== undefined ? updates.res_military : (k.res_military||0);
      const newVal = Math.min(MAX_RESEARCH, current + trainingGain);
      updates.res_military = newVal;
      events.push({ type: 'system', message: `🏋️ Training fields advanced Military Tactics by ${trainingGain} to ${newVal}%.` });
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

  updates.last_turn_at = Math.floor(Date.now() / 1000);
  return { updates, events };
}

// ── Hire units ────────────────────────────────────────────────────────────────

function hireUnits(k, unit, amount) {
  const validUnits = ['fighters','rangers','clerics','mages','thieves','ninjas','researchers','engineers'];
  if (!validUnits.includes(unit)) return { error: 'Invalid unit type' };
  if (amount <= 0) return { error: 'Amount must be positive' };
  if (unit === 'researchers' && (k.researchers + amount) > MAX_RESEARCHERS) {
    return { error: `Max researchers is ${MAX_RESEARCHERS.toLocaleString()}` };
  }

  const cost = amount * UNIT_COST;
  if (k.gold < cost) return { error: `Not enough gold — need ${cost.toLocaleString()} GC` };
  if (amount > k.population) return { error: 'Not enough population available' };

  return {
    updates: {
      gold: k.gold - cost,
      population: k.population - amount,
      [unit]: k[unit] + amount,
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

// ── Construction ──────────────────────────────────────────────────────────────

// Engineer-turns required to complete one unit of each building
const BUILDING_COST = {
  farms: 10, barracks: 20, outposts: 20, guard_towers: 20,
  schools: 50, armories: 50, vaults: 50, smithies: 150,
  markets: 300, cathedrals: 250, training: 500, colosseums: 250, castles: 5000,
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
  markets: 2000, cathedrals: 1500, training: 3000, colosseums: 1500, castles: 25000,
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
    return { error: `Need ${totalCost.toLocaleString()} GC but only have ${k.gold.toLocaleString()} GC` };
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
        updates[col] = (updates[col] !== undefined ? updates[col] : (k[col] || 0)) + actualCompleted;
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
  if (totalCost > k.gold) return { error: `Need ${totalCost.toLocaleString()} GC but only have ${k.gold.toLocaleString()} GC` };
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

  // Attack power — race military and magic bonuses applied
  // Weapons stockpile: each weapon equips one fighter, up to fighters sent
  const weaponsEquipped = Math.min(fightersSent, k.weapons_stockpile || 0);
  const weaponBonus     = 1 + (weaponsEquipped / Math.max(fightersSent, 1)) * 0.25; // up to +25%
  const atkWeapon  = (attacker.res_weapons / 100) * weaponBonus;
  const atkTactics = attacker.res_military / 100;
  const atkRace    = raceBonus(attacker, 'military');
  const atkMagic   = raceBonus(attacker, 'magic');
  const atkFighterPower = fightersSent * atkWeapon * atkTactics * atkRace;
  const atkMagePower    = magesSent * 2.5 * (attacker.res_attack_magic / 100) * atkMagic;
  // War machines: each adds 500 attack power, scaled by war machines research and race
  const wmCount    = Math.min(attacker.war_machines || 0, attacker.engineers || 0); // need engineers to operate
  const wmBonus    = wmCount * 500 * (attacker.res_war_machines / 100) * raceBonus(attacker, 'war_machines');
  const atkPower = atkFighterPower + atkMagePower + wmBonus;

  // Defence power — armor stockpile reduces casualties taken
  const armorEquipped = Math.min(defender.fighters, defender.armor_stockpile || 0);
  const armorBonus    = 1 + (armorEquipped / Math.max(defender.fighters, 1)) * 0.25; // up to +25%
  const defArmor   = (defender.res_armor / 100) * armorBonus;
  const defTactics = defender.res_military / 100;
  const defRace    = raceBonus(defender, 'military');
  const defMagic   = raceBonus(defender, 'magic');
  const defFighterPower = defender.fighters * defArmor * defTactics * defRace;
  const defMagePower    = (defender.mages||0) * 1.5 * (defender.res_defense_magic / 100) * defMagic;
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

  const report = {
    win, fightersSent, magesSent,
    atkFightersLost, atkMagesLost, defFightersLost, landTransferred,
    atkPower: Math.round(atkPower), defPower: Math.round(defPower),
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
    desc = `${stolen.toLocaleString()} GC`;
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

module.exports = {
  goldPerTurn, manaPerTurn, foodBalance, popGrowth,
  processTurn, hireUnits, studyDiscipline,
  queueBuildings, processBuildQueue, forgeTools,
  resolveMilitaryAttack, castSpell,
  covertSpy, covertLoot, covertAssassinate,
  resolveAllianceDefence,
  RACE_BONUSES, UNIT_COST, BUILDING_COST, BUILDING_COL, SPELL_DEFS,
};
