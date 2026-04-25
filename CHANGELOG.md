# Narmir — Land of Magic and Conquest
## Changelog

---

### Core Systems
- Registration, login, JWT auth with httpOnly cookie
- Turn system — +5 every 15 min, max 200, crash-safe boot catch-up
- 6 playable races with unique bonuses and penalties (Dwarf, High Elf, Orc, Dark Elf, Human, Dire Wolf)
- Kingdom status panel with resource tiles, XP bar, protection badge
- Three-column desktop status layout (military, research, buildings)
- Newbie protection — kingdoms under Turn 200 cannot be attacked, spelled, or covert-targeted
- Active effects bar — fog, blight, silence, plague, shield displayed as pill badges on status panel

---

### Economy
- Race-adjusted gold production:
  - Dwarf 457 · Orc 418 · High Elf 399 · Human 399 · Dark Elf 342 · Dire Wolf 266 GC/turn (404 land, 42% tax baseline)
- Tax slider with lock — persists server-side, loads correctly on login
- Markets and castles add flat gold bonuses per building

---

### Buildings
- 14 building types — continuous build from engineer allocation
- Build queue shows turn estimate per building type
- Building caps scale with kingdom level

**Tool system:**
- **Blueprints** — crafted by scribes in library, stored in smithy (cap: 25/smithy), required for 100t+ buildings (vaults, smithies, markets, libraries, mage towers, training fields, castles), consumed on completion, 20% drop chance from dungeons
- **Hammers** — produced in smithy (1 turn each, cap: 25/smithy), +5% build speed each, degrade over 20 turns of active use with live durability display
- **Scaffolding** — produced in smithy (1 turn + 2,500 GC each, cap: 10/smithy), required for buildings >100t base, speed bonus for buildings <100t (scales inversely), single use consumed on completion

**Smithy panel:** Displays stored hammers (with durability %), scaffolding count, blueprints count, all caps, and production allocation sliders for hammer/scaffolding output per turn.

**Build panel notices:** 📐 Blueprint needed / 🪜 Scaffolding needed badges appear beside building rows where engineers are allocated but tools are missing.

---

### Units & Upkeep
- 9 hirable unit types: fighters, rangers, clerics, mages, thieves, ninjas, researchers, engineers, scribes

**Housing capacity by race (per house):**
- Dire Wolf 700 (+40%) · Dwarf 650 (+30%) · Orc 600 (+20%) · Human 500 (base) · Dark Elf 450 (−10%) · High Elf 350 (−30%)
- Dire Wolf overcrowding morale penalty ×0.5 · High Elf ×2.0

**Support unit housing (free upkeep if housed):**
- Researchers → Schools: 100/school base (racial multipliers apply)
- Engineers → Smithies: 50/smithy base
- Scribes → Libraries: 20/library base
- Overflow units beyond capacity pay normal upkeep; combat troops always pay upkeep

**Upkeep race multipliers:**
- Dwarf ×0.85 · Human/High Elf ×1.00 · Dark Elf ×1.10 · Orc ×1.15 · Dire Wolf ×1.20
- Barracks discount: up to 50% off military upkeep

Hire panel shows school/smithy/library capacity with overflow highlighted red.

---

### Research
- 10 research disciplines with engineer/researcher allocation panel
- Distribute evenly and Release all buttons
- Research bars only — no percentage display
- Silence debuff suppresses research for 3 turns

---

### Exploration
- Three expedition types: Scout (10t), Deep (25t), Dungeon (50t)
- Gold formula: `rangers × 12 × tacBonus × raceBonus × rangerLevelMult × turns × rand(1.05–1.30)`

**Race exploration bonuses:**
- Dire Wolf ×1.40 · Dark Elf ×1.25 · Human ×1.10 · Orc ×1.05 · High Elf ×0.95 · Dwarf ×0.90
- Dire Wolf and Dark Elf also suffer reduced ranger attrition (×0.5 and ×0.6 respectively)

**Item drops:**
- Maps: Scout 5% · Deep 15% · Dungeon 25%
- Blueprints: Dungeon 20% on success

**Ultra-rare prizes (0.5% deep, 1% dungeon):**
- 🥚 Ancient Dragon Egg — +75 attack magic, +50 spellbook, +5,000 mana
- 📖 Tome of Forgotten Kings — +80 military, +50 weapons, +50 armor
- 💎 Crystalline Mana Heart — +20,000 mana, +60 defense magic, +100 spellbook
- 💰 Vault of the Ancients — +500,000 gold, +60 economy
- ⚔️ Banner of the Lost Legion — +10,000 fighters, +40 military
- 🌳 Seed of the World Tree — +500 land, +100 farms, +50,000 population

**The Throne of Nazdreg Grishnak** (0.1% chance, unique — one per server, forever):
> *Nazdreg Grishnak · August 13, 1975 — August 19, 2012*
>
> Awards all stats +100, 1,000,000 gold, 1,000 land, 100,000 population, +50 morale, +50,000 fighters.
> Broadcasts to every kingdom's news feed and global chat on discovery. Once found it is gone forever.

