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

// Tolerance for identifying a tile by colour. 2500 (about 50 per channel)
// absorbs JPEG artefacts while staying under the ~61 gap between an empty cell
// and a "2" tile, so those two never blur together.
function nearestTile(rgb, maxDist = 2500) {
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
// Is this pixel part of a 2048 board? The board is made of its background
// colour plus empty cells plus tiles, so match against the whole palette.
function isBoardPixel(rgb, tol) {
  if (dist2(rgb, BOARD_BG) <= tol) return true;
  for (const t of TILE_COLORS) if (dist2(rgb, t.rgb) <= tol) return true;
  return false;
}

/**
 * Locate the board as the largest CONNECTED region of board-palette pixels.
 *
 * A plain bounding box over every matching pixel is not usable in practice: on
 * a shared full screen, a handful of similarly-coloured pixels anywhere else
 * (browser chrome, the agent's own window) stretch the box until it no longer
 * looks square and the read is abandoned. Connected-component labelling ignores
 * those isolated specks and returns the actual board.
 */
// Default tolerance is deliberately tight. The page background behind the game
// (250,248,239) sits only ~31 from the "2" tile (238,228,218); at a looser
// tolerance the flood fill merges the board into the whole page and the
// detected rectangle is meaningless.
function findBoardRect(data, w, h, tol = 900) {
  // Work on a coarse mask; the board is large so this loses nothing and keeps
  // the flood fill cheap.
  const step = Math.max(1, Math.round(Math.min(w, h) / 180));
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  if (gw < 8 || gh < 8) return null;

  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = ((gy * step) * w + gx * step) * 4;
      if (isBoardPixel([data[i], data[i + 1], data[i + 2]], tol)) mask[gy * gw + gx] = 1;
    }
  }

  // Largest connected component (4-neighbour flood fill)
  const seen = new Uint8Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  let best = null;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let head = 0, tail = 0;
    queue[tail++] = s; seen[s] = 1;
    let minX = gw, minY = gh, maxX = -1, maxY = -1, n = 0;
    while (head < tail) {
      const p = queue[head++];
      const px = p % gw, py = (p / gw) | 0;
      n++;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px > 0)      { const q = p - 1;  if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
      if (px < gw - 1) { const q = p + 1;  if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
      if (py > 0)      { const q = p - gw; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
      if (py < gh - 1) { const q = p + gw; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
    }
    if (!best || n > best.n) best = { n, minX, minY, maxX, maxY };
  }
  if (!best || best.n < 40) return null;

  const x = best.minX * step, y = best.minY * step;
  const bw = (best.maxX - best.minX + 1) * step;
  const bh = (best.maxY - best.minY + 1) * step;
  const ratio = bw / bh;
  if (ratio < 0.75 || ratio > 1.33) return null; // the board is square
  if (bw < 60 || bh < 60) return null;
  return { x, y, w: bw, h: bh };
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
    // Distinguish "the board isn't in this frame" from "the palette differs".
    // A 2048 board is unmistakably warm/tan; if the frame contains almost no
    // warm mid-tones, the board simply isn't on screen — usually because
    // another window is covering the game.
    let warm = 0, sampled = 0;
    for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sampled++;
      if (r > 120 && r > b + 18 && g > b + 5 && r < 252) warm++;
    }
    const warmPct = sampled ? Math.round((warm / sampled) * 100) : 0;
    if (warmPct < 3) {
      out.notes.push(`no warm/tan pixels in this frame (${warmPct}%) — the 2048 board is NOT on screen. Make sure the game window is visible and not covered by the agent window.`);
    } else {
      out.notes.push(`warm pixels present (${warmPct}%) but board background rgb(${BOARD_BG}) was not matched — this site's palette likely differs; the per-cell colours below can be used to correct it`);
    }
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
function buttonClusters(data, w, h) {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 300));
  const pts = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (dist2([data[i], data[i + 1], data[i + 2]], BUTTON_BG) <= 2500) pts.push([x, y]);
    }
  }
  if (pts.length < 20) return [];
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
  return clusters.filter(c => c.n >= 15 && (c.maxX - c.minX) > 30 && (c.maxY - c.minY) > 10);
}

/**
 * Locate the restart control.
 *
 * Colour alone is not enough: several page elements share the button colour, and
 * clicking the wrong one silently does nothing. The game-over "Try again" button
 * is drawn INSIDE the board area, so when the board is known, a button within
 * those bounds is the one to click. Otherwise fall back to the nearest button
 * above the board ("New Game").
 */
