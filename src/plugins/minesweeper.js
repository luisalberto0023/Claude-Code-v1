// ── Minesweeper plugin ────────────────────────────────────────────────────────
//
// Reading a Minesweeper board from the screen, and the plugin surface the agent
// drives it through. The reasoning lives in minesweeper-solver.js and knows
// nothing about pixels.
//
// Nothing here is matched against a fixed palette. An earlier version encoded
// the classic greys — 192 for a cell, 255 for its highlight, 128 for its shadow
// — and read every test board perfectly while failing on the real site every
// single time. The tests were rendered with the same numbers the reader was
// looking for, so they could only ever agree with it. What a skin actually uses
// is not knowable in advance, and 2048 taught the same lesson twice.
//
// So the reader measures relationships that hold whatever the colours are:
//
//   A covered square is drawn raised: its top and left edges are LIGHTER than
//   its bottom and right. An opened square is not. Comparing one edge against
//   the other says which it is without knowing either value.
//
//   A grid shows up as evenly spaced edges. The spacing is recovered from where
//   brightness changes sharply, which does not depend on the colours either side.
//
//   A number is whatever contrasts with the square it is drawn on, and which of
//   the eight it is comes from hue: 1 blue, 2 green, 3 red, 4 navy, 5 maroon,
//   6 teal, 7 black, 8 grey. Those are consistent across Minesweeper skins in a
//   way that greys are not.

import { solve, UNKNOWN, FLAG } from "./minesweeper-solver.js";

export { UNKNOWN, FLAG };
export const MINE = -3;

// Only used to name a number once its ink has been separated from its
// background, never to find anything on screen.
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
const lum = c => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
const sat = c => Math.max(...c) - Math.min(...c);

function imageData(canvasEl) {
  if (!canvasEl || !canvasEl.width || !canvasEl.height) return null;
  try {
    return {
      data: canvasEl.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, canvasEl.width, canvasEl.height).data,
      w: canvasEl.width, h: canvasEl.height,
    };
  } catch { return null; }
}

/**
 * The largest block of flat grey on screen — the board and its frame.
 *
 * Grey rather than a particular grey: a Minesweeper board is drawn almost
 * entirely without colour, while pages around it are white and their chrome is
 * either brighter or coloured. The band excludes both ends so the page itself
 * cannot be mistaken for the board, which is what happened when white counted.
 */
function boardRegion(data, w, h) {
  const step = Math.max(1, Math.round(Math.min(w, h) / 400));
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  if (gw < 12 || gh < 12) return null;

  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const c = px(data, w, gx * step, gy * step);
      const l = lum(c);
      if (sat(c) <= 26 && l >= 96 && l <= 232) mask[gy * gw + gx] = 1;
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
  return (area.w >= 60 && area.h >= 60) ? area : null;
}

// How sharply brightness changes across each column and row. A grid of squares
// puts a change at every cell edge whatever the squares are drawn in, so this
// carries the spacing without depending on any colour.
function edgeProfiles(data, w, h, area) {
  const cols = new Float64Array(area.w);
  const rows = new Float64Array(area.h);
  for (let i = 1; i < area.w; i++) {
    let acc = 0;
    for (let j = 0; j < area.h; j += 2) {
      acc += Math.abs(lum(px(data, w, area.x + i, area.y + j)) -
                      lum(px(data, w, area.x + i - 1, area.y + j)));
    }
    cols[i] = acc;
  }
  for (let j = 1; j < area.h; j++) {
    let acc = 0;
    for (let i = 0; i < area.w; i += 2) {
      acc += Math.abs(lum(px(data, w, area.x + i, area.y + j)) -
                      lum(px(data, w, area.x + i, area.y + j - 1)));
    }
    rows[j] = acc;
  }
  const centre = s => {
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const out = new Float64Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] - mean;
    return out;
  };
  return { cols: centre(cols), rows: centre(rows) };
}

