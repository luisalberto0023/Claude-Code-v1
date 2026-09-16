// ── How a game ended ──────────────────────────────────────────────────────────
//
// One set of names for the result of a game, shared by the model's
// signal_game_end tool, the games loop, the HUD and the backend's memory file.
//
// Outcome is the unit any score across games is counted in, so it cannot have
// two spellings. It had: the solver path recorded a win as "win", while
// signal_game_end offered "won" and the backend seeded its counts with "won".
// A solver win therefore landed in a fifth bucket that nothing reads,
// outcomes.won stayed at 0, and the guard against a model inventing a win
// compared the model's report against "win", a name the model was never
// offered, so it could not fire.
//
// Every outcome the page writes comes from this list. tools/check-agent.mjs
// fails if agent_server.py's Outcome Literal, the signal_game_end enum or the
// HUD's colours disagree with it, or if a "win" outcome creeps back in.

// won      the game was beaten (a 2048 tile, a cleared minefield)
// lost     the game said so (a mine, a game-over screen)
// stuck    play could not continue: no move changes anything, or the board
//          cannot be read and guessing would be ruinous
// ended    the game finished without a measured win or loss
// aborted  the agent gave the session up for reasons outside the game, such as
//          a model that stopped answering
export const OUTCOMES = Object.freeze(["won", "lost", "stuck", "ended", "aborted"]);

// What the model may report through signal_game_end. "aborted" is a verdict on
// the agent, not on the game, and the model is in no position to give it: when
// its own requests are failing it is not being asked anything.
export const MODEL_OUTCOMES = Object.freeze(["won", "lost", "stuck", "ended"]);

// MODEL_OUTCOMES as a prompt spells them out: "won", "lost", "stuck" or "ended".
// Every prompt and tool description that asks the model how a game ended names
// the choices from here rather than in its own words. A prompt that asked for
// "win/loss/game-over" got "loss" back, and a model replying in JSON-action mode
// sees no enum, so the words it is given are the words it uses.
export const MODEL_OUTCOME_CHOICES = MODEL_OUTCOMES
  .map((name, i, all) => `${i === 0 ? "" : i === all.length - 1 ? " or " : ", "}"${name}"`)
  .join("");

// Names written before the vocabulary was shared. The solver path used "win",
// and a page from before this change may still send it.
const LEGACY = new Map([["win", "won"]]);

/**
 * The outcome name `value` stands for, or null when it is not one.
 *
 * Case and surrounding space are ignored, because a model replying in
 * JSON-action mode is not held to the tool schema's enum and "Won" means what
 * "won" means. Anything else unrecognised is null rather than a guess, so the
 * caller decides what an unreadable report counts as.
 */
export function normalizeOutcome(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  const mapped = LEGACY.get(name) ?? name;
  return OUTCOMES.includes(mapped) ? mapped : null;
}
