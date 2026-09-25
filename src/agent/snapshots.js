// ── Snapshots: the frame the agent acted on, next to what it made of it ────────
//
// A snapshot is a frame and a short text written side by side under
// logs/snapshots/<session>/ (POST /log/snapshot). They were taken only on the
// plugin paths, from the solver's own full-resolution capture, so a game with no
// plugin (the case the agent is for) left nothing but log lines, and log lines
// have been read back wrongly more than once.
//
// On the model's own path the frame is the one the model was actually sent: the
// JPEG from the page's grabFrame, with the crop and the click grid it was sent
// with, at the width sent (at most 1280 px). It is saved as sent, tagged
// "lowres" and written as a .jpg, so nobody mistakes it for a full-resolution
// capture. Its text holds the model's last reply whole: what it saw, its plan,
// its text and the actions it asked for.
//
// This module decides what a snapshot holds; GameAgent.jsx's snapshot() sends it.

import { SNAPSHOT_MAX_BYTES, snapshotBytes } from "./backend.js";

// A failing run can fail every turn; a handful of examples per game explains it
// as well as two hundred and does not fill the disk.
export const SNAPSHOTS_PER_GAME = 6;

// How a game ended is exempt from that allowance: there is one per game, it is
// the frame most worth having, and the snapshots before it would otherwise use
// the allowance up first (on Expert Minesweeper, the solver's guesses do).
//   game-over  the plugin saw the game end
//   gave-up    the plugin could not read the board and a blind move would lose
//   stuck      the model's actions stopped changing the screen, and play stopped
//   game-end   the model said the game is over (signal_game_end)
export const ENDING_TAGS = Object.freeze(["game-over", "gave-up", "stuck", "game-end"]);

// Added to the tag of a snapshot whose frame is the model's, not a capture at
// full resolution.
export const LOW_RES = "lowres";

export function isEnding(tag) {
  return ENDING_TAGS.includes(tag);
}

// The screen handler's decisions do not count toward that allowance either
// (src/agent/stuckScreen.js): each is a frame with the controls found on it
// outlined and numbered, and the list of them in its text, which is how the
// control finder's hit rate is measured, and the model's own snapshots would
// otherwise use the allowance up first.
//   decision-ask     the operator is asked what to do
//   decision-click   a control found on screen is clicked
//   claim-rejected   the model said the game is over, and nothing confirmed it
export const DECISION_TAGS = Object.freeze(["decision-ask", "decision-click", "claim-rejected"]);

// They have an allowance of their own. With no plugin a game has few (at most
// STUCK_LOOKS_PER_GAME rescues, each an ask and a click, and claims turned
// down), but the plugin path has no bound per game: a "Keep going" that does
// not close 2048's overlay asks and clicks again on every pass, and the active
// session's folder is never pruned by the log budget.
export const DECISION_SNAPSHOTS_PER_GAME = 12;

export function isDecision(tag) {
  return DECISION_TAGS.includes(tag);
}

/**
 * Whether a snapshot with this tag is taken, when `taken` have already counted
 * toward this game's allowance and `decisions` toward its decisions'. Returns
 * {take, counted, decision}: an ending is always taken and never counted; a
 * decision is taken while its own allowance lasts, and counted there
 * (`decision`), not in the game's.
 */
export function snapshotAllowance(tag, taken = 0, decisions = 0) {
  if (isEnding(tag)) return { take: true, counted: false, decision: false };
  if (isDecision(tag)) {
    return decisions < DECISION_SNAPSHOTS_PER_GAME
      ? { take: true, counted: false, decision: true } : { take: false, counted: false, decision: false };
  }
  return taken < SNAPSHOTS_PER_GAME ? { take: true, counted: true, decision: false } : { take: false, counted: false, decision: false };
}

const drawn = canvas => !!canvas && canvas.width > 0 && canvas.height > 0;

