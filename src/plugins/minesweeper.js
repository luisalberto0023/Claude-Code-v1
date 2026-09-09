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
 *
 * How far in to look cannot be fixed as a fraction of the square. A highlight
 * is drawn a couple of pixels wide whatever the zoom, so a probe at a tenth of
 * the way in sits inside it on a small square and past it on a large one — and
 * past it there is nothing to see, because a square's two edges are then both
 * plain interior and cancel. The symptom is not a wrong answer but silence:
 * every square measures zero, the grid is judged to have no edges at all, and
 * the correct spacing is thrown out in favour of a multiple of itself. That is
 * what "edges too faint (0.0)" was, at exactly the sizes where a three-pixel
 * bevel fell outside a tenth of the cell.
 *
 * So several depths are tried and the one that finds the most contrast wins.
 * A square with no bevel reads near zero at every depth, which is the answer.
 */
function bevel(data, w, h, x, y, pitch) {
  const from = Math.round(pitch * 0.25), to = Math.round(pitch * 0.75);
  const deepest = Math.max(1, Math.min(4, Math.round(pitch * 0.12)));
  let strongest = 0;
  for (let inset = 1; inset <= deepest; inset++) {
    let tl = 0, br = 0, n = 0;
    for (let k = from; k < to; k++) {
      tl += lum(px(data, w, x + k, y + inset));
      tl += lum(px(data, w, x + inset, y + k));
      br += lum(px(data, w, x + k, y + pitch - 1 - inset));
      br += lum(px(data, w, x + pitch - 1 - inset, y + k));
      n += 2;
    }
    const v = n ? (tl - br) / n : 0;
    if (Math.abs(v) > Math.abs(strongest)) strongest = v;
  }
  return strongest;
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

  // The square's own background, taken from a ring just inside its border.
  //
  // Not from the middle, and not from inner corners either. Whatever a square
  // contains is drawn centred, so the middle can be all glyph — but at the real
  // site's 24-pixel squares a printed 2 also covers the points a fifth of the
  // way in, and the "background" then came out as the digit's own green. Every
  // relationship after that inverts: the true grey becomes ink, and the vote
  // over it lands on grey, which is the colour of an 8. That is where a row
  // reading 1 2 1 1 2 came back as 1 8 1 1 8, and how a corner square with
  // three neighbours came to be read as a 7.
  //
  // A ring hugging the border is the one part of a square nothing is drawn in:
  // digits and mines are centred and inset, so it holds background whatever is
  // in the middle.
  const mid = arr => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const median3 = list =>
    [mid(list.map(c => c[0])), mid(list.map(c => c[1])), mid(list.map(c => c[2]))];
  const k = Math.max(2, Math.round(pitch * 0.13));
  const ringPixels = [];
  for (let i = k; i < pitch - k; i++) {
    ringPixels.push(px(data, w, x + i, y + k));
    ringPixels.push(px(data, w, x + i, y + pitch - 1 - k));
    ringPixels.push(px(data, w, x + k, y + i));
    ringPixels.push(px(data, w, x + pitch - 1 - k, y + i));
  }
  if (!ringPixels.length) return null;
  const bg = median3(ringPixels);
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

  // Which number it is, decided by the glyph's core rather than by a vote over
  // every pixel that differs from the background.
  //
  // Most of a small printed digit is edge: pixels part-way between the ink and
  // the paper. Those blends sit near mid-grey, which is the colour of an 8, so
  // counting them lets any digit outvote itself. The pixels furthest from the
  // background are the ones actually painted in the digit's colour, and their
  // median is that colour — a single measurement instead of a poll, and it does
  // not care how much of the square the glyph covers or how soft its edges are.
  const core = ink.slice().sort((a, b) => dist2(b, bg) - dist2(a, bg))
    .slice(0, Math.max(1, Math.round(ink.length / 3)));
  const paint = median3(core);
  let picked = null, bestD = Infinity;
  for (const t of NUMBER_COLOURS) {
    const d = dist2(paint, t.rgb);
    if (d < bestD) { bestD = d; picked = t.n; }
  }
  // Far from every one of them is not a digit at all — something is covering the
  // square, and reporting a number for it would be a guess.
  return bestD <= 20000 ? picked : null;
}

