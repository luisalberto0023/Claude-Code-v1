// What moved on screen between two frames, and where.
//
// The agent judges every action by whether the screen changed after it. That
// decides the no-op streak, when a game counts as stuck, whether the next turn
// sends a screenshot, and whether a restart worked. It used to be one number:
// the RMS of an 8×8 grid of mean brightness over the whole frame, against 2.0.
// That number cannot see a small edit. On the real Expert capture in
// tools/frames, opening one covered square moves it by 0.04 (as a blank) to
// 0.28 (as a "3"), 7 to 45 times short of the threshold, and by 0.01 to 0.08 on
// a whole 1920×1080 screen; a real 2048 move scored only 2 to 4 (commit
// 8121841). Meanwhile an animated background moves it all the time. And it
// cannot say where the change was, so a click that did nothing, beside a clock
// that ticked, read as a click that worked.
//
// Here the frame is averaged down to a 64×36 grid of grey levels. Two grids
// give, per cell, how far it moved; a noise floor taken from idle frames at the
// start of a game says how far each cell moves on its own (a clock, a blinking
// cursor, capture noise); and judge() looks for the change where the action
// acted: near the target for a click or a drag, anywhere in the view for keys
// and the gamepad.
//
// Every pixel counts toward its cell's mean. Letting the browser shrink the
// frame to 64×36 with drawImage would be one call too, but its filtering reads
// about four of the ~200 to 400 pixels behind each cell: on the same Expert
// capture, opening each of its 364 covered squares in turn, that missed 133
// outright, and a 2 px shift swung it by up to 190 grey levels. Averaging every
// pixel missed none (the weakest moved its cell by 14). So the page reads the frame
// once (pixelsOf, one getImageData) and this does the averaging, the same code
// tools/check-motion.mjs runs on the real captures in node.
//
// Pure: pixels in, numbers out. No DOM beyond a canvas handed in.

// The grid: 64×36 cells, 16:9 like most screens. A cell of a 1280×720 frame is
// 20×20 px, of the 920×620 board crop in tools/frames about 14×17.
export const MAP_COLS = 64;
export const MAP_ROWS = 36;

// A cell counts as changed when its mean grey level (0 to 255) moves by more
// than its limit: NOISE_GAIN times the noise calibrated for it, never less
// than MIN_DELTA and never more than MAX_LIMIT.
//
// MIN_DELTA: on a still screen a cell's mean does not move at all (the same
// pixels average to the same number), so this only has to clear rounding and a
// codec's odd flicker. The smallest real edit measured, one covered Minesweeper
// square opened as a blank on a whole 1920×1080 screen shrunk to 1280, moved its
// cell by 7; on the board crop, by 14 or more.
export const MIN_DELTA = 2;
// NOISE_GAIN: a floor from two idle frames is one sample of the noise per cell,
// and a comparison later looks at 2,304 cells at once, so the limit has to sit
// well out in the noise's tail. On a real capture with ±3 grey levels of noise
// in 8 px blocks (a codec's), 2.5 times the floor left no cell flagged in nine
// comparisons, where 2 times left five.
export const NOISE_GAIN = 2.5;
// MAX_LIMIT: high enough that a clock can be calibrated away (the real Expert
// page's timer, showing other digits, moves its cells by 20 to 45), so a key
// that did nothing is not read as working because the clock ticked meanwhile,
// which the old hash, too coarse to see a clock at all, got right. Capped, a
// floor taken while something was still settling cannot make those cells numb
// to everything for the rest of the game.
export const MAX_LIMIT = 64;

// How near its target a click's effect is looked for: within this many cells,
// each way. About 60 px on a 1280-wide frame; on the Expert board crop, two
// squares. A click that changed nothing near where it landed did nothing, even
// while a clock ticked across the screen.
export const NEAR_CELLS = 3;
// This share of the cells changed: the view as a whole changed (a new screen, a
// scroll, a fade). That counts as a change for any action, a click included.
export const GLOBAL_FRAC = 0.5;
// A restart has to show as a new screen: at least this share of the view
// changed, which a clock or a button's hover state alone does not reach. A
// click whose effect lands away from it (a dialog opening mid-screen, a card
// dealt to a far pile) counts from the same share, of cells where nothing
// moved on its own while the floor was taken: one opened square, a clock's
// tick or the pointer itself is a tenth of it or less. Before, a 420×300 panel
// opening mid-screen, 22% of the view, was "unchanged" for the click that
// opened it.
export const NEW_SCREEN_FRAC = 0.02;

