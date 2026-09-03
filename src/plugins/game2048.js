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
// Is this pixel part of the board's frame?
//
// Only the board's own background counts — not the tiles. Tiles from 128 up cast
// a glow, `box-shadow: 0 0 30px 10px rgba(243,215,116,...)`, and that colour sits
// about 10 from the 128 tile itself, so matching the whole palette swallowed the
// glow and stretched the detected board ~50px past its real edges. Every tile
// position then shifted and reads failed — but only once the board had grown a
// 128, which is exactly when it went wrong in play.
//
// The background is always visible regardless: 2048 draws a 15px border around
// the grid and a 15px gap between every cell, so it forms a connected lattice
// whose bounding box is the board, however full the board gets.
function isBoardPixel(rgb, tol) {
  return dist2(rgb, BOARD_BG) <= tol;
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
  return refineRect(data, w, h, { x, y, w: bw, h: bh }, tol);
}

/**
 * Tighten a detected board rectangle to its true pixel edges.
 *
 * The search above works on a coarse mask, so its rectangle can overshoot by a
 * step in each direction. Cell positions are derived from that rectangle, so the
 * error accumulates across the grid and lands worst on the far cells — a board
 * measured 6px too wide was enough to cut the digit off the last tile and fail
 * the read. The board's border is a solid band of its background colour, so the
 * real edge is where a row or column stops being mostly that colour.
 */
function refineRect(data, w, h, rect, tol = 900) {
  const isBg = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = (y * w + x) * 4;
    return dist2([data[i], data[i + 1], data[i + 2]], BOARD_BG) <= tol;
  };
  const margin = Math.ceil(Math.min(w, h) / 180) + 2;
  const rowFrac = y => {
    let n = 0, t = 0;
    for (let x = rect.x; x < rect.x + rect.w; x += 2) { t++; if (isBg(x, y)) n++; }
    return t ? n / t : 0;
  };
  const colFrac = x => {
    let n = 0, t = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 2) { t++; if (isBg(x, y)) n++; }
    return t ? n / t : 0;
  };
  const scan = (from, to, frac) => {
    const dir = to > from ? 1 : -1;
    for (let v = from; dir > 0 ? v <= to : v >= to; v += dir) if (frac(v) > 0.6) return v;
    return null;
  };
  const top = scan(rect.y - margin, rect.y + margin, rowFrac);
  const bottom = scan(rect.y + rect.h + margin, rect.y + rect.h - margin, rowFrac);
  const left = scan(rect.x - margin, rect.x + margin, colFrac);
  const right = scan(rect.x + rect.w + margin, rect.x + rect.w - margin, colFrac);
  if (top == null || bottom == null || left == null || right == null) return rect;
  const out = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  if (out.w < 40 || out.h < 40) return rect;
  return out;
}

// Where the board was last seen. The game-over overlay washes the board
// background toward its own colour, so detection fails exactly when the overlay
// is up — which is precisely when the "Try again" button needs locating. The
// board does not move, so the last good rectangle stands in.
let lastGoodRect = null;

