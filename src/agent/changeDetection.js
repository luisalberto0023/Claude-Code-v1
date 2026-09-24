// ── Did the action do anything? ───────────────────────────────────────────────
//
// After every action the page watches the screen until it changes or the timing
// profile's confirm delay runs out. What it concludes drives the rest of the
// loop: the model is told whether its move did anything, a run of moves that
// did nothing becomes a stuck game, the next turn's screenshot is skipped when
// nothing changed, and a restart counts only when the screen shows a new game.
//
// Two detectors judge every look at the screen. The motion map
// (src/vision/motion.js) decides by default. The legacy 8×8 hash it replaces is
// still worked out, and decides instead when the page's "Change detection"
// setting says so, so a run can be put back without a code change. Both are
// written to the log file side by side for every action, and a tally closes
// each run, so the first sessions on the test PC show where the two disagree.
//
// This module is what that means for the agent: which detector decides, where
// each tool acts (a click is judged near where it landed, a key anywhere), the
// wait itself, a pointer action's baseline (taken with the pointer already on
// its target), and the log lines. GameAgent.jsx's waitChange runs the wait;
// tools/check-motion.mjs checks all of it.

import {
  compare, judge, usesWideFloor, calibrateNoise, legacyDistance, RESTART_KIND, MIN_DELTA, NOISE_GAIN, MAX_LIMIT,
} from "../vision/motion.js";

export const CHANGE_DETECTORS = Object.freeze({ motion: "motion map", legacy: "legacy hash" });
export const DEFAULT_DETECTOR = "motion";

/** A detector's id: "motion" or "legacy", and the default for anything else. */
export function detectorOf(value) {
  return Object.prototype.hasOwnProperty.call(CHANGE_DETECTORS, value) ? value : DEFAULT_DETECTOR;
}

// The legacy hash's thresholds, as they were: 2.0 for an action and for the
// image skip, 3.0 for a restart.
export const LEGACY_THRESHOLD = 2.0;
export const LEGACY_RESTART_THRESHOLD = 3.0;

// How often the screen is looked at while waiting for a change, as before.
export const POLL_MS = 150;

// A game's noise floor comes from this many idle frames, this far apart: just
// over a second, so a clock that ticks once a second ticks between them. Nothing
// is sent to the game meanwhile.
export const CALIBRATION_FRAMES = 2;
export const CALIBRATION_GAP_MS = 1100;
// ...once the screen has settled: a restart returns as soon as the screen
// starts to change, and a new board still fading or popping in would otherwise
// be taken for noise and make the cells where the game is played numb for the
// whole game. At most this long; a game whose screen never stops moving (a
// real-time one) is calibrated as it is, and that movement is its noise.
export const CALIBRATION_SETTLE_MS = 2000;

// A pointer action's baseline is taken with the pointer already on its target
// (settleLook): the first look HOVER_POLL_MS after the pointer got there, since
// a screen share shows it a frame or two late, then a look every HOVER_POLL_MS
// until the screen at the target holds still (a hover highlight fading in), for
// at most HOVER_SETTLE_MS. On a still page that is two looks, about 200 ms.
export const HOVER_POLL_MS = 100;
export const HOVER_SETTLE_MS = 600;

/**
 * What a tool call is to the change map: its kind, where it acted, and a label
 * for the log. Points are in the frame's pixels, the image coordinates the
 * model clicks in, which is the frame the map is taken from. `at` is the target
 * when the input does not hold it (click_grid's point inside its cell).
 * "restart" is the restart's check that a new game began; "turn" the screen
 * between two turns.
 */
