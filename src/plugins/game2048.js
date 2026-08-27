// ── 2048 game plugin ──────────────────────────────────────────────────────────
// Deterministic perception + policy for 2048.
//
// Why this exists: a small local vision model cannot reliably read a 4x4 grid of
// numbers from a screenshot — in testing it hallucinated board contents and even
// invented scores. But every 2048 tile has a unique flat background colour, so
// the board can be read from pixels exactly, with no model and no tokens. Once
// the true board is known, an expectimax search picks a far better move than any
// small model would.
//
// This is the "plugin" shape other games can follow:
//   match(gameDesc)            -> is this plugin for the current game?
//   readState(canvas)          -> structured state, or null if not confident
//   chooseMove(state)          -> { key, reason }
//   isTerminal(state)          -> no legal moves left
//   describeState(state)       -> short text for logs / the model

// Official play2048.co palette. JPEG compression shifts these slightly, so
// matching is nearest-colour with a distance cutoff rather than exact equality.
const TILE_COLORS = [
  { v: 0,     rgb: [205, 193, 180] }, // empty cell
  { v: 2,     rgb: [238, 228, 218] },
  { v: 4,     rgb: [237, 224, 200] },
  { v: 8,     rgb: [242, 177, 121] },
  { v: 16,    rgb: [245, 149, 99] },
  { v: 32,    rgb: [246, 124, 95] },
  { v: 64,    rgb: [246, 94, 59] },
  { v: 128,   rgb: [237, 207, 114] },
  { v: 256,   rgb: [237, 204, 97] },
  { v: 512,   rgb: [237, 200, 80] },
  { v: 1024,  rgb: [237, 197, 63] },
  { v: 2048,  rgb: [237, 194, 46] },
  { v: 4096,  rgb: [60, 58, 50] },    // "super" tiles share a dark colour
];
const BOARD_BG = [187, 173, 160];
const BUTTON_BG = [143, 122, 102]; // "New Game" / "Try again" button

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

// Clones of 2048 use slightly different palettes (2048.org is noticeably more
// pastel than play2048.co), and JPEG compression shifts colours further, so
// matching is deliberately tolerant. 6000 in squared-RGB terms is about 45 per
// channel — wide enough for a re-skinned clone, still far narrower than the gap
// between adjacent tile colours.
function nearestTile(rgb, maxDist = 6000) {
  let best = null, bestD = Infinity;
  for (const t of TILE_COLORS) {
    const d = dist2(rgb, t.rgb);
    if (d < bestD) { bestD = d; best = t; }
  }
  return bestD <= maxDist ? best.v : null;
}

function nearestTileInfo(rgb) {
  let best = null, bestD = Infinity;
  for (const t of TILE_COLORS) {
    const d = dist2(rgb, t.rgb);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { v: best.v, dist: Math.round(Math.sqrt(bestD)) };
}

// Locate the board by finding the bounding box of the board's background colour.
// Returns null when too few matching pixels are found (board not on screen).
function findBoardRect(data, w, h, tol = 2500) {
  let minX = w, minY = h, maxX = -1, maxY = -1, hits = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 240)); // subsample for speed
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (dist2([data[i], data[i + 1], data[i + 2]], BOARD_BG) <= tol) {
        hits++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (hits < 40 || maxX <= minX || maxY <= minY) return null;
  const bw = maxX - minX, bh = maxY - minY;
  // The 2048 board is square; reject wildly non-square regions (usually a false
  // positive on page background rather than the board itself).
  const ratio = bw / bh;
  if (ratio < 0.7 || ratio > 1.4) return null;
  if (bw < 60 || bh < 60) return null;
  return { x: minX, y: minY, w: bw, h: bh };
}

/**
 * Diagnose why a read failed, using the actual pixels on screen.
 * Colours vary between 2048 clones and cannot be guessed reliably, so this
 * reports what is really there instead: the detected board and the measured RGB
 * of every cell with its closest known tile and distance.
 */
