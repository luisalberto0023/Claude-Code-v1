// ── The kill switch ───────────────────────────────────────────────────────────
//
// SETUP.md used to promise that moving the mouse into a screen corner kills all
// input. It never did: that is pyautogui's fail-safe, which stops only
// pyautogui's own calls, while keys go out through SendInput and the gamepad
// through vgamepad. ■ Stop only stopped the page asking for more, so a hold, a
// drag or a line of typing already sent ran on. The backend now has a halt flag
// (agent_server.py, "Kill switch"). Ctrl+Alt+Pause or Ctrl+Alt+Shift+H sets it
// (over most windows: a game in front can block a global hotkey, and then ■ Stop
// is the way), and so does ■ Stop; it lets go of everything held, and every
// input route refuses with HTTP 423 until POST /session/resume lifts it.
//
// This module is the page's side of it: reading the backend's halt state, what
// the red banner and the log say, what the model is told when its action was
// not sent, and whether ▶ Start may go ahead. A halt says nothing about the
// game, so the games loop waits it out: it is never a no-op, an error or a
// stuck game.
//
// tools/check-agent.mjs checks these against agent_server.py and the page.

import { haltNote } from "./inputLimits.js";

// The status the backend refuses input with while it is halted ("Locked").
export const HALT_STATUS = 423;
// Why input can be halted, as the backend names it (HALT_REASONS there).
export const HALT_REASONS = ["hotkey", "page", "stop"];
// The one halt the page lifts by itself: ■ Stop's own, once its run has ended.
// Any other stays until someone presses Resume.
export const STOP_HALT = "stop";
// How often the page asks for the halt state: about once a second while a run
// is on (or input is halted), so Resume is seen at once; now and then otherwise.
export const HALT_POLL_MS = 1000;
export const HALT_IDLE_POLL_MS = 5000;

const texts = list => (Array.isArray(list) ? list.filter(x => typeof x === "string") : []);

/**
 * The backend's halt state from a reply to GET /session/state, /session/halt or
 * /session/resume, or null when the reply is not one (the backend is down, or
 * older than this page and has no kill switch).
 */
export function readHaltState(reply) {
  if (typeof reply?.halted !== "boolean" || !Array.isArray(reply?.reasons)) return null;
  return {
    halted: reply.halted,
    reasons: texts(reply.reasons),
    by: typeof reply.by === "string" && reply.by ? reply.by : null,
    since: typeof reply.since === "string" ? reply.since : null,
    hotkeys: texts(reply.hotkeys),
    hotkeyProblems: texts(reply.hotkeyProblems),
  };
}

/**
 * Whether a reply from one of the backend's input routes says input is halted:
 * refused with 423 before anything was sent, or cut short part-way (a hold let
 * go early). The /session/ routes answer with the state itself, which is read
 * with readHaltState instead.
 */
export function inputHalted(path, status, reply) {
  if (String(path ?? "").startsWith("/session/")) return false;
  return status === HALT_STATUS || reply?.halted === true;
}

/** Whether an input route's reply says input is halted (see inputHalted). */
export function isHaltReply(reply) {
  return reply?.halted === true;
}

// The tool results of model actions that met a halt. They are listed here, not
// marked with a field, because a tool result goes to the provider as it is and
// Anthropic refuses a field it does not know. The restart loop reads this to
// tell a click that was never sent from one that did nothing.
const haltedResults = new WeakSet();

/** Note that this tool result is for an action that met a halt; returns it. */
export function markHalted(result) {
  if (result && typeof result === "object") haltedResults.add(result);
  return result;
}

/** Whether this tool result is for an action that met a halt (markHalted). */
export function metHalt(result) {
  return !!result && typeof result === "object" && haltedResults.has(result);
}

/** Halted by someone, not only by ■ Stop while its run winds down. */
export function haltedByOperator(state) {
  return !!state?.halted && state.reasons.some(r => r !== STOP_HALT);
}

// "2026-09-17T14:03:22" -> "14:03:22"
function clock(since) {
  const m = typeof since === "string" ? since.match(/T(\d\d:\d\d:\d\d)/) : null;
  return m ? m[1] : null;
}

/**
 * The red banner while input is halted: {title, detail}, or null when it is not
 * (a halt that only ■ Stop set lifts itself when the run ends, so it gets none).
 */
export function haltBanner(state) {
  if (!haltedByOperator(state)) return null;
  const at = clock(state.since);
  return {
    title: "Input halted: press Resume",
    detail: `Halted by ${state.by ?? "the kill switch"}${at ? ` at ${at}` : ""}. The backend let go of every key and ` +
      "button it held and sends no key, click or gamepad input until Resume. A run waits, and goes on from where it was.",
  };
}

/** What to log when the halt state changes, {text, type}, or null. */
export function haltChange(before, after) {
  if (!after) return null;
  const wasOperator = haltedByOperator(before);
  const isOperator = haltedByOperator(after);
  if (isOperator && (!wasOperator || before?.by !== after.by)) {
    return {
      type: "error",
      text: `⛔ Input halted by ${after.by ?? "the kill switch"}: everything held was let go, and no key, click or ` +
        "gamepad input is sent until you press Resume. A run waits meanwhile.",
    };
  }
  if (wasOperator && !after.halted) return { type: "success", text: "▶ Input resumed." };
  return null;
}

/** Why ▶ Start will not begin while input is halted, or null. */
export function haltStartProblem(state) {
  if (!haltedByOperator(state)) return null;
  return `Not started: input is halted (by ${state.by ?? "the kill switch"}). Press Resume first.`;
}

/**
 * What the model is told when its action met a halt. Not a move that failed:
 * the model must not try another way round a screen that did not change.
 */
export function haltedToolText(reply) {
  const done = reply?.ok === true
    ? haltNote(reply) || "Done, then input was halted."
    : typeof reply?.typed === "number" && reply.typed > 0
      ? `Only the first ${reply.typed} characters were typed.`
      : typeof reply?.clicked === "number" && reply.clicked > 0
        ? `Clicked ${reply.clicked} time${reply.clicked === 1 ? "" : "s"}, then stopped.`
        : "Not done.";
  return `${done} The operator halted all input (the kill switch): the backend let go of everything held and sends ` +
    "nothing more until they press Resume. This says nothing about the game, so do not try another action because " +
    "of it; play goes on from here after Resume.";
}

/**
 * The line under the controls about the kill-switch hotkeys, {type, text}, or
 * null until the backend has said.
 */
export function hotkeysNote(state) {
  if (!state) return null;
  const why = state.hotkeyProblems.length ? ` (${state.hotkeyProblems.join("; ")})` : "";
  if (!state.hotkeys.length) {
    return { type: "warn", text: `No kill-switch hotkey is registered${why}. ■ Stop halts input too.` };
  }
  return {
    type: "info",
    text: `Kill switch: ${state.hotkeys.join(" or ")} halts all input${why}. Resume here lifts it. ` +
      "A game in front can block the chord: then Alt+Tab here and press ■ Stop.",
  };
}