export function changeAction(tool, input = {}, at = null) {
  const inp = input ?? {};
  const point = (x, y) => ({ x: Number(x), y: Number(y) });
  const shown = p => `${Math.round(p.x)},${Math.round(p.y)}`;
  switch (tool) {
    case "click": {
      const p = at ?? point(inp.x, inp.y);
      return { kind: "click", tool, at: [p], label: `click at ${shown(p)}` };
    }
    case "click_grid": {
      const p = at ?? point(inp.x, inp.y);
      return { kind: "click", tool, at: [p], label: `click_grid ${String(inp.cell ?? "?").toUpperCase()} at ${shown(p)}` };
    }
    case "drag": {
      const from = point(inp.x1, inp.y1), to = point(inp.x2, inp.y2);
      return { kind: "drag", tool, at: [from, to], label: `drag ${shown(from)} → ${shown(to)}` };
    }
    case "restart":
      return { kind: RESTART_KIND, tool, label: "the restart" };
    case "turn":
      return { kind: "turn", tool, label: "the screen since the last turn" };
    case "press_key":
    case "hold_key":
      return { kind: "key", tool, label: `${tool} ${JSON.stringify(inp.key ?? "")}` };
    case "type_text":
      return { kind: "type", tool, label: `type_text (${String(inp.text ?? "").length} characters)` };
    case "scroll":
      return { kind: "scroll", tool, label: "scroll" };
    case "gamepad_button":
      return { kind: "gamepad", tool, label: `gamepad_button ${JSON.stringify(inp.button ?? "")}` };
    case "gamepad_stick":
    case "gamepad_trigger":
      return { kind: "gamepad", tool, label: tool };
    default:
      return { kind: "any", tool, label: String(tool ?? "action") };
  }
}

/**
 * One look judged by both detectors. `before` and `after` are looks as the page
 * takes them, {map, hash}: a motion map and a legacy hash of the same pixels.
 * The detector chosen decides `changed`, and `dist` is its figure: for the
 * motion map, the most a cell that counts for this action moved (near the
 * target for a click), in grey levels; for the legacy hash, its distance.
 */
export function judgeLooks(before, after, { noise = null, action = null, detector = DEFAULT_DETECTOR, threshold = LEGACY_THRESHOLD } = {}) {
  // A key, typing, the gamepad or a scroll is compared with the wide floor, so
  // a clock's next tick does not pass for its effect (motion.js, WIDE_SPREAD).
  const result = compare(before?.map, after?.map, noise, { wide: usesWideFloor(action) });
  const verdict = judge(result, action ?? {});
  const dist = legacyDistance(before?.hash, after?.hash);
  const motion = {
    changed: verdict.changed, why: verdict.why, peak: verdict.peak, nearest: verdict.nearest,
    maxCell: result?.maxCell ?? 0, changedFrac: result?.changedFrac ?? 0, cells: result?.cells.length ?? 0,
    bbox: result?.bbox ?? null, centroid: result?.centroid ?? null, global: !!result?.global,
    calibrated: !!result?.calibrated,
  };
  const legacy = { changed: dist > threshold, dist, threshold };
  const by = detectorOf(detector);
  return {
    changed: by === "legacy" ? legacy.changed : motion.changed,
    dist: by === "legacy" ? legacy.dist : motion.peak,
    by, motion, legacy,
  };
}

/**
 * Watch the screen until the chosen detector sees the action's effect, or
 * `maxMs` runs out. `look` grabs the screen and returns a look ({map, hash}, or
 * null when nothing could be captured). `baseline` MUST be the look from before
 * the action: fast games finish animating during the action's own round trip,
 * so a baseline taken afterwards compares the screen with itself.
 *
 * Returns judgeLooks' answer for the look that decided (the first that changed,
 * or else the one where the chosen detector's figure was largest), with
 * elapsed (when it decided; maxMs when it ran out), polls (looks taken after
 * the action) and seenBy: {motion, legacy}, whether each detector saw a change
 * at any of them. `motion` and `legacy` are each detector's own verdict: the
 * chosen one's on the look that decided, the other's on the first look it
 * called changed, else on its strongest.
 *
 * Both judge the same frames, and the wait stops when the chosen one decides.
 * When that is a change the other has not seen yet, the other gets one more
 * look, pollMs later, and the decision stands whatever it says. The motion map
 * usually decides on the first look, often while a move is still animating in,
 * and the legacy hash, judged on that look alone, would be logged as missing
 * moves it sees a poll later: the very count the two are compared by.
 */
