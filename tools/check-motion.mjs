#!/usr/bin/env node
// Check how the agent tells whether an action changed the screen.
//
//   node tools/check-motion.mjs
//
// It used to be one number, the RMS of an 8×8 grid of mean brightness over the
// whole frame, against 2.0, and it could not see a small edit: opening one
// Minesweeper square moved it by a few hundredths. Every correct click on a
// board read as a move that did nothing. The motion map (src/vision/motion.js)
// replaces it, and src/agent/changeDetection.js decides with it. This checks,
// on the real Expert capture in tools/frames (tools/real-frames.mjs):
//   - identical frames change nothing
//   - one covered square repainted as an opened blank, and as a "3", changes,
//     with the bounding box on that square, judged changed for a click at its
//     centre and not for a click far away; the legacy hash sees neither
//   - every covered square on the board, opened as a blank, is seen at its
//     click; a browser's 64×36 drawImage would miss many (why the page reads
//     every pixel)
//   - a panel opening away from a click counts for it, from 2% of the view
//   - a 2 px shift changes; ±3 grey levels of noise does not, once calibrated
//   - the pointer arriving on a click's target reads as a change there (why the
//     page moves it onto the target before the baseline), and with the pointer
//     in both frames a dead click is no change and every opening is still seen
//   - an animation over a tenth of the view, calibrated, leaves the board as
//     sensitive as before, and does not make a dead click on it look alive
//   - a clock that ticks, calibrated on one tick, is not a key's effect on any
//     later tick, and never counts for a click away from it
//   - a restart needs a new screen, a region and a resized frame behave, a
//     canvas is read with one getImageData, and the legacy hash still gives the
//     old numbers exactly
// Then the agent's side (which detector decides, where each tool acts, the wait
// itself, the baseline with the pointer on the target, a look that could not be
// taken never replacing a real one, a drag judged once both its ends settle, the
// calibration and the log lines), and the page's wiring: every pointer action
// moves the pointer onto its target before its baseline, every wait after an
// action judges it by where it acted, polls make no JPEG, native capture (which
// sends no frame when nothing changed) has the last look stand in, so clicks and
// keys keep their baselines by either detector, the image skip and the restart
// use the same detectors, a game is calibrated before the model's first turn in
// it, and both verdicts go to the log file for every action.

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { build } from "esbuild";
import { loadFrame } from "./real-frames.mjs";
import { createCanvas } from "./fake-canvas.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const mo = await import(src("vision", "motion.js"));
const cd = await import(src("agent", "changeDetection.js"));
const ep = await import(src("agent", "episodes.js"));
const msModule = await import(src("plugins", "minesweeper.js"));
const benchGame = await import(pathToFileURL(path.join(ROOT, "bench", "minesweeper", "game.js")).href);
const benchDraw = await import(pathToFileURL(path.join(ROOT, "bench", "minesweeper", "draw.js")).href);
const ms = msModule.default;
const COVERED = msModule.UNKNOWN;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const show = v => JSON.stringify(v);
const cases = (name, list) => {
  const bad = list.filter(([, got, test]) => !test(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check(name, !bad.length, bad.join("; "));
};

// ── Frames built from the real capture ────────────────────────────────────────
const { canvas: real } = loadFrame("expert-midgame");
const frame = { width: real.width, height: real.height, data: real.data };
const clone = f => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(f.data) });
const state = ms.readState(real);
const G = state?.grid;
const square = (r, c) => ({ x: G.x + c * G.pitch, y: G.y + r * G.pitch, w: G.pitch, h: G.pitch });
const centre = sq => ({ x: sq.x + sq.w / 2, y: sq.y + sq.h / 2 });

// Copy a rectangle of pixels from one place in a frame to another: a square
// repainted with another square's real pixels, off the same capture.
function copyRect(f, from, to, w, h, source = f) {
  const out = clone(f);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const s = ((from.y + dy) * source.width + from.x + dx) * 4, t = ((to.y + dy) * f.width + to.x + dx) * 4;
      for (let k = 0; k < 3; k++) out.data[t + k] = source.data[s + k];
    }
  }
  return out;
}
const repaint = (f, fromSq, toSq) => copyRect(f, fromSq, toSq, G.pitch, G.pitch);

// Deterministic noise of ±3 grey levels, per pixel or in blocks (a codec's).
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function noisy(f, seed, block = 1) {
  const out = clone(f), r = rng(seed);
  const bw = Math.ceil(f.width / block), bh = Math.ceil(f.height / block);
  const offsets = Array.from({ length: bw * bh }, () => Math.round(r() * 6 - 3));
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const o = block === 1 ? Math.round(r() * 6 - 3) : offsets[Math.floor(y / block) * bw + Math.floor(x / block)];
      for (let k = 0; k < 3; k++) out.data[(y * f.width + x) * 4 + k] = f.data[(y * f.width + x) * 4 + k] + o;
    }
  }
  return out;
}
// The pointer as a capture may draw it: the standard Windows arrow, 12×19 px,
// B its outline and W its fill, its tip at the point.
const ARROW = [
  "B", "BB", "BWB", "BWWB", "BWWWB", "BWWWWB", "BWWWWWB", "BWWWWWWB", "BWWWWWWWB", "BWWWWWWWWB",
  "BWWWWWWWWWB", "BWWWWWWBBBBB", "BWWWBWWB", "BWWBBWWB", "BWB  BWWB", "BB   BWWB", "B     BWWB", "      BWWB", "       BB",
];
function drawPointer(f, p) {
  for (let r = 0; r < ARROW.length; r++) for (let c = 0; c < ARROW[r].length; c++) {
    const ch = ARROW[r][c], x = Math.round(p.x) + c, y = Math.round(p.y) + r;
    if ((ch === "B" || ch === "W") && x < f.width && y < f.height) f.data.fill(ch === "B" ? 0 : 255, (y * f.width + x) * 4, (y * f.width + x) * 4 + 3);
  }
  return f;
}
const withPointer = (f, p) => drawPointer(clone(f), p);

function shifted(f, dx) {
  const out = clone(f);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const sx = Math.max(0, x - dx);
      for (let k = 0; k < 4; k++) out.data[(y * f.width + x) * 4 + k] = f.data[(y * f.width + sx) * 4 + k];
    }
  }
  return out;
}

// ── The capture itself ────────────────────────────────────────────────────────
console.log("the capture");
check("the Expert capture reads as a 16×30 board of 24 px squares", !!state && state.rows === 16 && state.cols === 30 && G.pitch === 24,
  state ? show({ rows: state.rows, cols: state.cols, grid: G }) : "not readable");
