// ── How long one action may hold, and how much it may type ────────────────────
//
// hold_key used to hold a key for whatever duration the model gave: 600 held it
// down for ten minutes that ■ Stop could not end, and type_text typed text of any
// length. The backend now bounds both (agent_server.py, "How long one request may
// hold, and how much it may type"), as it always bounded the gamepad's holds, and
// every hold is let go however it ends. The tool schemas state the same limits so
// the model can keep inside them. When it does not, the tool result says what was
// done rather than what was asked: a model told "Key held for 600s" plans around
// a hold that never happened.
//
// tools/check-agent.mjs fails if these numbers differ from agent_server.py's.

import { backendFailure } from "./backend.js";

export const KEY_HOLD_MAX_S = 5;
export const GAMEPAD_HOLD_MAX_S = 5;
// A shorter press is missed by games that read the pad once a frame.
export const GAMEPAD_BUTTON_MIN_S = 0.02;
export const TYPE_TEXT_MAX_CHARS = 300;

/** Seconds as the model reads them: "5s", "0.25s". A value the backend could not
 * put in JSON as a number ("inf", "nan") is shown as it came. */
function seconds(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 1000) / 1000}s` : String(value);
}

/**
 * A sentence saying how the backend bounded what was asked, or "" when it did as
 * asked. A backend from before the bounds sends no `limit`, and gets "" too, as
 * does a call that failed: the backend sends `limit` with its errors as well, and
 * a failed call typed or held nothing, in part or otherwise.
 *
 * `reply.limit` is {requested, applied, min, max, unit, clamped}, with unit "s"
 * for a hold and "characters" for typed text.
 *
 * A hold cut to the limit is not continued by the next call: the backend lets go
 * of everything when a call ends, and the next one comes a model turn later. A
 * model told to "repeat the call" would plan on an unbroken hold (a charge, a
 * sprint) that never happens, so the note says so.
 */
export function limitNote(reply) {
  const limit = reply?.limit;
  if (reply?.ok !== true || !limit || limit.clamped !== true) return "";
  if (limit.unit === "characters") {
    return `Only the first ${limit.applied} of ${limit.requested} characters were typed: at most ${limit.max} go in one call, so send the rest in another.`;
  }
  return limit.applied === limit.max
    ? `Asked for ${seconds(limit.requested)}, but a hold lasts at most ${seconds(limit.max)} per call and is let go when the call ends, so a longer hold is several calls with a gap between them, not one unbroken hold.`
    : `Asked for ${seconds(limit.requested)}, but a hold lasts at least ${seconds(limit.min)}.`;
}

/** A sentence saying a hold was cut short because input was halted, or "" (a
 * call that failed included). */
export function haltNote(reply) {
  return reply?.ok === true && reply.halted === true
    ? `Input was halted after ${seconds(reply.held)}, and everything held was let go.`
    : "";
}

/** What the backend's reply adds to a tool result: that input was halted, or
 * else how it bounded what was asked, or "". (A halted hold is not worth
 * repeating, so what a hold cut to the limit would say is left out.) */
export function replyNote(reply) {
  return haltNote(reply) || limitNote(reply);
}

/** `text` followed by replyNote(reply). */
export function withLimitNotes(text, reply) {
  return [text, replyNote(reply)].filter(Boolean).join(" ");
}

/** The tool result for hold_key: how long the key was really held. */
export function holdKeyResult(reply, input) {
  if (reply?.ok !== true) return `Error: ${backendFailure(reply)}`;
  const held = typeof reply.held === "number" ? reply.held : input?.duration;
  return withLimitNotes(`Key held for ${seconds(held)}.`, reply);
}

/** The tool result for type_text: whether all of the text went in. */
export function typeTextResult(reply) {
  if (reply?.ok !== true) return `Error: ${backendFailure(reply)}`;
  return withLimitNotes("Text typed.", reply);
}