export function diagnose(canvasEl) {
  const out = { ok: false, notes: [] };
  if (!canvasEl || !canvasEl.width) { out.notes.push("no canvas / zero size"); return out; }
  const w = canvasEl.width, h = canvasEl.height;
  out.canvas = `${w}×${h}`;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch (e) { out.notes.push("getImageData failed: " + e.message); return out; }

  // Which colours actually dominate the image? Useful when nothing matches.
  const buckets = new Map();
  const st = Math.max(1, Math.floor(Math.min(w, h) / 120));
  for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
    const i = (y * w + x) * 4;
    const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  out.topColors = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => {
      const [r, g, b] = k.split(",").map(Number);
      return `rgb(${r * 16},${g * 16},${b * 16})×${n}`;
    });

  // Try progressively looser board detection so we can tell "not found at all"
  // from "found only with a loose tolerance".
  let rect = null, usedTol = null;
  for (const tol of [900, 2500, 6000, 12000]) {
    rect = findBoardRect(data, w, h, tol);
    if (rect) { usedTol = tol; break; }
  }
  if (!rect) {
    out.notes.push(`board background rgb(${BOARD_BG}) not found even at loose tolerance — the site's palette likely differs`);
    return out;
  }
  out.rect = rect;
  out.boardTolerance = usedTol;

  const cw = rect.w / 4, ch = rect.h / 4;
  const cells = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const px = Math.round(rect.x + cw * (c + 0.5));
      const py = Math.round(rect.y + ch * (r + 0.5));
      const i = (py * w + px) * 4;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const near = nearestTileInfo(rgb);
      cells.push(`r${r}c${c} rgb(${rgb}) → ${near.v} (off by ${near.dist})`);
    }
  }
  out.cells = cells;
  const st2 = readState(canvasEl);
  out.ok = !!st2;
  if (st2) out.board = st2.board;
  else out.notes.push("cells found but too many were unreadable");
  return out;
}

/**
 * Locate the restart control ("New Game" / "Try again") by its button colour.
 * Deterministic, so restarting needs no model call and no click-grid.
 */
export function findRestartButton(canvasEl) {
  if (!canvasEl || !canvasEl.width) return null;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return null; }

  // Collect pixels close to the button colour, then group them into blobs by
  // scanning rows — the buttons are solid rectangles of one colour.
  const step = Math.max(1, Math.floor(Math.min(w, h) / 300));
  const pts = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (dist2([data[i], data[i + 1], data[i + 2]], BUTTON_BG) <= 2500) pts.push([x, y]);
    }
  }
  if (pts.length < 20) return null;

  // Cluster loosely: bucket by rounded position and keep the densest region.
  const clusters = [];
  for (const [x, y] of pts) {
    let placed = false;
    for (const cl of clusters) {
      if (x >= cl.minX - 40 && x <= cl.maxX + 40 && y >= cl.minY - 25 && y <= cl.maxY + 25) {
        cl.minX = Math.min(cl.minX, x); cl.maxX = Math.max(cl.maxX, x);
        cl.minY = Math.min(cl.minY, y); cl.maxY = Math.max(cl.maxY, y);
        cl.n++; placed = true; break;
      }
    }
    if (!placed) clusters.push({ minX: x, maxX: x, minY: y, maxY: y, n: 1 });
  }
  const good = clusters.filter(c => c.n >= 15 && (c.maxX - c.minX) > 30 && (c.maxY - c.minY) > 10);
  if (!good.length) return null;
  // Prefer the lowest one on screen: "Try again" sits below "New Game" when a
  // game-over overlay is showing, and it is the one we want.
  good.sort((a, b) => (b.minY - a.minY) || (b.n - a.n));
  const c = good[0];
  return { x: Math.round((c.minX + c.maxX) / 2), y: Math.round((c.minY + c.maxY) / 2) };
}

