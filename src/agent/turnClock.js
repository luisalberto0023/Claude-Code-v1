// ── Where a turn's time goes ──────────────────────────────────────────────────
//
// Only the model's reply was ever timed ("LLM replied in 4.2s"), so a slow run
// could not be pinned on the model, the backend, or the page's own waiting: the
// confirm polling after each action, the pause between actions, grabbing and
// encoding frames. Now every turn of play, the solver's and the model's, is
// measured by phase and written as one JSON line to logs/turns/<session>.jsonl,
// with the tokens it cost, the input it sent and whether the screen changed.
// On a game the agent has never seen, this is how to tell a slow model from a
// timing profile that waits too long, and a model that answers from one that
// answers in a shape the page cannot use.
//
// Phases are timed outermost first: while one is open, one opened inside it
// counts toward the outer. The confirm wait after an action grabs frames again
// and again, and those grabs are waiting for the screen to settle, not capture
// for the model. What no phase covers (the page's own work, snapshots written to
// disk) is other_ms.
//   capture   grabbing a frame; for a plugin, reading the board from it too
//   llm       waiting for the model, retries included
//   backend   the round trip of each request to an input route (mouse,
//             keyboard, gamepad, the game's speed)
//   confirm   waiting to see whether an action changed the screen; for a
//             plugin, the settle wait and the board read after its move
//   pace      the timing profile's pause after an action
//
// GameAgent.jsx keeps the turn being measured and times it from backend(),
// callAI, grabFrame, waitChange, pace() and the solver's own steps.
// tools/check-episodes.mjs checks this module, tools/check-agent.mjs the wiring.

export const TURN_PHASES = Object.freeze(["capture", "llm", "backend", "confirm", "pace"]);
export const TURN_KINDS = Object.freeze(["model", "plugin"]);

// Requests whose round trip is backend time, and those of them that send input
// to the game (counted as the turn's actions when the backend confirms them).
const TIMED_ROUTE = /^\/(?:mouse|keyboard|gamepad|game)\//;
const INPUT_ROUTE = /^\/(?:mouse|keyboard|gamepad)\//;

/** The phase a backend request's round trip belongs to, or null for one that is not timed. */
export function backendPhase(path) {
  return TIMED_ROUTE.test(String(path ?? "")) ? "backend" : null;
}

/** Whether a backend request sends input to the game. */
export function sendsInput(path) {
  return INPUT_ROUTE.test(String(path ?? ""));
}

/** What a turn came to, in a word, from what the model's or the solver's turn returned. */
export function turnResultName(kind, result) {
  if (!result || typeof result !== "object") return "error";
  if (kind === "model") return typeof result.kind === "string" ? result.kind : "error";
  if (result.halted) return "halted";
  if (result.stuck) return "stuck";
  if (result.gameOver) return "game-over";
  if (result.ok) return "move";
  if (result.fallback) return "fallback";
  return "error";
}

const monotonic = () => globalThis.performance?.now?.() ?? Date.now();
const count = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const addUp = (sum, v) => (count(v) == null ? sum : (sum ?? 0) + v);

/**
 * Start measuring one turn. `turn` is the number it plays as, `game` the game
 * of the run. A turn the model did not answer is taken back and tried again,
 * and a solver move that could not be made is tried again, under the same
 * number, so a number can have more than one line: `result` tells them apart.
 * `now` (a monotonic clock in ms) and `clock` (Date.now) are stand-ins in the
 * checks. Returns:
 *   enter(phase)  starts timing a phase, and returns the function that ends it.
 *                 Inside another phase, or after finish, it times nothing.
 *   note({...})   adds to what the turn did:
 *                   usage      {in, out, cached} tokens of a model reply (summed)
 *                   input      true for an input the backend confirmed sending
 *                   tools      how many of the model's tool calls were run
 *                   changed    whether an action changed the screen (any true wins)
 *                   image      whether the model was sent a screenshot
 *                   violation  a reply the page could not use as asked (a tool
 *                              not offered, no JSON action, an outcome that is
 *                              not one)
 *   finish(result)  ends the turn (and any phase left open) and returns its
 *                 record; later calls return the same record.
 */
export function startTurn({ kind, turn = null, game = null, now = monotonic, clock = Date.now } = {}) {
  const began = now();
  const at = new Date(clock()).toISOString();
  const spent = Object.fromEntries(TURN_PHASES.map(p => [p, 0]));
  const tokens = { in: null, out: null, cached: null };
  const violations = [];
  let open = null;
  let inputs = 0, tools = 0, changed = null, image = null;
  let record = null;

  const close = () => {
    if (!open) return;
    spent[open.phase] += Math.max(0, now() - open.at);
    open = null;
  };

  return {
    kind, turn, game,
    enter(phase) {
      if (record || open || !TURN_PHASES.includes(phase)) return () => {};
      const mine = { phase, at: now() };
      open = mine;
      return () => { if (open === mine) close(); };
    },
    note({ usage = null, input = false, tools: ran = null, changed: c = null, image: img = null, violation = null } = {}) {
      if (record) return;
      if (usage) {
        tokens.in = addUp(tokens.in, usage.in);
        tokens.out = addUp(tokens.out, usage.out);
        tokens.cached = addUp(tokens.cached, usage.cached);
      }
      if (input === true) inputs++;
      if (count(ran) != null) tools += ran;
      if (typeof c === "boolean") changed = changed === true || c;
      if (typeof img === "boolean") image = image === true || img;
      if (violation) violations.push(String(violation).slice(0, 200));
    },
    finish(result) {
      if (record) return record;
      close();
      const ms = Math.round(Math.max(0, now() - began));
      const phases = Object.fromEntries(TURN_PHASES.map(p => [`${p}_ms`, Math.round(spent[p])]));
      const covered = Object.values(phases).reduce((a, b) => a + b, 0);
      record = {
        turn, game, kind,
        result: turnResultName(kind, result),
        at, ms, ...phases,
        other_ms: Math.max(0, ms - covered),
        tokens_in: tokens.in, tokens_out: tokens.out, tokens_cached: tokens.cached,
        image,
        tools: kind === "model" ? tools : null,
        actions: inputs,
        changed,
        schemaViolation: violations.length ? violations.join("; ") : null,
      };
      return record;
    },
  };
}