function boardRectOrLast(data, w, h) {
  const found = findBoardRect(data, w, h);
  if (found) { lastGoodRect = found; return found; }
  return lastGoodRect;
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
      // Tighter than tile matching on purpose: the dark digits printed on 2 and
      // 4 tiles are rgb(119,110,101), only about 27 from the button colour
      // rgb(143,122,102). A loose match turns tile numbers into "buttons".
      if (dist2([data[i], data[i + 1], data[i + 2]], BUTTON_BG) <= 500) pts.push([x, y]);
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
  return clusters.filter(c => {
    if (c.n < 15 || (c.maxX - c.minX) <= 30 || (c.maxY - c.minY) <= 10) return false;
    // A button is a SOLID rectangle, so nearly every sample inside its bounds
    // matches. Glyphs are strokes with gaps and fill only a small fraction of
    // their bounding box — this is what separates real buttons from text.
    const cols = Math.floor((c.maxX - c.minX) / step) + 1;
    const rows = Math.floor((c.maxY - c.minY) / step) + 1;
    const fill = c.n / Math.max(1, cols * rows);
    return fill >= 0.55;
  });
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

  const known = rectHint || boardRectOrLast(data, w, h);
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

  const rect = known;
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
/**
 * Read the overlay covering the board, if any, and what it offers.
 *
 * 2048 puts up two different overlays and they are told apart by how many
 * buttons sit over the board: winning offers "Keep going" and "Try again", while
 * losing offers only "Try again". That difference matters because the two are
 * not interchangeable — on a win the game is still playable and its board is
 * worth keeping, and clicking the wrong control throws it away.
 *
 * Returns { kind: "win" | "over", options: [...] }, where each option carries
 * where to click. "New Game" sits above the board and is always offered.
 */
export function readOverlay(canvasEl, rectHint = null) {
  if (!canvasEl || !canvasEl.width) return null;
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return null; }
  const rect = rectHint || boardRectOrLast(data, w, h);
  if (!rect) return null;

  const centre = c => ({ x: Math.round((c.minX + c.maxX) / 2), y: Math.round((c.minY + c.maxY) / 2) });
  const clusters = buttonClusters(data, w, h);
  const inside = clusters
    .filter(c => {
      const p = centre(c);
      return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
    })
    .sort((a, b) => a.minX - b.minX);   // left to right
  if (!inside.length) return null;

  const above = clusters
    .filter(c => {
      const p = centre(c);
      return p.y < rect.y && p.y > rect.y - rect.h &&
             p.x > rect.x - rect.w * 0.3 && p.x < rect.x + rect.w * 1.3;
    })
    .sort((a, b) => b.minY - a.minY)[0];
  const newGame = above ? { id: "new-game", label: "New Game", ...centre(above) } : null;

  if (inside.length >= 2) {
    // Win: "Keep going" is drawn to the left of "Try again".
    const options = [
      { id: "keep-going", label: "Keep going", ...centre(inside[0]) },
      { id: "try-again", label: "Try again", ...centre(inside[1]) },
    ];
    if (newGame) options.push(newGame);
    return { kind: "win", options };
  }

  const options = [{ id: "try-again", label: "Try again", ...centre(inside[0]) }];
  if (newGame) options.push(newGame);
  return { kind: "over", options };
}