// Read one cell by sampling several points and taking the most common tile
// colour. Sampling many points steps over the digits printed on the tile.
function readCell(data, w, h, cx, cy, cw, ch) {
  const votes = new Map();
  const inset = 0.30; // stay inside the cell, away from gaps and rounded corners
  for (let sy = 0; sy < 5; sy++) {
    for (let sx = 0; sx < 5; sx++) {
      const px = Math.round(cx + cw * (inset + (1 - 2 * inset) * (sx / 4)));
      const py = Math.round(cy + ch * (inset + (1 - 2 * inset) * (sy / 4)));
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      const v = nearestTile([data[i], data[i + 1], data[i + 2]]);
      if (v === null) continue; // digit pixel or unknown — ignore
      votes.set(v, (votes.get(v) ?? 0) + 1);
    }
  }
  if (!votes.size) return null;
  let bestV = null, bestN = 0;
  for (const [v, n] of votes) if (n > bestN) { bestN = n; bestV = v; }
  // Require a clear majority so a half-animated tile doesn't produce a wrong read
  return bestN >= 6 ? bestV : null;
}

/**
 * Read the 2048 board from a canvas.
 * Returns { board, rect } or null when the board can't be read confidently.
 */
export function readState(canvasEl) {
  if (!canvasEl || !canvasEl.width || !canvasEl.height) return null;
  const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
  const w = canvasEl.width, h = canvasEl.height;
  let img;
  try { img = ctx.getImageData(0, 0, w, h); } catch { return null; }
  const data = img.data;

  const rect = findBoardRect(data, w, h);
  if (!rect) return null;

  const cw = rect.w / 4, ch = rect.h / 4;
  const board = [];
  let unread = 0;
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const v = readCell(data, w, h, rect.x + c * cw, rect.y + r * ch, cw, ch);
      if (v === null) { unread++; row.push(0); } else row.push(v);
    }
    board.push(row);
  }
  // A couple of unreadable cells is tolerable (mid-animation); more means the
  // read is not trustworthy and the caller should fall back.
  if (unread > 2) return null;
  return { board, rect };
}

// ── Game mechanics ────────────────────────────────────────────────────────────

const DIRS = ["up", "down", "left", "right"];

function cloneBoard(b) { return b.map(r => r.slice()); }

// Collapse one line toward index 0. Returns { line, gained }.
function collapse(line) {
  const nums = line.filter(v => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < nums.length; i++) {
    if (i + 1 < nums.length && nums[i] === nums[i + 1]) {
      const merged = nums[i] * 2;
      out.push(merged);
      gained += merged;
      i++;
    } else out.push(nums[i]);
  }
  while (out.length < 4) out.push(0);
  return { line: out, gained };
}

function getLine(b, dir, idx) {
  const line = [];
  for (let k = 0; k < 4; k++) {
    if (dir === "left") line.push(b[idx][k]);
    else if (dir === "right") line.push(b[idx][3 - k]);
    else if (dir === "up") line.push(b[k][idx]);
    else line.push(b[3 - k][idx]);
  }
  return line;
}

function setLine(b, dir, idx, line) {
  for (let k = 0; k < 4; k++) {
    if (dir === "left") b[idx][k] = line[k];
    else if (dir === "right") b[idx][3 - k] = line[k];
    else if (dir === "up") b[k][idx] = line[k];
    else b[3 - k][idx] = line[k];
  }
}

/** Apply a move. Returns { board, moved, gained }. */
export function applyMove(board, dir) {
  const b = cloneBoard(board);
  let gained = 0, moved = false;
  for (let idx = 0; idx < 4; idx++) {
    const before = getLine(b, dir, idx);
    const { line, gained: g } = collapse(before);
    gained += g;
    if (line.some((v, i) => v !== before[i])) moved = true;
    setLine(b, dir, idx, line);
  }
  return { board: b, moved, gained };
}