function periodCandidates(signal) {
  const hi = Math.min(72, Math.floor(signal.length / 4));
  const scores = [];
  for (let p = 8; p <= hi; p++) {
    let acc = 0, n = 0;
    for (let i = 0; i + p < signal.length; i++) { acc += signal[i] * signal[i + p]; n++; }
    scores.push({ p, score: n ? acc / n : 0 });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.filter(s => s.score > 0).slice(0, 6).map(s => s.p);
}

function phaseOf(signal, p) {
  let best = 0, bestSum = -Infinity;
  for (let off = 0; off < p; off++) {
    let sum = 0;
    for (let i = off; i < signal.length; i += p) sum += signal[i];
    if (sum > bestSum) { bestSum = sum; best = off; }
  }
  return best;
}

/**
 * Is this square covered?
 *
 * By comparing its own edges against each other, not against a known colour: a
 * raised square is lit from the top left, so that side is brighter than the
 * bottom right. The difference is what matters, so any skin that draws squares
 * as raised at all will read correctly.
 */
function bevel(data, w, h, x, y, pitch) {
  const inset = Math.max(1, Math.round(pitch * 0.10));
  const from = Math.round(pitch * 0.25), to = Math.round(pitch * 0.75);
  let tl = 0, br = 0, n = 0;
  for (let k = from; k < to; k++) {
    tl += lum(px(data, w, x + k, y + inset));
    tl += lum(px(data, w, x + inset, y + k));
    br += lum(px(data, w, x + k, y + pitch - 1 - inset));
    br += lum(px(data, w, x + pitch - 1 - inset, y + k));
    n += 2;
  }
  return n ? (tl - br) / n : 0;
}

/**
 * How strongly this square is outlined, whatever it contains.
 *
 * The bevel says whether a square is covered, but it is measured inset from the
 * edge and so reads zero on an opened square — whose only marking is a one-pixel
 * line right on the border — which makes an opened square indistinguishable from
 * bare frame. This looks at the border itself against the square's own middle,
 * so both kinds of square register and the frame does not.
 */
function edgeContrast(data, w, h, x, y, pitch) {
  const from = Math.round(pitch * 0.3), to = Math.round(pitch * 0.7);
  let top = 0, left = 0, n = 0;
  for (let k = from; k < to; k++) {
    top += lum(px(data, w, x + k, y));
    left += lum(px(data, w, x, y + k));
    n++;
  }
  if (!n) return 0;
  const inner = [];
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.28], [0.5, 0.72]]) {
    inner.push(lum(px(data, w, x + Math.round(pitch * fx), y + Math.round(pitch * fy))));
  }
  inner.sort((a, b) => a - b);
  const mid = inner[inner.length >> 1];
  return Math.max(Math.abs(top / n - mid), Math.abs(left / n - mid));
}

function cellInterior(data, w, h, x, y, pitch) {
  const lo = Math.round(pitch * 0.22), hi = Math.round(pitch * 0.78);
  const out = [];
  for (let dy = lo; dy < hi; dy++) {
    for (let dx = lo; dx < hi; dx++) out.push(px(data, w, x + dx, y + dy));
  }
  return out;
}

/** Read one square, given how raised squares look on this board. */
function classifyCell(data, w, h, x, y, pitch, thresholds) {
  const raisedThreshold = typeof thresholds === "number" ? thresholds : thresholds.raised;
  const outlineCut = typeof thresholds === "number" ? 0 : thresholds.outline;
  const lift = bevel(data, w, h, x, y, pitch);
  const raised = lift >= raisedThreshold;
  const inside = cellInterior(data, w, h, x, y, pitch);
  if (!inside.length) return null;

  // The square's own background, taken from its inner corners.
  //
  // Not from the middle: whatever is drawn here is drawn centred, and a mine
  // fills enough of the middle that the median there IS the mine — so the
  // background came out black, almost nothing differed from it, and the square
  // read as unclassifiable. The corners are clear of both digits and discs.
  const mid = arr => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const corners = [];
  for (const fx of [0.20, 0.28, 0.72, 0.80]) {
    for (const fy of [0.20, 0.28, 0.72, 0.80]) {
      corners.push(px(data, w, x + Math.round(pitch * fx), y + Math.round(pitch * fy)));
    }
  }
  const bg = [mid(corners.map(c => c[0])), mid(corners.map(c => c[1])), mid(corners.map(c => c[2]))];
  const ink = inside.filter(c => dist2(c, bg) > 2200);
  const inkFrac = ink.length / inside.length;

  if (raised) {
    const red = ink.filter(c => c[0] > 110 && c[0] - c[1] > 45 && c[0] - c[2] > 45).length;
    return red >= Math.max(3, ink.length * 0.15) ? FLAG : UNKNOWN;
  }
  if (inkFrac < 0.04) {
    // Nothing raised, nothing drawn: an empty opened square, or bare frame. The
    // square has a line along its border and the frame does not, which is the
    // only thing separating them — and without the check, a frame drawn close
    // enough in colour reads as a column of empty squares and the board grows an
    // extra column.
    if (outlineCut > 0 && edgeContrast(data, w, h, x, y, pitch) < outlineCut) return null;
    return 0;
  }

  // A mine is a filled disc of neutral black covering most of the square. Both
  // parts matter: judging by darkness alone made a maroon 5 a mine, since its
  // ink is dark too — but it is strongly coloured, and a mine is not. Judging by
  // size alone would confuse it with a 7, which is also black but only strokes.
  const neutralDark = ink.filter(c => lum(c) < 70 && sat(c) < 40).length;
  if (neutralDark / inside.length > 0.45) return MINE;

  const votes = new Map();
  for (const c of ink) {
    let best = null, bestD = Infinity;
    for (const t of NUMBER_COLOURS) {
      const d = dist2(c, t.rgb);
      if (d < bestD) { bestD = d; best = t.n; }
    }
    if (bestD <= 9000) votes.set(best, (votes.get(best) ?? 0) + 1);
  }
  let picked = null, most = 0;
  for (const [n, count] of votes) if (count > most) { most = count; picked = n; }
  return (picked != null && most >= ink.length * 0.3) ? picked : null;
}