Cancel expedition button available on all active expeditions.

---

### Magic & Library
- 16 spells across 4 tiers — scroll-based casting with obscure option
- Mages craft scrolls in library; scribes craft maps and blueprints
- Map required to interact with other kingdoms (attack, spell, covert)
- Mage tower mana production
- Shrine morale and healing
- Spell target selector panel — own kingdom list in spell panel, pre-selects from rankings

---

### Combat & Covert
- Military attack with power comparison and full battle report
- Win probability shown in attack panel and rankings table
- Covert ops — spy, loot, assassinate
- War log panel with full history

---

### Unit XP & Levelling
All units gain XP from activity each turn. Level scaling: **+0.5% effectiveness per level, max +50% at level 100.**

| Unit | XP sources | What scales |
|---|---|---|
| Engineers | +10 per building completed | Build speed |
| Researchers | +5 per discipline advanced | Research increment |
| Mages | +2/turn mana, +20/scroll completed | Mana production, scroll speed |
| Scribes | +15 per map/blueprint completed | Craft speed |
| Rangers | +3/turn exploring, +8/20/40 by expedition type | Expedition rewards, land discovery |
| Fighters | +30 combat win, +10 combat loss | Combat power |
| Thieves | +12 spy success, +20 loot success | Loot amount, success chance |
| Ninjas | +30 assassination success | Kills, success chance |

**Hire dilution:** `new_avg_xp = (old_xp × old_count) / (old_count + hired)` — new recruits lower the average.

Training fields award passive XP with equipment bonuses.

**Racial unique bonuses (unlocked at unit level 5+):**
- 🔨 **Dwarf engineers** — can solo-crew war machines (normally needs a full crew)
- ✨ **High Elf mages** — scrolls crafted produce 2 instead of 1
- ⚔️ **Orc fighters** — every 10 fighters trains 1 free fighter per turn
- 🕵️ **Dark Elf ninjas** — silent assassination, target receives no news event
- 🐺 **Dire Wolf rangers** — expeditions tick down 2 turns per turn (return 1 turn early)
- 💚 **Human clerics** — +1 morale aura per turn across the kingdom

---

### Social & Communication
- Global chat with Socket.io — real-time, username-based (not kingdom name)
- Online users sidebar with race icons and MOD badges
- IRC commands for all users: `/me <action>`, `/msg <username> <text>`
- Moderator-only commands: `/kick`, `/ban`, `/unban`, `/delete`
- Whispers shown in amber to both sender and recipient
- /me actions render as centred italic emotes (not chat bubbles)
- Alliance system — create, invite, dismiss, pledge (0–10%), chat board
- Rankings panel with win probability and one-click ⚔️ / ✨ / 🕵️ action buttons per kingdom
- Protected kingdoms show 🛡️ badge and greyed-out action buttons in rankings
- News panel with type filters (All / Combat / Spells / Covert / System) and icons

---

### Admin
- Tab layout: ⚙️ Manage · 🏰 Kingdoms · 📋 Changelog
- Full kingdom edit modal — live data fetched from server
- Promote/demote chat moderators by username
- Chat ban list with unban button per player
- Ban reason stored and displayed
- AI kingdoms with race-aware economic and military behaviour
- Global announcement broadcast to all players
- Promote to admin
- Admin notes textarea — saves to localStorage

---

### Wishlist — Future Additions

**Gameplay**
- Spell casting target history — remember last target per spell
- Kingdom descriptions — players can write a lore bio
- Bounty board — players place gold bounties on other kingdoms
- Diplomacy — non-aggression pacts, trade agreements between kingdoms
- Seasons — periodic world events affecting all kingdoms (drought, plague, magic surge)
- Prestige / reset system — kingdoms that reach max level can prestige for a permanent bonus
- Named hero units — single high-level units with unique abilities

**Combat**
- Alliance war — alliances can declare war on each other
- Siege mechanics — castle walls reduce land capture percentage
- Battle replay — animated step-by-step battle report
- Mercenary hiring — temporary troops available for gold at market

**Social**
- Alliance rankings — leaderboard for combined alliance land
- Kingdom profiles — public page showing race, level, history
- Trade system — send gold or resources between kingdoms
- Messaging — direct kingdom-to-kingdom messages

**World**
- World map — visual representation of kingdom territories
- Named regions — kingdoms occupy named land areas
- More races — Gnome (inventor), Vampire (undead mage), Troll (regenerating fighter)
- Race lore panel — detailed backstory for each race

**Polish**
- iOS layout testing and fixes
- Sound effects — combat, level up, expedition return
- Dark/light theme toggle
- Email notifications — optional alerts for attacks and expedition return
- Tutorial / new player guide
- Achievements system
