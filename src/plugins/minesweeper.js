// ── Minesweeper plugin ────────────────────────────────────────────────────────
//
// Reading a Minesweeper board from the screen, and the plugin surface the agent
// drives it through. The reasoning lives in minesweeper-solver.js and knows
// nothing about pixels.
//
// The board is a regular lattice, so nothing here assumes a cell size: the pitch
// is measured from the picture. minesweeper.online has a zoom control, the
// classic skin sizes cells to it, and hard-coding 24px would break the moment
// anyone touched it — the same mistake as assuming 2048's stylesheet, which cost
// several rounds there.
//
// Two properties of the classic skin do the work:
//
//   Unopened squares are drawn raised — white along the top and left edges, dark
//   grey along the bottom and right. That bevel is what separates "not yet
//   opened" from "opened and empty", which are otherwise the same flat grey.
//
//   Numbers have their own colours, and unlike 2048's near-identical tiles these
//   are far apart: 1 is blue, 2 green, 3 red, 4 navy, 5 maroon, 6 teal, 7 black,
//   8 grey. A number can be identified from the colour of its strokes alone,
//   which is far more reliable at a 24px cell than reading the shape.

import { solve, UNKNOWN, FLAG } from "./minesweeper-solver.js";

export { UNKNOWN, FLAG };
export const MINE = -3;

const FACE = [192, 192, 192];       // cell fill and board background
const HIGHLIGHT = [255, 255, 255];  // top/left bevel of an unopened square
const SHADOW = [128, 128, 128];     // bottom/right bevel, and grid lines

// Classic number colours. 8 shares grey with the shadow, so it is only ever
// accepted from the middle of a cell, never near an edge.
const NUMBER_COLOURS = [
  { n: 1, rgb: [0, 0, 255] },
  { n: 2, rgb: [0, 128, 0] },
  { n: 3, rgb: [255, 0, 0] },
  { n: 4, rgb: [0, 0, 128] },
  { n: 5, rgb: [128, 0, 0] },
  { n: 6, rgb: [0, 128, 128] },
  { n: 7, rgb: [0, 0, 0] },
  { n: 8, rgb: [128, 128, 128] },
];

export const LEVELS = {
  beginner:     { rows: 9,  cols: 9,  mines: 10, label: "Beginner" },
  intermediate: { rows: 16, cols: 16, mines: 40, label: "Intermediate" },
  expert:       { rows: 16, cols: 30, mines: 99, label: "Expert" },
};

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

const px = (data, w, x, y) => {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};

/**
 * Find the grid: where it starts, how big a cell is, and how many there are.
 *
 * Cell edges repeat, so the columns carrying bevel pixels form a comb whose
 * spacing is the cell pitch. Measuring the spacing between those columns is
 * enough to recover the geometry without knowing the zoom level or the level
 * being played.
 */