/**
 * Find the grid, and how raised squares look on this particular board.
 *
 * Candidate spacings are laid over the picture and judged by whether the squares
 * they imply actually behave like cells — that is a far better arbiter than the
 * strength of a correlation, which can lock onto twice the pitch when covered
 * and opened rows alternate.
 */
// What the last grid search looked at and why it turned each spacing down.
// "No grid" on its own has cost several rounds of guessing at what the reader
// disliked, so it now says.
let gridTrace = null;
export function lastGridSearch() { return gridTrace; }

export function findGrid(canvasEl) {
  const img = imageData(canvasEl);
  if (!img) return null;
  const { data, w, h } = img;
  const area = boardRegion(data, w, h);
  if (!area) { gridTrace = { area: null, peaks: [], tried: [] }; return null; }

  const { cols: colSig, rows: rowSig } = edgeProfiles(data, w, h, area);

  // Every multiple of the true spacing correlates too, and on a board whose
  // lines are faint the multiple can correlate better — so the peaks alone are
  // not enough. Taking one lands on a grid of 6x10 squares where there are
  // 16x30, and the board it produces is not partly wrong, it is wholly wrong:
  // each "square" spans nine real ones, reads as whatever sits at its top left,
  // and nothing downstream can tell. So every candidate's divisors are tried
  // alongside it, and the scoring below — which rewards a spacing that yields
  // more squares that read as squares — settles which is real.
  const peaks = [...new Set([...periodCandidates(colSig), ...periodCandidates(rowSig)])];
  const withDivisors = new Set();
  for (const p of peaks) {
    withDivisors.add(p);
    for (let d = 2; d <= 6; d++) if (p % d === 0) withDivisors.add(p / d);
  }
  const candidates = [...withDivisors].filter(p => p >= 8).sort((a, b) => a - b);

  // Why each spacing was rejected. Reported by diagnose(), because "no grid" on
  // its own has cost several rounds of guessing at what the reader disliked.
  gridTrace = { area, peaks: [...peaks].sort((a, b) => a - b), tried: [] };
  const reject = (pitch, why) => gridTrace.tried.push({ pitch, why });

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
    if (samples.length < 25) { reject(pitch, `only ${samples.length} squares fit`); continue; }
    const magnitudes = samples.map(Math.abs).sort((a, b) => a - b);
    const scale = magnitudes[Math.floor(magnitudes.length * 0.9)];
    if (scale < 12) { reject(pitch, `edges too faint (${scale.toFixed(1)})`); continue; }
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
    if (!vRun || !hRun) { reject(pitch, !vRun && !hRun ? "no run of grid lines either way" : !vRun ? "no run of horizontal lines" : "no run of vertical lines"); continue; }

    // Where the squares start, and how many there are.
    //
    // Two things are uncertain, not one. A run of n lines bounds n-1 squares if
    // both outer edges drew a line and n if only one did — the same board gave
    // ten lines down and nine across. And the run itself can begin a square
    // late: where the frame meets the first column there is sometimes almost no
    // edge to see, the run starts at the second line instead, and the board
    // comes out shifted one column across. That reads a real 30-wide board as
    // columns 1..30, dropping the first and taking a strip of frame as the
    // last — a whole board of plausible-looking squares, every one of them in
    // the wrong place.
    //
    // So the start is a candidate too, and the readings are judged by three
    // things: whether the squares read as squares, whether the shape is one
    // Minesweeper actually uses, and whether the board could exist at all. The
    // last is what separates a one-square shift from the truth, because a
    // misaligned board puts numbers where no number could be.
    // The run can begin a square early as well as a square late — early when a
    // frame edge is strong enough to pass for a grid line, late when the join
    // between frame and first column is not. Both happened on the same site,
    // one on each axis of the same picture.
    //
    // Which means the number of squares cannot be counted from the run either:
    // a run of eighteen lines starting one square early bounds sixteen squares,
    // not seventeen. So it is measured from the chosen start to the run's far
    // end, which is a real grid line whatever happened at the near one.
    const starts = axis => [axis.from, axis.from - pitch, axis.from + pitch];
    const counts = (axis, anchor) => {
      const fit = Math.round((axis.to - anchor) / pitch);
      return [fit, fit + 1, fit - 1];
    };

    const evaluate = (top, left, rowCount, colCount) => {
      if (rowCount < 5 || colCount < 5 || rowCount > 40 || colCount > 40) return null;
      if (top < 0 || left < 0) return null;
      if (top + rowCount * pitch > area.y + area.h + pitch) return null;
      if (left + colCount * pitch > area.x + area.w + pitch) return null;
      const board = [];
      let known = 0, total = 0;
      for (let r = 0; r < rowCount; r++) {
        const row = [];
        for (let c = 0; c < colCount; c++) {
          const v = classifyCell(data, w, h, left + c * pitch, top + r * pitch, pitch, thresholds);
          total++;
          if (v !== null) known++;
          row.push(v === null ? UNKNOWN : v);
        }
        board.push(row);
      }
      const frac = total ? known / total : 0;
      const why = implausible(board);
      const rank = frac + (levelOf(rowCount, colCount) ? 1 : 0) + (why ? 0 : 1);
      return { rank, frac, rowCount, colCount, top, left, why, unread: total - known };
    };

    // Nine placements each way is eighty-one boards, and reading every square of
    // each is far too much work to do per candidate spacing. Order them by how
    // likely they are instead — the shapes Minesweeper actually uses first, then
    // the alignments closest to the run as measured — and stop at the first that
    // is fully readable, a known shape, and legal, which is the ordinary case.
    const combos = [];
    for (const top of starts(vRun)) for (const rc of counts(vRun, top)) {
      for (const left of starts(hRun)) for (const cc of counts(hRun, left)) {
        combos.push({
          top, left, rc, cc,
          known: levelOf(rc, cc) ? 0 : 1,
          drift: Math.abs(top - vRun.from) + Math.abs(left - hRun.from),
        });
      }
    }
    combos.sort((a, b) => a.known - b.known || a.drift - b.drift);

    let pick = null, looked = 0;
    for (const k of combos) {
      if (looked >= 16) break;
      const got = evaluate(k.top, k.left, k.rc, k.cc);
      if (!got) continue;
      looked++;
      if (!pick || got.rank > pick.rank ||
          (got.rank === pick.rank && got.rowCount * got.colCount > pick.rowCount * pick.colCount)) {
        pick = got;
      }
      if (pick.rank >= 3) break;             // readable, a known shape, and legal
    }
    if (!pick || pick.frac < 0.95) {
      reject(pitch, pick
        ? `best was ${pick.rowCount}x${pick.colCount} at ${pick.left},${pick.top}: ${pick.unread} squares unreadable` +
          (pick.why ? `, and ${pick.why}` : "")
        : "no arrangement of squares fitted");
      continue;
    }

    // Prefer the reading that classifies the most squares. A wrong spacing can
    // still line up with something; it cannot also produce squares that read as
    // Minesweeper squares.
    const score = pick.rank * pick.rowCount * pick.colCount;
    if (!bestGrid || score > bestGrid.score) {
      bestGrid = {
        x: pick.left, y: pick.top, pitch,
        rows: pick.rowCount, cols: pick.colCount,
        threshold, thresholds, score,
      };
    }
  }
  return bestGrid;
}