// What moves on its own does not keep to the cells it moved in while the floor
// was taken. Every cell's floor is the most any cell within FLOOR_SPREAD cells of
// it moved, which is enough for a click, judged at its target. A key, typing,
// the gamepad or a scroll (WIDE_KINDS) is judged anywhere in the view, and a
// clock's next tick lights other segments of its digits, or another digit,
// cells away from the ones one tick lit: so those use the most within
// WIDE_SPREAD cells. On the bench Minesweeper's timer (a three-digit counter
// about five cells wide), a key that did nothing read as working on 218 of 597
// later ticks with the floor spread one cell, on 6 (the ticks to 100 and 200)
// spread three, and on none spread four. It is only for those inputs: a change
// near something that moves on its own has to be larger to count, which a
// click on a square beside the clock, or the image skip, must not pay for.
export const FLOOR_SPREAD = 1;
export const WIDE_SPREAD = 4;
export const WIDE_KINDS = Object.freeze(["key", "type", "gamepad", "scroll"]);
// The whole view's floor (see calibrateNoise): the idle movement of the cells
// at this quantile, but at most GLOBAL_OF_MEDIAN times the median cell's.
export const GLOBAL_QUANTILE = 0.95;
export const GLOBAL_OF_MEDIAN = 3;

// Grey level of one pixel, with the weights the old 8×8 hash used.
const grey = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

/**
 * The pixels of a frame, and of the region of it asked for: a canvas (read with
 * ONE getImageData, over the region only), an ImageData, or {data, width,
 * height} as tools/fake-canvas.mjs makes. The region is {x, y, width, height}
 * in the frame's pixels, cut to the frame; the whole frame when not given.
 *
 * Returns {data, stride, ox, oy, x, y, width, height}, where the pixel at frame
 * coordinates (px, py) starts at data[((py - oy) * stride + (px - ox)) * 4]; or
 * null when there is nothing to read.
 */
