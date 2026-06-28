/* Data layer for accounts, ranked ratings, and the leaderboard.

   Uses Postgres when DATABASE_URL is set (e.g. Neon); otherwise falls back to
   an in-memory store so the server runs (and is testable) before a database is
   connected. The in-memory data is non-persistent — restart clears it. */

import { randomUUID } from 'crypto';
import { computeElo } from './elo.js';

const START_RATING = 1000;
const hasPg = !!process.env.DATABASE_URL;

let pool = null;
let mem = null; // in-memory fallback: Map<token, player>

export async function initDb() {
  if (hasPg) {
    const pg = await import('pg');
    pool = new pg.default.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon/managed PG
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        rating INT NOT NULL DEFAULT ${START_RATING},
        wins INT NOT NULL DEFAULT 0,
        losses INT NOT NULL DEFAULT 0,
        draws INT NOT NULL DEFAULT 0,
        games INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        p1 INT NOT NULL,
        p2 INT NOT NULL,
        winner INT,                     -- 1, 2, or NULL for draw
        p1_before INT, p2_before INT,
        p1_after INT,  p2_after INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS players_rating_idx ON players (rating DESC);
    `);
    console.log('[db] Postgres connected');
  } else {
    mem = new Map();
    console.log('[db] no DATABASE_URL — using in-memory store (non-persistent)');
  }
}

function cleanName(name, fallback) {
  return (name ? String(name) : fallback).slice(0, 16).toUpperCase() || fallback;
}

export async function getOrCreatePlayer({ token, name }) {
  const safeName = cleanName(name, 'PLAYER');
  if (hasPg) {
    if (token) {
      const found = await pool.query('SELECT * FROM players WHERE token=$1', [token]);
      if (found.rows[0]) {
        if (name) await pool.query('UPDATE players SET name=$1, updated_at=now() WHERE token=$2', [safeName, token]);
        return found.rows[0].name === safeName ? found.rows[0] : { ...found.rows[0], name: safeName };
      }
    }
    const newToken = token || randomUUID();
    const ins = await pool.query(
      'INSERT INTO players (token, name) VALUES ($1,$2) ON CONFLICT (token) DO UPDATE SET name=EXCLUDED.name RETURNING *',
      [newToken, safeName],
    );
    return ins.rows[0];
  }
  // in-memory
  if (token && mem.has(token)) {
    const p = mem.get(token);
    if (name) p.name = safeName;
    return p;
  }
  const newToken = token || randomUUID();
  const p = { id: mem.size + 1, token: newToken, name: safeName, rating: START_RATING, wins: 0, losses: 0, draws: 0, games: 0 };
  mem.set(newToken, p);
  return p;
}

export async function getByToken(token) {
  if (!token) return null;
  if (hasPg) return (await pool.query('SELECT * FROM players WHERE token=$1', [token])).rows[0] || null;
  return mem.get(token) || null;
}

// winner: 1, 2, or 'draw'. p1/p2 are player rows (need id + rating).
export async function recordRankedResult(p1, p2, winner) {
  const scoreP1 = winner === 'draw' ? 0.5 : winner === 1 ? 1 : 0;
  const { newA, newB, deltaA, deltaB } = computeElo(p1.rating, p2.rating, scoreP1);

  const p1w = winner === 1 ? 1 : 0, p1l = winner === 2 ? 1 : 0;
  const p2w = winner === 2 ? 1 : 0, p2l = winner === 1 ? 1 : 0;
  const dr = winner === 'draw' ? 1 : 0;

  if (hasPg) {
    await pool.query('UPDATE players SET rating=$1, wins=wins+$2, losses=losses+$3, draws=draws+$4, games=games+1, updated_at=now() WHERE id=$5',
      [newA, p1w, p1l, dr, p1.id]);
    await pool.query('UPDATE players SET rating=$1, wins=wins+$2, losses=losses+$3, draws=draws+$4, games=games+1, updated_at=now() WHERE id=$5',
      [newB, p2w, p2l, dr, p2.id]);
    await pool.query('INSERT INTO matches (p1,p2,winner,p1_before,p2_before,p1_after,p2_after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [p1.id, p2.id, winner === 'draw' ? null : winner, p1.rating, p2.rating, newA, newB]);
  } else {
    const a = mem.get(p1.token), b = mem.get(p2.token);
    if (a) { a.rating = newA; a.wins += p1w; a.losses += p1l; a.draws += dr; a.games += 1; }
    if (b) { b.rating = newB; b.wins += p2w; b.losses += p2l; b.draws += dr; b.games += 1; }
  }
  return { ratings: { 1: newA, 2: newB }, deltas: { 1: deltaA, 2: deltaB } };
}

export async function leaderboard(limit = 100) {
  if (hasPg) {
    const r = await pool.query(
      'SELECT name, rating, wins, losses, draws, games FROM players WHERE games > 0 ORDER BY rating DESC, wins DESC LIMIT $1',
      [limit],
    );
    return r.rows;
  }
  return [...mem.values()].filter(p => p.games > 0)
    .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
    .slice(0, limit)
    .map(({ name, rating, wins, losses, draws, games }) => ({ name, rating, wins, losses, draws, games }));
}

export async function rankOf(token) {
  const me = await getByToken(token);
  if (!me || me.games === 0) return null;
  if (hasPg) {
    const r = await pool.query('SELECT count(*)::int AS c FROM players WHERE games>0 AND (rating>$1 OR (rating=$1 AND wins>$2))', [me.rating, me.wins]);
    return { rank: r.rows[0].c + 1, name: me.name, rating: me.rating, wins: me.wins, losses: me.losses, draws: me.draws };
  }
  const higher = [...mem.values()].filter(p => p.games > 0 && (p.rating > me.rating || (p.rating === me.rating && p.wins > me.wins))).length;
  return { rank: higher + 1, name: me.name, rating: me.rating, wins: me.wins, losses: me.losses, draws: me.draws };
}
