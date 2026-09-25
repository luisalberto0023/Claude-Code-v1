// ── Actions that changed nothing ──────────────────────────────────────────────
//
// A model whose action did nothing will, left to itself, send it again: a small
// one re-issued the same dead arrow key turn after turn. So the agent keeps
// count. After every action sent it asks whether the screen changed
// (src/agent/changeDetection.js: the motion map by default, judged near where a
// click landed, anywhere for a key or the gamepad), and
//   - the next turn is told which action did nothing, and what else did nothing
//     since the screen last changed, and is always shown the screen;
//   - a run of them ends the game as stuck (stuckVerdict).
//
// An action whose effect is not known is not counted either way: one that never
// reached the game (the backend down, restarting or refusing the page: notSent),
// or one with no frame of the screen to judge it by (unseen). A backend hiccup
// must not end a game as stuck, a result that never happened. Those are counted
// on their own instead, and a run of them pauses play (blindPause): the stuck
// rule cannot stop an agent that is acting without seeing what it does.
//
// Only press_key used to be counted. A click, a drag, a scroll, a hold, typing,
// the gamepad or a sequence's steps that did nothing left the count where it
// was: in a mouse or controller game stuck detection never fired, and the turn
// after a click that missed could skip its screenshot as "unchanged". Every
// action type now counts, through one helper in the page (GameAgent.jsx,
// noteEffect) that keeps its refs with these functions.
//
// An action is counted by its signature: the tool and its input, written the
// same way however the model wrote it. Keys by name ("ArrowUp", "UP" and "up"
// are one key), click_grid by its cell whatever point inside it, a stick by the
// direction it was pushed, and a click within CLICK_NEAR_PX of one that already
// changed nothing as that one (two clicks a few pixels apart hit the same
// thing). The stuck rule counts how many different actions changed nothing:
// the same dead square clicked four times is one action tried four times, not
// four actions. The model is still told the action it sent, and which one it
// was counted as.
//
// Pure: no DOM, no refs. tools/check-noops.mjs checks it, on the real
// Minesweeper capture and the local Minesweeper's own pixels too.

import { NO_FRAME, POINT_KINDS } from "../vision/motion.js";
import { backendFailure } from "./backend.js";
import { detectorOf } from "./changeDetection.js";
import { MODEL_OUTCOME_CHOICES } from "./outcomes.js";

// Clicks this close are the same click: within this many pixels of the model's
// image, each way, of one that changed nothing. A Minesweeper square there is 14
// to 24 px. A click is not rounded to a fixed 16 px grid instead: 407 and 408
// would fall either side of a line, and a model clicking the same spot again a
// pixel off would be counted as trying something new.
export const CLICK_NEAR_PX = 16;

// Stuck: at least STUCK_STREAK actions in a row changed nothing across at least
// STUCK_DISTINCT different ones, or STUCK_HARD_STOP in a row, whatever they were.
// The same numbers as when only keys were counted. The model is nudged after
// every one, and told at the 3rd to try another place, key or control.
export const STUCK_STREAK = 4;
export const STUCK_DISTINCT = 3;
export const STUCK_HARD_STOP = 10;

// The streaks at which the games loop reminds the model to try something else,
// or to say the game is over: the 3rd action in a row that changed nothing, and
// the 6th (noOpReminderDue).
export const NO_OP_REMINDERS = Object.freeze([3, 6]);

// Play pauses after this many actions in a row whose effect is not known
// (blindPause): as many as the stuck rule's longest run.
export const BLIND_PAUSE = STUCK_HARD_STOP;

// ── Signatures ────────────────────────────────────────────────────────────────

// Other names for one key, as the backend reads them (agent_server.py's scan
// codes, and what models write).
const KEY_NAMES = Object.freeze({
  esc: "escape", return: "enter", del: "delete", ins: "insert", spacebar: "space",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
  pgup: "pageup", pgdn: "pagedown",
  control: "ctrl", ctrlleft: "ctrl", shiftleft: "shift", altleft: "alt", winleft: "win",
});
// Modifiers go first, in this order, so "Shift+Ctrl+Z" and "ctrl+shift+z" are one.
const MODIFIERS = Object.freeze(["ctrl", "ctrlright", "alt", "altright", "shift", "shiftright", "win", "winright"]);