export function findGrid(canvasEl) {
  if (!canvasEl || !canvasEl.width) return null;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return null; }

  // Where is the playfield? Take the largest block of squares drawn in the
  // classic greys — the page around it is white and the chrome is not this
  // colour at this scale.
  const step = Math.max(1, Math.round(Math.min(w, h) / 400));
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  if (gw < 12 || gh < 12) return null;
  // Only the grey face counts. The bevel highlight is pure white, which is also
  // the page behind the game, so including it merges the board into the whole
  // page — the same way 2048's glow once stretched its board past its edges.
  // Every square contributes face pixels whatever state it is in, so the face
  // alone still covers the playfield.
  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (dist2(px(data, w, gx * step, gy * step), FACE) <= 400) mask[gy * gw + gx] = 1;
    }
  }
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
      const x = p % gw, y = (p / gw) | 0;
      n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0)      { const q = p - 1;  if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
      if (x < gw - 1) { const q = p + 1;  if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
      if (y > 0)      { const q = p - gw; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
      if (y < gh - 1) { const q = p + gw; if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; } }
    }
    if (!best || n > best.n) best = { n, minX, minY, maxX, maxY };
  }
  if (!best || best.n < 200) return null;

  const area = {
    x: best.minX * step, y: best.minY * step,
    w: (best.maxX - best.minX + 1) * step,
    h: (best.maxY - best.minY + 1) * step,
  };
  if (area.w < 60 || area.h < 60) return null;

  // Cell edges repeat, so the count of bevel pixels along each column and row is
  // a periodic signal whose period is the cell size. Measured by how strongly
  // the signal matches itself when shifted, rather than by looking for peaks:
  // the mine counter, the timer and the frame all produce peaks of their own,
  // and picking those gave a plausible-looking but wrong grid.
  const isEdge = (x, y) => {
    const c = px(data, w, x, y);
    return dist2(c, HIGHLIGHT) <= 300 || dist2(c, SHADOW) <= 500;
  };
  const signalAlong = (along, across, sample) => {
    const s = new Float64Array(along);
    for (let i = 0; i < along; i++) {
      let n = 0;
      for (let j = 0; j < across; j += 2) if (sample(i, j)) n++;
      s[i] = n;
    }
    const mean = s.reduce((a, b) => a + b, 0) / along;
    for (let i = 0; i < along; i++) s[i] -= mean;
    return s;
  };
  const periodOf = (s) => {
    const hi = Math.min(64, Math.floor(s.length / 4));
    const scores = new Map();
    let bestScore = 0, best = null;
    for (let p = 8; p <= hi; p++) {
      let acc = 0, n = 0;
      for (let i = 0; i + p < s.length; i++) { acc += s[i] * s[i + p]; n++; }
      // Normalised so long periods are not favoured simply by overlapping less.
      const score = n ? acc / n : 0;
      scores.set(p, score);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (bestScore <= 0 || best == null) return null;
    // A signal repeating every cell also repeats every two cells, and twice the
    // pitch can score higher when rows alternate — covered rows carry more bevel
    // than opened ones — which measured the grid at double its true size and put
    // every cell in the wrong place. Only whole fractions of the best period can
    // be the real one, so those are the only alternatives considered; anything
    // else that happens to score well is a different signal, not this one.
    for (let k = 8; k >= 2; k--) {
      const candidate = best / k;
      if (!Number.isInteger(candidate) || candidate < 8) continue;
      if ((scores.get(candidate) ?? 0) >= bestScore * 0.8) return candidate;
    }
    return best;
  };
  const phaseOf = (s, p) => {
    let best = 0, bestSum = -Infinity;
    for (let off = 0; off < p; off++) {
      let sum = 0;
      for (let i = off; i < s.length; i += p) sum += s[i];
      if (sum > bestSum) { bestSum = sum; best = off; }
    }
    return best;
  };

  const colSig = signalAlong(area.w, area.h, (i, j) => isEdge(area.x + i, area.y + j));
  const rowSig = signalAlong(area.h, area.w, (i, j) => isEdge(area.x + j, area.y + i));
  const pitchX = periodOf(colSig), pitchY = periodOf(rowSig);
  if (!pitchX && !pitchY) return null;

  // Try the pitches the two axes suggest, and their halves, and keep whichever
  // actually produces a grid of cells.
  //
  // The signal is not always trustworthy on its own: a board whose covered and
  // opened rows alternate repeats every two rows as well as every one, so an
  // axis can lock onto twice the pitch, and a short axis can lock onto nothing
  // meaningful at all. Rather than deciding from the signal and hoping, each
  // candidate is laid over the picture and judged by whether the squares it
  // implies actually look like cells. That check already exists, and it is a far
  // better arbiter than the strength of a correlation.
  const candidates = [...new Set([
    pitchX, pitchY,
    pitchX && pitchY ? Math.round((pitchX + pitchY) / 2) : null,
    pitchX ? Math.round(pitchX / 2) : null,
    pitchY ? Math.round(pitchY / 2) : null,
  ].filter(p => p && p >= 8))].sort((a, b) => a - b);

  let bestGrid = null;
  for (const pitch of candidates) {
    const x0 = area.x + phaseOf(colSig, pitch);
    const y0 = area.y + phaseOf(rowSig, pitch);

    const looksLikeCell = (cx, cy) => {
      if (cx + pitch > w || cy + pitch > h) return false;
      if (isRaised(data, w, h, cx, cy, pitch)) return true;
      // An opened cell carries a grid line along its top or left edge. What is
      // drawn inside says nothing — a large number covers most of the middle and
      // a mine covers more still, so any requirement to be mostly-grey there
      // rejects exactly the cells carrying the information. The frame has no
      // grid lines, which is what it needs to be told apart from.
      let line = 0, lineN = 0;
      for (let k = Math.round(pitch * 0.3); k < pitch * 0.7; k += 2) {
        lineN += 2;
        if (dist2(px(data, w, cx + k, cy), SHADOW) <= 900) line++;
        if (dist2(px(data, w, cx, cy + k), SHADOW) <= 900) line++;
      }
      return lineN > 0 && line / lineN > 0.3;
    };
    const rowOk = (gy) => {
      let ok = 0, n = 0;
      for (let gx = x0; gx + pitch <= area.x + area.w; gx += pitch) { n++; if (looksLikeCell(gx, gy)) ok++; }
      return n >= 5 && ok / n > 0.8;
    };
    const colOk = (gx, top, bottom) => {
      let ok = 0, n = 0;
      for (let gy = top; gy + pitch <= bottom; gy += pitch) { n++; if (looksLikeCell(gx, gy)) ok++; }
      return n >= 5 && ok / n > 0.8;
    };

    let top = y0;
    while (top + pitch <= area.y + area.h && !rowOk(top)) top += pitch;
    let bottom = top;
    while (bottom + pitch <= area.y + area.h && rowOk(bottom)) bottom += pitch;
    if (bottom - top < pitch * 5) continue;

    let left = x0;
    while (left + pitch <= area.x + area.w && !colOk(left, top, bottom)) left += pitch;
    let right = left;
    while (right + pitch <= area.x + area.w && colOk(right, top, bottom)) right += pitch;
    if (right - left < pitch * 5) continue;

    const cols = Math.round((right - left) / pitch);
    const rows = Math.round((bottom - top) / pitch);
    if (cols < 5 || rows < 5 || cols > 40 || rows > 40) continue;

    // Prefer the candidate covering the most of the board: a pitch that is too
    // large still validates, over fewer, larger squares.
    const covered = rows * cols * pitch * pitch;
    if (!bestGrid || covered > bestGrid.covered) {
      bestGrid = { x: left, y: top, pitch, rows, cols, covered };
    }
  }
  if (!bestGrid) return null;
  const { x: left, y: top, pitch, rows, cols } = bestGrid;
  return { x: left, y: top, pitch, rows, cols };
}