/**
 * Which frame a snapshot saves, first that has one:
 *   canvas  the canvas the caller passed
 *   solver  the solver's full-resolution capture, when this run drew one (the
 *           page empties it as each run starts, so a run with no plugin never
 *           saves the last run's board, or a blank canvas)
 *   model   the frame last sent to the model: {data (base64 JPEG), width,
 *           height, turn, grid, crop}
 *   none    nothing has been captured yet: the text is saved alone
 */
export function snapshotFrame({ canvas = null, solverCanvas = null, modelFrame = null } = {}) {
  if (drawn(canvas)) return { kind: "canvas", canvas };
  if (drawn(solverCanvas)) return { kind: "solver", canvas: solverCanvas };
  if (modelFrame?.data) return { kind: "model", frame: modelFrame };
  return { kind: "none" };
}

/** The tag the files are named with: "lowres" is added for the model's frame. */
export function snapshotTag(tag, choice) {
  return choice?.kind === "model" ? `${tag}-${LOW_RES}` : tag;
}

/**
 * The line that says what the frame is, for the model's frame and for none. A
 * capture at full resolution is what snapshots always held, and its text is
 * left as the caller wrote it.
 */
export function frameNote(choice) {
  if (choice?.kind === "model") {
    const f = choice.frame;
    const size = f.width && f.height ? `${f.width}×${f.height} ` : "";
    const extras = [f.crop ? "cropped" : null, f.grid ? "with the click grid drawn on it" : null].filter(Boolean);
    return `Frame (${LOW_RES}): the ${size}JPEG sent to the model` +
      `${f.turn != null ? ` with turn ${f.turn}` : ""}${extras.length ? `, ${extras.join(", ")}` : ""}, ` +
      `saved as sent. Not a full-resolution capture.`;
  }
  if (choice?.kind === "none") return "No frame: nothing had been captured yet.";
  return null;
}

/**
 * The model's reply as a snapshot keeps it: {turn, see, plan, text, actions}.
 * `actions` are [{tool, input}], from JSON-action mode's parsed actions or the
 * native tool calls. Nothing is cut short: the snapshot is where it is read
 * whole.
 */
export function modelReply({ turn = null, see = null, plan = null, text = null, actions = [] } = {}) {
  const words = v => (typeof v === "string" && v.trim() ? v : null);
  return {
    turn: Number.isFinite(turn) ? turn : null,
    see: words(see),
    plan: words(plan),
    text: words(text),
    actions: (Array.isArray(actions) ? actions : [])
      .filter(a => a && (a.tool ?? a.name))
      .map(a => ({ tool: String(a.tool ?? a.name), input: a.input ?? {} })),
  };
}

const inputText = input => {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input);
  }
};

/** The model's last reply as lines of text, whole. */
export function replyLines(reply) {
  if (!reply) return ["No reply from the model yet this run."];
  const lines = [`The model's last reply${reply.turn != null ? ` (turn ${reply.turn})` : ""}:`];
  if (reply.see) lines.push(`See: ${reply.see}`);
  if (reply.plan) lines.push(`Plan: ${reply.plan}`);
  if (reply.text) lines.push("Text:", reply.text);
  if (reply.actions.length) {
    lines.push("Actions:");
    for (const a of reply.actions) lines.push(`  ${a.tool} ${inputText(a.input)}`);
  } else {
    lines.push("Actions: none");
  }
  return lines;
}

/** A snapshot's text on the model's path: what happened, then the reply. */
export function snapshotText(heading, reply) {
  return [heading, "", ...replyLines(reply)].join("\n");
}

// The streaks of actions that changed nothing at which the model's path saves
// a snapshot: the 3rd in a row and the 6th.
export const NO_OP_SNAPSHOTS = Object.freeze([3, 6]);

/**
 * Which no-op snapshot a turn takes. `noOps` is the streak of actions that
 * changed nothing after this turn, `saved` the step of NO_OP_SNAPSHOTS last
 * saved in this streak (0 for none). Each step is saved once, however the
 * streak got there: one reply can press several keys (from 2 to 4 in one turn,
 * past 3), and a turn that presses none leaves the streak where it was, which
 * must not save the same moment again. A streak that jumps past both steps is
 * saved once, at the higher. Returns {take: the step to save, or 0; saved}.
 */