/**
 * Read the whole board.
 * Returns { board, rows, cols, grid } or null when it cannot be read.
 */
/**
 * The grid, once found, is kept and reused.
 *
 * findGrid measures spacing from where brightness changes sharply, so what it
 * sees depends on what is drawn on the board — and that changes with every
 * move. Re-deriving the grid from each frame meant the geometry drifted as
 * squares opened: a run would read cleanly at first and then start failing, or
 * worse, lock onto an origin a couple of pixels out, at which point every
 * square is sampled across its own border and a live board reads as untouched.
 * That is what "best guess — 20.6% chance of a mine" was: 99/480, the density
 * of a board with nothing on it, on a board with a hundred squares open.
 *
 * The board does not move while it is being played, so the grid is measured
 * once, reused, and only re-measured when it stops reading.
 */
let lockedGrid = null;
let lastUnreadable = [];
let lastImpossible = null;
let lockDrops = 0;

/** Forget the locked grid — the board has moved, or a new one has started. */
export function resetGrid() { lockedGrid = null; }

/** The grid currently locked in, for the HUD and for diagnostics. */
export function getGrid() { return lockedGrid; }

const gridFits = (grid, w, h) =>
  grid && grid.capture?.w === w && grid.capture?.h === h;

/**
 * Could this board exist?
 *
 * A number counts the mines around it, and mines are never on an opened square
 * — so a number can never exceed the count of its own unopened neighbours. A
 * corner square touches three others and can therefore never be more than a 3.
 *
 * This is worth checking because a misread board is not obviously broken. It
 * comes back a legal-looking grid, the solver reasons over it perfectly well,
 * and the agent plays the answer. The run that prompted this returned a corner
 * 7 sitting beside a pair of adjacent 8s — arithmetically impossible, and
 * nothing in the system objected. Board arithmetic is free and catches it.
 *
 * Returns a description of the first impossibility, or null.
 */