export async function watchForChange(look, baseline, {
  maxMs = 2000, pollMs = POLL_MS, now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)), ...how
} = {}) {
  const t0 = now();
  if (!baseline) baseline = await look();
  const by = detectorOf(how.detector);
  const other = by === "legacy" ? "motion" : "legacy";
  const figure = { motion: v => v.peak, legacy: v => v.dist };
  const own = { motion: null, legacy: null };
  let polls = 0;
  let strongest = null;
  const judgeNext = async () => {
    const seen = judgeLooks(baseline, await look(), how);
    polls++;
    for (const name of ["motion", "legacy"]) {
      const v = seen[name], kept = own[name];
      if (!kept || (!kept.changed && (v.changed || figure[name](v) > figure[name](kept)))) own[name] = v;
    }
    if (!strongest || seen.dist > strongest.dist) strongest = seen;
    return seen;
  };
  // At once first: the change may already have happened.
  let seen = await judgeNext();
  while (!seen.changed && now() - t0 < maxMs) {
    await wait(pollMs);
    seen = await judgeNext();
  }
  const changed = seen.changed;
  const elapsed = changed ? now() - t0 : maxMs;
  if (changed && !own[other].changed) {
    await wait(pollMs);
    await judgeNext();
  }
  const decided = changed ? seen : strongest;
  return {
    ...decided, changed, [other]: own[other], elapsed, polls,
    seenBy: { motion: own.motion.changed, legacy: own.legacy.changed },
  };
}

/**
 * The baseline for a pointer action, taken once the page has moved the pointer
 * onto its target: looks pollMs apart, the first pollMs after the pointer got
 * there (a screen share shows it a frame or two late), until two in a row show
 * nothing changed near `at` (the target, or targets, in the frame's pixels), or
 * maxMs runs out. The pointer, and any hover highlight under it, are then in
 * the baseline as in every look after the action, so neither passes for the
 * action's effect, which judge() looks for exactly there.
 *
 * A look that could not be taken (null) says nothing about the screen: it never
 * replaces the last real one, and never counts as the screen holding still. A
 * null baseline would make the wait take its own after the action, and judge
 * every click, live or dead, as unchanged. (The page stands its last look in
 * when native capture sends no frame because nothing changed, GameAgent.jsx's
 * lookFrom; this does not rely on it.)
 *
 * Returns {look (the last real one, the baseline, or null if none was taken),
 * still (whether it held still), looks (how many were taken)}.
 */
export async function settleLook(look, {
  at = null, noise = null, pollMs = HOVER_POLL_MS, maxMs = HOVER_SETTLE_MS,
  now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const t0 = now();
  const there = { kind: "click", at: at ? [].concat(at) : [] };
  await wait(pollMs);
  let last = await look();
  let looks = 1;
  while (now() - t0 < maxMs) {
    await wait(pollMs);
    const next = await look();
    looks++;
    if (!next) continue;
    const moved = last ? compare(last.map, next.map, noise) : null;
    last = next;
    if (moved && !judge(moved, there).changed) return { look: last, still: true, looks };
  }
  return { look: last, still: false, looks };
}

/**
 * Take a game's noise floor: wait for the screen to settle (two looks in a row
 * with nothing moved past MIN_DELTA, for up to settleMs), then take `frames`
 * idle looks gapMs apart. Nothing is sent to the game. `stopped()` ends it
 * early, with no floor. As in settleLook, a look that could not be taken
 * neither replaces the last real one nor counts as the screen holding still.
 *
 * Returns {noise (calibrateNoise's floor, or null), still (whether the screen
 * settled), frames (looks used)}.
 */
export async function calibrate(look, {
  frames = CALIBRATION_FRAMES, gapMs = CALIBRATION_GAP_MS, settleMs = CALIBRATION_SETTLE_MS, pollMs = POLL_MS,
  now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)), stopped = () => false,
} = {}) {
  const t0 = now();
  let last = await look();
  let still = false;
  while (!stopped() && now() - t0 < settleMs) {
    await wait(pollMs);
    const next = await look();
    if (!next) continue;
    const moved = last ? compare(last.map, next.map) : null;
    last = next;
    if (moved && !moved.cells.length) { still = true; break; }
  }
  const maps = [last?.map];
  for (let i = 1; i < frames && !stopped(); i++) {
    await wait(gapMs);
    maps.push((await look())?.map);
  }
  if (stopped()) return { noise: null, still, frames: 0 };
  const usable = maps.filter(Boolean);
  return { noise: calibrateNoise(usable), still, frames: usable.length };
}

