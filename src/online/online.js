/* Client transport for online play — talks to the authoritative Colyseus
   server. The server owns game state and validates every move, so this layer
   just opens rooms and relays input/state.

   colyseus.js is imported dynamically so single-player stays lean and offline. */

import { serverUrl } from './serverConfig.js';

let _client = null;
async function getClient() {
  if (_client) return _client;
  const { Client } = await import('colyseus.js');
  _client = new Client(serverUrl());
  return _client;
}

// Host a private match → returns the joined Room (its code arrives via the
// server's "welcome" message).
export async function createPrivate(config, name) {
  const c = await getClient();
  return c.create('game', { mode: 'private', gridSize: config.gridSize, name });
}

// Auto-pair with another waiting player (casual).
export async function quickMatch(name) {
  const c = await getClient();
  return c.joinOrCreate('game', { mode: 'quick', name });
}

// Ranked queue — ELO + leaderboard. Requires an account token.
export async function rankedMatch(token, name) {
  const c = await getClient();
  return c.joinOrCreate('ranked', { token, name });
}

// Join a private match by its 4-character code.
export async function joinByCode(rawCode, name) {
  const code = (rawCode || '').trim().toUpperCase();
  if (code.length !== 4) throw new Error('Enter the 4-character room code.');
  const res = await fetch(`${serverUrl()}/api/room/${encodeURIComponent(code)}`);
  if (res.status === 404) throw new Error('Room not found. Check the code.');
  if (!res.ok) throw new Error('Could not reach the server.');
  const { roomId } = await res.json();
  const c = await getClient();
  return c.joinById(roomId, { name });
}
