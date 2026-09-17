// ── What a model turn came to, and what the games loop does next ──────────────
//
// A turn used to end in {stop: true, reason} or {stop: false}, and the loop read
// every stop as the game being over. A request that failed stopped the turn too,
// so a model that did not answer ended the game as "ended", had New Game clicked
// on a live board, and was saved to memory as a played game.
//
// A turn now says which of these it was:
//
//   action           the model answered and its actions ran
//   game-ended       the model answered and signalled that the game is over
//   transport-error  no answer, but one may come: rate limits, server errors,
//                    timeouts, a network that dropped (see llmErrors.js)
//   fatal-error      no answer, and none will come by waiting: a rejected key, a
//                    model that does not exist, a request the provider refuses
//   stopped          the user pressed Stop
//
// decideAfterTurn turns that into what the loop does. It is the one place that
// decides, so the rule can be checked on its own: only "game-ended" ends a game
// with an outcome, and so only it can lead to a restart or be saved to memory as
// a game. A model that stopped answering pauses the session and leaves the board
// alone; after MODEL_WAIT_CAP_MS lost to it, at once on a fatal error, or when
// Stop is pressed while the model is not answering (decideAfterWait, and
// decideAfterTurn for a Stop during a failing request), the session is given up
// as "aborted", which is a verdict on the agent, not on the game.
//
// The games loop does not act on those decisions by hand. settleModelCall
// carries a model call's result through the wait for the model and says what
// the loop does next, and gameEnding decides whether a game that play has left
// gets a result at all, so both can be checked without running the page. The
// loop only wires them in, and tools/check-agent.mjs checks that wiring.

import { MODEL_OUTCOMES, normalizeOutcome } from "./outcomes.js";

export const TURN_KINDS = Object.freeze(["action", "game-ended", "transport-error", "fatal-error", "stopped"]);

// How much time a session gives a model that is not answering before giving up.
//
// It counts the time lost to the outage: the failed requests themselves and the
// waits between checks, added up across every failure until a turn gets
// through. A check that the model answers is not a turn that worked, so it does
// not end the count, or a request the model keeps failing (one too large for a
// flaky link, say) would keep the session waiting for ever, one short pause at a
// time. Play in between does not count either: a solver that carries on for an
// hour between two short outages has not been waiting for the model.
export const MODEL_WAIT_CAP_MS = 15 * 60 * 1000;

// When to check whether the model answers again: 15 s after the failure, then
// 30 s, then 60 s, then every 120 s until the cap.
export const MODEL_CHECK_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000]);

// How long one check that the model answers may take, at most. The check is a
// one-word reply, so a model that is up answers it in far less; without a
// limit of its own it would get a whole turn's deadline (ten minutes through
// the Ollama relay), and one hung check could carry the wait well past the cap.
export const MODEL_CHECK_TIMEOUT_MS = 120_000;
// The shortest deadline a check gets, even when little of the cap is left, so
// the last check still gives a model that is loading a fair chance.
export const MODEL_CHECK_MIN_TIMEOUT_MS = 30_000;

/**
 * The turn result for a model call that failed, from classifyLlmError's verdict.
 * A Stop that landed after the call had already failed once (callAI sets
 * `afterFailure` to that failure's verdict) says so, since it stopped a request
 * that was not getting through rather than a healthy one.
 */
export function turnFailure(verdict) {
  if (verdict?.kind === "stopped") {
    return verdict.afterFailure ? { kind: "stopped", afterFailure: verdict.afterFailure } : { kind: "stopped" };
  }
  if (verdict?.kind === "fatal") return { kind: "fatal-error", error: verdict };
  return { kind: "transport-error", error: verdict };
}

const minutes = ms => Math.max(1, Math.round(ms / 60000));