const fixed = (v, n) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : "?");
const boxText = b => (b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}` : "none");

function motionText(m) {
  return `motion map ${m.changed ? "CHANGED" : "no change"} — ${m.why}, peak ${fixed(m.peak, 1)}` +
    `${m.cells ? `, bbox ${boxText(m.bbox)}` : ""}${m.calibrated ? "" : ", uncalibrated"}`;
}

function legacyText(l) {
  return `legacy hash ${l.changed ? "CHANGED" : "no change"} — dist ${fixed(l.dist, 2)}, needs over ${fixed(l.threshold, 1)}`;
}

/**
 * The log line for one action's wait: both detectors side by side, and which
 * one decided. Written to the log file for every action.
 */
export function changeLine(seen, action = null) {
  if (!seen?.motion || !seen?.legacy) return null;
  const label = action?.label ?? "action";
  const disagree = !!seen.seenBy && seen.seenBy.motion !== seen.seenBy.legacy;
  return `Change after ${label} (${Math.round(seen.elapsed ?? 0)} ms, ${seen.polls ?? 0} look${seen.polls === 1 ? "" : "s"}): ` +
    `${motionText(seen.motion)} | ${legacyText(seen.legacy)} | decided by the ${CHANGE_DETECTORS[detectorOf(seen.by)]}` +
    `${disagree ? ` (they disagree: only the ${seen.seenBy.motion ? "motion map" : "legacy hash"} saw a change)` : ""}`;
}

/**
 * The log line for the image skip at the start of a turn: the screen now
 * against the screen at the last turn, by both detectors, and what was done.
 */
export function turnLine(seen, { turn, skipped }) {
  if (!seen?.motion || !seen?.legacy) return null;
  return `Turn ${turn} screen since the last turn: ${motionText(seen.motion)} | ${legacyText(seen.legacy)} | ` +
    `decided by the ${CHANGE_DETECTORS[detectorOf(seen.by)]}: ${skipped ? "image skipped" : "image sent if this turn sends one"}`;
}

/** What the noise floor taken at the start of a game came to, for the log. */
export function calibrationLine(noise, {
  detector = DEFAULT_DETECTOR, gapMs = CALIBRATION_GAP_MS, settleMs = CALIBRATION_SETTLE_MS, game = null, still = true,
} = {}) {
  const head = `Change detection${game ? ` for game ${game}` : ""} (decided by the ${CHANGE_DETECTORS[detectorOf(detector)]}):`;
  if (!noise) {
    return `${head} no noise floor, as no two idle frames could be captured; a cell counts as changed past ${MIN_DELTA} grey levels.`;
  }
  const cells = noise.cols * noise.rows;
  const idle = `from ${noise.frames} idle frames ${(gapMs / 1000).toFixed(1)} s apart` +
    `${still ? "" : ` (the screen was still moving after ${(settleMs / 1000).toFixed(0)} s, so that movement counts as noise)`}`;
  const flickers = noise.global > MIN_DELTA / NOISE_GAIN;
  if (!noise.moving) {
    const past = Math.max(MIN_DELTA, NOISE_GAIN * noise.global);
    return `${head} noise floor ${idle}: nothing moved on its own` +
      `${flickers ? ` beyond the whole view's flicker of ${fixed(noise.global, 1)}` : ""}, ` +
      `so a cell counts as changed past ${Number.isInteger(past) ? past : fixed(past, 1)} grey levels.`;
  }
  const floorText = flickers
    ? ` The whole view flickers by ${fixed(noise.global, 1)}, so every cell needs more.` : "";
  return `${head} noise floor ${idle}: ${noise.moving} of ${cells} cells moved on their own (${boxText(noise.movingBox)}); ` +
    `a change there counts only past ${NOISE_GAIN}× that movement, at most ${MAX_LIMIT} grey levels.${floorText}`;
}

/** A count, over a run, of the actions judged and where the detectors disagreed. */
export function newTally() {
  return { actions: 0, agree: 0, motionOnly: 0, legacyOnly: 0 };
}

export function tallyChange(tally, seen) {
  if (!tally || !seen?.seenBy) return tally;
  tally.actions++;
  const { motion, legacy } = seen.seenBy;
  if (motion === legacy) tally.agree++;
  else if (motion) tally.motionOnly++;
  else tally.legacyOnly++;
  return tally;
}

/** The run's closing line on the two detectors, or null when no action was judged. */
export function tallyLine(tally, detector = DEFAULT_DETECTOR) {
  if (!tally?.actions) return null;
  const n = v => `${v} action${v === 1 ? "" : "s"}`;
  return `Change detection this run (decided by the ${CHANGE_DETECTORS[detectorOf(detector)]}): ${n(tally.actions)} judged; ` +
    `both detectors agreed on ${tally.agree}, only the motion map saw a change on ${n(tally.motionOnly)}, ` +
    `only the legacy hash on ${n(tally.legacyOnly)}. The log file has a "Change after ..." line for each.`;
}
