import { Room } from 'colyseus';
// Single source of truth: the server validates moves with the SAME pure logic
// the client uses. A client literally cannot apply an illegal move.
import { createInitialState, makeMove } from '../../src/game/gameLogic.js';

// code -> roomId registry for private rooms (single instance / Render free tier).
export const codeRegistry = new Map();

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  return Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
}
function clampGrid(n) {
  n = parseInt(n, 10);
  return [4, 5, 6, 7].includes(n) ? n : 5;
}
function cleanName(s, fallback) {
  return (s ? String(s) : fallback).slice(0, 16).toUpperCase() || fallback;
}

export class GameRoom extends Room {
  maxClients = 2;

  onCreate(options) {
    this.isPrivate = options?.mode === 'private';
    // Quick match uses a fixed standard grid so ranked stays fair later.
    const gridSize = options?.mode === 'quick' ? 5 : clampGrid(options?.gridSize);
    this.config = { gridSize, mode: 'classic', vsAI: false };

    this.gameState = createInitialState(this.config);
    this.names = { 1: '', 2: '' };
    this.seats = {};            // sessionId -> playerNumber (1|2)
    this.gameStatus = 'waiting';
    this.abandonedBy = null;
    this.code = '';

    if (this.isPrivate) {
      let code = genCode(), tries = 0;
      while (codeRegistry.has(code) && tries++ < 20) code = genCode();
      this.code = code;
      codeRegistry.set(code, this.roomId);
      this.setPrivate(true); // keep out of quick-match pool
    }

    this.onMessage('move', (client, msg) => this.handleMove(client, msg));
    this.onMessage('rematch', (client) => this.handleRematch(client));
  }

  onJoin(client, options) {
    const playerNumber = Object.keys(this.seats).length + 1; // first=1, second=2
    this.seats[client.sessionId] = playerNumber;
    this.names[playerNumber] = cleanName(options?.name, `PLAYER ${playerNumber}`);

    client.send('welcome', { you: playerNumber, code: this.code });

    if (Object.keys(this.seats).length >= 2) {
      this.gameStatus = 'playing';
      this.abandonedBy = null;
      this.lock();
    }
    this.sync();
  }

  handleMove(client, msg) {
    if (this.gameStatus !== 'playing') return;
    const pn = this.seats[client.sessionId];
    if (!pn) return;
    // Anti-cheat: must be your turn...
    if (this.gameState.currentPlayer !== pn) {
      client.send('rejected', { reason: 'not-your-turn' });
      return;
    }
    // ...and the move must be legal per the authoritative game logic.
    const next = makeMove(this.gameState, msg?.lineType, msg?.row | 0, msg?.col | 0);
    if (next === this.gameState) {
      client.send('rejected', { reason: 'illegal-move' });
      return;
    }
    this.gameState = next;
    if (next.status === 'finished') this.gameStatus = 'finished';
    this.sync();
  }

  handleRematch(client) {
    if (this.seats[client.sessionId] !== 1) return;        // host only
    if (Object.keys(this.seats).length < 2) return;        // need both players
    this.gameState = createInitialState(this.config);
    this.gameStatus = 'playing';
    this.abandonedBy = null;
    this.sync();
  }

  async onLeave(client, consented) {
    const pn = this.seats[client.sessionId];
    if (consented) {
      delete this.seats[client.sessionId];
      this.markAbandoned(pn);
      return;
    }
    try {
      // Grace period for flaky mobile connections.
      await this.allowReconnection(client, 20);
      // reconnected — seat preserved, nothing to do
    } catch {
      delete this.seats[client.sessionId];
      this.markAbandoned(pn);
    }
  }

  markAbandoned(pn) {
    if (this.gameStatus === 'finished') return;
    this.gameStatus = 'abandoned';
    this.abandonedBy = pn || null;
    this.sync();
  }

  onDispose() {
    if (this.code) codeRegistry.delete(this.code);
  }

  snapshot() {
    return {
      code: this.code,
      status: this.gameStatus,
      names: this.names,
      abandonedBy: this.abandonedBy,
      state: this.gameState,
    };
  }
  sync() { this.broadcast('sync', this.snapshot()); }
}