if (!state) {
  console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
const cellsWhere = test => {
  const out = [];
  for (let r = 0; r < state.rows; r++) for (let c = 0; c < state.cols; c++) if (test(state.board[r][c], r, c)) out.push([r, c]);
  return out;
};
const covered = cellsWhere(v => v === COVERED);
// Covered squares with covered squares all round: a repaint there is one square
// changing in the middle of the unopened part of the board.
const deepCovered = covered.filter(([r, c]) => [-1, 0, 1].every(dr => [-1, 0, 1].every(dc =>
  state.board[r + dr]?.[c + dc] === COVERED)));
const blank = cellsWhere(v => v === 0)[0];
const three = cellsWhere(v => v === 3)[0];
check("it has covered squares, an opened blank and an opened 3 to copy",
  deepCovered.length > 20 && !!blank && !!three, show({ covered: covered.length, deepCovered: deepCovered.length, blank, three }));
// The target: a covered square in the middle of the covered area.
const [tr, tc] = deepCovered[Math.floor(deepCovered.length / 2)];
const target = square(tr, tc);
const asBlank = repaint(frame, square(...blank), target);
const asThree = repaint(frame, square(...three), target);

const base = mo.motionMap(frame);
const mapOf = f => mo.motionMap(f);
const click = (p, kind = "click") => ({ kind, at: p });
const KEY = { kind: "key" };

// ── The motion map ────────────────────────────────────────────────────────────
console.log("the motion map");
{
  check("the map is 64×36 over the whole 920×620 frame", base.cols === 64 && base.rows === 36 && base.width === 920
    && base.height === 620 && base.x === 0 && base.y === 0 && base.cells.length === 64 * 36, show({ ...base, cells: base.cells.length }));
  const same = mo.compare(base, mapOf(clone(frame)));
  cases("identical frames change nothing", [
    ["compare", same, r => r.maxCell === 0 && r.cells.length === 0 && r.changedFrac === 0 && r.bbox === null && r.centroid === null && !r.global],
    ["a click at the square", mo.judge(same, click(centre(target))), v => v.changed === false],
    ["a key", mo.judge(same, KEY), v => v.changed === false],
  ]);

  for (const [label, edited] of [["an opened blank", asBlank], ["a 3", asThree]]) {
    const r = mo.compare(base, mapOf(edited));
    const b = r.bbox;
    // The box is made of whole map cells (about 14×17 px here), so it may reach
    // up to one cell past the square on each side, never further.
    const onSquare = !!b && b.x <= target.x && b.y <= target.y && b.x + b.w >= target.x + target.w && b.y + b.h >= target.y + target.h
      && target.x - b.x < 15 && target.y - b.y < 18 && b.x + b.w - (target.x + target.w) < 15 && b.y + b.h - (target.y + target.h) < 18;
    check(`one covered square repainted as ${label} changes, with the bbox on that square`,
      r.cells.length > 0 && onSquare && Math.abs(r.centroid.x - centre(target).x) < 12 && Math.abs(r.centroid.y - centre(target).y) < 12,
      show({ square: target, bbox: b, centroid: r.centroid, cells: r.cells.length, maxCell: r.maxCell }));
    const atIt = mo.judge(r, click(centre(target)));
    const far = mo.judge(r, click(centre(square(tr, tc >= 15 ? tc - 12 : tc + 12))));
    cases(`...judged changed for a click at its centre and a key, and not for a click 12 squares away (${label})`, [
      ["click at it", atIt, v => v.changed && v.nearest === 0 && v.peak === r.maxCell],
      ["a key", mo.judge(r, KEY), v => v.changed],
      ["click far away", far, v => !v.changed && v.nearest > mo.NEAR_CELLS],
    ]);
    const legacy = mo.legacyDistance(mo.legacyHash(frame), mo.legacyHash(edited));
    check(`the legacy hash does NOT see it: distance ${legacy.toFixed(3)}, ${(cd.LEGACY_THRESHOLD / legacy).toFixed(0)}× short of ${cd.LEGACY_THRESHOLD}`,
      legacy > 0 && legacy < cd.LEGACY_THRESHOLD, `distance ${legacy}`);
  }

  // Every covered square, opened as a blank, one at a time: pasted into one
  // working copy and put back after, rather than a copy of the frame each.
  let missed = 0, weakest = Infinity;
  let shrinkMissed = 0;
  const shrink = f => bilinear64x36(f);
  const shrunkBase = shrink(frame);
  const edited = clone(frame);
  const paste = (from, to, source) => {
    for (let dy = 0; dy < G.pitch; dy++) {
      const s = ((from.y + dy) * frame.width + from.x) * 4, t = ((to.y + dy) * frame.width + to.x) * 4;
      edited.data.set(source.data.subarray(s, s + G.pitch * 4), t);
    }
  };
  for (const [r, c] of covered) {
    const sq = square(r, c);
    paste(square(...blank), sq, frame);
    const res = mo.compare(base, mapOf(edited));
    const v = mo.judge(res, click(centre(sq)));
    if (!v.changed) missed++;
    weakest = Math.min(weakest, v.peak);
    const after = shrink(edited);
    if (!after.some((g, i) => Math.abs(g - shrunkBase[i]) > mo.MIN_DELTA)) shrinkMissed++;
    paste(sq, sq, frame);
  }
  check("...and the working copy is the capture again after", edited.data.every((v, i) => v === frame.data[i]));
  check(`every one of the ${covered.length} covered squares, opened as a blank, is seen at its click (weakest moved its cell ${weakest.toFixed(1)} grey levels)`,
    missed === 0 && weakest > 4 * mo.MIN_DELTA, `${missed} missed, weakest ${weakest}`);
  check(`a browser's 64×36 drawImage (bilinear) would miss ${shrinkMissed} of them: why the page averages every pixel`,
    shrinkMissed >= covered.length / 5, `${shrinkMissed} of ${covered.length}`);

  const shift = mo.compare(base, mapOf(shifted(frame, 2)));
  const shiftLegacy = mo.legacyDistance(mo.legacyHash(frame), mo.legacyHash(shifted(frame, 2)));
  check(`a 2 px shift changes (${(100 * shift.changedFrac).toFixed(0)}% of the cells; the legacy hash: ${shiftLegacy.toFixed(2)})`,
    mo.judge(shift, KEY).changed && shift.changedFrac > 0.1 && mo.judge(shift, click(centre(target))).changed,
    show({ changedFrac: shift.changedFrac, maxCell: shift.maxCell }));

  // A click whose effect lands away from it: a plain panel opening mid-screen
  // after a click on the "Beginner" link at the top left. Under half the view,
  // it used to be "unchanged" for the click that opened it.
  const topLeft = { x: 118, y: 45 };
  const panelCases = [[200, 120], [300, 200], [420, 300]].map(([w, h]) => {
    const out = clone(frame);
    const x0 = Math.round((frame.width - w) / 2), y0 = Math.round((frame.height - h) / 2);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const edge = x - x0 < 3 || y - y0 < 3 || x0 + w - x <= 3 || y0 + h - y <= 3;
      out.data.fill(edge ? 40 : 250, (y * frame.width + x) * 4, (y * frame.width + x) * 4 + 3);
    }
    const v = mo.judge(mo.compare(base, mapOf(out)), click(topLeft));
    return [`${w}×${h} (${(100 * w * h / (frame.width * frame.height)).toFixed(0)}% of the view)`, v, x => x.changed && /away from the target/.test(x.why)];
  });
  cases(`a panel opening away from the click counts for it, from ${100 * mo.NEW_SCREEN_FRAC}% of the view (one square, a clock or the pointer is far less)`, panelCases);
}

// ── The pointer ───────────────────────────────────────────────────────────────
// Not every browser honours the capture's cursor: "never" (GameAgent.jsx,
// startCapture), and tools/frames' own captures have the pointer in them.
console.log("the pointer");
{
  // Put a rectangle of the capture back into a working copy.
  const restore = (work, x0, y0, w, h) => {
    for (let y = y0; y < Math.min(frame.height, y0 + h); y++) {
      const s = (y * frame.width + x0) * 4;
      work.data.set(frame.data.subarray(s, s + Math.min(w, frame.width - x0) * 4), s);
    }
  };
  const opened = cellsWhere(v => v !== COVERED && v !== undefined).filter(([r, c]) => r > 2 || c > 2);
  const parked = centre(square(0, 0));   // where the last click left it
  const before = mapOf(withPointer(frame, parked));
  let moved = 0;
  for (const [r, c] of opened) {
    const at = centre(square(r, c));
    if (mo.judge(mo.compare(before, mapOf(withPointer(frame, at))), click(at)).changed) moved++;
  }
  check(`the pointer moving onto a click's target reads as a change there: ${moved} of ${opened.length} dead clicks on open squares (why the page moves it there before the baseline)`,
    moved >= opened.length * 0.9, `${moved} of ${opened.length}`);

  // Moved there first, it is in the baseline too, so a dead click compares the
  // screen with itself (the wait below shows it); and each covered square
  // opening under the pointer is still seen.
  let missed = 0;
  const work = clone(frame);
  for (const [r, c] of covered) {
    const sq = square(r, c), at = centre(sq);
    const hovered = mapOf(drawPointer(work, at));
    for (let dy = 0; dy < G.pitch; dy++) {
      const s = ((square(...blank).y + dy) * frame.width + square(...blank).x) * 4, t = ((sq.y + dy) * frame.width + sq.x) * 4;
      work.data.set(frame.data.subarray(s, s + G.pitch * 4), t);
    }
    if (!mo.judge(mo.compare(hovered, mapOf(drawPointer(work, at))), click(at)).changed) missed++;
    restore(work, sq.x, sq.y, G.pitch + 12, G.pitch + 19);
  }
  check(`with the pointer on the target before and after, every one of the ${covered.length} covered squares opening under it is seen (${missed} missed)`,
    missed === 0 && work.data.every((v, i) => v === frame.data[i]), show({ missed }));
}

