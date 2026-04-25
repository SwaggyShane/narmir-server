# Narmir — Land of Magic and Conquest

A browser-based multiplayer kingdom management game with real-time chat, turn-based strategy, and deep race customisation. Built with Node.js, Express, Socket.io, and SQLite.

---

## Live

**Game:** https://narmir-server.onrender.com  
**Admin:** https://narmir-server.onrender.com/admin

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express |
| Real-time | Socket.io |
| Database | SQLite (via `better-sqlite3` wrapper) |
| Auth | JWT — httpOnly cookie + localStorage fallback |
| Frontend | Vanilla JS, single-file HTML/CSS |
| Hosting | Render (persistent disk at `/data/narmir.db`) |

---

## Setup

```bash
yarn install
node index.js
```

**Environment variables:**

| Variable | Description |
|---|---|
| `JWT_SECRET` | Secret key for JWT signing |
| `ADMIN_SECRET` | Password for admin panel access |
| `DB_PATH` | Path to SQLite database (default: `/data/narmir.db`) |
| `PORT` | Server port (default: 3000) |

---

## Project Structure

```
narmir-server/
├── index.js                  # Entry point — Express app, Socket.io, turn regen
├── game/
│   ├── engine.js             # All game logic — combat, spells, expeditions, upkeep, XP
│   └── sockets.js            # Socket.io event handlers — chat, combat, covert, real-time events
├── routes/
│   ├── auth.js               # Register, login, logout
│   ├── kingdom.js            # All kingdom actions — build, hire, attack, research, expedition, covert
│   ├── admin.js              # Admin routes — kingdoms, promotions, bans, chat mods
│   └── middleware.js         # requireAuth JWT middleware
├── db/
│   └── schema.js             # Table creation + safe column migrations on boot
└── public/
    ├── index.html            # Full game frontend (single file)
    ├── admin.html            # Admin panel
    └── throne.png            # The Throne of Nazdreg Grishnak
```

---

## Races

| Race | Strengths | Weaknesses |
|---|---|---|
| **Dwarf** | Construction ×1.20, Economy ×1.202, War machines ×1.25 | Magic ×0.75, Research ×0.90 |
| **High Elf** | Magic ×1.30, Research ×1.20 | Economy ×1.05, Military ×0.90 |
| **Orc** | Military ×1.25, Fighters ×1.60 | Research ×0.80, Magic ×0.70 |
| **Dark Elf** | Stealth ×1.40, Ninjas ×1.30 | Economy ×0.90, Military ×0.90 |
| **Human** | Balanced — ×1.05–1.10 most categories | No dominant weakness |
| **Dire Wolf** | Fighters ×1.80, Exploration ×1.40 | Economy ×0.70, Magic ×0.60 |

---

## Core Game Loop

1. **Turns** regenerate at +5 every 15 minutes (max 200 stored)
2. Spend turns to: build, research, hire, attack, cast spells, send expeditions
3. Engineers build continuously based on allocation — no turn cost per building
4. Gold is produced each turn based on land × tax × economy research × race bonus
5. Support units (researchers, engineers, scribes) are housed in their buildings and pay no upkeep
6. All units gain XP from activity, levelling up to provide up to +50% effectiveness at level 100
7. Races unlock a unique racial bonus when their signature unit reaches level 5

---

## Turn Economy

**Gold per turn** (baseline: 404 land, 42% tax, 100% economy research):

| Race | GC/turn |
|---|---|
| Dwarf | 457 |
| Orc | 418 |
| High Elf | 399 |
| Human | 399 |
| Dark Elf | 342 |
| Dire Wolf | 266 |

---

## Building Tool System

Three types of construction tools are produced in smithies:

| Tool | Source | Cap | Effect |
|---|---|---|---|
| **Hammers** | Smithy (1 turn) | 25/smithy | +5% build speed each, degrade after 20 turns of use |
| **Scaffolding** | Smithy (1 turn + 2,500 GC) | 10/smithy | Required for >100t buildings; speed bonus for <100t buildings |
| **Blueprints** | Library (scribes) | 25/smithy | Required for 100t+ buildings; also drop from dungeons (20%) |

---

## Expedition Rewards

Gold formula: `rangers × 12 × tacBonus × raceBonus × rangerLevel × turns × rand(1.05–1.30)`

| Type | Turns | Map drop | Blueprint drop |
|---|---|---|---|
| Scout | 10 | 5% | — |
| Deep | 25 | 15% | — |
| Dungeon | 50 | 25% | 20% |

Ultra-rare prizes: 0.5% chance on deep, 1% on dungeon. The Throne of Nazdreg Grishnak has a 0.1% chance on deep/dungeon and can only be found once across the entire server.

---

## Chat & Moderation

Real-time global chat via Socket.io. Messages use username (not kingdom name).

**User commands:** `/me <action>` · `/msg <username> <text>`  
**Mod commands:** `/kick` · `/ban [reason]` · `/unban` · `/delete <id>`

Moderators are assigned via the admin panel. Banned users can be unbanned from the admin chat ban list.

---

## Admin Panel

Access at `/admin` with the `ADMIN_SECRET` password.

- **⚙️ Manage** — global announcements, chat moderators, ban list, promote to admin
- **🏰 Kingdoms** — full kingdom editor, AI seeding, bulk reset tools
- **📋 Changelog** — completed features list and wishlist

---

## Special: The Throne of Nazdreg Grishnak

A tribute to a real player. The throne exists once in the entire game world and can never be found again once discovered.

> *Nazdreg Grishnak · August 13, 1975 — August 19, 2012*
>
> "An orc who sat upon this throne once commanded armies and shaped the world.
> His name is remembered. His legacy endures."

When found, every kingdom receives a news event and a global chat broadcast. The finder receives all stats +100, 1,000,000 gold, 1,000 land, 100,000 population, +50 morale, and 50,000 fighters.

---

## License

Private project. All rights reserved.