export function isGameOverScreen(canvasEl) {
  return readOverlay(canvasEl) !== null;
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
// The board is not four equal quarters. 2048 lays out 106.25px cells with a
// 15px gap on every side, so a board of width B has
//   gap  = B * 15 / (4*106.25 + 5*15) = B * 0.03
//   cell = B * 106.25 / (...)         = B * 0.2125
// Dividing the board by four instead put every sample progressively off, and for
// the top row it landed them exactly on the tile's edge — which is why reads
// failed there and nowhere else.
const GAP_FRAC = 15 / (4 * 106.25 + 5 * 15);
const CELL_FRAC = 106.25 / (4 * 106.25 + 5 * 15);

function tileRect(rect, r, c) {
  const gap = rect.w * GAP_FRAC;
  const cw = rect.w * CELL_FRAC, chh = rect.h * CELL_FRAC;
  const gy = rect.h * GAP_FRAC;
  return {
    x: rect.x + gap + c * (cw + gap),
    y: rect.y + gy + r * (chh + gy),
    w: cw, h: chh,
  };
}

// Sampled inside the tile, in the bands above and below the centred number and
// clear of the 1px white inset border every tile draws just inside its edge
// (`inset 0 0 0 1px rgba(255,255,255,...)`), plus the glow that tiles from 128
// up cast over their neighbours.
const SAMPLE_XS = [0.22, 0.32, 0.42, 0.58, 0.68, 0.78];
const SAMPLE_YS = [0.16, 0.21, 0.26, 0.74, 0.79, 0.84];
const TEXT_LIGHT = [249, 246, 242];
const TEXT_DARK = [119, 110, 101];

function isTextPixel(rgb) {
  return dist2(rgb, TEXT_LIGHT) <= 900 || dist2(rgb, TEXT_DARK) <= 1600;
}

/**
 * Identify one cell by the median of many interior samples.
 *
 * Matching pixels individually and voting does not work for the high tiles: 128,
 * 256, 512, 1024 and 2048 are all near-identical yellows about 17 apart, while
 * scaling the capture blurs each pixel by more than that. Individual pixels then
 * scatter across several tiers and the winner of the vote is close to arbitrary
 * — which is why every board above 128 was read as 128.
 *
 * The median across ~40 samples cancels that noise (and ignores stray glyph or
 * edge pixels), leaving a value accurate to a channel or two, which resolves the
 * 17-unit gaps cleanly. A read is rejected unless the winning colour is
 * distinctly closer than the runner-up, so an animating tile reads as unknown
 * rather than as the wrong number.
 */
/**
 * Read the number printed on a tile.
 *
 * Colour alone cannot separate the high tiles: 128, 256, 512, 1024 and 2048 are
 * near-identical yellows about 17 apart, which is within the noise a screen
 * capture adds. The printed number is unambiguous, so it is the primary source
 * and colour is only the fallback. Requires the capture not to be downscaled —
 * the digits need the resolution.
 */
function readTileNumber(data, w, h, cx, cy, cw, ch, bgColour) {
  // Inset past the rounded corners and the 1px white inset border.
  const x0 = Math.round(cx + cw * 0.06), x1 = Math.round(cx + cw * 0.94);
  const y0 = Math.round(cy + ch * 0.06), y1 = Math.round(cy + ch * 0.94);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 12 || bh < 12) return null;

  // The number is whatever contrasts with this tile's own background, rather
  // than a specific ink colour. Different 2048 sites use different palettes and
  // different text colours, and matching fixed ones ties the reader to one
  // site's stylesheet; contrast against the measured background does not care
  // what either colour actually is.
  const mask = new Uint8Array(bw * bh);
  let ink = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y0 + y) * w + (x0 + x)) * 4;
      const on = dist2([data[i], data[i + 1], data[i + 2]], bgColour) > 4000 ? 1 : 0;
      mask[y * bw + x] = on;
      ink += on;
    }
  }
  // Too little contrast anywhere means no number is drawn — an empty cell.
  if (ink < bw * bh * 0.02) return 0;
  const n = readNumber(mask, bw, bh);
  if (n === null) return null;
  // Only powers of two from 2 up are real tiles; anything else is a misread.
  if (n < 2 || n > 131072 || (n & (n - 1)) !== 0) return null;
  return n;
}

// What a failed read saw, so the log can say why rather than only that it failed.
const lastFailure = { cells: [] };

export function lastReadFailure() {
  if (!lastFailure.cells.length) return null;
  return lastFailure.cells
    .map(c => `r${c.r}c${c.c} rgb(${c.rgb.join(",")})`)
    .join("  ");
}