export function implausible(board) {
  const rows = board.length, cols = board[0]?.length ?? 0;
  const opened = v => v !== UNKNOWN && v !== FLAG && v !== MINE;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = board[r][c];
      if (!Number.isInteger(v) || v <= 0) continue;
      let room = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          if (!opened(board[nr][nc])) room++;
        }
      }
      if (v > room) {
        return `r${r}c${c} reads ${v} but has only ${room} unopened neighbour${room === 1 ? "" : "s"}`;
      }
    }
  }
  return null;
}

/**
 * A read is allowed to lose a few squares, but not to pretend they are covered.
 *
 * Demanding all 480 threw away whole games over one square — twice in four,
 * both times a square the pointer happened to be sitting on, and neither
 * anywhere near the move being considered. But an unreadable square must never
 * simply pass as covered either: the solver would treat it as somewhere still
 * to explore and reason about a board that is not there. So they are reported,
 * and chooseMove keeps its distance from them and refuses to gamble while any
 * remain.
 */
const MOST_UNREADABLE = 3;

function readOnGrid(data, w, h, grid) {
  const board = [];
  const unreadable = [];
  for (let r = 0; r < grid.rows; r++) {
    const row = [];
    for (let c = 0; c < grid.cols; c++) {
      const v = classifyCell(data, w, h, grid.x + c * grid.pitch, grid.y + r * grid.pitch,
        grid.pitch, grid.thresholds ?? grid.threshold);
      if (v === null) { unreadable.push([r, c]); row.push(UNKNOWN); } else row.push(v);
    }
    board.push(row);
  }
  if (unreadable.length > MOST_UNREADABLE) return { board: null, unreadable, why: null };
  // A board that cannot exist was misread, however cleanly it came out.
  const why = implausible(board);
  if (why) return { board: null, unreadable, why };
  return { board, unreadable, why: null };
}

export function readState(canvasEl, gridHint = null) {
  const img = imageData(canvasEl);
  if (!img) return null;
  const { data, w, h } = img;

  // Try the grid we already have before paying for detection again. Detection
  // is both the expensive part of a read and the part that drifts.
  const known = gridHint || (gridFits(lockedGrid, w, h) ? lockedGrid : null);
  if (known) {
    const { board, unreadable, why } = readOnGrid(data, w, h, known);
    if (board) {
      lastUnreadable = unreadable; lastImpossible = null;
      return { board, rows: known.rows, cols: known.cols, grid: known, unreadable };
    }
    lastUnreadable = unreadable; lastImpossible = why;
    if (known === lockedGrid) { lockedGrid = null; lockDrops++; }
  }

  const grid = findGrid(canvasEl);
  if (!grid) return null;
  const { board, unreadable, why } = readOnGrid(data, w, h, grid);
  if (!board) { lastUnreadable = unreadable; lastImpossible = why; return null; }
  lastUnreadable = unreadable; lastImpossible = null;
  lockedGrid = { ...grid, capture: { w, h } };
  return { board, rows: grid.rows, cols: grid.cols, grid: lockedGrid, unreadable };
}

