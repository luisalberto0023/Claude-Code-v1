// ── Minesweeper, the game itself ──────────────────────────────────────────────
//
// A local Minesweeper for the agent to play, served by the dev server at
// http://localhost:5173/bench/minesweeper/. It replaces minesweeper.online as the
// Minesweeper test bed: that site's rules call any program that clicks on a
// board or helps solve it cheating, and it keeps public rankings that real
// players compete on (see src/agent/sitePolicy.js). A page of our own can be
// played unattended for as long as a test needs, reset at will, and replayed
// board for board.
//
// Written for this project, with no code taken from any other Minesweeper. This
// file is the rules only, with no page and no pixels, so the checks can play it
// in node (tools/check-bench.mjs); draw.js turns a game into pixels and main.js
// wires both to the page.
//
// The rules are the ones tools/minesweeper-sim.mjs measures the solver under:
// mines are placed at the first click, never on the square clicked or next to
// it, so the first click always opens an area and never loses. A board is fixed
// by its seed and that first click, so the same seed played the same way gives
// the same game.

export const LEVELS = Object.freeze({
  beginner:     Object.freeze({ key: "beginner",     rows: 9,  cols: 9,  mines: 10, label: "Beginner" }),
  intermediate: Object.freeze({ key: "intermediate", rows: 16, cols: 16, mines: 40, label: "Intermediate" }),
  expert:       Object.freeze({ key: "expert",       rows: 16, cols: 30, mines: 99, label: "Expert" }),
});

// Expert is what the agent was tested on, and what the real captures in
// tools/frames show.
export const DEFAULT_LEVEL = "expert";

// The timer stops here, as the classic one does.
export const MAX_SECONDS = 999;

/** The level called `name`, or the default one. */
export function levelFrom(name) {
  const key = String(name ?? "").trim().toLowerCase();
  return LEVELS[key] ?? LEVELS[DEFAULT_LEVEL];
}

/**
 * The seed `?seed=` asks for, as an unsigned 32-bit number, or null for none.
 * A whole number from 0 to 4294967295 is used as it is; any other text is
 * hashed, so `?seed=monday` works too and always means the same board.
 */
export function seedFrom(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{1,10}$/.test(text) && Number(text) <= 0xffffffff) return Number(text);
  let h = 0x811c9dc5;                              // FNV-1a
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h;
}

/** A seed for a board nobody asked for by number. */
export function randomSeed() {
  const c = globalThis.crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * The seed of the game after the one played with `seed`. A session of several
 * games on `?seed=N` plays N, N+1, N+2 …, so the whole session can be run again
 * and no two of its games are the same board.
 */
export function nextSeed(seed) {
  return ((seed >>> 0) + 1) >>> 0;
}

// The same generator tools/minesweeper-sim.mjs uses (mulberry32).
function generator(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function around(game, i) {
  const r = Math.floor(i / game.cols), c = i % game.cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nc >= 0 && nr < game.rows && nc < game.cols) out.push(nr * game.cols + nc);
    }
  }
  return out;
}

function withCounts(game, mine) {
  game.mine = mine;
  game.count = new Uint8Array(game.rows * game.cols);
  for (let i = 0; i < mine.length; i++) {
    if (!mine[i]) game.count[i] = around(game, i).filter(j => mine[j]).length;
  }
  return game;
}

/** A new game, mines not yet placed: they go down at the first click. */
export function newGame(level = DEFAULT_LEVEL, seed = randomSeed()) {
  const lv = typeof level === "string" ? levelFrom(level) : level;
  const cells = lv.rows * lv.cols;
  return {
    level: lv.key ?? null, label: lv.label ?? `${lv.rows}×${lv.cols}`,
    rows: lv.rows, cols: lv.cols, mines: lv.mines, seed: seed >>> 0,
    mine: null, count: null,
    open: new Uint8Array(cells), flag: new Uint8Array(cells),
    status: "ready",                 // ready → playing → won | lost
    opened: 0, flags: 0, exploded: -1,
    startedAt: null, endedAt: null,
  };
}

/**
 * A game on a board chosen square by square, for the checks: `mines` lists
 * [row, col] for each mine. The first click does not move them.
 */
export function gameWithMines({ rows, cols }, mines, seed = 0) {
  const game = newGame({ key: null, rows, cols, mines: 0 }, seed);
  const mine = new Uint8Array(rows * cols);
  for (const [r, c] of mines) mine[r * cols + c] = 1;
  game.mines = mine.reduce((a, b) => a + b, 0);
  return withCounts(game, mine);
}