export function pixelsOf(frame, region = null) {
  const fw = frame?.width | 0, fh = frame?.height | 0;
  if (!fw || !fh) return null;
  const x = clampInt(region?.x ?? 0, 0, fw - 1);
  const y = clampInt(region?.y ?? 0, 0, fh - 1);
  const width = clampInt(region?.width ?? fw - x, 1, fw - x);
  const height = clampInt(region?.height ?? fh - y, 1, fh - y);
  if (frame.data && frame.data.length >= fw * fh * 4) {
    return { data: frame.data, stride: fw, ox: 0, oy: 0, x, y, width, height };
  }
  if (typeof frame.getContext === "function") {
    const img = frame.getContext("2d").getImageData(x, y, width, height);
    return { data: img.data, stride: width, ox: x, oy: y, x, y, width, height };
  }
  return null;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

/**
 * The frame, or a region of it, as a MAP_COLS × MAP_ROWS grid of mean grey
 * levels. Every pixel belongs to exactly one cell (column floor(i × cols /
 * width)), so the cells tile the region and differ in size by a pixel at most.
 * A region narrower or shorter than the grid gets one cell per pixel that way.
 *
 * Returns {cols, rows, x, y, width, height, cells}, where x, y, width and
 * height are the region in the frame's pixels and cells a Float32Array, row by
 * row; or null.
 */
export function motionMap(frame, region = null) {
  const px = pixelsOf(frame, region);
  if (!px) return null;
  const { data, stride, width, height } = px;
  const cols = Math.min(MAP_COLS, width), rows = Math.min(MAP_ROWS, height);
  const sums = new Float64Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  const colOf = new Int32Array(width);
  for (let i = 0; i < width; i++) colOf[i] = Math.floor(i * cols / width);
  for (let j = 0; j < height; j++) {
    const row = Math.floor(j * rows / height) * cols;
    let p = ((px.y - px.oy + j) * stride + (px.x - px.ox)) * 4;
    for (let i = 0; i < width; i++, p += 4) {
      const k = row + colOf[i];
      sums[k] += grey(data, p);
      counts[k]++;
    }
  }
  const cells = new Float32Array(cols * rows);
  for (let k = 0; k < cells.length; k++) cells[k] = sums[k] / counts[k];
  return { cols, rows, x: px.x, y: px.y, width, height, cells };
}

// Two maps (or a map and a noise floor) cover the same region with the same grid.
function sameGrid(a, b) {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows
    && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function gridOf(m) {
  return { cols: m.cols, rows: m.rows, x: m.x, y: m.y, width: m.width, height: m.height };
}

// Where cell (c, r) sits in the frame's pixels: the pixels whose column
// floor(i × cols / width) is c run from ceil(c × width / cols) up to, not
// including, ceil((c + 1) × width / cols). Rows the same way.
function cellBox(grid, c, r) {
  const x0 = grid.x + Math.ceil(c * grid.width / grid.cols);
  const x1 = grid.x + Math.ceil((c + 1) * grid.width / grid.cols);
  const y0 = grid.y + Math.ceil(r * grid.height / grid.rows);
  const y1 = grid.y + Math.ceil((r + 1) * grid.height / grid.rows);
  return { x0, y0, x1, y1 };
}

// The cell a point in the frame's pixels falls in; a point outside the region
// counts as the nearest cell on its edge.
function cellAt(grid, point) {
  const c = Math.floor((Number(point.x) - grid.x) * grid.cols / grid.width);
  const r = Math.floor((Number(point.y) - grid.y) * grid.rows / grid.height);
  return {
    c: Number.isFinite(c) ? Math.max(0, Math.min(grid.cols - 1, c)) : 0,
    r: Number.isFinite(r) ? Math.max(0, Math.min(grid.rows - 1, r)) : 0,
  };
}

/**
 * The noise floor, from two or more maps of an idle screen (nothing sent to
 * the game in between). Per cell: how far it moved on its own, the range of its
 * values across the maps, spread FLOOR_SPREAD cells each way (`floor`) and
 * WIDE_SPREAD cells each way (`wide`), since a thing that moves does not keep to
 * its cells.
 *
 * Over the whole view (`global`): the 95th percentile of those ranges, but at
 * most three times their median. A codec flickers everywhere and evenly: on the
 * real capture with ±3 grey levels of noise, per pixel or in blocks of 8 to 48
 * px, its 95th percentile was 2.8 to 3.7 times its median, so this is at or
 * near it, and no cell was flagged in 108 later comparisons. An animation in one
 * part of the view (an advert, a looping background) moves only its own cells:
 * it leaves the median at the capture's noise, and its own floor covers it. The
 * 95th percentile alone became the animation's own movement once it covered more
 * than 5% of the cells, and every cell, the board included, went blind to
 * anything smaller: with a strip over 6% of the view, not one of 283 squares
 * opened on the board was seen at its click.
 *
 * Maps taken more than a second apart catch a clock that ticks once a second.
 *
 * Returns {cols, rows, x, y, width, height, floor, wide, stirred, global,
 * frames, moving, movingBox}, where floor, wide and stirred are Float32Arrays
 * per cell, moving the number of cells the idle screen moved by more than
 * MIN_DELTA and more than NOISE_GAIN times the whole view's floor (moved on its
 * own, beyond the capture's noise), stirred 1 on those cells and next to them,
 * and movingBox their bounding box in the frame's pixels (null if none); or null
 * when fewer than two maps of one region were given.
 */
export function calibrateNoise(maps) {
  const usable = (maps ?? []).filter(Boolean);
  if (usable.length < 2 || !usable.every(m => sameGrid(m, usable[0]))) return null;
  const grid = gridOf(usable[0]);
  const { cols, rows } = grid;
  const n = cols * rows;
  const range = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let lo = Infinity, hi = -Infinity;
    for (const m of usable) { const v = m.cells[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    range[k] = hi - lo;
  }
  const sorted = Array.from(range).sort((a, b) => a - b);
  const quantile = q => sorted[Math.floor(q * (n - 1))];
  const global = Math.min(quantile(GLOBAL_QUANTILE), GLOBAL_OF_MEDIAN * quantile(0.5));
  // A cell moved on its own when it moved further than the whole view's noise
  // explains (a clock, an animation; not a codec's flicker). `stirred` marks
  // those cells and their neighbours: a change there is not counted as a
  // click's effect away from its target (judge).
  const past = Math.max(MIN_DELTA, NOISE_GAIN * global);
  const own = new Float32Array(n);
  let moving = 0;
  let box = null;
  for (let k = 0; k < n; k++) {
    if (range[k] > past) {
      own[k] = 1;
      moving++;
      box = grow(box, cellBox(grid, k % cols, Math.floor(k / cols)));
    }
  }
  return {
    ...grid, floor: spread(range, cols, rows, FLOOR_SPREAD), wide: spread(range, cols, rows, WIDE_SPREAD),
    stirred: spread(own, cols, rows, FLOOR_SPREAD), global, frames: usable.length, moving, movingBox: asBox(box),
  };
}

// Per cell, the most any cell within `by` cells of it (each way) holds.
function spread(values, cols, rows, by) {
  const out = new Float32Array(values.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let most = 0;
      for (let rr = Math.max(0, r - by); rr <= Math.min(rows - 1, r + by); rr++) {
        for (let cc = Math.max(0, c - by); cc <= Math.min(cols - 1, c + by); cc++) {
          most = Math.max(most, values[rr * cols + cc]);
        }
      }
      out[r * cols + c] = most;
    }
  }
  return out;
}

// How far a cell of this grid must move to count: NOISE_GAIN times its noise
// (its own floor, or with `wide` its wide floor, or the whole view's, whichever
// is highest), between MIN_DELTA and MAX_LIMIT. With no calibration, MIN_DELTA.
export function limitOf(noise, k, { wide = false } = {}) {
  if (!noise) return MIN_DELTA;
  const own = (wide ? noise.wide ?? noise.floor : noise.floor)?.[k] ?? 0;
  const n = Math.max(own, noise.global ?? 0);
  return Math.max(MIN_DELTA, Math.min(MAX_LIMIT, NOISE_GAIN * n));
}

function grow(box, b) {
  if (!box) return { ...b };
  return { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) };
}

function asBox(box) {
  return box ? { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 } : null;
}

/**
 * What changed from one map to the next, against a noise floor from
 * calibrateNoise (or none: then every cell's limit is MIN_DELTA). A floor taken
 * for another region is ignored. `wide` uses the floor spread WIDE_SPREAD cells,
 * for an input in WIDE_KINDS (usesWideFloor).
 *
 * Returns:
 *   grid         the maps' grid: {cols, rows, x, y, width, height}
 *   delta        per cell, how far its mean grey level moved (Float32Array)
 *   limit        per cell, how far it had to move to count
 *   cells        the indices of the cells that moved past their limit
 *   maxCell      the most any cell moved, in grey levels
 *   changedFrac  the share of cells that moved past their limit
 *   quietFrac    the share of cells that moved past their limit where nothing
 *                moved on its own while the floor was taken (noise.stirred):
 *                all of changedFrac when uncalibrated
 *   bbox         {x, y, w, h}: those cells' bounding box, in the frame's pixels
 *   centroid     {x, y}: their centre, weighted by how far past its limit each
 *                moved, in the frame's pixels
 *   global       most of the view changed (GLOBAL_FRAC)
 *   calibrated   a noise floor for this grid was used
 * bbox and centroid are null when nothing changed. Maps of different regions
 * or sizes (a window resized, the crop changed) are the view changing as a
 * whole: every cell counts, and `resized` is set. Null when a map is missing.
 */
export function compare(before, after, noise = null, { wide = false } = {}) {
  if (!before || !after) return null;
  const grid = gridOf(after);
  const n = grid.cols * grid.rows;
  if (!sameGrid(before, after)) {
    const cells = Array.from({ length: n }, (_, k) => k);
    return {
      grid, delta: null, limit: null, cells, maxCell: 255, changedFrac: 1, quietFrac: 1,
      bbox: { x: grid.x, y: grid.y, w: grid.width, h: grid.height },
      centroid: { x: grid.x + grid.width / 2, y: grid.y + grid.height / 2 },
      global: true, resized: true, calibrated: false,
    };
  }
  const floor = noise && sameGrid(noise, after) ? noise : null;
  const delta = new Float32Array(n), limit = new Float32Array(n);
  const cells = [];
  let maxCell = 0, quiet = 0, box = null, wsum = 0, wx = 0, wy = 0;
  for (let k = 0; k < n; k++) {
    const d = Math.abs(after.cells[k] - before.cells[k]);
    const l = limitOf(floor, k, { wide });
    delta[k] = d;
    limit[k] = l;
    if (d > maxCell) maxCell = d;
    if (d <= l) continue;
    cells.push(k);
    if (!floor?.stirred?.[k]) quiet++;
    const b = cellBox(grid, k % grid.cols, Math.floor(k / grid.cols));
    box = grow(box, b);
    const w = d - l;
    wsum += w;
    wx += w * (b.x0 + b.x1) / 2;
    wy += w * (b.y0 + b.y1) / 2;
  }
  const changedFrac = cells.length / n;
  return {
    grid, delta, limit, cells, maxCell, changedFrac, quietFrac: quiet / n,
    bbox: asBox(box),
    centroid: wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null,
    global: changedFrac >= GLOBAL_FRAC,
    calibrated: !!floor,
  };
}

// The kinds of action judge() knows. A pointer acts at a place, so its effect
// is looked for there; keys, typing, the gamepad and a scroll act on the game
// as a whole, so a change anywhere in the view counts; a restart has to change
// the view as a whole.
export const POINT_KINDS = Object.freeze(["click", "drag"]);
export const RESTART_KIND = "restart";
// judge()'s answer when a look was missing, so there was nothing to compare: not
// "the action changed nothing", which the no-op count (src/agent/noops.js) must
// not be told.
export const NO_FRAME = "no frame to compare";

// An action's target points, in the frame's pixels: `at` may be one point or a
// list (a drag's start and end). Points that are not numbers are left out.
function targetsOf(action) {
  const at = action?.at;
  const list = Array.isArray(at) ? at : at ? [at] : [];
  return list.filter(p => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)));
}