function emptyCells(b) {
  const out = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (b[r][c] === 0) out.push([r, c]);
  return out;
}

export function legalMoves(board) {
  return DIRS.filter(d => applyMove(board, d).moved);
}

export function isTerminal(state) {
  return state ? legalMoves(state.board).length === 0 : false;
}

// ── Evaluation ────────────────────────────────────────────────────────────────
// Gradient weights keep the largest tile pinned in one corner and the rest of
// the board ordered around it — the standard winning shape for 2048.
const WEIGHTS = [
  [ 65536, 32768, 16384,  8192],
  [   512,  1024,  2048,  4096],
  [   256,   128,    64,    32],
  [     2,     4,     8,    16],
];

function evaluate(b) {
  let score = 0;
  let empty = 0;
  let smooth = 0;
  let maxV = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = b[r][c];
      if (v === 0) { empty++; continue; }
      score += v * WEIGHTS[r][c];
      if (v > maxV) maxV = v;
      // Penalise neighbouring tiles of very different magnitude (rough surface)
      if (c + 1 < 4 && b[r][c + 1] !== 0) smooth -= Math.abs(Math.log2(v) - Math.log2(b[r][c + 1]));
      if (r + 1 < 4 && b[r + 1][c] !== 0) smooth -= Math.abs(Math.log2(v) - Math.log2(b[r + 1][c]));
    }
  }
  return score + empty * 12000 + smooth * 2000;
}

function expectimax(b, depth, isChance) {
  if (depth <= 0) return evaluate(b);

  if (!isChance) {
    let best = -Infinity;
    for (const d of DIRS) {
      const { board: nb, moved, gained } = applyMove(b, d);
      if (!moved) continue;
      best = Math.max(best, gained + expectimax(nb, depth - 1, true));
    }
    return best === -Infinity ? evaluate(b) : best;
  }

  const cells = emptyCells(b);
  if (!cells.length) return evaluate(b);
  // Sample at most a few empty cells; averaging over all of them costs a lot and
  // changes the ranking very little.
  const sample = cells.length > 6 ? cells.filter((_, i) => i % Math.ceil(cells.length / 6) === 0) : cells;
  let total = 0;
  for (const [r, c] of sample) {
    for (const [v, p] of [[2, 0.9], [4, 0.1]]) {
      b[r][c] = v;
      total += p * expectimax(b, depth - 1, false);
      b[r][c] = 0;
    }
  }
  return total / sample.length;
}

/**
 * Pick the best move for a board.
 * Returns { key, reason, gained } or null when no move is legal.
 */
export function chooseMove(state) {
  const board = state.board;
  const empty = emptyCells(board).length;
  // Search deeper when the board is crowded and mistakes are expensive.
  const depth = empty > 8 ? 3 : empty > 4 ? 4 : 5;

  let best = null, bestScore = -Infinity;
  for (const d of DIRS) {
    const { board: nb, moved, gained } = applyMove(board, d);
    if (!moved) continue;
    const s = gained + expectimax(nb, depth - 1, true);
    if (s > bestScore) { bestScore = s; best = { key: d, gained }; }
  }
  if (!best) return null;

  const maxV = Math.max(...board.flat());
  best.reason = `expectimax d${depth}: ${best.key}` +
    (best.gained ? ` (merges +${best.gained})` : "") +
    ` · max tile ${maxV}, ${empty} empty`;
  return best;
}

export function describeState(state) {
  if (!state) return "board unreadable";
  return state.board.map(r => r.map(v => (v === 0 ? "." : v)).join("\t")).join("\n");
}

export function match(gameDesc) {
  return /2048/i.test(String(gameDesc ?? ""));
}

export const plugin = {
  id: "2048",
  label: "2048 (board reader + expectimax solver)",
  match, readState, chooseMove, isTerminal, describeState, applyMove, legalMoves,
  diagnose, findRestartButton,
};

export default plugin;