export function noOpSnapshot(noOps, saved = 0) {
  const step = [...NO_OP_SNAPSHOTS].reverse().find(n => noOps >= n) ?? 0;
  if (step < saved) saved = 0; // the streak broke, and this is a new one
  return step > saved ? { take: step, saved: step } : { take: 0, saved };
}

/** The heading for a game the model said was over (signal_game_end). */
export function gameEndHeading({ outcome, finalScore = null, reason = null } = {}) {
  return `The model ended the game: ${outcome ?? "ended"}` +
    `${finalScore != null ? `, score ${finalScore}` : ""}` +
    `${typeof reason === "string" && reason.trim() ? `. Its reason: ${reason}` : ""}.`;
}

/**
 * Everything snapshot() sends, or null when this game's allowance is used up.
 *
 *   tag, text      what the snapshot is, and its words
 *   canvas         a canvas to save, if the caller has one
 *   solverCanvas   the solver's capture canvas
 *   modelFrame     the frame last sent to the model (see snapshotFrame)
 *   taken          how many snapshots have counted toward this game's allowance
 *   decisions      how many of the screen handler's have counted toward theirs
 *   encodePng      (canvas, text) -> {png, halvings}: the page's snapshotPng,
 *                  which fits a canvas under the backend's size limit
 *
 * Returns {taken, decisions, frame, body: {tag, png, jpeg?, text}, warnings}:
 * `taken` and `decisions` are the new counts, `frame` which frame was chosen,
 * and `warnings` lines for the log.
 */
export function prepareSnapshot({ tag, text = null, canvas = null, solverCanvas = null, modelFrame = null,
  taken = 0, decisions = 0, encodePng } = {}) {
  const allowance = snapshotAllowance(tag, taken, decisions);
  if (!allowance.take) return null;
  const choice = snapshotFrame({ canvas, solverCanvas, modelFrame });
  const note = frameNote(choice);
  const words = note ? [text, note].filter(Boolean).join("\n\n") : text;
  const body = { tag: snapshotTag(tag, choice), png: null, text: words ?? null };
  const warnings = [];
  if (choice.canvas) {
    try {
      const fitted = encodePng(choice.canvas, words);
      body.png = fitted.png;
      if (fitted.halvings) {
        warnings.push(fitted.png
          ? `📷 The frame was too large to save whole; saving it at 1/${2 ** fitted.halvings} size.`
          : "📷 The frame was too large to save even at 1/16 size; saving the text only.");
      }
    } catch { /* tainted or oversized canvas — the text alone is still useful */ }
  } else if (choice.frame) {
    if (snapshotBytes(choice.frame.data, words) <= SNAPSHOT_MAX_BYTES) body.jpeg = choice.frame.data;
    else warnings.push("📷 The model's frame was too large to save; saving the text only.");
  }
  return {
    taken: taken + (allowance.counted ? 1 : 0), decisions: decisions + (allowance.decision ? 1 : 0),
    frame: choice.kind, body, warnings,
  };
}

// What the log says, once a run, when the backend wrote a snapshot's text but
// not the model's frame sent with it.
export const FRAME_DROPPED_WARNING =
  "📷 The backend did not save the frame, only its text: it runs code from before this change. " +
  "Close the backend and start.bat windows and run start.bat again.";

/**
 * Whether the backend dropped the frame of a snapshot it said it wrote: `body`
 * is what was sent, `files` the paths it wrote. A backend started before the
 * model's frames were saved has no `jpeg` field, and its pydantic model drops an
 * unknown field without a word, so it writes the .txt alone. The test PC often
 * runs a backend nobody restarted after a pull, and the frame is the point.
 */
export function frameDropped(body, files) {
  return !!body?.jpeg && Array.isArray(files) && !files.some(f => /\.jpg$/i.test(String(f)));
}