/**
 * Whether this action is compared with the wide floor (WIDE_SPREAD): a key,
 * typing, the gamepad or a scroll, whose effect is looked for anywhere, so a
 * clock's tick must not pass for it: compare(before, after, noise,
 * {wide: usesWideFloor(action)}). A restart and the screen between two turns
 * keep the tight one, so they err toward "changed": an image sent that could
 * have been skipped, never one skipped that showed a square opening.
 */
export function usesWideFloor(action) {
  return WIDE_KINDS.includes(action?.kind);
}

/**
 * Whether a comparison shows that an action did something.
 *
 * `action` is {kind, at}: `at` the target point or points, in the frame's
 * pixels (the coordinates the model clicked at). A click or drag with a target
 * counts change within NEAR_CELLS of it, or at least NEW_SCREEN_FRAC of the view
 * changed away from it where nothing moved on its own (quietFrac); with no
 * target, anywhere. A restart counts at least NEW_SCREEN_FRAC of the view
 * changed. Anything else (keys, typing, the gamepad, a scroll, the screen
 * between two turns) counts change anywhere in the view.
 *
 * The pointer itself is not told apart: a capture that draws it shows it moving
 * onto the target as a change right there. So the page moves the pointer onto a
 * click's target before it takes the baseline (GameAgent.jsx, hoverFirst).
 *
 * Returns {changed, why, peak, nearest}: why in words for the log; peak the
 * most a cell that counts for this action moved (near the target for a click,
 * unless a change away from it counted; anywhere otherwise), in grey levels;
 * nearest how many cells from the target the nearest change was, for a click
 * with one (null otherwise).
 */