/** Is this square still covered? The bevel says so, whatever is drawn on it. */
function isRaised(data, w, h, x, y, pitch) {
  const inset = Math.max(1, Math.round(pitch * 0.08));
  let light = 0, dark = 0, n = 0;
  for (let k = Math.round(pitch * 0.25); k < pitch * 0.75; k += 2) {
    const top = px(data, w, x + k, y + inset);
    const left = px(data, w, x + inset, y + k);
    const bottom = px(data, w, x + k, y + pitch - 1 - inset);
    const right = px(data, w, x + pitch - 1 - inset, y + k);
    n += 2;
    if (dist2(top, HIGHLIGHT) <= 900) light++;
    if (dist2(left, HIGHLIGHT) <= 900) light++;
    if (dist2(bottom, SHADOW) <= 900) dark++;
    if (dist2(right, SHADOW) <= 900) dark++;
  }
  if (!n) return false;
  return light / n > 0.5 && dark / n > 0.4;
}

/** Read one square. */
function readCell(data, w, h, x, y, pitch) {
  const raised = isRaised(data, w, h, x, y, pitch);

  // Anything that is not the cell's own grey, taken from the middle so the
  // bevel never contributes.
  const lo = Math.round(pitch * 0.22), hi = Math.round(pitch * 0.78);
  const marks = [];
  for (let dy = lo; dy < hi; dy++) {
    for (let dx = lo; dx < hi; dx++) {
      const c = px(data, w, x + dx, y + dy);
      if (dist2(c, FACE) > 1500 && dist2(c, HIGHLIGHT) > 900) marks.push(c);
    }
  }

  if (raised) {
    // A covered square with red on it is flagged; the flag is the only red thing
    // drawn on an unopened cell.
    const red = marks.filter(c => c[0] > 120 && c[1] < 90 && c[2] < 90).length;
    return red >= Math.max(3, marks.length * 0.12) ? FLAG : UNKNOWN;
  }

  // Opened. Few marks means an empty square.
  const area = (hi - lo) * (hi - lo);
  if (marks.length < area * 0.04) return 0;

  // A mine is a filled disc, so it covers far more of the cell than any digit
  // does. Without this it reads as a 7 — both are black — and a lost game looks
  // like a playable one.
  // The disc covers roughly two thirds of the sampled middle; a digit's strokes
  // cover a quarter at most. At 0.3 a bold 7 crossed the line and a playable
  // board looked lost.
  const dark = marks.filter(c => c[0] < 90 && c[1] < 90 && c[2] < 90).length;
  if (dark > area * 0.45) return MINE;

  // Which number, by the colour of its strokes: a vote over the mark pixels,
  // which is steadier than reading the digit's shape at this size.
  const votes = new Map();
  for (const c of marks) {
    let best = null, bestD = Infinity;
    for (const t of NUMBER_COLOURS) {
      const d = dist2(c, t.rgb);
      if (d < bestD) { bestD = d; best = t.n; }
    }
    if (bestD <= 6000) votes.set(best, (votes.get(best) ?? 0) + 1);
  }
  let picked = null, most = 0;
  for (const [n, count] of votes) if (count > most) { most = count; picked = n; }
  if (picked == null || most < marks.length * 0.35) return null;
  return picked;
}

/**
 * Read the whole board.
 * Returns { board, rows, cols, grid } or null when the grid cannot be found.
 */