/** A key or combo by name: lower case, one name per key, modifiers first. */
export function keyName(key) {
  const text = String(key ?? "");
  if (text === " ") return "space";
  const keys = [...new Set(text.split("+").map(k => k.trim().toLowerCase()).filter(Boolean).map(k => KEY_NAMES[k] ?? k))];
  if (!keys.length) return text.trim().toLowerCase() || "(none)"; // "+" on its own
  return [...MODIFIERS.filter(m => keys.includes(m)), ...keys.filter(k => !MODIFIERS.includes(k))].join("+");
}

// The virtual pad's other names for its buttons, as agent_server.py's _BTN_MAP.
const PAD_BUTTONS = Object.freeze({
  south: "a", east: "b", west: "x", north: "y",
  left_shoulder: "lb", right_shoulder: "rb", left_thumb: "ls", right_thumb: "rs",
  dpad_up: "up", dpad_down: "down", dpad_left: "left", dpad_right: "right",
});

function padButton(button) {
  const name = String(button ?? "").trim().toLowerCase();
  return PAD_BUTTONS[name] ?? (name || "(none)");
}

// A point of the model's image, in whole pixels.
const px = v => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : "?";
};
const point = (x, y) => `${px(x)},${px(y)}`;

// "(right)", "(double)", "(right, double)", or nothing for one left click.
function pointerHow(input, { clicks: counts = true } = {}) {
  const button = String(input?.button ?? "left").trim().toLowerCase() || "left";
  const n = Math.round(Number(input?.clicks ?? 1));
  const clicks = Number.isFinite(n) && n > 1 ? n : 1;
  const how = [
    button !== "left" ? button : "",
    counts && clicks > 1 ? ({ 2: "double", 3: "triple" }[clicks] ?? `${clicks} clicks`) : "",
  ].filter(Boolean);
  return how.length ? ` (${how.join(", ")})` : "";
}

// A click_grid cell as the page reads it: "c4" and "C04" are C4.
function gridCell(cell) {
  const text = String(cell ?? "").trim().toUpperCase();
  const m = text.match(/^([A-Z]+)0*(\d+)$/);
  return m ? `${m[1]}${m[2]}` : text || "?";
}

// Where a stick was pushed: one of eight directions, or the centre.
const STICK_DIRECTIONS = ["right", "up-right", "up", "up-left", "left", "down-left", "down", "down-right"];
export const STICK_DEAD_ZONE = 0.25;
function stickDirection(x, y) {
  const dx = Number(x) || 0, dy = Number(y) || 0;
  if (Math.hypot(dx, dy) < STICK_DEAD_ZONE) return "centre";
  const eighth = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return STICK_DIRECTIONS[((eighth % 8) + 8) % 8];
}

// Typed text, shown whole up to this many characters.
const TEXT_SHOWN = 24;

/**
 * An action's signature: the tool and its input, normalised so that the same
 * action written two ways is one. Also how the model is told which action did
 * nothing, so it reads as an action: "press_key up", "click at 595,408",
 * "click_grid C4 (right)", "gamepad_stick left up-right". A click a few pixels
 * from one that already changed nothing is matched to it when it is counted
 * (knownAs), not here.
 */
export function actionSignature(tool, input = {}) {
  const inp = input ?? {};
  switch (tool) {
    case "click":
      return `click at ${point(inp.x, inp.y)}${pointerHow(inp)}`;
    case "click_grid":
      return `click_grid ${gridCell(inp.cell)}${pointerHow(inp)}`;
    case "drag":
      return `drag ${point(inp.x1, inp.y1)} → ${point(inp.x2, inp.y2)}${pointerHow(inp, { clicks: false })}`;
    case "scroll": {
      const amount = Number(inp.amount) || 0;
      return `scroll ${amount > 0 ? "up" : amount < 0 ? "down" : "0"} at ${point(inp.x, inp.y)}`;
    }
    case "press_key":
    case "hold_key":
      return `${tool} ${keyName(inp.key)}`;
    case "type_text": {
      const text = String(inp.text ?? "");
      return text.length > TEXT_SHOWN
        ? `type_text ${JSON.stringify(text.slice(0, TEXT_SHOWN))}… (${text.length} characters)`
        : `type_text ${JSON.stringify(text)}`;
    }
    case "gamepad_button":
      return `gamepad_button ${padButton(inp.button)}`;
    case "gamepad_stick":
      return `gamepad_stick ${String(inp.stick ?? "left").trim().toLowerCase()} ${stickDirection(inp.x, inp.y)}`;
    case "gamepad_trigger": {
      const value = Number(inp.value ?? 1);
      return `gamepad_trigger ${String(inp.trigger ?? "right").trim().toLowerCase()}${value > 0 ? "" : " released"}`;
    }
    default:
      return String(tool ?? "action");
  }
}