export function judge(result, action = {}) {
  if (!result) return { changed: false, why: NO_FRAME, peak: 0, nearest: null };
  const kind = action?.kind ?? "any";
  const share = pct(result.changedFrac);
  if (kind === RESTART_KIND) {
    const changed = result.global || result.changedFrac >= NEW_SCREEN_FRAC;
    return {
      changed,
      why: changed ? `${share} of the view changed` : `only ${share} of the view changed (a new game changes ${pct(NEW_SCREEN_FRAC)} or more)`,
      peak: result.maxCell, nearest: null,
    };
  }
  const targets = POINT_KINDS.includes(kind) ? targetsOf(action) : [];
  if (!targets.length) {
    if (!result.cells.length) return { changed: false, why: "nothing moved past the noise", peak: result.maxCell, nearest: null };
    return {
      changed: true,
      why: result.global ? `most of the view changed (${share})` : `${result.cells.length} cell${result.cells.length === 1 ? "" : "s"} changed (${share} of the view)`,
      peak: result.maxCell, nearest: null,
    };
  }

  const { grid } = result;
  const spots = targets.map(p => cellAt(grid, p));
  const away = k => {
    const c = k % grid.cols, r = Math.floor(k / grid.cols);
    return Math.min(...spots.map(s => Math.max(Math.abs(c - s.c), Math.abs(r - s.r))));
  };
  // How much moved near the target, changed or not: what the log and the tool
  // result report for a click.
  let peak = 0;
  if (result.delta) {
    for (const s of spots) {
      for (let r = Math.max(0, s.r - NEAR_CELLS); r <= Math.min(grid.rows - 1, s.r + NEAR_CELLS); r++) {
        for (let c = Math.max(0, s.c - NEAR_CELLS); c <= Math.min(grid.cols - 1, s.c + NEAR_CELLS); c++) {
          peak = Math.max(peak, result.delta[r * grid.cols + c]);
        }
      }
    }
  } else {
    peak = result.maxCell;
  }
  let nearest = null;
  for (const k of result.cells) {
    const d = away(k);
    if (nearest === null || d < nearest) nearest = d;
  }
  if (nearest === null) return { changed: false, why: "nothing moved past the noise", peak, nearest };
  if (result.global) return { changed: true, why: `most of the view changed (${share})`, peak, nearest };
  if (nearest <= NEAR_CELLS) {
    const near = result.cells.filter(k => away(k) <= NEAR_CELLS).length;
    return { changed: true, why: `${near} cell${near === 1 ? "" : "s"} changed at the target`, peak, nearest };
  }
  // Away from the target, only where nothing moved on its own counts: an
  // animation elsewhere that outgrew its floor is not the click's doing.
  const cellsText = `${result.cells.length} cell${result.cells.length === 1 ? "" : "s"}`;
  const quiet = result.quietFrac ?? result.changedFrac;
  if (quiet >= NEW_SCREEN_FRAC) {
    return {
      changed: true, why: `${pct(quiet)} of the view changed away from the target (${cellsText}, the nearest ${nearest} cells off)`,
      peak: result.maxCell, nearest,
    };
  }
  return {
    changed: false,
    why: `only away from the target changed (${cellsText}, the nearest ${nearest} cells off)`,
    peak, nearest,
  };
}