// ── Noise, and what moves on its own ─────────────────────────────────────────
console.log("noise and calibration");
{
  for (const [label, block] of [["per pixel", 1], ["in 8 px blocks, as a codec's", 8]]) {
    const idle = [1, 2].map(seed => mapOf(noisy(frame, seed * 10 + block, block)));
    const noise = mo.calibrateNoise(idle);
    const later = [3, 4].map(seed => mapOf(noisy(frame, seed * 10 + block, block)));
    const calibrated = mo.compare(later[0], later[1], noise);
    check(`±3 grey levels of noise ${label} gives no change after calibration from two idle frames, and nothing counts as moving on its own`,
      !!noise && noise.frames === 2 && calibrated.cells.length === 0 && !mo.judge(calibrated, KEY).changed && calibrated.calibrated
        && mo.compare(later[0], later[1], noise, { wide: true }).cells.length === 0 && noise.moving === 0,
      show({ cells: calibrated.cells.length, maxCell: calibrated.maxCell, global: noise?.global, moving: noise?.moving }));
    // ...and still sees the one square opened, noise and all.
    const opened = mo.compare(later[0], mapOf(repaint(noisy(frame, 40 + block, block), square(...blank), target)), noise);
    check(`...while one square opened under that noise is still seen at its click (${label})`,
      mo.judge(opened, click(centre(target))).changed, show({ cells: opened.cells.length, maxCell: opened.maxCell }));
  }
  const blockNoise = mo.compare(mapOf(noisy(frame, 91, 8)), mapOf(noisy(frame, 92, 8)));
  check(`without calibration, the block noise alone would count as a change (${blockNoise.cells.length} cells): why each game is calibrated`,
    blockNoise.cells.length > 0 && mo.judge(blockNoise, KEY).changed);

  // A clock: the page's timer, top right, shows the mine counter's digits
  // (top left) in one frame and its own in the next, as a tick would.
  const red = [];
  for (let y = 0; y < G.y; y++) for (let x = 0; x < frame.width; x++) {
    const i = (y * frame.width + x) * 4;
    if (frame.data[i] > 180 && frame.data[i + 1] < 80 && frame.data[i + 2] < 80) red.push({ x, y });
  }
  const left = red.filter(p => p.x < frame.width / 2), right = red.filter(p => p.x >= frame.width / 2);
  const boxOf = ps => ({ x: Math.min(...ps.map(p => p.x)), y: Math.min(...ps.map(p => p.y)),
    w: Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)) + 1, h: Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)) + 1 });
  const counter = boxOf(left), timer = boxOf(right);
  const w = Math.min(counter.w, timer.w) + 4, h = Math.max(counter.h, timer.h) + 4;
  const ticked = copyRect(frame, { x: counter.x - 2, y: counter.y - 2 }, { x: timer.x + timer.w - w + 2, y: timer.y - 2 }, w, h);
  check("the capture has its red counter and timer above the board", left.length > 200 && right.length > 200,
    show({ counter, timer }));
  const tick = mo.compare(base, mapOf(ticked));
  const noise = mo.calibrateNoise([base, mapOf(ticked)]);
  cases(`a tick of the timer (it moves its cells by up to ${tick.maxCell.toFixed(0)} grey levels) counts for a key uncalibrated, and calibration finds it`, [
    ["uncalibrated, a key", mo.judge(tick, KEY), v => v.changed],
    ["calibrated", noise, n => !!n && n.moving > 0 && !!n.movingBox && n.movingBox.x > frame.width / 2 && n.movingBox.y < G.y],
  ]);
  // A click on the board that did nothing, while the clock ticked: not a change,
  // calibrated or not. And one that opened the square, while it ticked: a change.
  const deadClick = mo.compare(base, mapOf(ticked));
  const liveClick = mo.compare(base, mapOf(repaint(ticked, square(...blank), target)), noise);
  cases("a click on the board judges the board, not the clock", [
    ["a dead click while the clock ticked", mo.judge(deadClick, click(centre(target))), v => !v.changed],
    ["an opening click while the clock ticked", mo.judge(liveClick, click(centre(target))), v => v.changed],
  ]);

  // An animation above the board over a tenth of the view (an advert, a looping
  // banner), moving while the floor is taken and after.
  const stripH = Math.round(0.1 * frame.height);
  const strip = (f, phase) => {
    const out = clone(f);
    for (let y = 0; y < stripH; y++) for (let x = 0; x < f.width; x++) {
      const v = ((x >> 4) + (y >> 4) + phase) % 3 === 0 ? 40 : ((x >> 3) + phase * 2) % 5 === 0 ? 230 : 128 + 40 * Math.sin((x + y + phase * 37) / 9);
      out.data.fill(v, (y * f.width + x) * 4, (y * f.width + x) * 4 + 3);
    }
    return out;
  };
  const idle = [0, 1].map(phase => mapOf(strip(frame, phase)));
  const animNoise = mo.calibrateNoise(idle);
  const ranges = Array.from(idle[0].cells, (v, k) => Math.abs(v - idle[1].cells[k])).sort((a, b) => a - b);
  const p95 = ranges[Math.floor(0.95 * (ranges.length - 1))];
  const stripBefore = mapOf(strip(frame, 2));
  const stripWork = strip(frame, 3);
  let stripMissed = 0;
  for (const [r, c] of covered) {
    const sq = square(r, c);
    for (let dy = 0; dy < G.pitch; dy++) {
      const s0 = ((square(...blank).y + dy) * frame.width + square(...blank).x) * 4, t0 = ((sq.y + dy) * frame.width + sq.x) * 4;
      stripWork.data.set(frame.data.subarray(s0, s0 + G.pitch * 4), t0);
    }
    if (!mo.judge(mo.compare(stripBefore, mapOf(stripWork), animNoise), click(centre(sq))).changed) stripMissed++;
    for (let dy = 0; dy < G.pitch; dy++) {
      const t0 = ((sq.y + dy) * frame.width + sq.x) * 4;
      stripWork.data.set(frame.data.subarray(t0, t0 + G.pitch * 4), t0);
    }
  }
  check(`an animation over ${(100 * stripH / frame.height).toFixed(0)}% of the view, calibrated, leaves the whole view's floor at ${animNoise.global.toFixed(1)} (the 95th percentile alone: ${p95.toFixed(1)}), and every one of the ${covered.length} openings is seen (${stripMissed} missed)`,
    !!animNoise && animNoise.global <= mo.MIN_DELTA / mo.NOISE_GAIN && animNoise.moving > 0 && stripMissed === 0 && p95 > 10,
    show({ global: animNoise?.global, p95, moving: animNoise?.moving, stripMissed }));
  // With a codec's noise on top, the animation outgrows its floor between later
  // frames; a dead click on the board is still no change, as nothing changed
  // where nothing moved on its own.
  const noisyStrip = (seed, phase) => mapOf(strip(noisy(frame, seed, 8), phase));
  const bothNoise = mo.calibrateNoise([noisyStrip(501, 0), noisyStrip(502, 1)]);
  let aliveDead = 0, outgrew = 0;
  const probes = deepCovered.filter((_, i) => i % Math.ceil(deepCovered.length / 8) === 0);
  for (const [i, [r, c]] of probes.entries()) {
    const res = mo.compare(noisyStrip(600 + i, 2), noisyStrip(700 + i, 3), bothNoise);
    outgrew = Math.max(outgrew, res.changedFrac);
    if (mo.judge(res, click(centre(square(r, c)))).changed) aliveDead++;
  }
  check(`...and with a codec's noise too, no dead click on the board reads as changed (${aliveDead} of ${probes.length}), though the animation outgrew its floor over up to ${(100 * outgrew).toFixed(1)}% of the view`,
    aliveDead === 0 && outgrew >= mo.NEW_SCREEN_FRAC, show({ aliveDead, outgrew }));
}

// ── A clock that ticks: the bench Minesweeper's own timer ────────────────────
// Calibrated on one tick, later ticks light other segments and other digits.
console.log("a clock");
{
  const game = benchGame.newGame("expert", 42);
  const geo = benchDraw.geometry(game.rows, game.cols, 24);
  benchGame.reveal(game, 8, 15, 1_000_000);   // the first click starts the timer
  const start = game.startedAt;
  const at = s => { const cv = createCanvas(geo.width, geo.height); benchDraw.drawGame(cv, game, { size: 24, now: start + s * 1000 + 300 }); return cv; };
  const noise = mo.calibrateNoise([mapOf(at(18)), mapOf(at(19))]);
  const ticks = [];
  for (let s = 1; s <= 121; s++) ticks[s] = { map: mapOf(at(s)), hash: null };
  const deadKey = cd.changeAction("press_key", { key: "ArrowUp" });
  let wide = 0, tight = 0;
  for (let s = 1; s < 121; s++) {
    if (cd.judgeLooks(ticks[s], ticks[s + 1], { noise, action: deadKey }).changed) wide++;
    if (mo.judge(mo.compare(ticks[s].map, ticks[s + 1].map, noise), KEY).changed) tight++;
  }
  check(`calibrated on one tick (18 to 19), a key that did nothing is not read as working on any of the next 120 ticks (${wide}; with the floor spread ${mo.FLOOR_SPREAD} cell, as a click's is, ${tight} would)`,
    !!noise && noise.moving > 0 && wide === 0 && tight > 10, show({ wide, tight, moving: noise?.moving }));
  // A square right under the timer, opened while it ticks: seen at its click,
  // whose floor is the tight one. And a dead click there while it ticks: not.
  const col = [27, 28, 29].find(c => !game.open[c] && !game.mine[c] && game.count[c] > 0);
  const sqAt = { x: geo.grid.x + col * 24 + 12, y: geo.grid.y + 12 };
  const beforeOpen = { map: mapOf(at(30)), hash: null };
  const deadThere = cd.judgeLooks(beforeOpen, { map: mapOf(at(31)), hash: null }, { noise, action: cd.changeAction("click", sqAt) });
  benchGame.reveal(game, 0, col, start + 30_000);
  const openThere = cd.judgeLooks(beforeOpen, { map: mapOf(at(31)), hash: null }, { noise, action: cd.changeAction("click", sqAt) });
  cases("a square right under the timer, clicked while it ticks, is judged by what the square did", [
    ["opened", openThere.motion, v => v.changed && v.nearest === 0],
    ["dead", deadThere.motion, v => !v.changed],
  ]);
}

