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
  ranked = false; // overridden by RankedRoom

  onCreate(options) {
    this.isPrivate = options?.mode === 'private';
    // Quick/ranked use a fixed standard grid so ranked stays fair.
    const gridSize = (options?.mode === 'quick' || this.ranked) ? 5 : clampGrid(options?.gridSize);
    this.config = { gridSize, mode: 'classic', vsAI: false };

    this.gameState = createInitialState(this.config);
    this.names = { 1: '', 2: '' };
    this.players = {};          // playerNumber -> account row (ranked only)
    this.seats = {};            // sessionId -> playerNumber (1|2)
    this.gameStatus = 'waiting';
    this.abandonedBy = null;
    this.recorded = false;
    this.lastResult = null;     // ranked: { ratings, deltas }
    this.code = '';

    if (this.isPrivate) {
      let code = genCode(), tries = 0;
      while (codeRegistry.has(code) && tries++ < 20) code = genCode();
      this.code = code;
      codeRegistry.set(code, this.roomId);
      this.setPrivate(true);
    }

    this.onMessage('move', (client, msg) => this.handleMove(client, msg));
    this.onMessage('rematch', (client) => this.handleRematch(client));
  }

  async onJoin(client, options) {
    const playerNumber = Object.keys(this.seats).length + 1; // first=1, second=2
    this.seats[client.sessionId] = playerNumber;
    await this.assignPlayer(client, options, playerNumber);

    client.send('welcome', { you: playerNumber, code: this.code, ranked: this.ranked, rating: this.players[playerNumber]?.rating ?? null });

    if (Object.keys(this.seats).length >= 2) {
      this.gameStatus = 'playing';
      this.abandonedBy = null;
      this.lock();
    }
    this.sync();
  }

  // Casual: just a display name. RankedRoom overrides to load the account.
  async assignPlayer(client, options, pn) {
    this.names[pn] = cleanName(options?.name, `PLAYER ${pn}`);
  }

  handleMove(client, msg) {
    if (this.gameStatus !== 'playing') return;
    const pn = this.seats[client.sessionId];
    if (!pn) return;
    if (this.gameState.currentPlayer !== pn) {        // anti-cheat: your turn only
      client.send('rejected', { reason: 'not-your-turn' });
      return;
    }
    const next = makeMove(this.gameState, msg?.lineType, msg?.row | 0, msg?.col | 0); // anti-cheat: legal only
    if (next === this.gameState) {
      client.send('rejected', { reason: 'illegal-move' });
      return;
    }
    this.gameState = next;
    if (next.status === 'finished') {
      this.gameStatus = 'finished';
      this.finalize(next.winner);
    }
    this.sync();
  }

  handleRematch(client) {
    if (this.seats[client.sessionId] !== 1) return;        // host only
    if (Object.keys(this.seats).length < 2) return;
    this.gameState = createInitialState(this.config);
    this.gameStatus = 'playing';
    this.abandonedBy = null;
    this.recorded = false;
    this.lastResult = null;
    this.sync();
  }

  async onLeave(client, consented) {
    const pn = this.seats[client.sessionId];
    if (!consented) {
      try { await this.allowReconnection(client, 20); return; } catch { /* gone */ }
    }
    delete this.seats[client.sessionId];
    // Leaving a ranked game in progress is a loss for the leaver.
    if (this.ranked && this.gameStatus === 'playing' && !this.recorded && this.players[1] && this.players[2]) {
      const winner = pn === 1 ? 2 : 1;
      this.gameStatus = 'finished';
      await this.finalize(winner);
    } else {
      this.markAbandoned(pn);
    }
  }

  markAbandoned(pn) {
    if (this.gameStatus === 'finished') return;
    this.gameStatus = 'abandoned';
    this.abandonedBy = pn || null;
    this.sync();
  }

  // Casual: nothing. RankedRoom overrides to update ratings + broadcast result.
  async finalize(_winner) { this.sync(); }

  onDispose() {
    if (this.code) codeRegistry.delete(this.code);
  }

  snapshot() {
    return {
      code: this.code,
      status: this.gameStatus,
      ranked: this.ranked,
      names: this.names,
      ratings: { 1: this.players[1]?.rating ?? null, 2: this.players[2]?.rating ?? null },
      abandonedBy: this.abandonedBy,
      state: this.gameState,
    };
  }
  sync() { this.broadcast('sync', this.snapshot()); }
}