// The same corner sampling readCell uses, for reporting a failure.
function sampleCellColour(data, w, h, cx, cy, cw, ch) {
  const rs = [], gs = [], bs = [];
  for (const fy of SAMPLE_YS) {
    for (const fx of SAMPLE_XS) {
      const px = Math.round(cx + cw * fx), py = Math.round(cy + ch * fy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return [0, 0, 0];
  const mid = a => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return [mid(rs), mid(gs), mid(bs)];
}

function readCell(data, w, h, cx, cy, cw, ch) {
  // Sample only the four corner patches. The number is drawn centred, so a ring
  // around it still catches the glyph when the number is wide or the font large
  // — a "4" sampled that way returned the dark text colour, matched nothing in
  // the palette, and took the whole board down with it. The corners are
  // background for every tile regardless of how many digits it has.
  const rs = [], gs = [], bs = [];
  for (const fy of SAMPLE_YS) {
    for (const fx of SAMPLE_XS) {
      const px = Math.round(cx + cw * fx);
      const py = Math.round(cy + ch * fy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      const c = [data[i], data[i + 1], data[i + 2]];
      if (isTextPixel(c)) continue;   // glyph antialiasing — ignore
      rs.push(c[0]); gs.push(c[1]); bs.push(c[2]);
    }
  }
  if (rs.length < 6) return null;
  const mid = arr => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
  const avg = [mid(rs), mid(gs), mid(bs)];

  // The printed number decides, and nothing overrides it.
  //
  // Colour cannot identify a tile on its own: neighbouring values differ by only
  // about 17 (128/256, 256/512, 512/1024, and 2/4 by 18), which is inside
  // capture noise, and the palette differs between 2048 sites anyway. Falling
  // back to the nearest colour did not fail loudly — it returned a real but
  // wrong tile, so a 512 was recorded as a 256 and the solver kept trying to
  // merge a pair that was not there.
  const printed = readTileNumber(data, w, h, cx, cy, cw, ch, avg);
  if (printed !== null) return printed;

  // Unreadable. The colour is reported so the log can say what was actually on
  // screen, but it is never used as the answer.
  return null;
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
  lastGoodRect = rect;

  const board = [];
  let unread = 0;
  lastFailure.cells = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const t = tileRect(rect, r, c);
      const v = readCell(data, w, h, t.x, t.y, t.w, t.h);
      if (v === null) {
        unread++;
        row.push(0);
        // Record what the cell actually looked like so a failure can be
        // diagnosed from the log instead of guessed at.
        if (lastFailure.cells.length < 4) {
          lastFailure.cells.push({ r, c,
            rgb: sampleCellColour(data, w, h, t.x, t.y, t.w, t.h) });
        }
      } else row.push(v);
    }
    board.push(row);
  }
  // A cell that cannot be read must never be reported as empty. Doing so told
  // the solver it had free space exactly where a large tile sat, so it planned
  // around room that did not exist and suffocated while its score kept climbing.
  // An incomplete read is no read: the caller retries or falls back.
  if (unread > 0) return null;
  return { board, rect };
}

// ── Game mechanics ────────────────────────────────────────────────────────────

// ── Reading SCORE and BEST from the page ──────────────────────────────────────
// The score the agent reports must come from the game, not from its own tally of
// the merges it thinks it made: that tally is only as good as the board read
// behind it, and when the reader was wrong it produced scores the board could
// never have produced. BEST cannot be derived at all — it is the game's own
// record across runs — so both are read from the two boxes above the board.
//
// Digits are white on the box fill, so segmentation is a colour threshold and a
// column projection. Classification uses shape rather than a font template:
// counting enclosed holes and where they sit separates 0/4/6/8/9, and coarse ink
// profiles separate 1/2/3/5/7. Anything ambiguous returns null, and the caller
// keeps its previous value rather than recording a guess.

// Digits are pure white; the page background behind the boxes is (250,248,239),
// only 330 away, so this has to stay tight or the whole page matches.
const DIGIT_WHITE_MAX = 200;

// Count enclosed background regions in a binary glyph (holes), and note the
// vertical centre of the largest one.
function holesOf(grid, gw, gh) {
  const seen = new Uint8Array(gw * gh);
  const holes = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (grid[i] || seen[i]) continue;
      // Flood the background region; it is a hole only if it never touches the edge.
      const stack = [[x, y]];
      seen[i] = 1;
      let touchesEdge = false, n = 0, sumY = 0;
      while (stack.length) {
        const [px, py] = stack.pop();
        n++; sumY += py;
        if (px === 0 || py === 0 || px === gw - 1 || py === gh - 1) touchesEdge = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (grid[ni] || seen[ni]) continue;
          seen[ni] = 1; stack.push([nx, ny]);
        }
      }
      if (!touchesEdge && n >= 3) holes.push({ n, cy: sumY / n / gh });
    }
  }
  holes.sort((a, b) => b.n - a.n);
  return holes;
}