// The signatures of actions that act at a point: a click, a scroll, a drag
// (from one point to another). What comes before and after the points must
// match for two of them to be one action.
const AT_POINTS = /^(click at |scroll (?:up|down|0) at |drag )(-?\d+),(-?\d+)(?: → (-?\d+),(-?\d+))?(.*)$/;

function pointsOf(signature) {
  const m = String(signature ?? "").match(AT_POINTS);
  if (!m) return null;
  const points = [[Number(m[2]), Number(m[3])]];
  if (m[4] != null) points.push([Number(m[4]), Number(m[5])]);
  return { head: m[1], points, tail: m[6] };
}

/**
 * Whether two signatures are one action at about one place: the same click,
 * scroll or drag, each point within CLICK_NEAR_PX of the other's, each way.
 */
export function sameSpot(a, b) {
  const p = pointsOf(a), q = pointsOf(b);
  return !!p && !!q && p.head === q.head && p.tail === q.tail && p.points.length === q.points.length
    && p.points.every(([x, y], k) => Math.max(Math.abs(x - q.points[k][0]), Math.abs(y - q.points[k][1])) <= CLICK_NEAR_PX);
}

/**
 * The signature this action is counted under: one already in `failed` that is
 * the same action at about the same place (sameSpot), else its own. So a model
 * clicking a dead square again a pixel or two off is counted as trying the same
 * thing again (and told so, beside the click it sent: noOpNudge).
 */
export function knownAs(signature, failed = []) {
  const known = [...(failed ?? [])];
  if (known.includes(signature)) return signature;
  return known.find(s => sameSpot(signature, s)) ?? signature;
}

// ── The count ─────────────────────────────────────────────────────────────────

/** Whether a wait's verdict (waitChange) had no frame to judge by. */
export function unseen(confirm) {
  return confirm?.motion?.why === NO_FRAME;
}

/**
 * Whether the backend's reply says the action may never have reached the game:
 * no answer at all (the backend down or restarting, which backend() marks
 * `unreachable`), the page turned away (a backend restarted with a new token:
 * `refused`), or the backend's own server failing on the request (`crashed`).
 * The backend's own refusal of an action (a key it does not know, a click off
 * the screen) did reach it, and is not one of these: the same action would be
 * refused again, so it counts as changing nothing, as it always has for keys.
 */
export function notSent(reply) {
  return reply?.unreachable === true || !!reply?.refused || reply?.crashed === true;
}

/**
 * Whether the motion map saw a change, but only away from where a click or a
 * drag acted, too small to count as its effect (motion.js, judge). The action
 * is counted as changing nothing where it acted, and the model is told so in
 * those words: the change elsewhere may have been its effect after all (a
 * counter, a total), which the model can tell and the count cannot.
 */
export function changedAway(confirm) {
  return !confirm?.changed && detectorOf(confirm?.by) === "motion" && confirm?.motion?.nearest != null;
}

/** No action counted yet: at the start of a run and of each game. */
export function newNoOps() {
  return { streak: 0, failed: new Set(), lastNoOp: null, unknown: 0 };
}

/**
 * The count after one action. `state` is {streak (actions in a row that
 * changed nothing), failed (what those were counted as, a Set of signatures),
 * lastNoOp (the last one, or null once something changed), unknown (actions in
 * a row whose effect is not known)}; `confirm` the wait's verdict for this
 * action (waitChange: {changed, motion, ...}); `reply` the backend's reply to it.
 *
 * An action that changed the screen starts the count again. One that did not
 * adds to the streak and to the set, where the same action twice is one
 * (knownAs: the same signature, or a click at about the same place). lastNoOp
 * is {signature: the action as the model sent it, countedAs: what it was counted
 * as (the signature itself, or the click at about the same place), away: whether
 * the screen changed only away from where it acted (changedAway)}.
 *
 * An action judged while input was halted (`halted`: the kill switch) says
 * nothing about the game and leaves the count as it was. So does one whose
 * effect is not known, one that never reached the game (notSent) or that had
 * no frame to judge it by (unseen), except that it adds to `unknown`, which any
 * action that was sent and seen sets back to 0 (blindPause reads it).
 * Returns the new state, a new Set, with counted: whether it counted.
 */
