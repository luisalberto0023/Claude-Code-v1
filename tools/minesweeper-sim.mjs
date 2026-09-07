#!/usr/bin/env node
// Play Minesweeper against a simulated board to measure the solver on its own,
// with nothing to do with reading a screen.
//
//   node tools/minesweeper-sim.mjs [--level beginner|intermediate|expert] [--games 200]
//
// Mines are placed after the first click and never under it, which is what
// minesweeper.online does — so an opening move cannot lose, and the win rates
// here are comparable with the ones quoted for other solvers.

import { solve, UNKNOWN, FLAG } from "../src/plugins/minesweeper-solver.js";

const LEVELS = {
  beginner:     { rows: 9,  cols: 9,  mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert:       { rows: 16, cols: 30, mines: 99 },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const level = arg("level", "beginner");
const GAMES = Number(arg("games", 200));
const cfg = LEVELS[level];
if (!cfg) { console.error(`Unknown level "${level}"`); process.exit(1); }

function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const around = (r, c, rows, cols) => {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) out.push([nr, nc]);
  }
  return out;
};

function play(seed) {
  const { rows, cols, mines } = cfg;
  const rand = rng(seed);
  let layout = null;                       // placed on the first click
  const view = Array.from({ length: rows }, () => new Array(cols).fill(UNKNOWN));
  let openedCount = 0, guesses = 0, firstGuessLost = false;

  const place = (sr, sc) => {
    const safe = new Set([sr * cols + sc, ...around(sr, sc, rows, cols).map(([r, c]) => r * cols + c)]);
    const spots = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!safe.has(r * cols + c)) spots.push([r, c]);
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (const [r, c] of spots.slice(0, mines)) grid[r][c] = -1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (grid[r][c] === -1) continue;
      grid[r][c] = around(r, c, rows, cols).filter(([nr, nc]) => grid[nr][nc] === -1).length;
    }
    return grid;
  };

  // Opening a blank square cascades, exactly as the game does.
  const open = (r, c) => {
    if (view[r][c] !== UNKNOWN) return true;
    if (layout[r][c] === -1) return false;
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      if (view[cr][cc] !== UNKNOWN) continue;
      view[cr][cc] = layout[cr][cc];
      openedCount++;
      if (layout[cr][cc] === 0) for (const [nr, nc] of around(cr, cc, rows, cols)) {
        if (view[nr][nc] === UNKNOWN) stack.push([nr, nc]);
      }
    }
    return true;
  };

  const target = rows * cols - mines;
  for (let step = 0; step < rows * cols * 4; step++) {
    if (openedCount >= target) return { won: true, guesses, openedCount, firstGuessLost };
    const { actions, certain } = solve(view, mines);
    if (!actions.length) return { won: false, stalled: true, guesses, openedCount, firstGuessLost };
    if (!certain) guesses++;
    for (const a of actions) {
      if (a.type === "flag") { view[a.r][a.c] = FLAG; continue; }
      if (!layout) layout = place(a.r, a.c);            // first click is always safe
      if (!open(a.r, a.c)) {
        return { won: false, guesses, openedCount, firstGuessLost: guesses <= 1 };
      }
      if (openedCount >= target) return { won: true, guesses, openedCount, firstGuessLost };
    }
  }
  return { won: false, stalled: true, guesses, openedCount, firstGuessLost };
}

const t0 = Date.now();
const results = [];
for (let i = 0; i < GAMES; i++) results.push(play(1000 + i));
const wins = results.filter(r => r.won).length;
const stalled = results.filter(r => r.stalled).length;
const avgGuesses = (results.reduce((a, r) => a + r.guesses, 0) / GAMES).toFixed(2);
const cleared = (results.reduce((a, r) => a + r.openedCount, 0) / GAMES /
  (cfg.rows * cfg.cols - cfg.mines) * 100).toFixed(1);

console.log(`${level}: ${cfg.rows}x${cfg.cols}, ${cfg.mines} mines — ${GAMES} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  won            ${wins}/${GAMES}  (${(100 * wins / GAMES).toFixed(1)}%)`);
console.log(`  board cleared  ${cleared}% on average`);
console.log(`  guesses/game   ${avgGuesses}`);
if (stalled) console.log(`  stalled        ${stalled}  <- solver returned no move; should be 0`);