/** Why the last read was rejected — for the log. */
export function lastReadFailure() {
  if (lastImpossible) return `the board could not exist — ${lastImpossible}`;
  if (!lastUnreadable.length) return null;
  const shown = lastUnreadable.slice(0, 8).map(([r, c]) => `r${r}c${c}`).join(" ");
  const tail = lastUnreadable.length > 8 ? ` … and ${lastUnreadable.length - 8} more` : "";
  const drops = lockDrops ? ` (grid re-measured ${lockDrops}×)` : "";
  return `${lastUnreadable.length} square${lastUnreadable.length > 1 ? "s" : ""}: ${shown}${tail}${drops}`;
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

  resetGrid();                       // diagnose measures, never reuses
  const grid = findGrid(canvasEl);
  // Say what each spacing was turned down for. "No grid" on its own has cost
  // several rounds of guessing at what the reader disliked; the reasons name it.
  const trace = lastGridSearch();
  if (trace?.tried?.length) {
    out.spacingsTried = trace.tried.map(t => `${t.pitch}px: ${t.why}`);
  }
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

  // Play around squares that could not be read.
  //
  // A deduction is local: it comes from a numbered square, and everything it
  // concludes is next to that square. So a conclusion can only be wrong because
  // of an unreadable square if the two are within two squares of each other,
  // and keeping that distance is enough to make what is played sound. Counting
  // arguments are not local in the same way, so while anything is unreadable
  // the odds cannot be trusted and nothing is risked on them.
  let actions = result.actions;
  if (state.unreadable?.length) {
    if (!result.certain) return null;
    const near = (r, c) => state.unreadable.some(
      ([ur, uc]) => Math.abs(ur - r) <= 2 && Math.abs(uc - c) <= 2);
    actions = actions.filter(a => !near(a.r, a.c));
    if (!actions.length) return null;
  }

  const { x, y, pitch } = state.grid;
  const half = Math.floor(pitch / 2);
  // Certain moves can be played together; a guess is played alone so the board
  // is re-read before anything is built on it.
  const chosen = result.certain ? actions : actions.slice(0, 1);
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

/**
 * Has a new game started?
 *
 * Restarts were confirmed by watching for the screen to change, which works
 * when a finished board is covered in revealed mines and fails when it is not:
 * a game abandoned after three moves looks almost identical to the fresh one
 * that replaces it, the change went unnoticed, and the session ended believing
 * it could not start another. A new board is not "different", it is empty, and
 * that is something to check rather than infer.
 */
export function looksLikeNewGame(state) {
  const { opened, flags, mines } = tally(state.board ?? state);
  return opened === 0 && flags === 0 && mines === 0;
}

/**
 * Somewhere to leave the pointer that is not on the board.
 *
 * The agent clicks a square and then looks at the board, which means the
 * pointer is sitting on the square it just played. A cursor is opaque: it
 * covered a red 3 on a real run and made that square unreadable six reads
 * running, and the game was given up with everything else on the board
 * perfectly legible. Below the last row is off the grid and still well inside
 * the window, so nothing is dragged or hovered by going there.
 */
export function parkPoint(state) {
  const g = state?.grid ?? lockedGrid;
  if (!g) return null;
  return { x: g.x + Math.round(g.cols * g.pitch / 2), y: g.y + g.rows * g.pitch + g.pitch };
}

export function isTerminal(state) {
  return outcomeOf(state).result !== "playing";
}

/**
 * How this game ended, in Minesweeper's own terms.
 *
 * "Board full — no legal moves, final score 0, highest tile 8" is 2048 talking,
 * and it hid what actually happened every single game: whether the run ended on
 * a mine or was cut short, and how much of the board it had cleared first.
 */
export function outcomeOf(state) {
  const board = state.board ?? state;
  const rows = state.rows ?? board.length;
  const cols = state.cols ?? board[0]?.length ?? 0;
  const { covered, opened, mines } = tally(board);
  const level = levelOf(rows, cols);
  const safeTotal = level ? rows * cols - level.mines : null;
  const cleared = safeTotal ? Math.round((opened / safeTotal) * 100) : null;

  // A revealed mine ends it immediately, however much is left covered.
  if (mines) {
    return {
      result: "lost", opened, cleared,
      detail: `opened a mine — ${opened} squares cleared${cleared != null ? ` (${cleared}% of the board)` : ""}`,
    };
  }
  // Otherwise won when every square that is not a mine has been opened.
  if (level && covered <= level.mines) {
    return { result: "won", opened, cleared: 100, detail: `cleared the board — every one of the ${safeTotal} safe squares` };
  }
  return { result: "playing", opened, cleared, detail: `${opened} squares cleared, ${covered} to go` };
}

/** What a finished game is worth: squares cleared. There is no running score. */
export function scoreOf(state) { return tally(state.board ?? state).opened; }

/** Count what is on a board, in the terms this game is scored in. */
export function tally(board) {
  let covered = 0, flags = 0, opened = 0, blank = 0, mines = 0;
  for (const row of board) {
    for (const v of row) {
      if (v === UNKNOWN) covered++;
      else if (v === FLAG) flags++;
      else if (v === MINE) mines++;
      else { opened++; if (v === 0) blank++; }
    }
  }
  return { covered, flags, opened, blank, mines };
}

export function describeState(state) {
  const board = state.board ?? state;
  const rows = state.rows ?? board.length;
  const cols = state.cols ?? board[0]?.length ?? 0;
  const { covered, flags, opened, mines } = tally(board);
  const level = levelOf(rows, cols);
  const hit = mines ? `, ${mines} mine${mines > 1 ? "s" : ""} showing` : "";
  return `${level?.label ?? `${rows}×${cols}`}: ${opened} opened, ${flags} flagged, ${covered} covered${hit}`;
}

/**
 * The board as text, for the log and for the saved record of a run.
 *
 * Every round of troubleshooting so far has been guesswork over a log that said
 * what the solver decided but never what it was looking at. A board that reads
 * as untouched and a board that is untouched produce the same line — "best
 * guess, 20.6%" — and only the picture tells them apart.
 */
export function renderBoard(board) {
  const sym = v =>
    v === UNKNOWN ? "·" : v === FLAG ? "⚑" : v === MINE ? "✱" : v === 0 ? " " : String(v);
  const width = String(board[0]?.length ?? 0).length;
  const head = "    " + board[0]?.map((_, c) => String(c % 10)).join("") ?? "";
  const lines = board.map((row, r) =>
    `${String(r).padStart(width)} |${row.map(sym).join("")}|`);
  return [head, ...lines].join("\n");
}

/**
 * Whether a fresh read can be squared with the one before it.
 *
 * Minesweeper only ever moves one way: a square that has been opened stays
 * open and keeps its number, and mines do not disappear. Anything else is the
 * reader being wrong, not the game changing — which is worth catching, because
 * a board misread as untouched still yields a legal-looking move, and the
 * agent will happily play it and lose. Returns a description of the first
 * contradiction, or null when the two are consistent.
 */
export function contradicts(prev, next) {
  if (!prev || !next) return null;
  const a = prev.board ?? prev, b = next.board ?? next;
  if (a.length !== b.length || a[0]?.length !== b[0]?.length) {
    return `board changed size (${a.length}×${a[0]?.length} → ${b.length}×${b[0]?.length})`;
  }
  const opened = v => v !== UNKNOWN && v !== FLAG;
  let reverted = 0, changed = 0, first = null;
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) {
      const was = a[r][c], now = b[r][c];
      if (!opened(was) || was === now) continue;
      if (!opened(now)) { reverted++; first ??= `r${r}c${c} was ${was}, now covered`; }
      else { changed++; first ??= `r${r}c${c} was ${was}, now ${now}`; }
    }
  }
  const total = reverted + changed;
  if (!total) return null;
  return `${total} opened square${total > 1 ? "s" : ""} disagree with the previous read (${first})`;
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
  findGrid, levelOf, LEVELS, MINE, findRestartButton, diagnose,
  // Reading and reporting: the agent uses these to check its own perception and
  // to describe a run in Minesweeper's terms rather than 2048's.
  resetGrid, getGrid, lastReadFailure, lastGridSearch, contradicts, renderBoard,
  outcomeOf, scoreOf, tally, implausible, parkPoint, looksLikeNewGame,
  // "Highest tile" means something in 2048 and nothing here, where the same
  // numbers count neighbouring mines. There is no running score either — what a
  // game is worth is how much of the board it cleared.
  tracksTiles: false,
  scoreLabel: "squares cleared",
  // Every click here is irreversible and a wrong one ends the game, so a turn
  // must never be handed to the model to click at coordinates it guessed. In
  // 2048 a wrong arrow key does nothing and the same fallback is harmless.
  blindMovesAreFatal: true,
};

export default plugin;