export function noteAction(state, { signature, confirm, reply = null, halted = false } = {}) {
  const streak = state?.streak ?? 0;
  const failed = new Set(state?.failed ?? []);
  const lastNoOp = state?.lastNoOp ?? null;
  const unknown = state?.unknown ?? 0;
  if (halted) return { streak, failed, lastNoOp, unknown, counted: false };
  if (notSent(reply) || unseen(confirm)) return { streak, failed, lastNoOp, unknown: unknown + 1, counted: false };
  if (confirm?.changed) return { streak: 0, failed: new Set(), lastNoOp: null, unknown: 0, counted: true };
  const countedAs = knownAs(signature, failed);
  failed.add(countedAs);
  return {
    streak: streak + 1, failed, unknown: 0, counted: true,
    lastNoOp: { signature, countedAs, away: changedAway(confirm) },
  };
}

/**
 * Which reminder the games loop gives after a turn. `streak` is the count
 * after the turn, `given` the step of NO_OP_REMINDERS last given in this streak
 * (0 for none). Each step once, however the streak got there: a sequence's
 * steps each count, so one turn can take the streak from 2 to 4, past 3, and a
 * turn that sends nothing leaves it where it was. The same rule as the no-op
 * snapshots (snapshots.js, noOpSnapshot). Returns {remind: the step to give,
 * or 0; given}.
 */
export function noOpReminderDue(streak, given = 0) {
  const step = [...NO_OP_REMINDERS].reverse().find(n => streak >= n) ?? 0;
  if (step < given) given = 0; // the streak broke, and this is a new one
  return step > given ? { remind: step, given: step } : { remind: 0, given };
}

/**
 * What the log says when play pauses because the agent cannot tell what its
 * actions do: `unknown` of them in a row (noteAction), no frame of the screen
 * to judge them by or never sent. Null below BLIND_PAUSE. Play pauses rather
 * than stopping as stuck: nothing is known about the game, and every action
 * sent meanwhile went to a screen nobody looked at.
 */
export function blindPause(unknown) {
  if (!(unknown >= BLIND_PAUSE)) return null;
  return `⏸ Paused: the agent could not tell what its last ${unknown} actions did ` +
    "(no frame of the screen to compare, or the action never reached the backend). " +
    "Check the screen share or capture and the backend window, then press ▶ Resume.";
}

/**
 * Whether play on this game stops as stuck: `streak` actions in a row changed
 * nothing, `distinct` of them different. Returns {stuck, exhausted (enough
 * different actions tried), hardStop (a long run, whatever it was), reason (for
 * the game's record), logLine}; reason and logLine are null when not stuck.
 */
export function stuckVerdict({ streak = 0, distinct = 0 } = {}) {
  const exhausted = streak >= STUCK_STREAK && distinct >= STUCK_DISTINCT;
  const hardStop = streak >= STUCK_HARD_STOP;
  if (exhausted) {
    return {
      stuck: true, exhausted, hardStop,
      reason: `no moves available: ${distinct} different actions all changed nothing over ${streak} actions`,
      logLine: `No moves available — ${distinct} different actions all changed nothing on screen over ${streak} actions.`,
    };
  }
  if (hardStop) {
    return {
      stuck: true, exhausted, hardStop,
      reason: `no progress after ${streak} actions in a row`,
      logLine: `No progress after ${streak} consecutive actions.`,
    };
  }
  return { stuck: false, exhausted, hardStop, reason: null, logLine: null };
}

// ── What the model and the log are told ───────────────────────────────────────

const fixed = (v, n) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : "?");