/**
 * Find the grid, and how raised squares look on this particular board.
 *
 * Candidate spacings are laid over the picture and judged by whether the squares
 * they imply actually behave like cells — that is a far better arbiter than the
 * strength of a correlation, which can lock onto twice the pitch when covered
 * and opened rows alternate.
 */
export function findGrid(canvasEl) {
  const img = imageData(canvasEl);
  if (!img) return null;
  const { data, w, h } = img;
  const area = boardRegion(data, w, h);
  if (!area) return null;

  const { cols: colSig, rows: rowSig } = edgeProfiles(data, w, h, area);
  const candidates = [...new Set([...periodCandidates(colSig), ...periodCandidates(rowSig)])]
    .filter(p => p >= 8).sort((a, b) => a - b);

  let bestGrid = null;
  for (const pitch of candidates) {
    const x0 = area.x + phaseOf(colSig, pitch);
    const y0 = area.y + phaseOf(rowSig, pitch);

    // How strongly are edges drawn on this board? Measured here rather than
    // assumed, and used both to tell squares from the frame and to tell covered
    // squares from opened ones.
    //
    // The sign carries the meaning. A covered square is lit from the top left,
    // so that edge is brighter: strongly positive. An opened square has a thin
    // dark line along the same edge: strongly negative. The frame has neither
    // and sits near zero. So the magnitude says "this is a square" and the sign
    // says which kind — measured against this board's own contrast, so a skin
    // drawn in any greys reads the same way.
    const samples = [];
    for (let gy = y0; gy + pitch <= area.y + area.h; gy += pitch) {
      for (let gx = x0; gx + pitch <= area.x + area.w; gx += pitch) {
        samples.push(bevel(data, w, h, gx, gy, pitch));
      }
    }
    if (samples.length < 25) continue;
    const magnitudes = samples.map(Math.abs).sort((a, b) => a - b);
    const scale = magnitudes[Math.floor(magnitudes.length * 0.9)];
    if (scale < 12) continue;
    const threshold = scale * 0.35;
    const outlineSamples = [];
    for (let gy = y0; gy + pitch <= area.y + area.h; gy += pitch) {
      for (let gx = x0; gx + pitch <= area.x + area.w; gx += pitch) {
        outlineSamples.push(edgeContrast(data, w, h, gx, gy, pitch));
      }
    }
    outlineSamples.sort((a, b) => a - b);
    const outlineScale = outlineSamples[Math.floor(outlineSamples.length * 0.75)];
    const thresholds = { raised: threshold, outline: Math.max(6, outlineScale * 0.3) };

    // The board's extent comes from its grid lines, not from testing squares one
    // at a time.
    //
    // A per-square test kept failing on the squares that matter: a digit fills
    // the middle, so sampling there to compare against the border reads almost
    // no difference, and rows full of numbers were rejected as "not cells" while
    // empty rows passed. The lines themselves are the strongest thing on the
    // board — long, continuous, and running the full width — and they are
    // already measured. The board is simply the run of evenly spaced lines.
    const lineAt = (sig, at) => (at >= 0 && at < sig.length ? sig[at] : -Infinity);
    const runOf = (sig, start, limit, base) => {
      const positions = [];
      for (let v = start; v <= limit; v += pitch) positions.push({ v, s: lineAt(sig, v - base) });
      const finite = positions.map(p2 => p2.s).filter(Number.isFinite).sort((a, b) => a - b);
      if (finite.length < 6) return null;
      const strong = finite[Math.floor(finite.length * 0.75)];
      if (strong <= 0) return null;
      const cut = strong * 0.35;
      const isStrong = positions.map(p2 => p2.s >= cut);

      // Tolerate the occasional faint line rather than stopping at it.
      //
      // How visible a line is depends on what sits either side of it: where a
      // covered row meets an opened one, the covered row's dark lower edge abuts
      // the opened row's dark upper line and there is almost nothing to see. One
      // such boundary in the middle of a board split the run in two and neither
      // half was long enough to count, so a perfectly ordinary board looked like
      // no board at all.
      let best = null;
      for (let a = 0; a < positions.length; a++) {
        if (!isStrong[a]) continue;
        for (let b = positions.length - 1; b > a; b--) {
          if (!isStrong[b]) continue;
          const span = b - a + 1;
          if (span < 6) break;
          let hits = 0;
          for (let i = a; i <= b; i++) if (isStrong[i]) hits++;
          if (hits / span >= 0.7 && (!best || span > best.n)) {
            best = { from: positions[a].v, to: positions[b].v, n: span };
          }
          break;   // longest b for this a is enough
        }
      }
      return best && best.n >= 6 ? best : null;
    };

    const vRun = runOf(rowSig, y0, area.y + area.h - 1, area.y);
    const hRun = runOf(colSig, x0, area.x + area.w - 1, area.x);
    if (!vRun || !hRun) continue;

    const top = vRun.from, left = hRun.from;

    // How many squares a run of lines bounds depends on whether the board's far
    // edge drew a line of its own, which is not something to rely on: the same
    // board gave ten lines down and nine across, so counting them as n-1 either
    // way lost a column. Both readings are tried and the one whose squares
    // actually read as squares is kept.
    const readable = (rowCount, colCount) => {
      if (rowCount < 5 || colCount < 5 || rowCount > 40 || colCount > 40) return -1;
      if (top + rowCount * pitch > area.y + area.h + pitch) return -1;
      if (left + colCount * pitch > area.x + area.w + pitch) return -1;
      let known = 0, total = 0;
      for (let r = 0; r < rowCount; r++) {
        for (let c = 0; c < colCount; c++) {
          total++;
          if (classifyCell(data, w, h, left + c * pitch, top + r * pitch, pitch, thresholds) !== null) known++;
        }
      }
      return total ? known / total : -1;
    };
    let rows = 0, cols = 0, bestFrac = -1;
    for (const rc of [vRun.n - 1, vRun.n]) {
      for (const cc of [hRun.n - 1, hRun.n]) {
        const frac = readable(rc, cc);
        if (frac < 0) continue;
        // A column of frame beside the board reads exactly like a column of
        // empty squares — the boundary at its left really is the last square's
        // right edge, so no measurement separates them. What does is that
        // Minesweeper boards come in known shapes: 9x9, 16x16, 16x30. A reading
        // that is one of those is preferred over one that is not, and a board of
        // some other size is still accepted when nothing standard fits.
        const known = levelOf(rc, cc) ? 1 : 0;
        const rank = frac + known;
        if (rank > bestFrac || (rank === bestFrac && rc * cc > rows * cols)) {
          bestFrac = rank; rows = rc; cols = cc;
        }
      }
    }
    if (bestFrac < 0.95) continue;
    bestFrac = Math.min(bestFrac, 1);

    // Prefer the reading that classifies the most squares. A wrong spacing can
    // still line up with something; it cannot also produce squares that read as
    // Minesweeper squares.
    const score = bestFrac * rows * cols;
    if (!bestGrid || score > bestGrid.score) {
      bestGrid = { x: left, y: top, pitch, rows, cols, threshold, thresholds, score };
    }
  }
  return bestGrid;
}

