import { createServer } from 'http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom, codeRegistry } from './rooms/GameRoom.js';

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

// Keep-warm / uptime probe (used by the keepalive workflow + Render health check).
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Resolve a private room code -> roomId so the client can joinById().
app.get('/api/room/:code', (req, res) => {
  const roomId = codeRegistry.get(String(req.params.code || '').toUpperCase());
  if (!roomId) return res.status(404).json({ error: 'not-found' });
  res.json({ roomId });
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: createServer(app) }),
});

gameServer.define('game', GameRoom);

gameServer.listen(port)
  .then(() => console.log(`[nexus-grid] server listening on :${port}`))
  .catch((e) => { console.error(e); process.exit(1); });