// Averaged shapes of each digit over three sans-bold fonts at five sizes, as a
// 10x15 grid of ink fractions quantised to 0-9. Averaging across fonts rather
// than copying one keeps the match from depending on the exact face the page
// uses. Enclosed-hole count gates which digits are even considered, which is a
// property of the shape rather than the font and rules out most confusions
// outright (4 against 1, 8 against 6, 9 against 3).
const TPL_W = 10, TPL_H = 15;
const DIGIT_TEMPLATES = [
  "001479520002799999401798557993399400289569810006988981000599997100059999710005999971000599898100059979810006994993001796189733699303899999610025896400",
  "112466422334566663335666897333654599733332248873330002666333000266633300026663330002666333000266633300026663330002666333222366745555556688886666668999",
  "013589631035999999615887557995566200379834400016980110002798000000489500000479720001499720001599620001699410001598410000599743333389999999999999999999",
  "013589630015999999613887558994365100389623200027960000004883001356884000238997200012457983000000279811100016995650001799687533699747999999822257996410",
  "000017994000003999400001799940000495894000276289400069228940028602894016810289404940028940884334895399999999998888889998111112894100000289400000028940",
  "279999999327999999932796555541389200000038911210003984797410499999997148754479951110002798000000169900000016994440002798787534799547999999611257985410",
  "001359842000699999710598656784289510033259810000007972265310997689986199985579959994001798898200059969710005994993000698189733599602899999710025797410",
  "999999999999999999995555556898000000289500000069710000049840000018961000003984000001696200000389410000069820000017961000004994000000599200000069810000",
  "003489630004999999613998446994598300179659820017962895113893038877884102799898302896224984798100169899700005998981001698699622499716998899820146997420",
  "002488420004999998303997557982698200289589700017989970001698898100279959962259991699999899015786369800012006971220002794387434798217999998300157975200",
];
const HOLES_OF_DIGIT = [1, 0, 0, 0, 1, 0, 1, 0, 2, 1];

function classifyDigit(cells) {
  // A binary copy is what the hole count is computed on.
  const bin = new Uint8Array(TPL_W * TPL_H);
  for (let i = 0; i < cells.length; i++) bin[i] = cells[i] > 0.5 ? 1 : 0;
  const nHoles = holesOf(bin, TPL_W, TPL_H).length;

  let candidates = [];
  for (let d = 0; d < 10; d++) if (HOLES_OF_DIGIT[d] === nHoles) candidates.push(d);
  if (!candidates.length) candidates = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  let best = null, bestD = Infinity, secondD = Infinity;
  for (const d of candidates) {
    const tpl = DIGIT_TEMPLATES[d];
    let sum = 0;
    for (let i = 0; i < cells.length; i++) {
      const diff = cells[i] - (tpl.charCodeAt(i) - 48) / 9;
      sum += diff * diff;
    }
    if (sum < bestD) { secondD = bestD; bestD = sum; best = d; }
    else if (sum < secondD) secondD = sum;
  }
  // Ambiguous match: report nothing rather than a wrong digit, so the caller
  // keeps the value it already has.
  if (candidates.length > 1 && bestD > secondD * 0.85) return null;
  return best;
}

// Split the ink into digits by columns that contain no ink, then classify each.
function readNumber(mask, w, h) {
  const colHas = new Array(w).fill(false);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) if (mask[y * w + x]) { colHas[x] = true; break; }
  }
  const spans = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    if (x < w && colHas[x]) { if (start < 0) start = x; }
    else if (start >= 0) { spans.push([start, x - 1]); start = -1; }
  }
  if (!spans.length || spans.length > 9) return null;

  let out = "";
  for (const [x0, x1] of spans) {
    let y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = x0; x <= x1; x++) {
        if (mask[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
      }
    }
    if (y1 < y0) return null;
    const dw = x1 - x0 + 1, dh = y1 - y0 + 1;
    if (dh < 9) return null;   // below this the strokes merge and holes close up
    // Average the ink over each cell rather than sampling one pixel: a single
    // sample throws away most of the glyph and makes thin strokes disappear.
    const cells = new Float32Array(TPL_W * TPL_H);
    for (let gy = 0; gy < TPL_H; gy++) {
      for (let gx = 0; gx < TPL_W; gx++) {
        const sx0 = x0 + gx * dw / TPL_W, sx1 = x0 + (gx + 1) * dw / TPL_W;
        const sy0 = y0 + gy * dh / TPL_H, sy1 = y0 + (gy + 1) * dh / TPL_H;
        let on = 0, total = 0;
        for (let yy = Math.floor(sy0); yy < Math.max(Math.floor(sy0) + 1, Math.round(sy1)); yy++) {
          for (let xx = Math.floor(sx0); xx < Math.max(Math.floor(sx0) + 1, Math.round(sx1)); xx++) {
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            total++; on += mask[yy * w + xx];
          }
        }
        cells[gy * TPL_W + gx] = total ? on / total : 0;
      }
    }
    const d = classifyDigit(cells);
    if (d === null) return null;
    out += d;
  }
  return out.length ? Number(out) : null;
}