export function readState(canvasEl, gridHint = null) {
  const grid = gridHint || findGrid(canvasEl);
  if (!grid) return null;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return null; }

  const board = [];
  let unread = 0;
  for (let r = 0; r < grid.rows; r++) {
    const row = [];
    for (let c = 0; c < grid.cols; c++) {
      const v = readCell(data, w, h, grid.x + c * grid.pitch, grid.y + r * grid.pitch, grid.pitch);
      if (v === null) { unread++; row.push(UNKNOWN); } else row.push(v);
    }
    board.push(row);
  }
  // A square that cannot be read must not pass as covered: the solver would
  // treat it as somewhere still to explore and reason from a board that is not
  // there. Same rule as 2048 — an incomplete read is no read.
  if (unread > 0) return null;
  return { board, rows: grid.rows, cols: grid.cols, grid };
}

// Exposed for tests: reading one square is where a skin difference shows up
// first, and diagnosing that through a whole-board read hides which cell failed.
export function __readCellAt(canvasEl, grid, r, c) {
  const w = canvasEl.width, h = canvasEl.height;
  const data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  return readCell(data, w, h, grid.x + c * grid.pitch, grid.y + r * grid.pitch, grid.pitch);
}

/** Which level is this board? Recognised by its shape. */
export function levelOf(rows, cols) {
  for (const [key, l] of Object.entries(LEVELS)) {
    if (l.rows === rows && l.cols === cols) return { key, ...l };
  }
  return null;
}

export function chooseMove(state) {
  const level = levelOf(state.rows, state.cols);
  const mines = state.mines ?? level?.mines;
  if (!mines || !state.grid) return null;
  const result = solve(state.board, mines);
  if (!result.actions.length) return null;

  const { x, y, pitch } = state.grid;
  const half = Math.floor(pitch / 2);
  // Certain moves can be played together; a guess is played alone so the board
  // is re-read before anything is built on it.
  const chosen = result.certain ? result.actions : result.actions.slice(0, 1);
  return {
    actions: chosen.map(a => ({
      type: "click",
      button: a.type === "flag" ? "right" : "left",
      x: x + a.c * pitch + half,
      y: y + a.r * pitch + half,
      label: `${a.type} r${a.r}c${a.c}`,
    })),
    reason: result.reason,
    certain: result.certain,
  };
}

export function isTerminal(state) {
  // A revealed mine ends it immediately, however much is left covered.
  for (const row of state.board) for (const v of row) if (v === MINE) return true;
  // Otherwise won when every square that is not a mine has been opened.
  const level = levelOf(state.rows, state.cols);
  if (!level) return false;
  let covered = 0;
  for (const row of state.board) for (const v of row) if (v === UNKNOWN || v === FLAG) covered++;
  return covered <= level.mines;
}

export function describeState(state) {
  let covered = 0, flags = 0, opened = 0;
  for (const row of state.board) {
    for (const v of row) {
      if (v === UNKNOWN) covered++;
      else if (v === FLAG) flags++;
      else opened++;
    }
  }
  const level = levelOf(state.rows, state.cols);
  return `${level?.label ?? `${state.rows}x${state.cols}`}: ${opened} opened, ${flags} flagged, ${covered} covered`;
}

/**
 * The face above the board, which starts a fresh game.
 *
 * Located from the grid rather than by hunting the whole screen: it sits
 * centred over the columns, in the panel above them. The generic button finder
 * does not see it — it is a small square, and that finder looks for wide
 * labelled controls.
 */
export function findRestartButton(canvasEl, gridHint = null) {
  const grid = gridHint || findGrid(canvasEl);
  if (!grid) return null;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return null; }

  // The face is the only yellow thing on a board drawn entirely in greys.
  const midX = grid.x + Math.round((grid.cols * grid.pitch) / 2);
  const top = Math.max(0, grid.y - Math.round(grid.pitch * 4));
  let sumX = 0, sumY = 0, n = 0;
  for (let y = top; y < grid.y; y++) {
    for (let x = Math.max(0, midX - grid.pitch * 6); x < Math.min(w, midX + grid.pitch * 6); x++) {
      const c = px(data, w, x, y);
      if (c[0] > 180 && c[1] > 150 && c[2] < 120) { sumX += x; sumY += y; n++; }
    }
  }
  if (n < 20) return null;
  return { x: Math.round(sumX / n), y: Math.round(sumY / n), kind: "new-game", restarts: true };
}

export function match(gameDesc) {
  return /mine\s*sweeper|minesweeper/i.test(String(gameDesc ?? ""));
}

export const plugin = {
  id: "minesweeper",
  label: "Minesweeper (board reader + constraint solver)",
  match, readState, chooseMove, isTerminal, describeState,
  findGrid, levelOf, LEVELS, MINE, findRestartButton,
};

export default plugin;