// Mines everywhere but the first square and its neighbours, drawn by the seed.
// A board too full to leave the neighbours free keeps only the square itself.
function placeMines(game, first) {
  const cells = game.rows * game.cols;
  let safe = new Set([first, ...around(game, first)]);
  if (cells - safe.size < game.mines) safe = new Set([first]);
  const spots = [];
  for (let i = 0; i < cells; i++) if (!safe.has(i)) spots.push(i);
  const rand = generator(game.seed);
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  const mine = new Uint8Array(cells);
  for (const i of spots.slice(0, game.mines)) mine[i] = 1;
  withCounts(game, mine);
}

const playable = game => game.status === "ready" || game.status === "playing";
const index = (game, r, c) =>
  (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < game.rows && c < game.cols)
    ? r * game.cols + c : -1;

function finish(game, status, now) {
  game.status = status;
  game.endedAt = now;
  // A won board shows every mine flagged, as the classic game does.
  if (status === "won") {
    for (let i = 0; i < game.mine.length; i++) {
      if (game.mine[i] && !game.flag[i]) { game.flag[i] = 1; game.flags++; }
    }
  }
}

/**
 * Open the square at row `r`, column `c`, as a left click does. An empty square
 * opens its neighbours too. Returns whether anything changed.
 */
export function reveal(game, r, c, now = Date.now()) {
  const i = index(game, r, c);
  if (i < 0 || !playable(game) || game.open[i] || game.flag[i]) return false;
  if (!game.mine) placeMines(game, i);
  if (game.status === "ready") { game.status = "playing"; game.startedAt = now; }
  if (game.mine[i]) {
    game.exploded = i;
    finish(game, "lost", now);
    return true;
  }
  const stack = [i];
  while (stack.length) {
    const j = stack.pop();
    if (game.open[j] || game.flag[j]) continue;
    game.open[j] = 1;
    game.opened++;
    if (game.count[j] === 0) for (const k of around(game, j)) if (!game.open[k]) stack.push(k);
  }
  if (game.opened === game.rows * game.cols - game.mines) finish(game, "won", now);
  return true;
}

/** Put a flag on a covered square, or take it off, as a right click does. */
export function toggleFlag(game, r, c) {
  const i = index(game, r, c);
  if (i < 0 || !playable(game) || game.open[i]) return false;
  game.flag[i] = game.flag[i] ? 0 : 1;
  game.flags += game.flag[i] ? 1 : -1;
  return true;
}

/**
 * Open every unflagged neighbour of an opened number that has as many flags
 * around it as its number, as a middle click (or both buttons) does. A flag in
 * the wrong place loses the game here, as it does in the classic one.
 */
export function chord(game, r, c, now = Date.now()) {
  const i = index(game, r, c);
  if (i < 0 || !playable(game) || !game.open[i] || !game.count[i]) return false;
  const near = around(game, i);
  if (near.filter(j => game.flag[j]).length !== game.count[i]) return false;
  let changed = false;
  for (const j of near) {
    if (game.open[j] || game.flag[j]) continue;
    changed = reveal(game, Math.floor(j / game.cols), j % game.cols, now) || changed;
    if (!playable(game)) break;
  }
  return changed;
}

/**
 * What the square at `r`, `c` shows:
 *   {kind: "covered"}                 not opened
 *   {kind: "flag"}                    flagged
 *   {kind: "open", n}                 opened, with n mines around it (0 to 8)
 *   {kind: "mine", exploded}          a mine shown once the game is lost;
 *                                     exploded for the one that was opened
 *   {kind: "wrong-flag"}              a flag on a square with no mine, shown
 *                                     once the game is lost
 */
export function cellView(game, r, c) {
  const i = r * game.cols + c;
  const lost = game.status === "lost";
  if (game.open[i]) return { kind: "open", n: game.count[i] };
  if (lost && i === game.exploded) return { kind: "mine", exploded: true };
  if (game.flag[i]) return lost && !game.mine[i] ? { kind: "wrong-flag" } : { kind: "flag" };
  if (lost && game.mine[i]) return { kind: "mine", exploded: false };
  return { kind: "covered" };
}

/** What the mine counter shows: mines not yet flagged (below 0 with too many flags). */
export function minesLeft(game) {
  return game.mines - game.flags;
}

/** What the timer shows: whole seconds since the first click, up to 999. */
export function secondsPlayed(game, now = Date.now()) {
  if (game.startedAt == null) return 0;
  const until = game.endedAt ?? now;
  return Math.min(MAX_SECONDS, Math.max(0, Math.floor((until - game.startedAt) / 1000)));
}