/**
 * What the games loop does after a turn.
 *
 * `outage` is null while turns get through, and {lostMs, probes} while the model
 * is failing: lostMs is the time lost to it so far and probes how many checks
 * have run. `failedForMs` is how long the turn being judged took, which is time
 * lost when it failed. The returned `outage` replaces the one passed in: a turn
 * the model answered clears it, a transport error starts or extends it.
 *
 * Returns {next, outage, ...}, where next is one of
 *   "continue"        carry on playing this game
 *   "end-game"        the game is over: with `outcome` (a model outcome, never
 *                     "aborted") and `finalScore`
 *   "wait-for-model"  pause, leave the board alone, and wait until the model
 *                     answers (nextModelCheck says when to look)
 *   "abort-session"   give the session up: `outcome` is "aborted", `message`
 *                     says why
 *   "stop"            the user stopped a run whose model was answering
 */
export function decideAfterTurn(result, outage = null, failedForMs = 0) {
  switch (result?.kind) {
    case "action":
      return { next: "continue", outage: null };

    case "game-ended": {
      // The model may only report what signal_game_end offers it; "aborted" is
      // not the model's to give, and a name that cannot be read is just "ended".
      const named = normalizeOutcome(result.outcome);
      return {
        next: "end-game",
        outage: null,
        outcome: MODEL_OUTCOMES.includes(named) ? named : "ended",
        finalScore: result.finalScore ?? null,
      };
    }

    case "transport-error": {
      const lostMs = (outage?.lostMs ?? 0) + Math.max(0, Number(failedForMs) || 0);
      const next = { lostMs, probes: outage?.probes ?? 0 };
      if (lostMs >= MODEL_WAIT_CAP_MS) {
        return {
          next: "abort-session",
          outage: next,
          outcome: "aborted",
          message: `the model has not answered for ${minutes(lostMs)} minutes` +
            `${result.error?.userText ? ` (last error: ${result.error.userText})` : ""}`,
        };
      }
      return { next: "wait-for-model", outage: next };
    }

    case "fatal-error":
      return {
        next: "abort-session",
        outage,
        outcome: "aborted",
        message: result.error?.userText || "the model provider refused the request",
      };

    case "stopped": {
      // Stop pressed while the model was not getting through: in the wait
      // before a retry, during a retry, or on the first turn after a check
      // answered. That is the operator giving up on the model, as a Stop
      // during the wait itself is (decideAfterWait), and the game in play did
      // not end, so it must not be recorded as "ended".
      if (outage || result.afterFailure) {
        const last = result.afterFailure?.userText;
        return {
          next: "abort-session",
          outage,
          outcome: "aborted",
          message: `stopped while the model was not answering${last ? ` (last error: ${last})` : ""}`,
        };
      }
      return { next: "stop", outage };
    }

    default:
      // A turn result nothing recognises is a bug in the page. Giving the
      // session up leaves the board as it is; guessing "the game ended" is the
      // mistake this module exists to stop.
      return {
        next: "abort-session",
        outage,
        outcome: "aborted",
        message: `a turn ended in an unrecognised way (${JSON.stringify(result ?? null)})`,
      };
  }
}

/**
 * What the games loop does once a wait for the model is over, from what the
 * wait came to: {kind: "answered"}, {kind: "gave-up", message} or
 * {kind: "stopped"}.
 *
 * Returns {next: "continue"} to run the step that failed again, or
 * {next: "abort-session", outcome: "aborted", message}. Stop pressed during the
 * wait gives the session up as well, rather than ending it as a normal Stop
 * would: the game in play did not end, the model had already stopped
 * answering, and recording that game as "ended" is the false result this
 * module exists to prevent. It is the operator reaching the cap early.
 */
export function decideAfterWait(waited) {
  switch (waited?.kind) {
    case "answered":
      return { next: "continue" };
    case "stopped":
      return { next: "abort-session", outcome: "aborted", message: "stopped while waiting for the model to answer" };
    case "gave-up":
      return { next: "abort-session", outcome: "aborted", message: waited.message || "the model did not answer" };
    default:
      return {
        next: "abort-session",
        outcome: "aborted",
        message: `a wait for the model ended in an unrecognised way (${JSON.stringify(waited ?? null)})`,
      };
  }
}

/**
 * How long to wait before the next check that the model answers, or null once
 * the outage has cost MODEL_WAIT_CAP_MS and the session should be given up. The
 * last wait is shortened so the final check lands on the cap, not past it.
 */
