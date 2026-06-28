import { createServer } from 'http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom, codeRegistry } from './rooms/GameRoom.js';
import { RankedRoom } from './rooms/RankedRoom.js';
import { initDb, getOrCreatePlayer, leaderboard, rankOf } from './db.js';

const port = Number(process.env.PORT) || 2567;

const app = express();
app.use(express.json());

// Allow the web client (GitHub Pages) and the APK to call the REST endpoints.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Resolve a private room code -> roomId so the client can joinById().
app.get('/api/room/:code', (req, res) => {
  const roomId = codeRegistry.get(String(req.params.code || '').toUpperCase());
  if (!roomId) return res.status(404).json({ error: 'not-found' });
  res.json({ roomId });
});

// Create/refresh a device account; returns the persistent token + stats.
app.post('/api/account', async (req, res) => {
  try {
    const { token, name } = req.body || {};
    const p = await getOrCreatePlayer({ token, name });
    res.json({ token: p.token, id: p.id, name: p.name, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws, games: p.games });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'server-error' });
  }
});

// Global top 100 + the caller's own rank (if ?token= is supplied).
app.get('/api/leaderboard', async (req, res) => {
  try {
    const top = await leaderboard(100);
    const me = req.query.token ? await rankOf(String(req.query.token)) : null;
    res.json({ top, me });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'server-error' });
  }
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: createServer(app) }),
});

gameServer.define('game', GameRoom);     // casual: private rooms + quick match
gameServer.define('ranked', RankedRoom); // ranked: ELO + leaderboard

await initDb();
gameServer.listen(port)
  .then(() => console.log(`[nexus-grid] server listening on :${port}`))
  .catch((e) => { console.error(e); process.exit(1); });
