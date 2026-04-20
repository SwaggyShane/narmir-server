# Narmir Server

Real-time multiplayer backend for **Narmir — Land of Magic and Conquest**.

## Stack

| Layer | Tech |
|---|---|
| HTTP server | Node.js + Express |
| Real-time | Socket.io (WebSockets) |
| Database | SQLite via better-sqlite3 |
| Auth | JWT (httpOnly cookie) |
| Game logic | Pure JS engine (no framework) |

## Project layout

```
narmir-server/
├── src/
│   ├── index.js          — server entry point
│   ├── db/
│   │   └── schema.js     — SQLite init, all CREATE TABLE statements
│   ├── game/
│   │   ├── engine.js     — pure game logic (turn, combat, spells, covert)
│   │   └── sockets.js    — Socket.io event handlers
│   └── routes/
│       ├── auth.js       — /api/auth/* (register, login, logout, me)
│       ├── kingdom.js    — /api/kingdom/* (turn, hire, research, build, news)
│       └── middleware.js — requireAuth JWT middleware
├── public/
│   ├── index.html        — copy narmir-dashboard.html here and rename
│   └── client.js         — frontend ↔ server bridge
├── .env.example
└── package.json
```

## Quick start

```bash
# 1. Install dependencies
cd narmir-server
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env — at minimum change JWT_SECRET

# 3. Place the frontend
cp /path/to/narmir-dashboard.html public/index.html

# 4. Wire in the client connector
# Add this line just before </body> in public/index.html:
#   <script src="/client.js"></script>

# 5. Start in dev mode (auto-restarts on changes)
npm run dev

# 6. Open http://localhost:3000 — register your kingdom and play
```

## REST API

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/register | — | Create account + kingdom |
| POST | /api/auth/login | — | Login, sets cookie |
| POST | /api/auth/logout | — | Clear cookie |
| GET | /api/auth/me | ✓ | Verify token |
| GET | /api/kingdom/me | ✓ | Full kingdom state |
| GET | /api/kingdom/rankings | ✓ | Top 50 by land |
| GET | /api/kingdom/:id | ✓ | Public kingdom view |
| POST | /api/kingdom/turn | ✓ | Advance one turn |
| POST | /api/kingdom/hire | ✓ | Hire units |
| POST | /api/kingdom/research | ✓ | Study a discipline |
| POST | /api/kingdom/build | ✓ | Build structures |
| POST | /api/kingdom/options | ✓ | Set tax / rename |
| GET | /api/kingdom/news/list | ✓ | Get + clear news |
| POST | /api/alliance/create | ✓ | Found alliance |
| POST | /api/alliance/invite | ✓ | Invite member |
| POST | /api/alliance/leave | ✓ | Leave alliance |
| GET | /api/alliance/:id | ✓ | Alliance + members |
| GET | /api/chat/:room | ✓ | Chat history |

## Socket.io events

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `action:attack` | `{ targetId, fighters, mages }` | Launch military attack |
| `action:spell` | `{ targetId, spellId, power, duration, obscure }` | Cast a spell |
| `action:spy` | `{ targetId, units }` | Spy mission |
| `action:loot` | `{ targetId, thieves, lootType }` | Loot operation |
| `action:assassinate` | `{ targetId, ninjas, unitType }` | Assassination |
| `chat:global` | `{ message }` | Global chat message |
| `chat:alliance` | `{ message }` | Alliance chat message |

### Server → Client (push)

| Event | Description |
|---|---|
| `event:attack_received` | You were attacked — includes report |
| `event:spell_received` | A spell hit your kingdom |
| `event:covert` | Covert op against your kingdom |
| `event:alliance_flare` | Alliance member under attack |
| `chat:message` | New chat message (global or alliance) |
| `unread_news` | Unread news count on connect |

## Deployment

For production (e.g. Railway, Render, Fly.io):

1. Set `NODE_ENV=production` and a strong `JWT_SECRET`
2. `npm start`
3. SQLite `narmir.db` persists in the project root — mount a volume if using containers

For multiple servers / horizontal scaling, replace better-sqlite3 with PostgreSQL and use Socket.io Redis adapter.