export function nextModelCheck(outage) {
  const lostMs = Math.max(0, outage?.lostMs ?? 0);
  if (lostMs >= MODEL_WAIT_CAP_MS) return null;
  const probes = Math.max(0, outage?.probes ?? 0);
  const delay = MODEL_CHECK_DELAYS_MS[Math.min(probes, MODEL_CHECK_DELAYS_MS.length - 1)];
  return Math.min(delay, MODEL_WAIT_CAP_MS - lostMs);
}

/**
 * The deadline for one check that the model answers: at most
 * MODEL_CHECK_TIMEOUT_MS or a normal request's `requestMs`, whichever is
 * shorter, and no more than is left of the cap, though never less than
 * MODEL_CHECK_MIN_TIMEOUT_MS.
 */
export function modelCheckTimeoutMs(outage, requestMs) {
  const left = MODEL_WAIT_CAP_MS - Math.max(0, outage?.lostMs ?? 0);
  const limit = Math.min(MODEL_CHECK_TIMEOUT_MS, requestMs > 0 ? requestMs : MODEL_CHECK_TIMEOUT_MS);
  return Math.min(limit, Math.max(MODEL_CHECK_MIN_TIMEOUT_MS, left));
}

/**
 * What the games loop does with a model call's result: a turn of play, or the
 * model's part of a restart. Decides with decideAfterTurn and, when that says
 * to, waits for the model with `waitForModel(outage, lastError)`, the page's
 * wait, which returns what decideAfterWait reads.
 *
 * `session` is {outage, abortReason} and is updated in place: the outage as
 * decideAfterTurn leaves it, and abortReason once the session is given up.
 * `failedForMs` is how long the call took.
 *
 * Returns {loop}, where loop is one of
 *   "play"      the call got through; carry on
 *   "retry"     the model answers again; run the step that failed once more
 *   "end-game"  the model said the game is over, with `outcome` and `finalScore`
 *   "stop"      the user stopped a run whose model was answering
 *   "give-up"   the session is over, and session.abortReason says why
 */
export async function settleModelCall(result, session, failedForMs, waitForModel) {
  const step = decideAfterTurn(result, session.outage, failedForMs);
  session.outage = step.outage;
  switch (step.next) {
    case "continue":
      return { loop: "play" };
    case "end-game":
      return { loop: "end-game", outcome: step.outcome, finalScore: step.finalScore };
    case "stop":
      return { loop: "stop" };
    case "wait-for-model": {
      let waited;
      try {
        waited = await waitForModel(session.outage, result?.error);
      } catch (e) {
        // A wait that breaks is not an answer, and play must not go on as if
        // it were one.
        waited = { kind: "gave-up", message: `the wait for the model failed (${e?.message ?? e})` };
      }
      const after = decideAfterWait(waited);
      if (after.next === "continue") return { loop: "retry" };
      session.abortReason = after.message;
      return { loop: "give-up" };
    }
    default:
      session.abortReason = step.message;
      return { loop: "give-up" };
  }
}

/**
 * Whether a game that play has left gets a result, and which. The games loop
 * asks this every time play on a game stops, before it records anything, so a
 * way out of play that forgot to name an outcome cannot fall back to "ended".
 *
 *   outcome      the outcome play named for the game, or null
 *   abortReason  set when the session was given up
 *   stopped      whether the user pressed Stop
 *
 * Returns {record: true, outcome} for a game with a result: the outcome play
 * named, or "ended" for a game Stop cut short while the model was answering (as
 * a Stop always has). Otherwise {record: false}: the session was given up, so
 * the game did not finish, the agent did; or play left the game with no outcome
 * and no Stop, which is a bug in the page, and `abortReason` then gives the
 * session up rather than recording a result nobody saw.
 */
export function gameEnding({ outcome = null, abortReason = null, stopped = false } = {}) {
  if (abortReason) return { record: false };
  const named = normalizeOutcome(outcome);
  if (named && named !== "aborted") return { record: true, outcome: named };
  if (stopped) return { record: true, outcome: "ended" };
  return {
    record: false,
    abortReason: `play on a game stopped without an outcome (${JSON.stringify(outcome)})`,
  };
}