// ── Restarts, regions, sizes, reading a canvas, the legacy numbers ───────────
console.log("restarts, regions and sizes");
{
  // A new game: every opened square covered again.
  const fresh = clone(frame);
  const coverFrom = square(tr, tc);
  for (const [r, c] of cellsWhere(v => v !== COVERED)) {
    const to = square(r, c);
    for (let dy = 0; dy < G.pitch; dy++) {
      const s = ((coverFrom.y + dy) * frame.width + coverFrom.x) * 4, t = ((to.y + dy) * frame.width + to.x) * 4;
      fresh.data.set(frame.data.subarray(s, s + G.pitch * 4), t);
    }
  }
  const restart = cd.changeAction("restart");
  cases("a restart needs a new screen: a new board counts, one square or a ticking clock does not", [
    ["a new board", mo.judge(mo.compare(base, mapOf(fresh)), restart), v => v.changed],
    ["one square opened", mo.judge(mo.compare(base, mapOf(asThree)), restart), v => !v.changed],
  ]);

  const board = { x: G.x, y: G.y, width: 30 * G.pitch, height: 16 * G.pitch };
  const inBoard = mo.compare(mo.motionMap(frame, board), mo.motionMap(asThree, board));
  check("a map of a region reports the change in the frame's own pixels",
    inBoard.cells.length > 0 && inBoard.bbox.x <= target.x && inBoard.bbox.x + inBoard.bbox.w >= target.x + target.w
      && inBoard.bbox.y <= target.y && inBoard.bbox.y + inBoard.bbox.h >= target.y + target.h
      && mo.judge(inBoard, click(centre(target))).changed && mo.motionMap(frame, board).x === G.x,
    show({ bbox: inBoard.bbox, target }));
  const small = mo.motionMap({ width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(128) });
  check("a frame smaller than the grid gets one cell per pixel", small.cols === 40 && small.rows === 20 && small.cells.every(v => v === 128),
    show({ cols: small.cols, rows: small.rows }));
  const resized = mo.compare(base, mo.motionMap(frame, { x: 0, y: 0, width: 900, height: 620 }));
  check("a frame of another size (a window resized, the crop changed) is the whole view changing",
    resized.resized && resized.global && mo.judge(resized, KEY).changed && mo.judge(resized, click(centre(target))).changed, show(resized.bbox));
  check("a noise floor for another region is not used", mo.compare(base, base, mo.calibrateNoise([small, small])).calibrated === false);

  // A canvas is read once, over the region asked for.
  const reads = [];
  const canvasLike = {
    width: frame.width, height: frame.height,
    getContext: () => ({
      getImageData: (x, y, w, h) => {
        reads.push([x, y, w, h]);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let j = 0; j < h; j++) data.set(frame.data.subarray(((y + j) * frame.width + x) * 4, ((y + j) * frame.width + x + w) * 4), j * w * 4);
        return { data, width: w, height: h };
      },
    }),
  };
  const fromCanvas = mo.motionMap(canvasLike);
  const fromRegion = mo.motionMap(canvasLike, board);
  const boardMap = mo.motionMap(frame, board);
  check("a canvas is read with ONE getImageData per map (over the region, when one is given), and gives the same map",
    show(reads) === show([[0, 0, 920, 620], [board.x, board.y, board.width, board.height]])
      && fromCanvas.cells.every((v, i) => v === base.cells[i])
      && fromRegion.cells.every((v, i) => v === boardMap.cells[i]), show(reads));

  // The legacy hash, exactly as it was: one getImageData per cell of an 8×8 grid.
  const oldHash = c => {
    const ctx = c.getContext("2d");
    const cw = Math.max(1, Math.floor(c.width / 8)), ch = Math.max(1, Math.floor(c.height / 8));
    const hash = new Float32Array(64);
    for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
      const data = ctx.getImageData(gx * cw, gy * ch, cw, ch).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      hash[gy * 8 + gx] = data.length > 0 ? sum / (data.length / 4) : 0;
    }
    return hash;
  };
  reads.length = 0;
  const was = oldHash(canvasLike);
  const oldReads = reads.length;
  reads.length = 0;
  const now = mo.legacyHash(canvasLike);
  check(`the legacy hash gives the old numbers exactly, from 1 read of the canvas instead of ${oldReads}`,
    now.every((v, i) => v === was[i]) && reads.length === 1 && oldReads === 64, `reads ${reads.length}`);
  check("the legacy distance is the old RMS, and 0 with a hash missing",
    Math.abs(mo.legacyDistance(new Float32Array(64).fill(1), new Float32Array(64).fill(4)) - 3) < 1e-9 && mo.legacyDistance(null, now) === 0);
}