/**
 * Read the whole board.
 * Returns { board, rows, cols, grid } or null when it cannot be read.
 */
export function readState(canvasEl, gridHint = null) {
  const grid = gridHint || findGrid(canvasEl);
  if (!grid) return null;
  const img = imageData(canvasEl);
  if (!img) return null;
  const { data, w, h } = img;

  const board = [];
  let unread = 0;
  for (let r = 0; r < grid.rows; r++) {
    const row = [];
    for (let c = 0; c < grid.cols; c++) {
      const v = classifyCell(data, w, h, grid.x + c * grid.pitch, grid.y + r * grid.pitch,
        grid.pitch, grid.thresholds ?? grid.threshold);
      if (v === null) { unread++; row.push(UNKNOWN); } else row.push(v);
    }
    board.push(row);
  }
  // A square that cannot be read must not pass as covered: the solver would
  // treat it as somewhere still to explore and reason about a board that is not
  // there. An incomplete read is no read.
  if (unread > 0) return null;
  return { board, rows: grid.rows, cols: grid.cols, grid };
}

/**
 * Report what is actually on screen, for when a read fails.
 *
 * Written because the alternative is guessing at a site's appearance, which cost
 * several rounds on 2048 and again here. This reports measurements, not verdicts.
 */
export function diagnose(canvasEl) {
  const out = { ok: false, notes: [] };
  const img = imageData(canvasEl);
  if (!img) { out.notes.push("no canvas / getImageData failed"); return out; }
  const { data, w, h } = img;
  out.canvas = `${w}×${h}`;

  const buckets = new Map();
  const st = Math.max(1, Math.floor(Math.min(w, h) / 120));
  for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
    const c = px(data, w, x, y);
    const key = `${c[0] >> 4},${c[1] >> 4},${c[2] >> 4}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  out.topColors = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => { const [r, g, b] = k.split(",").map(Number); return `rgb(${r * 16},${g * 16},${b * 16})×${n}`; });

  const area = boardRegion(data, w, h);
  if (!area) {
    out.notes.push("no large flat-grey region found — is the board on screen and uncovered?");
    return out;
  }
  out.area = `${area.w}×${area.h} at ${area.x},${area.y}`;

  const { cols: colSig, rows: rowSig } = edgeProfiles(data, w, h, area);
  out.colPeriods = periodCandidates(colSig).join(", ") || "none";
  out.rowPeriods = periodCandidates(rowSig).join(", ") || "none";

  const grid = findGrid(canvasEl);
  if (!grid) {
    out.notes.push("no spacing produced a usable grid of cells");
    return out;
  }
  out.grid = `${grid.cols}×${grid.rows}, cell ${grid.pitch}px at ${grid.x},${grid.y}`;
  out.raisedThreshold = grid.threshold.toFixed(1);

  // What each of the first few squares measured, so a misread can be placed.
  out.cells = [];
  for (let r = 0; r < Math.min(3, grid.rows); r++) {
    for (let c = 0; c < Math.min(6, grid.cols); c++) {
      const x = grid.x + c * grid.pitch, y = grid.y + r * grid.pitch;
      const b = bevel(data, w, h, x, y, grid.pitch);
      const inside = cellInterior(data, w, h, x, y, grid.pitch);
      const mid = arr => { const s = arr.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
      const bg = [mid(inside.map(k => k[0])), mid(inside.map(k => k[1])), mid(inside.map(k => k[2]))];
      const ink = inside.filter(k => dist2(k, bg) > 2200).length / inside.length;
      const v = classifyCell(data, w, h, x, y, grid.pitch, grid.thresholds ?? grid.threshold);
      out.cells.push(`r${r}c${c} bg rgb(${bg.join(",")}) bevel ${b.toFixed(1)} ink ${(ink * 100).toFixed(0)}% → ${v === null ? "UNREADABLE" : v === UNKNOWN ? "covered" : v === FLAG ? "flag" : v === MINE ? "mine" : v}`);
    }
  }
  const state = readState(canvasEl, grid);
  out.ok = !!state;
  if (state) { out.board = state.board; out.state = state; }
  else out.notes.push("some squares could not be classified — see the cell measurements above");
  return out;
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