// The numbers the verdict was reached on, by the detector that decided.
function measure(confirm, action, changed) {
  if (detectorOf(confirm?.by) === "legacy" && confirm?.legacy) {
    return `legacy hash: dist ${fixed(confirm.legacy.dist, 2)}, needs over ${fixed(confirm.legacy.threshold, 1)}`;
  }
  const m = confirm?.motion;
  if (!m) return `dist ${fixed(confirm?.dist, 2)}`;
  // With nothing changed, a click's peak is what moved near where it landed.
  const atTarget = !changed && POINT_KINDS.includes(action?.kind) && (action?.at ?? []).some(p =>
    Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)));
  return `motion map: ${m.why}, peak ${fixed(m.peak, 1)} grey levels${atTarget ? " near the target" : ""}`;
}

// What an action that changed nothing did, in the words the model and the log
// are given: nothing on screen, or nothing where it acted (changedAway).
const nothingWhere = confirm => (changedAway(confirm) ? "changed nothing where it acted" : "changed nothing on screen");

/**
 * The sentence a tool result gives for what the action did: "Screen changed
 * (...)." or "That action changed nothing on screen (...).", with the numbers
 * it was judged on, and how many in a row changed nothing. A click whose only
 * change was away from where it landed "changed nothing where it acted", and
 * the model is told that change may have been its effect. `action` is
 * changeAction's for this action, `streak` the count after it, `reply` the
 * backend's reply (an action never sent has no effect to tell).
 */
export function effectText(confirm, { action = null, streak = 0, reply = null } = {}) {
  if (notSent(reply)) return `Not sent (${backendFailure(reply)}), so whether it would have changed anything is not known.`;
  if (unseen(confirm)) return "Whether it changed anything is not known: no frame of the screen could be taken to compare.";
  if (confirm?.changed) return `Screen changed (${measure(confirm, action, true)}).`;
  return `That action ${nothingWhere(confirm)} (${measure(confirm, action, false)}).` +
    `${changedAway(confirm) ? " If that change elsewhere was its effect, it worked." : ""}` +
    `${streak >= 2 ? ` That is ${streak} actions in a row counted as changing nothing.` : ""}`;
}

/** The same for one step of execute_sequence, to go after its dash. */
export function stepText(confirm, { action = null, reply = null } = {}) {
  if (notSent(reply)) return `not sent (${backendFailure(reply)})`;
  if (unseen(confirm)) return "not seen (no frame of the screen to compare)";
  if (confirm?.changed) return "changed";
  return `${nothingWhere(confirm)} (${measure(confirm, action, false)})`;
}

/**
 * The log file's line for an action counted as changing nothing: `state` the
 * count after it (noteAction), whose lastNoOp is that action.
 */
export function noOpLine(state) {
  const distinct = state?.failed?.size ?? 0;
  const { signature = "?", countedAs = signature, away = false } = state?.lastNoOp ?? {};
  const as = countedAs !== signature ? ` (counted as ${countedAs})` : "";
  return `No-op ${state?.streak ?? 0} in a row: ${signature}${as} ${away ? "changed nothing where it acted" : "changed nothing on screen"} ` +
    `(${distinct} different action${distinct === 1 ? "" : "s"} since the screen last changed).`;
}

/**
 * What the next turn's message starts with after an action that changed
 * nothing, or "" when the last one did something. `lastNoOp` is noteAction's:
 * the action is named as the model sent it, and as what it was counted when
 * that was a click already tried at about the same place.
 */
export function noOpNudge({ lastNoOp = null, failed = [] } = {}) {
  if (!lastNoOp) return "";
  const { signature, countedAs = signature, away = false } = lastNoOp;
  const named = countedAs !== signature ? `${signature}, the same spot as ${countedAs}` : signature;
  const others = [...failed].filter(s => s !== countedAs);
  const also = others.length ? ` Also changed nothing since the screen last changed: ${others.join(", ")}.` : "";
  return away
    ? `Your last action (${named}) changed nothing where it acted; the screen changed only away from it.${also}` +
      " Unless that change was its effect, try something different now."
    : `Your last action (${named}) changed nothing on screen. Do not repeat it.${also} Try something different now.`;
}

/** The message the games loop adds at the 3rd and 6th action in a row that changed nothing. */
export function noOpReminder({ streak = 0, failed = [] } = {}) {
  const tried = [...failed].join(", ") || "n/a";
  return `${streak} actions in a row changed nothing on screen (tried: ${tried}). ` +
    "Try something you have not tried since the screen last changed: another place, another key or another control. " +
    `If nothing you can do changes the screen, the game is over or stuck: call signal_game_end with outcome ${MODEL_OUTCOME_CHOICES}.`;
}