export function findRestartButton(canvasEl, rectHint = null, exclude = []) {
  if (!canvasEl || !canvasEl.width) return null;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return null; }

  let clusters = buttonClusters(data, w, h);
  // Skip buttons already tried: both "Try again" and "New Game" restart the
  // game, so if the preferred one does not work we must be able to fall through
  // to the other rather than clicking the same place again.
  if (exclude.length) {
    clusters = clusters.filter(c => {
      const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
      return !exclude.some(p => Math.abs(p.x - cx) < 45 && Math.abs(p.y - cy) < 25);
    });
  }
  if (!clusters.length) return null;

  const rect = rectHint ?? findBoardRect(data, w, h);
  const centre = c => ({ x: Math.round((c.minX + c.maxX) / 2), y: Math.round((c.minY + c.maxY) / 2) });

  if (rect) {
    // "Try again" overlays the board — strongly preferred when present.
    const inside = clusters.filter(c => {
      const p = centre(c);
      return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
    });
    if (inside.length) {
      inside.sort((a, b) => b.n - a.n);
      return { ...centre(inside[0]), kind: "try-again" };
    }
    // Otherwise "New Game" sits just above the board, horizontally near it.
    const above = clusters.filter(c => {
      const p = centre(c);
      return p.y < rect.y && p.y > rect.y - rect.h && p.x > rect.x - rect.w * 0.3 && p.x < rect.x + rect.w * 1.3;
    });
    if (above.length) {
      above.sort((a, b) => b.minY - a.minY); // the one closest above the board
      return { ...centre(above[0]), kind: "new-game" };
    }
  }

  clusters.sort((a, b) => (b.minY - a.minY) || (b.n - a.n));
  return { ...centre(clusters[0]), kind: "guess" };
}

/**
 * Is the game over? The "Try again" button only exists on the game-over
 * overlay, so a button inside the board bounds is a reliable signal — and it
 * still works when the overlay has washed out the tile colours enough that the
 * board itself cannot be read.
 */
export function isGameOverScreen(canvasEl) {
  if (!canvasEl || !canvasEl.width) return false;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return false; }
  const rect = findBoardRect(data, w, h);
  if (!rect) return false;
  return buttonClusters(data, w, h).some(c => {
    const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  });
}

/** A freshly started 2048 game has only two tiles on the board. */
export function looksLikeNewGame(state) {
  if (!state) return false;
  const filled = state.board.flat().filter(v => v > 0);
  return filled.length > 0 && filled.length <= 2 && filled.every(v => v === 2 || v === 4);
}

// Read one cell by sampling several points and taking the most common tile
// colour. Sampling many points steps over the digits printed on the tile.
// Sample the tile's background in a ring around its centre.
//
// The digits are printed in the middle of the tile, and light text on a tile is
// numerically close to the palest tile colours — white (249,246,242) is only
// about 32 away from the "2" tile (238,228,218), well inside the tolerance a
// re-skinned clone needs. Sampling through the centre therefore lets the text
// outvote the tile. Reading the ring avoids the glyphs entirely.
// Sample fractions chosen from measured pixels: 0.20-0.80 lands on tile
// background across the cell, while the gaps between tiles sit outside that
// range and the printed digits sit in the middle.
const SAMPLE_FRACS = [0.20, 0.32, 0.50, 0.68, 0.80];
const TEXT_LIGHT = [249, 246, 242];
const TEXT_DARK = [119, 110, 101];

function isTextPixel(rgb) {
  return dist2(rgb, TEXT_LIGHT) <= 900 || dist2(rgb, TEXT_DARK) <= 1600;
}

function readCell(data, w, h, cx, cy, cw, ch) {
  const votes = new Map();
  let usable = 0;
  for (const fy of SAMPLE_FRACS) {
    for (const fx of SAMPLE_FRACS) {
      // Skip the middle of the tile, where the number is drawn
      if (fx > 0.35 && fx < 0.65 && fy > 0.35 && fy < 0.65) continue;
      const px = Math.round(cx + cw * fx);
      const py = Math.round(cy + ch * fy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      const c = [data[i], data[i + 1], data[i + 2]];
      if (isTextPixel(c)) continue;   // glyph antialiasing — ignore
      usable++;
      const v = nearestTile(c);
      if (v === null) continue;
      votes.set(v, (votes.get(v) ?? 0) + 1);
    }
  }
  if (!votes.size || !usable) return null;
  let bestV = null, bestN = 0;
  for (const [v, n] of votes) if (n > bestN) { bestN = n; bestV = v; }
  // Require a clear majority so a mid-animation tile doesn't produce a bad read
  return bestN >= Math.max(5, usable * 0.5) ? bestV : null;
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
export function chooseMove(state, exclude = []) {
  const board = state.board;
  const empty = emptyCells(board).length;
  // Search deeper when the board is crowded and mistakes are expensive.
  const depth = empty > 8 ? 3 : empty > 4 ? 4 : 5;

  let best = null, bestScore = -Infinity;
  for (const d of DIRS) {
    // Skip moves already shown not to change the real board. If the read is
    // subtly wrong, repeating the same "legal" move loops forever; trying the
    // next-best move breaks out of that.
    if (exclude.includes(d)) continue;
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
  diagnose, findRestartButton, isGameOverScreen, looksLikeNewGame,
};

export default plugin;
