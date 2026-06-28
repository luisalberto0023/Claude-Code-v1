import { GameRoom } from './GameRoom.js';
import { getOrCreatePlayer, recordRankedResult } from '../db.js';

// Ranked = public quick-match queue with persistent accounts + ELO.
export class RankedRoom extends GameRoom {
  ranked = true;

  onCreate(options) {
    // Force standard public match regardless of incoming options.
    super.onCreate({ mode: 'quick' });
  }

  async assignPlayer(client, options, pn) {
    const account = await getOrCreatePlayer({ token: options?.token, name: options?.name });
    this.players[pn] = account;
    this.names[pn] = account.name;
  }

  async finalize(winner) {
    if (this.recorded) return;
    if (!this.players[1] || !this.players[2]) { this.sync(); return; }
    this.recorded = true;
    try {
      const result = await recordRankedResult(this.players[1], this.players[2], winner);
      this.players[1].rating = result.ratings[1];
      this.players[2].rating = result.ratings[2];
      this.lastResult = result;
      this.broadcast('ranked_result', { winner, ratings: result.ratings, deltas: result.deltas });
    } catch (e) {
      console.error('[ranked] failed to record result:', e?.message || e);
    }
    this.sync();
  }
}