/**
 * Read the SCORE and BEST values shown above the board.
 * Returns { score, best } with null for anything that could not be read.
 */
export function readScores(canvasEl, rectHint = null) {
  if (!canvasEl || !canvasEl.width) return { score: null, best: null };
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return { score: null, best: null }; }

  const rect = rectHint || findBoardRect(data, w, h);
  if (!rect) return { score: null, best: null };

  // The boxes sit in the strip above the board. Find them by their fill colour
  // first — the same tone as the board — because the page behind them is nearly
  // white and searching for white digits across the whole strip matches the page
  // itself rather than the numbers.
  const y0 = Math.max(0, rect.y - Math.round(rect.h * 0.34));
  const y1 = Math.max(0, rect.y - 2);
  if (y1 - y0 < 12) return { score: null, best: null };

  const step = 2;
  const pts = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = rect.x; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (dist2([data[i], data[i + 1], data[i + 2]], BOARD_BG) <= 900) pts.push([x, y]);
    }
  }
  const boxes = [];
  for (const [x, y] of pts) {
    let placed = false;
    for (const bx of boxes) {
      // Tight: the two boxes are separated by only a thin strip of page
      // background, and a loose gap merges them into one number.
      if (x >= bx.minX - 4 && x <= bx.maxX + 4 && y >= bx.minY - 4 && y <= bx.maxY + 4) {
        bx.minX = Math.min(bx.minX, x); bx.maxX = Math.max(bx.maxX, x);
        bx.minY = Math.min(bx.minY, y); bx.maxY = Math.max(bx.maxY, y);
        bx.n++; placed = true; break;
      }
    }
    if (!placed) boxes.push({ minX: x, maxX: x, minY: y, maxY: y, n: 1 });
  }
  const found = boxes
    .filter(b => (b.maxX - b.minX) > 20 && (b.maxY - b.minY) > 12)
    .sort((a, b) => a.minX - b.minX);
  if (!found.length) return { score: null, best: null };

  const values = found.map(b => {
    // Skip the label ("SCORE" / "BEST") in the upper part of the box.
    const bx0 = b.minX, bx1 = b.maxX;
    const by0 = b.minY + Math.round((b.maxY - b.minY) * 0.34), by1 = b.maxY;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw < 6 || bh < 8) return null;
    const mask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = ((by0 + y) * w + (bx0 + x)) * 4;
        mask[y * bw + x] =
          dist2([data[i], data[i + 1], data[i + 2]], [255, 255, 255]) <= DIGIT_WHITE_MAX ? 1 : 0;
      }
    }
    return readNumber(mask, bw, bh);
  });

  // SCORE is the left box, BEST the right one.
  return { score: values[0] ?? null, best: values.length > 1 ? values[values.length - 1] : null };
}

// Exposed so the digit reader can be unit-tested directly. Reading numbers off
// the screen is the part most likely to break on an unfamiliar font, and testing
// it only through a whole board read makes a failure hard to place.
export const __ocr = { readNumber, classifyDigit, readTileNumber, tileRect };

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
  readScores, lastReadFailure, readOverlay,
};

export default plugin;