function pct(frac) {
  const p = 100 * (Number(frac) || 0);
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

// ── The 8×8 hash this replaces ────────────────────────────────────────────────
// Kept so a run can be switched back to it (the page's Change detection
// setting) and so both are logged side by side until the motion map has proved
// itself on the test PC. The numbers are the old ones exactly: each of 64
// cells, floor(width / 8) × floor(height / 8) pixels from the top-left, is the
// mean grey level of its pixels, and the distance between two hashes is the
// RMS of the 64 differences.

/** The legacy 8×8 hash of a frame (the same inputs as motionMap), or null. */
export function legacyHash(frame) {
  const px = pixelsOf(frame);
  if (!px) return null;
  const { data, stride, width, height } = px;
  const cw = Math.max(1, Math.floor(width / 8)), ch = Math.max(1, Math.floor(height / 8));
  const hash = new Float32Array(64);
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      let sum = 0, count = 0;
      for (let y = gy * ch; y < Math.min(height, (gy + 1) * ch); y++) {
        let p = (y * stride + gx * cw) * 4;
        for (let x = gx * cw; x < Math.min(width, (gx + 1) * cw); x++, p += 4) {
          sum += grey(data, p);
          count++;
        }
      }
      hash[gy * 8 + gx] = count ? sum / count : 0;
    }
  }
  return hash;
}

/** The legacy distance between two 8×8 hashes: 0 when either is missing. */
export function legacyDistance(a, b) {
  if (!a || !b) return 0;
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / 64);
}
