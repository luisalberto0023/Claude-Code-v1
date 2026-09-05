# Online multiplayer — setup

Online play uses a small **authoritative game server** (Node + Colyseus). The
server owns each match's state and validates **every move** with the same
`gameLogic.js` the client uses, so illegal/out-of-turn moves are impossible —
the foundation for ranked play and anti-cheat.

```
 phone ─┐                         ┌─ validates moves (gameLogic.js)
 phone ─┤── WebSocket ──► server ─┤── private rooms + quick match
        │   (Colyseus)            └─ broadcasts authoritative state
```

Everything below is **free**. The only later costs are store fees when you
publish (Google Play $25 one-time, Apple $99/year).

## 1. Deploy the server to Render (free)

1. Go to https://render.com → sign up (free) → **New → Blueprint**.
2. Connect this GitHub repo. Render reads **`render.yaml`** and creates the
   `nexus-grid-server` web service (root dir `server/`, free plan).
3. Deploy. When it's live you'll get a URL like
   `https://nexus-grid-server.onrender.com`.
4. Sanity check: open `<that URL>/health` → should return `{"ok":true,...}`.

> Free instances sleep after ~15 min idle. Step 3 below keeps it warm.

## 2. Point the app at the server

Set the URL in **`src/online/serverConfig.js`**:

```js
const FALLBACK = 'https://nexus-grid-server.onrender.com';
```

(or set `VITE_SERVER_URL` at build time). Commit + push — CI rebuilds the web
site and the APK, and **Play Online** activates.

## 3. Keep the free server warm (zero cost)

So matchmaking isn't stuck behind a 30–60s cold start:

- **Built in:** `.github/workflows/keepalive.yml` pings `/health` every ~10 min.
  Add a repo **variable** `GAME_SERVER_URL` = your Render URL
  (Settings → Secrets and variables → Actions → **Variables**).
- **Recommended also:** a free monitor like **UptimeRobot** or **cron-job.org**
  hitting `<URL>/health` every 5 minutes (more reliable than GitHub's scheduler).

## Enable ranked + leaderboard (free Postgres) — Phase 2

Ranked play and the leaderboard need a database. Without one the server still
runs and ranked "works", but ratings reset on restart (in-memory fallback).

1. Create a free Postgres at **https://neon.tech** (or Supabase). Copy the
   connection string (looks like `postgresql://user:pass@host/db?sslmode=require`).
2. In **Render → your service → Environment**, add:
   `DATABASE_URL = <that connection string>`
3. Save → Render redeploys. On boot the server logs `[db] Postgres connected`
   and auto-creates the `players` and `matches` tables. Ratings now persist.

That's it — **Ranked** matches update ELO and the **Leaderboard** shows the
global Top 100 (and your rank).

## How to play

- **Quick match:** auto-pairs you with another waiting player (standard 4×4).
- **Create:** pick a grid, get a 4-letter code, share it.
- **Join:** enter a friend's code.

Host is Player 1 (cyan), guest is Player 2 (crimson). The board only accepts
input on your turn; the server rejects anything else.

## Local development

```bash
cd server && npm install && npm start      # server on :2567
# in serverConfig.js set FALLBACK = 'http://localhost:2567'
npm run dev                                 # web client (repo root)
```

Integration test (server must be running):

```bash
node server/test-playtest.mjs
```

## Scope / roadmap

- **Phase 1 (done):** authoritative server, private rooms + quick match,
  server-side validation. *Classic mode, 2 players.*
- **Phase 2 (done):** device accounts, ELO ranked queue, leaderboard (Postgres
  on a free tier such as Neon/Supabase — see the setup section above).
- **Phase 3:** Play Store (signed AAB) + iOS App Store (Capacitor iOS via a
  cloud-Mac build + TestFlight).

## Notes / limits

- v1 is **client-account-less** (display name only). Real sign-in comes with
  ranked in Phase 2 to keep the leaderboard honest.
- Online needs the **hosted site or the APK** — not the single-file
  `nexus-grid.html` (which is for offline local play; its online button is
  hidden).