// ── The agent's side: which detector, where each tool acts, the wait ─────────
console.log("change detection");
{
  check("the motion map decides by default, and the legacy hash can be chosen",
    cd.DEFAULT_DETECTOR === "motion" && show(Object.keys(cd.CHANGE_DETECTORS)) === show(["motion", "legacy"])
      && cd.detectorOf("legacy") === "legacy" && cd.detectorOf("nonsense") === "motion" && cd.detectorOf(undefined) === "motion");
  check("the legacy thresholds are the old ones: 2.0 for an action and the image skip, 3.0 for a restart",
    cd.LEGACY_THRESHOLD === 2.0 && cd.LEGACY_RESTART_THRESHOLD === 3.0 && cd.POLL_MS === 150);
  cases("each tool is judged where it acts", [
    ["click", cd.changeAction("click", { x: 10, y: 20 }), a => a.kind === "click" && show(a.at) === show([{ x: 10, y: 20 }])],
    ["click_grid at its cell's point", cd.changeAction("click_grid", { cell: "c4" }, { x: 55, y: 66 }),
      a => a.kind === "click" && show(a.at) === show([{ x: 55, y: 66 }]) && a.label.includes("C4")],
    ["drag, at both ends", cd.changeAction("drag", { x1: 1, y1: 2, x2: 3, y2: 4 }), a => a.kind === "drag" && a.at.length === 2],
    ["press_key", cd.changeAction("press_key", { key: "up" }), a => a.kind === "key" && !a.at && a.label.includes('"up"')],
    ["hold_key", cd.changeAction("hold_key", { key: "w" }), a => a.kind === "key" && !a.at],
    ["type_text", cd.changeAction("type_text", { text: "abc" }), a => a.kind === "type" && !a.at],
    ["scroll, anywhere", cd.changeAction("scroll", { x: 1, y: 2 }), a => a.kind === "scroll" && !a.at],
    ["gamepad", ["gamepad_button", "gamepad_stick", "gamepad_trigger"].map(t => cd.changeAction(t, {})), l => l.every(a => a.kind === "gamepad" && !a.at)],
    ["restart", cd.changeAction("restart"), a => a.kind === mo.RESTART_KIND],
  ]);

  const look = f => ({ map: mo.motionMap(f), hash: mo.legacyHash(f) });
  const before = look(frame), opened = look(asThree);
  const at = cd.changeAction("click", centre(target));
  const byMotion = cd.judgeLooks(before, opened, { action: at });
  const byLegacy = cd.judgeLooks(before, opened, { action: at, detector: "legacy" });
  cases("both detectors judge every look, and the one chosen decides", [
    ["motion map", byMotion, s => s.changed && s.by === "motion" && s.dist === s.motion.peak && s.motion.changed && !s.legacy.changed],
    ["legacy hash", byLegacy, s => !s.changed && s.by === "legacy" && s.dist === s.legacy.dist && s.motion.changed],
    ["restart threshold", cd.judgeLooks(before, opened, { detector: "legacy", threshold: 3 }), s => s.legacy.threshold === 3],
  ]);

  // The wait, on a clock of its own: looks come from a script.
  const scripted = (list) => {
    let i = 0, t = 0;
    return {
      look: async () => list[Math.min(i++, list.length - 1)],
      now: () => t,
      wait: async ms => { t += ms; },
      taken: () => i,
    };
  };
  {
    const s = scripted([before, before, opened, opened]);
    const seen = await cd.watchForChange(s.look, before, { maxMs: 2000, action: at, now: s.now, wait: s.wait });
    check("the wait decides at the first look that changed, gives the other detector one more look, and says both verdicts",
      seen.changed && seen.polls === 4 && seen.elapsed === 300 && s.now() === 300 + cd.POLL_MS
        && seen.seenBy.motion && !seen.seenBy.legacy && seen.by === "motion" && !seen.legacy.changed,
      show({ changed: seen.changed, polls: seen.polls, elapsed: seen.elapsed, t: s.now(), seenBy: seen.seenBy }));
  }
  {
    // A key whose effect animates in: the first look catches its start (a strip
    // moved 1 px), the next the whole move (6 px). The motion map decides on the
    // first; the legacy hash, given its one more look, sees it too, so the two
    // are not logged as disagreeing about a move both see.
    const startStrip = clone(frame), moved1 = shifted(frame, 1);
    for (let y = 300; y < 330; y++) startStrip.data.set(moved1.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4), y * frame.width * 4);
    const s = scripted([look(startStrip), look(shifted(frame, 6))]);
    const key = cd.changeAction("press_key", { key: "up" });
    const seen = await cd.watchForChange(s.look, before, { maxMs: 2000, action: key, now: s.now, wait: s.wait });
    const line = cd.changeLine(seen, key);
    check("a move still animating in when the motion map decides is still judged by the legacy hash on the next look, and not logged as a disagreement",
      seen.changed && seen.by === "motion" && seen.elapsed === 0 && seen.polls === 2 && seen.seenBy.motion && seen.seenBy.legacy
        && seen.legacy.changed && !/disagree/.test(line) && /legacy hash CHANGED/.test(line), line);
  }
  {
    const s = scripted([before]);
    const seen = await cd.watchForChange(s.look, before, { maxMs: 600, action: at, now: s.now, wait: s.wait });
    check("a wait that runs out says unchanged after maxMs, as before", !seen.changed && seen.elapsed === 600 && seen.polls === 5,
      show({ changed: seen.changed, polls: seen.polls, elapsed: seen.elapsed }));
  }
  {
    const s = scripted([opened, opened]);
    const seen = await cd.watchForChange(s.look, before, { maxMs: 600, action: at, detector: "legacy", now: s.now, wait: s.wait });
    check("with the legacy hash chosen it decides, and the motion map's view is still reported",
      !seen.changed && seen.by === "legacy" && seen.seenBy.motion && !seen.seenBy.legacy, show(seen.seenBy));
  }
  {
    const s = scripted([before, opened]);
    const seen = await cd.watchForChange(s.look, null, { maxMs: 600, action: at, now: s.now, wait: s.wait });
    check("with no baseline, one is taken first", seen.changed && seen.polls === 2 && s.taken() === 3);
  }
  {
    const s = scripted([null, null]);
    const seen = await cd.watchForChange(s.look, before, { maxMs: 300, action: at, now: s.now, wait: s.wait });
    check("a look that could not be taken is no change, not an error", !seen.changed && seen.motion.why === "no frame to compare");
  }

  // A pointer action's baseline: the page moves the pointer onto the target
  // first, then settleLook waits for the screen there to hold still.
  {
    const parkedAt = centre(square(0, 0)), there = centre(target);
    const away = look(withPointer(frame, parkedAt)), onIt = look(withPointer(frame, there));
    const openedUnder = look(withPointer(repaint(frame, square(...blank), target), there));
    // The share shows the pointer a look late: the first look still has it
    // where it was.
    const s = scripted([away, onIt, onIt]);
    const settled = await cd.settleLook(s.look, { at: there, now: s.now, wait: s.wait });
    const click = cd.changeAction("click", there);
    const deadLooks = scripted([onIt]), liveLooks = scripted([openedUnder]);
    const dead = await cd.watchForChange(deadLooks.look, settled.look, { maxMs: 300, action: click, now: deadLooks.now, wait: deadLooks.wait });
    const live = await cd.watchForChange(liveLooks.look, settled.look, { maxMs: 300, action: click, now: liveLooks.now, wait: liveLooks.wait });
    const fromParked = cd.judgeLooks(away, onIt, { action: click });
    cases("the baseline is taken once the pointer shows on the target and holds still: a dead click is then no change, an opening is", [
      ["settled", settled, v => v.still && v.look === onIt && v.looks === 3 && s.now() === 3 * cd.HOVER_POLL_MS],
      ["a dead click", dead, v => !v.changed],
      ["an opening under the pointer", live, v => v.changed && v.motion.nearest === 0],
      ["from a baseline with the pointer elsewhere, the dead click would read changed", fromParked, v => v.changed],
    ]);
    const still = scripted([onIt, onIt]);
    const quick = await cd.settleLook(still.look, { at: there, now: still.now, wait: still.wait });
    const busy = scripted([away, onIt, away, onIt, away, onIt, away, onIt, away, onIt]);
    const slow = await cd.settleLook(busy.look, { at: there, now: busy.now, wait: busy.wait });
    // Something moving far from the target (the clock) does not hold it up.
    const ticking = scripted([onIt, look(withPointer(copyRect(frame, { x: 0, y: 0 }, { x: 800, y: 90 }, 40, 30), there))]);
    const clock = await cd.settleLook(ticking.look, { at: there, now: ticking.now, wait: ticking.wait });
    cases(`on a still screen it takes two looks (${2 * cd.HOVER_POLL_MS} ms), and at most ${cd.HOVER_SETTLE_MS} ms`, [
      ["still", { still: quick.still, looks: quick.looks, t: still.now() }, v => v.still && v.looks === 2 && v.t === 2 * cd.HOVER_POLL_MS],
      ["never still", { still: slow.still, t: busy.now() }, v => !v.still && v.t <= cd.HOVER_SETTLE_MS + cd.HOVER_POLL_MS],
      ["a clock ticking away from the target", { still: clock.still, looks: clock.looks }, v => v.still && v.looks === 2],
    ]);
  }

  // A look that could not be taken (null: native capture sends no frame when
  // nothing changed) says nothing about the screen. Taken for the baseline, the
  // wait would take its own after the action, and every click read unchanged.
  {
    const there = centre(target);
    const onIt = look(withPointer(frame, there));
    const gaps = scripted([onIt, null]);
    const settled = await cd.settleLook(gaps.look, { at: there, now: gaps.now, wait: gaps.wait });
    const gapped = scripted([onIt, null, onIt]);
    const resumed = await cd.settleLook(gapped.look, { at: there, now: gapped.now, wait: gapped.wait });
    const cal = scripted([before, null, before]);
    const taken = await cd.calibrate(cal.look, { now: cal.now, wait: cal.wait });
    // None until the settle time runs out: the first look is still the first
    // idle frame, so the floor has its two.
    const gappy = scripted([before, null, null, before]);
    const gapTaken = await cd.calibrate(gappy.look, { now: gappy.now, wait: gappy.wait, settleMs: 2 * cd.POLL_MS });
    cases("a look that could not be taken never replaces a real one, and is not the screen holding still", [
      ["settling, with none after the first", { still: settled.still, kept: settled.look === onIt }, v => v.kept && !v.still],
      ["settling, with one missing between two", { still: resumed.still, kept: resumed.look === onIt, looks: resumed.looks }, v => v.kept && v.still && v.looks === 3],
      ["calibrating, with one missing", { still: taken.still, frames: taken.frames, floor: !!taken.noise }, v => v.still && v.frames === 2 && v.floor],
      ["calibrating, with none until the settle time ran out", { still: gapTaken.still, frames: gapTaken.frames, floor: !!gapTaken.noise },
        v => !v.still && v.frames === 2 && v.floor],
    ]);
  }

  // A drag: the baseline has the pointer on its start (hoverFirst), and the page
  // takes it back there after the drag, but the share still shows it on the end
  // for a look. Judged at once, a drag that did nothing reads as changed at both
  // ends; the page lets both ends settle first (settleAt), then waits.
  {
    const opens = cellsWhere(v => v !== COVERED && v !== undefined);
    const pairs = [];
    for (let i = 0; i + 1 < opens.length; i += 7) pairs.push([centre(square(...opens[i])), centre(square(...opens[(i + 40) % opens.length]))]);
    const dragOf = (from, to) => cd.changeAction("drag", { x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    const settledThenWait = async (looks, base, action) => {
      const s = scripted(looks);
      await cd.settleLook(s.look, { at: action.at, now: s.now, wait: s.wait });
      return cd.watchForChange(s.look, base, { maxMs: 300, action, now: s.now, wait: s.wait });
    };
    let settledAlive = 0, atOnceAlive = 0;
    for (const [from, to] of pairs) {
      const base = look(withPointer(frame, from));
      const late = [look(withPointer(frame, to)), look(withPointer(frame, from))];
      if ((await settledThenWait(late, base, dragOf(from, to))).changed) settledAlive++;
      const s = scripted(late);
      if ((await cd.watchForChange(s.look, base, { maxMs: 300, action: dragOf(from, to), now: s.now, wait: s.wait })).changed) atOnceAlive++;
    }
    // A drag that moved a piece: the covered target square carried onto an open
    // square far off, a blank left where it was.
    const pieceAt = centre(target), toSq = square(...opens.find(([r, c]) => Math.abs(c - tc) > 8 || Math.abs(r - tr) > 6)), dropAt = centre(toSq);
    const moved = repaint(repaint(frame, target, toSq), square(...blank), target);
    const live = await settledThenWait([look(withPointer(moved, dropAt)), look(withPointer(moved, pieceAt))], look(withPointer(frame, pieceAt)), dragOf(pieceAt, dropAt));
    cases(`a drag is judged once both ends have settled, with the pointer back on its start shown a look late (${pairs.length} dead drags)`, [
      ["dead drags, settled first", settledAlive, n => n === 0],
      ["dead drags judged at once would read changed", atOnceAlive, n => n === pairs.length],
      ["a drag that moved a piece", { changed: live.changed, by: live.by, why: live.motion.why }, v => v.changed && v.by === "motion"],
    ]);
  }

  // Calibration: settle, then two idle frames 1.1 s apart.
  {
    const ticking = look(copyRect(frame, { x: 0, y: 0 }, { x: 800, y: 90 }, 40, 30));
    const s = scripted([opened, before, before, ticking]);
    const taken = await cd.calibrate(s.look, { now: s.now, wait: s.wait });
    check("calibration waits for the screen to settle, then takes two idle frames 1.1 s apart",
      taken.still && taken.frames === 2 && !!taken.noise && taken.noise.moving > 0 && s.now() === cd.POLL_MS * 2 + cd.CALIBRATION_GAP_MS
        && cd.CALIBRATION_FRAMES === 2 && cd.CALIBRATION_GAP_MS > 1000,
      show({ still: taken.still, frames: taken.frames, t: s.now(), moving: taken.noise?.moving }));
    const busy = scripted([before, opened, before, opened, before, opened, before, opened, before, opened, before, opened, before, opened, before, opened]);
    const moving = await cd.calibrate(busy.look, { now: busy.now, wait: busy.wait, settleMs: 600 });
    check("a screen that never settles is calibrated as it is, after at most the settle time, and says so",
      !moving.still && !!moving.noise && moving.noise.moving > 0 && /still moving/.test(cd.calibrationLine(moving.noise, { still: moving.still })));
    const stopped = await cd.calibrate(scripted([before]).look, { stopped: () => true, now: () => 0, wait: async () => {} });
    check("■ Stop ends a calibration with no floor", stopped.noise === null);
  }

  // The log lines.
  const seen = { ...byMotion, elapsed: 150, polls: 1, seenBy: { motion: true, legacy: false } };
  const line = cd.changeLine(seen, at);
  check("every action's line has both detectors side by side, which decided, and where they disagree",
    /^Change after click at \d+,\d+ \(150 ms, 1 look\): motion map CHANGED — .*peak \d+\.\d, bbox \d+,\d+ \d+×\d+.* \| legacy hash no change — dist 0\.\d\d, needs over 2\.0 \| decided by the motion map \(they disagree: only the motion map saw a change\)$/.test(line),
    line);
  const tl = cd.turnLine(byMotion, { turn: 4, skipped: false });
  check("the image skip's line says the same, and whether the image was skipped",
    /^Turn 4 screen since the last turn: motion map CHANGED .* \| legacy hash no change .* \| decided by the motion map: image sent/.test(tl), tl);
  const cal = cd.calibrationLine(mo.calibrateNoise([base, base]), { game: 2 });
  check("the calibration line says which detector decides and what moved on its own",
    /^Change detection for game 2 \(decided by the motion map\): noise floor from 2 idle frames 1\.1 s apart: nothing moved on its own/.test(cal)
      && /no noise floor/.test(cd.calibrationLine(null)), cal);
  const tally = cd.newTally();
  for (const seenBy of [{ motion: true, legacy: true }, { motion: true, legacy: false }, { motion: false, legacy: false }, { motion: false, legacy: true }]) {
    cd.tallyChange(tally, { seenBy });
  }
  const closing = cd.tallyLine(tally, "legacy");
  check("the run closes with a tally of where the two disagreed",
    show(tally) === show({ actions: 4, agree: 2, motionOnly: 1, legacyOnly: 1 })
      && /^Change detection this run \(decided by the legacy hash\): 4 actions judged; both detectors agreed on 2, only the motion map saw a change on 1 action, only the legacy hash on 1 action\./.test(closing)
      && cd.tallyLine(cd.newTally()) === null, closing);

  const run = { session: "s", changeDetection: "legacy", timing: {} };
  check("run.json and the RUN line say which detector decided",
    ep.RUN_FIELDS.includes("changeDetection") && ep.runRecord(run).changeDetection === "legacy"
      && ep.runHeader(run).includes(" · change detection legacy hash · ") && ep.runHeader({ ...run, changeDetection: "motion" }).includes("change detection motion map"),
    ep.runHeader(run));
}

// ── The page's wiring ─────────────────────────────────────────────────────────
console.log("GameAgent.jsx");
const AGENT = path.join(ROOT, "src", "GameAgent.jsx");
const code = fs.readFileSync(AGENT, "utf8").replace(/\r\n/g, "\n");
const between = (from, to) => {
  const a = code.indexOf(from);
  const b = a < 0 ? -1 : code.indexOf(to, a + from.length);
  return a < 0 || b < 0 ? "" : code.slice(a, b);
};
{
  const count = re => [...code.matchAll(re)].length;
  check("the 8×8 hash is gone from the page, which reads each frame once for both detectors",
    !/\bframeHash\(|\bhashDist\(/.test(code) && count(/getImageData\(/g) === 0
      && /function lookAt\(canvasEl\) \{\s*const pixels = pixelsOf\(canvasEl\);[\s\S]{0,200}?return \{ map: motionMap\(frame\), hash: legacyHash\(frame\) \};/.test(code));
  const waits = [...code.matchAll(/await waitChange\(([^;]*?)\);/g)].map(m => m[1]);
  const unjudged = waits.filter(w => !/^lookNow, (__base|base), \{[\s\S]*action: changeAction\(/.test(w));
  check(`every wait for a change looks with lookNow from a baseline taken before the action, and says where it acted (${waits.length} waits)`,
    waits.length >= 12 && !unjudged.length, unjudged.join("  |  ") || `found ${waits.length}`);
  const baselines = [...code.matchAll(/await snapshotHash\(([^)]*)\)/g)].map(m => m[1]);
  check(`every baseline is a look, not a frame for the model (${baselines.length}, and the pointer actions' through settledBaseline)`,
    baselines.length >= 7 && baselines.every(b => b === "lookNow")
      && /async function settleAt\(look, at\) \{\s*return inTurnPhase\("confirm", \(\) => settleLook\(look, \{ at, noise: _changeNoise \}\)\);\s*\}/.test(code)
      && /async function settledBaseline\(look, at\) \{\s*return \(await settleAt\(look, at\)\)\.look;\s*\}/.test(code),
    show([...new Set(baselines)]));

  // Every pointer action moves the pointer onto its target, checks for a halt,
  // and takes its baseline there before it acts, and a click is then sent with
  // no move of its own.
  const tools = between("const executeTool = useCallback(", 'toolName === "update_memory"');
  check("hoverFirst moves the pointer, stops at a halt, then takes the baseline there",
    /const hoverFirst = async \(x, y, at\) => \{\s*const moved = await backend\("\/mouse\/move", \{ x, y, duration: timing\.mouseSpeed \}\);\s*if \(isHaltReply\(moved\)\) return \{ halted: moved \};\s*return \{ base: await settledBaseline\(lookNow, at\) \};/.test(tools));
  const pointerTools = ["click", "click_grid", "drag", "scroll"].map(name => {
    const body = between(`if (toolName === "${name}") {`, "\n    }\n");
    const hovered = body.indexOf("await hoverFirst(");
    const acts = body.search(/backend\("\/mouse\/(click|drag|scroll)"/);
    const ok = hovered >= 0 && acts > hovered
      && /if \(hovered\.halted\) return halted\(hovered\.halted\);\s*const __base = hovered\.base;/.test(body)
      && !/snapshotHash\(/.test(body)
      && (!/\/mouse\/click/.test(body) || /move_duration: 0,/.test(body));
    return [name, ok];
  });
  const sequence = between('if (toolName === "execute_sequence") {', "const confirm = await waitChange(");
  pointerTools.push(["execute_sequence's click", /if \(t === "click"\) \{[\s\S]*?const hovered = await hoverFirst\([\s\S]*?__base = hovered\.base \?\? null;\s*r = hovered\.halted \?\? await backend\("\/mouse\/click", \{[\s\S]*?move_duration: 0,/.test(sequence)]);
  const unhovered = pointerTools.filter(([, ok]) => !ok).map(([name]) => name);
  check(`click, click_grid, drag, scroll and a sequence's click take their baseline with the pointer already on the target (${pointerTools.length - unhovered.length} of ${pointerTools.length})`,
    !unhovered.length && !/move_duration: timing\.mouseSpeed/.test(code), unhovered.join(", "));
  const drag = between('if (toolName === "drag") {', "\n    }\n");
  check("a drag takes the pointer back to its start, lets both ends settle, and only then is judged, in the confirm time left",
    /const ends = \[\{ x: Number\(toolInput\.x1\), y: Number\(toolInput\.y1\) \}, \{ x: Number\(toolInput\.x2\), y: Number\(toolInput\.y2\) \}\];/.test(drag)
      && /const hovered = await hoverFirst\(s1\.x, s1\.y, ends\[0\]\);/.test(drag)
      && /const back = await backend\("\/mouse\/move", \{ x: s1\.x, y: s1\.y, duration: 0 \}\);\s*if \(isHaltReply\(back\)\) return halted\(back\);\s*(?:\/\/[^\n]*\s*)*const settling = Date\.now\(\);\s*await settleAt\(lookNow, ends\);\s*const confirm = await waitChange\(lookNow, __base, \{ maxMs: Math\.max\(0, timing\.confirmDelay - \(Date\.now\(\) - settling\)\), action: changeAction\("drag", toolInput\) \}\);/.test(drag),
    drag.slice(drag.indexOf("const back"), drag.indexOf("setLastConfirm")));
  const restart = between("const attemptRestart = useCallback(", "const testSolver = useCallback(");
  check("the restart's own clicks, and the model's, are verified from a baseline taken with the pointer on the button",
    /const clickToRestart = async \(x, y\) => \{\s*const moved = await sendWhenLive\("\/mouse\/move", \{ x, y, duration: timing\.mouseSpeed \}\);\s*if \(moved\.stopped\) return \{ base: null, res: moved \};[\s\S]*?const base = await settledBaseline\(lookNow, [^;]*;\s*const res = await sendWhenLive\("\/mouse\/click", \{ x, y, button: "left", clicks: 1, move_duration: 0 \}\);/.test(restart)
      && [...restart.matchAll(/const \{ base, res \} = await clickToRestart\(x, y\);/g)].length === 2
      && /await executeTool\(clickAct\.tool, clickAct\.input, `\$\{clickAct\.tool\}__restart`, \{ onBaseline: b => \(base = b\) \}\);/.test(restart)
      && [...tools.matchAll(/const __base = hovered\.base;\s*onBaseline\?\.\(__base\);/g)].length === 2);
  const drawFrame = between("const drawFrame = useCallback(", "const captureNow = useCallback(");
  const lookNow = between("const lookNow = useCallback(", "\n\n");
  check("a look makes no JPEG: drawFrame captures with encode off and draws no grid, and lookNow only reads it",
    !!drawFrame && !/toDataURL|drawGrid/.test(drawFrame) && /captureFrame\([^)]*\{ encode: false \}\)/.test(drawFrame)
      && /inTurnPhase\("capture", async \(\) => lookFrom\(await drawFrame\(\), canvasRef\.current, captureKey\(\)\)\)/.test(lookNow),
    lookNow.slice(0, 200));
  const captureNow = between("const captureNow = useCallback(", "const grabFrame = useCallback(");
  check("a frame for the model is looked at before the click grid goes on, kept as the last look, and encoded once",
    /const look = keepLook\(lookAt\(canvasRef\.current\), captureKey\(\)\.key\);[\s\S]*drawGrid\(canvasRef\.current\);/.test(captureNow)
      && count(/toDataURL\("image\/jpeg", FRAME_QUALITY\)/g) === 2 && /return \{ \.\.\.base, look \};/.test(captureNow),
    captureNow.slice(0, 300));
  // Native capture sends no frame when nothing changed: the last look stands in,
  // for that capture only. drawFrame is the only caller of /capture/frame, so
  // every frame the backend sends is kept.
  check("the last look is kept by every look and frame, keyed by the capture source, native region and crop, and a new region forgets it",
    count(/backend\("\/capture\/frame"\)/g) === 1 && count(/keepLook\(lookAt\(/g) === 2
      && /const captureKey = useCallback\(\(\) => \(\{\s*native: captureSourceRef\.current === "native",\s*key: `\$\{captureSourceRef\.current\}\|\$\{nativeRegionRef\.current \?\? ""\}\|\$\{JSON\.stringify\(cropRef\.current \?\? null\)\}`,\s*\}\), \[\]\);/.test(code)
      && /function lookFrom\(drawn, canvasEl, \{ key = "", native = false \} = \{\}\) \{\s*if \(drawn\) return keepLook\(lookAt\(canvasEl\), key\);\s*return native && _lastLook\?\.key === key \? _lastLook\.look : null;\s*\}/.test(code)
      && /nativeRegionRef\.current = r\.ok \? JSON\.stringify\(r\.region\) : null;/.test(between("const selectNativeWindow = useCallback(", "}, [addLog]);")));
  check("the image skip judges the screen since the last turn by both detectors",
    /const sinceLast = \(currentLook && lastTurnLookRef\.current\)\s*\? judgeLooks\(lastTurnLookRef\.current, currentLook,\s*\{ noise: _changeNoise, detector: _changeDetector, action: changeAction\("turn"\), threshold: LEGACY_THRESHOLD \}\)/.test(code)
      && /const a1Skip = turnCountRef\.current > 1 && !!sinceLast && !sinceLast\.changed && !lastNoOp;/.test(code)
      && /addLog\(turnLine\(sinceLast, \{ turn: turnCountRef\.current, skipped: a1Skip \}\), "info", \{ fileOnly: true \}\)/.test(code));
  check("a restart counts only as a new screen (or, by the legacy hash, over 3.0)",
    /waitChange\(lookNow, base, \{\s*maxMs: Math\.max\(timing\.confirmDelay, 2500\), threshold: LEGACY_RESTART_THRESHOLD, action: changeAction\("restart"\),\s*\}\)/.test(code));
  check("the wait hands both verdicts to the page, with the action",
    /const seen = await watchForChange\(look, baseline, \{ \.\.\.how, noise: _changeNoise, detector: _changeDetector \}\);\s*noteTurn\(\{ changed: !!seen\.changed \}\);\s*_onChangeJudged\?\.\(seen, how\.action \?\? null\);/.test(code));
  check("...which writes them to the log file only, one line per action, and counts them",
    /onChangeJudged\(\(seen, action\) => \{\s*const line = changeLine\(seen, action\);\s*if \(line\) addLog\(line, "info", \{ fileOnly: true \}\);\s*tallyChange\(changeTallyRef\.current, seen\);/.test(code)
      && /if \(!fileOnly\) setLog\(/.test(code));
  check("each game is calibrated from idle frames before the model's first turn in it, and a solver's game not at all",
    /setChangeNoise\(null\);\s*let changeCalibrated = false;\s*\n\s*while \(!stopRef\.current\) \{/.test(code)
      // With no plugin the look as the game begins is kept for the screen
      // handler (src/agent/stuckScreen.js, withAppeared), once calibrated.
      && /if \(!changeCalibrated\) \{\s*changeCalibrated = true;\s*await calibrateChange\(gameIdx \+ 1\);\s*(?:\/\/[^\n]*\s*)*(?:if \(modelPlays && !stopRef\.current\) gameStartLookRef\.current = \{ look: await lookNow\(\), scale: \{ \.\.\.scaleRef\.current \} \};\s*(?:\/\/[^\n]*\s*)*)?while \(\(pauseRef\.current \|\| haltedRef\.current\) && !stopRef\.current\) await [^\n]*\s*if \(stopRef\.current\) break;\s*\}\s*const turnStarted = Date\.now\(\);\s*const result = await agentTurn\(/.test(code)
      && [...code.matchAll(/await calibrateChange\(/g)].length === 1
      && /const taken = await calibrate\(lookNow, \{ stopped: \(\) => stopRef\.current \}\);\s*if \(stopRef\.current\) return;\s*setChangeNoise\(taken\.noise\);/.test(code));
  check("a run starts with no floor and a fresh tally, and closes with the tally",
    /setChangeNoise\(null\);\s*changeTallyRef\.current = newTally\(\);/.test(code)
      && /const changeTally = tallyLine\(changeTallyRef\.current, _changeDetector\);\s*if \(changeTally\) addLog\(changeTally, "info"\);/.test(code));
  check("the setting is in ADVANCED, applied at once, and stamped on the run",
    /aria-label="Change detection"/.test(code) && /Object\.entries\(CHANGE_DETECTORS\)\.map\(/.test(code)
      && /useEffect\(\(\) => \{ setChangeDetector\(changeDetector\); \}, \[changeDetector\]\);/.test(code)
      && /changeDetection: detectorOf\(changeDetector\),/.test(between("const runSettings = {", "};")));
}

// The page's own waitChange, bundled, on looks of the real capture.
{
  const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
  const reactFromRepo = {
    name: "react-from-repo",
    setup(b) {
      b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, a => ({ path: pathToFileURL(requireFromRoot.resolve(a.path)).href, external: true }));
    },
  };
  const bundlePath = path.join(os.tmpdir(), `game-agent-motion-${process.pid}-${randomUUID()}.mjs`);
  let page = null;
  try {
    await build({
      stdin: {
        contents: `${fs.readFileSync(AGENT, "utf8")}\nexport { waitChange as __waitChange, snapshotHash as __snapshotHash, lookAt as __lookAt, setChangeDetector as __setChangeDetector, setChangeNoise as __setChangeNoise, onChangeJudged as __onChangeJudged, settledBaseline as __settledBaseline, settleAt as __settleAt, lookFrom as __lookFrom, keepLook as __keepLook };\n`,
        resolveDir: path.join(ROOT, "src"), sourcefile: "GameAgent.jsx", loader: "jsx",
      },
      bundle: true, platform: "node", format: "esm", jsx: "automatic",
      outfile: bundlePath, logLevel: "silent", plugins: [reactFromRepo],
    });
    page = await import(pathToFileURL(bundlePath).href);
  } catch (e) {
    check("GameAgent.jsx bundles with waitChange, snapshotHash, settledBaseline, settleAt, lookAt, lookFrom and the detector's setters", false, e?.message ?? String(e));
  } finally {
    fs.rmSync(bundlePath, { force: true });
  }
  if (page) {
    const canvasOf = f => ({ width: f.width, height: f.height, getContext: () => ({ getImageData: () => ({ data: f.data, width: f.width, height: f.height }) }) });
    const before = page.__lookAt(canvasOf(frame)), after = page.__lookAt(canvasOf(asBlank));
    check("lookAt reads a canvas into a motion map and a legacy hash",
      !!before?.map && before.map.cols === 64 && before.hash?.length === 64 && page.__lookAt({ width: 0, height: 0 }) === null);
    const heard = [];
    page.__onChangeJudged((seen, action) => heard.push({ seen, action }));
    page.__setChangeNoise(null);
    const looks = () => { let n = 0; return async () => (n++ === 0 ? before : after); };
    const action = cd.changeAction("click", centre(target));
    page.__setChangeDetector("motion");
    const baseline = await page.__snapshotHash(looks());
    const byMotion = await page.__waitChange(async () => after, baseline, { maxMs: 300, action });
    page.__setChangeDetector("legacy");
    const byLegacy = await page.__waitChange(async () => after, before, { maxMs: 300, action });
    page.__setChangeDetector("motion");
    page.__onChangeJudged(null);
    cases("the page's waitChange: one opened square is a change by the motion map, and not by the legacy hash when that is chosen", [
      ["motion map", byMotion, s => s.changed && s.by === "motion" && !s.legacy.changed],
      ["legacy hash", byLegacy, s => !s.changed && s.by === "legacy" && s.motion.changed && s.elapsed === 300],
      ["heard, with the action", heard, h => h.length === 2 && h.every(x => x.action === action && x.seen.motion && x.seen.legacy)],
      ["and logged side by side", heard.map(h => cd.changeLine(h.seen, h.action)),
        l => /decided by the motion map/.test(l[0]) && /decided by the legacy hash \(they disagree/.test(l[1])],
    ]);
    // The page's own baseline for a pointer action, on real timers: the share
    // shows the pointer on the target a look late, and the baseline has it.
    const there = centre(target);
    const shown = [page.__lookAt(canvasOf(withPointer(frame, centre(square(0, 0))))), page.__lookAt(canvasOf(withPointer(frame, there)))];
    let n = 0;
    const t0 = Date.now();
    const settled = await page.__settledBaseline(async () => shown[Math.min(n++, 1)], there);
    check("the page's settledBaseline returns the look with the pointer on the target, once it has held still",
      settled === shown[1] && n === 3 && Date.now() - t0 >= 3 * cd.HOVER_POLL_MS - 20, show({ looks: n, ms: Date.now() - t0 }));

    // Native capture (the backend's dxcam) sends no frame when nothing on the
    // monitor changed since the last one it sent, and a pointer move alone makes
    // one; it draws no pointer. Looks here go through the page's own lookFrom,
    // which stands the last look in, so no baseline is lost.
    const look = f => page.__lookAt(canvasOf(f));
    const nativeCapture = start => {
      let screen = start, served = null, pointerMoved = false, t = 0;
      const canvas = {
        width: 0, height: 0, shown: null,
        getContext() { const f = this.shown; return { getImageData: () => ({ data: f.data, width: f.width, height: f.height }) }; },
      };
      const capture = { key: "native||null", native: true };
      return {
        canvas, capture,
        look: async () => {
          t += 100;   // the backend tries five times, 20 ms apart, then says "no frame captured"
          if (screen === served && !pointerMoved) return page.__lookFrom(null, canvas, capture);
          served = screen;
          pointerMoved = false;
          Object.assign(canvas, { width: screen.width, height: screen.height, shown: screen });
          return page.__lookFrom({ base: {}, mutated: false }, canvas, capture);
        },
        raw: async () => {   // the same capture with nothing standing in
          t += 100;
          if (screen === served && !pointerMoved) return null;
          served = screen;
          pointerMoved = false;
          return look(screen);
        },
        show: s => { screen = s; },
        movePointer: () => { pointerMoved = true; },
        now: () => t, wait: async ms => { t += ms; },
      };
    };
    // A plain panel over a fifth of the view, at its centre: a change the legacy
    // hash sees too.
    const withPanel = f => {
      const out = clone(f), w = 420, h = 300, x0 = Math.round((f.width - w) / 2), y0 = Math.round((f.height - h) / 2);
      for (let y = y0; y < y0 + h; y++) out.data.fill(250, (y * f.width + x0) * 4, (y * f.width + x0 + w) * 4);
      return out;
    };
    const panelAt = { x: frame.width / 2, y: frame.height / 2 };
    // A click as the page makes it: the turn's frame, the pointer moved onto the
    // target (hoverFirst), the baseline once it holds still, the click, the wait.
    const nativeClick = async (after, at, detector) => {
      const cap = nativeCapture(frame);
      await cap.look();
      cap.movePointer();
      const settled = await cd.settleLook(cap.look, { at, now: cap.now, wait: cap.wait });
      if (after) cap.show(after);
      const seen = await cd.watchForChange(cap.look, settled.look, { maxMs: 600, action: cd.changeAction("click", at), detector, now: cap.now, wait: cap.wait });
      return { baseline: !!settled.look, still: settled.still, looks: settled.looks, changed: seen.changed, by: seen.by };
    };
    const settledFast = v => v.baseline && v.still && v.looks === 2;
    cases("native capture on a still screen: every click keeps its baseline, a live one reads changed and a dead one unchanged, by either detector", [
      ["motion map, a square opened", await nativeClick(asBlank, centre(target), "motion"), v => settledFast(v) && v.changed && v.by === "motion"],
      ["motion map, a dead click", await nativeClick(null, centre(target), "motion"), v => settledFast(v) && !v.changed],
      ["legacy hash, a panel opened", await nativeClick(withPanel(frame), panelAt, "legacy"), v => settledFast(v) && v.changed && v.by === "legacy"],
      ["legacy hash, a dead click", await nativeClick(null, panelAt, "legacy"), v => settledFast(v) && !v.changed],
    ]);
    const nativeKey = async (after, { raw = false } = {}) => {
      const cap = nativeCapture(frame);
      const shown = await cap.look();   // the turn's frame
      const source = raw ? cap.raw : cap.look;
      const base = await source();      // the key's baseline: nothing changed since
      if (after) cap.show(after);
      const seen = await cd.watchForChange(source, base, { maxMs: 600, action: cd.changeAction("press_key", { key: "x" }), now: cap.now, wait: cap.wait });
      return { baseline: base === shown, changed: seen.changed };
    };
    const still = nativeCapture(frame);
    await still.look();
    const calibrated = await cd.calibrate(still.look, { now: still.now, wait: still.wait });
    cases("...a key keeps the turn's look as its baseline, a still screen calibrates, and the last look stands in only for the capture it came from", [
      ["a key that worked", await nativeKey(asBlank), v => v.baseline && v.changed],
      ["a key that did nothing", await nativeKey(null), v => v.baseline && !v.changed],
      ["with nothing standing in, a key that worked would read unchanged", await nativeKey(asBlank, { raw: true }), v => !v.baseline && !v.changed],
      ["calibration", { still: calibrated.still, frames: calibrated.frames, line: cd.calibrationLine(calibrated.noise, { still: calibrated.still }) },
        v => v.still && v.frames === 2 && /nothing moved on its own/.test(v.line)],
      ["another region or crop", page.__lookFrom(null, still.canvas, { ...still.capture, key: "native|{\"left\":0}|null" }), v => v === null],
      ["a browser share with no frame", page.__lookFrom(null, still.canvas, { ...still.capture, native: false }), v => v === null],
    ]);

    // The same through the page's own settledBaseline, settleAt and waitChange,
    // on real timers.
    page.__setChangeDetector("motion");
    page.__setChangeNoise(null);
    const pageClick = async after => {
      const cap = nativeCapture(frame);
      await cap.look();
      cap.movePointer();
      const base = await page.__settledBaseline(cap.look, centre(target));
      if (after) cap.show(after);
      return page.__waitChange(cap.look, base, { maxMs: cd.POLL_MS, action: cd.changeAction("click", centre(target)) });
    };
    const liveClick = await pageClick(asBlank), deadClick = await pageClick(null);
    // A dead drag with the share a look late: the pointer still on the end first.
    const opensForDrag = cellsWhere(v => v !== COVERED && v !== undefined);
    const dragFrom = centre(square(...opensForDrag[0])), dragTo = centre(square(...opensForDrag[40 % opensForDrag.length]));
    const lateLooks = [look(withPointer(frame, dragTo)), look(withPointer(frame, dragFrom))];
    let k = 0;
    const lateSource = async () => lateLooks[Math.min(k++, 1)];
    const dragAction = cd.changeAction("drag", { x1: dragFrom.x, y1: dragFrom.y, x2: dragTo.x, y2: dragTo.y });
    const dragSettled = await page.__settleAt(lateSource, dragAction.at);
    const deadDrag = await page.__waitChange(lateSource, look(withPointer(frame, dragFrom)), { maxMs: cd.POLL_MS, action: dragAction });
    cases("the page's own functions: native clicks judged by what they did, and a dead drag, settled first, is no change", [
      ["a native click that opened a square", liveClick, s => s.changed && s.by === "motion"],
      ["a native click that did nothing", deadClick, s => !s.changed],
      ["a dead drag's ends settled", dragSettled, v => v.still && v.look === lateLooks[1]],
      ["a dead drag", deadDrag, s => !s.changed],
    ]);
  }
}

// ── What the operator is told ─────────────────────────────────────────────────
console.log("SETUP.md");
{
  const setup = fs.readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  check("SETUP.md explains the setting, the pointer going first, the calibration line, the per-action lines and the tally, and Test 18 shares the Entire Screen",
    /Change detection/.test(setup) && /motion map/.test(setup) && /legacy hash/.test(setup)
      && /Change after /.test(setup) && /noise floor/.test(setup) && /Change detection this run/.test(setup)
      && /The pointer goes first/.test(setup) && /\*\*Share Screen\*\* → \*\*Entire Screen\*\*/.test(setup)
      && /until the screen at both its\s+ends holds still/.test(setup) && /DirectX capture \(dxcam\) on a still screen/.test(setup)
      && /Pass, change detection:/.test(setup));
}

console.log(failures ? `\n${failures} check${failures === 1 ? "" : "s"} failed` : "\nall change-detection checks passed");
process.exit(failures ? 1 : 0);

// A browser's drawImage straight down to 64×36 with its default (bilinear)
// filtering: each cell samples the four pixels around its centre.
function bilinear64x36(f) {
  const W = 64, H = 36, out = new Float32Array(W * H);
  const sx = f.width / W, sy = f.height / H;
  const g = (x, y) => { const i = (y * f.width + x) * 4; return 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2]; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = (x + 0.5) * sx - 0.5, fy = (y + 0.5) * sy - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(f.width - 1, x0 + 1), y1 = Math.min(f.height - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      out[y * W + x] = (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay) + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
    }
  }
  return out;
}
