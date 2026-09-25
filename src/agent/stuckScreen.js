// ── When play stops: what is on screen, and what to do about it ───────────────
//
// A game stops answering for reasons the agent can often see: a game-over
// panel, a level-complete dialog, a win that offers to keep going, a message
// box. The page's screen handler (analyseStuckScreen in GameAgent.jsx) measures
// the controls on screen from pixels (src/vision/buttons.js) and asks the model
// only what each one is; the decision flow (resolveDecision) then acts on one,
// or asks the operator when the choice is theirs. It used to run only when a
// plugin was playing, so a game with no plugin, the case the agent is for, met
// every game-over screen with "try something else" until it was called stuck.
//
// This module is the part of that which is decisions, not pixels or requests:
//   - where the controls are looked for (searchPlan): with no plugin, only a
//     frame cropped to the game; with no crop, nowhere, and the operator is
//     asked, since a search of the whole screen finds the browser's own buttons
//     and links too
//   - what a control is (controlKind), from the words on it; a sign-in,
//     download, payment or online-play control is one the agent never clicks
//     itself (refused)
//   - the decision built from what was found and what the model said, and what
//     happens when nobody answers in time (fallbackChoice): the recommended
//     option's own id
//   - the model's word that a game is over (signal_game_end), weighed as a
//     claim (claimVerdict): accepted when a control that ends a game is on
//     screen, or when nothing the model does changes the screen any more; a
//     report that play cannot go on ("stuck") is taken as it is. A claim
//     turned down is dropped once the model's moves change the screen
//     (claimStands)
//   - what the games loop does after the handler has had its turn
//     (afterStuckChoice)
// The texts the operator and the model get are here too, so they can be read
// and checked in one place (tools/check-stuck.mjs). What the model is told
// never quotes a label read off the screen: screen text is the game's content,
// not a message from the agent (src/agent/prompts.js).

import { toScreen, mapBox } from "../vision/frameMap.js";
import { compare } from "../vision/motion.js";

// The built-in choices a decision can end in, besides clicking an option:
//   play-on    no click; the model plays on (offered with no plugin)
//   next-game  this game ends; the games loop starts the next one
//   stop       the session ends
export const PLAY_ON = "play-on";
export const NEXT_GAME = "next-game";
export const STOP = "stop";

// The 2048 plugin's "Keep going" option on a won board: an unattended run keeps
// playing a won board, which cannot lose anything already recorded. Only a
// decision that offers it can fall back to it.
export const DECISION_DEFAULT = "keep-going";

// How long the decision dialog waits for the operator before taking the
// fallback (fallbackChoice).
export const DECISION_WAIT_S = 90;

// How many times a game with no plugin may be got going again by the screen
// handler (a control clicked that changed the screen, or the operator's "keep
// playing") before a stuck game stays stuck. A control that only toggles
// something (a menu that opens and closes) would otherwise buy four more dead
// actions each time, for ever.
export const STUCK_LOOKS_PER_GAME = 3;

// How many claims in a row a game's end may be claimed and not confirmed. A
// model that keeps saying the game is over without playing on never reaches
// the stuck rule (a turn with no action counts as nothing), so the third such
// claim ends the game as stuck, saying why. Moves that change the screen in
// between start the count again (claimStands): the game was not over.
export const CLAIM_REJECTS_PER_GAME = 3;

// The words on a control, by what the control does. A game's own words vary,
// so these are only the common ones: the model is also asked for the kind, and
// its answer counts where the words say nothing (controlKind).
//   restart   throws the board away and starts again
//   next      goes on to the next level or round: this one is over
//   continue  closes a message, or resumes the same game
//   other     anything else (a menu, a link, settings, a shop)
//   refused   signs in or makes an account, downloads or installs, pays, or
//             plays against other people: what the standing screen rule
//             (src/agent/prompts.js) and CLAUDE.md's "Where the agent may play"
//             forbid. The agent never clicks one itself, and one on screen
//             leaves the choice to the operator
export const REFUSED = "refused";
export const CONTROL_KINDS = Object.freeze(["restart", "next", "continue", "other", REFUSED]);
// Checked before the others, so "Continue with Google", "Sign in to continue"
// and "Download to continue" are refused, not a continue.
const REFUSED_WORDS = new RegExp("\\b(" + [
  "sign[ -]?(in|up)", "log[ -]?(in|on)", "login", "account", "register", "google", "facebook", "apple", "microsoft",
  "discord", "twitter", "download", "install", "get the app", "buy", "purchase", "pay", "payment", "checkout",
  "subscribe", "subscription", "premium", "ranked", "online", "multiplayer", "pvp", "join", "match(making)?",
].join("|") + ")\\b", "i");
const RESTART_WORDS = /\b(try again|play again|new game|restart|retry|replay|start over|start again|new round|rematch)\b/i;
const NEXT_WORDS = /\bnext\b/i;
const CONTINUE_WORDS = /\b(keep going|keep playing|continue|resume|ok|okay|close|got it|dismiss|back to (the )?game)\b/i;

/**
 * What a control is, from its label (the words on it, as the model read them)
 * and, where they say nothing, the kind the model gave (`said`). Refused when
 * either says so: that only ever leaves more to the operator. Null for a
 * control with no label: nothing is known about it.
 */
export function controlKind(label, said = null) {
  const words = typeof label === "string" ? label.trim() : "";
  const given = typeof said === "string" ? said.trim().toLowerCase() : "";
  if (given === REFUSED || REFUSED_WORDS.test(words)) return REFUSED;
  if (!words) return null;
  if (RESTART_WORDS.test(words)) return "restart";
  if (NEXT_WORDS.test(words)) return "next";
  if (CONTINUE_WORDS.test(words)) return "continue";
  return CONTROL_KINDS.includes(given) ? given : "other";
}

/** Whether a control of this kind means the game (or the level) is over. */
export function isEndControl(kind) {
  return kind === "restart" || kind === "next";
}

// The kinds a control the agent clicks by itself may be, with no plugin: known
// to start again, go on, or carry on. Anything else (a menu, a link, a control
// with no label) is the operator's call (isRealChoice).
const ACTING_KINDS = Object.freeze(["restart", "next", "continue"]);

// A control as the model is told about it: by what it does, never by the words
// on it. Those were read off a screen nobody vetted, and a message from the
// agent is no place to repeat them (src/agent/prompts.js).
const KIND_WORDS = Object.freeze({
  restart: "a control that starts the game again",
  next: "a control that goes on to the next level or round",
  continue: "a control that closes a message or carries play on",
});
const kindWords = kind => KIND_WORDS[kind] ?? "a control";

// ── Where to look ──────────────────────────────────────────────────────────────

export const NO_CROP_WHY =
  "no crop is set, so the agent does not look for the game's buttons itself: a search of the whole screen " +
  "finds the browser's and the desktop's own buttons and links too. Set Crop to game area (ADVANCED) to let it";
export const NO_FRAME_WHY = "there was no frame of the screen to search";

/**
 * Where the controls are looked for.
 *   plugin       a plugin is playing: its board area, from its layout, when the
 *                layout was measured on a frame this wide (`frameWidth`), plus
 *                generous margins (controls sit above a board, overlays on it);
 *                otherwise the whole frame, as before
 *   drawn        with no plugin: whether a frame was drawn at all
 *   cropped      with no plugin: whether that frame is cropped to the game
 * Returns {search: true, region} (region null for the whole frame) or
 * {search: false, why}: nothing is searched and nothing is clicked, and the
 * operator is asked.
 */
export function searchPlan({ plugin = false, layout = null, frameWidth = 0, drawn = true, cropped = false } = {}) {
  if (plugin) {
    const r = layout?.boardRect;
    if (r && layout.capture?.w === frameWidth) {
      return {
        search: true, where: "the plugin's board area",
        region: { x: Math.max(0, r.x - r.w * 0.35), y: Math.max(0, r.y - r.h * 0.45), w: r.w * 1.7, h: r.h * 1.75 },
      };
    }
    return { search: true, where: "the whole frame", region: null };
  }
  if (!drawn) return { search: false, why: NO_FRAME_WHY };
  if (!cropped) return { search: false, why: NO_CROP_WHY };
  return { search: true, where: "the crop", region: null };
}

// ── What the model is asked about the controls ─────────────────────────────────

/**
 * The system prompt that asks the model what the controls are. The page puts
 * the standing screen rule in front of it (so "Reply with ONLY a JSON object"
 * stays the last thing read). The controls are measured from pixels, and
 * outlined and numbered on the image the model gets, so it names them and
 * never guesses where they are.
 *
 * For a claim (`purpose` "claim") the question is a neutral one: the model that
 * said the game is over is not told that its answer is what weighs the claim.
 */
export function labelPrompt(purpose = "stuck") {
  const situation = purpose === "claim"
    ? "You are looking at a game's screen. Say what each control on it is."
    : "You are looking at a game that has stopped responding to input.";
  return `${situation}
The clickable controls have already been located for you: each is outlined and numbered on the image.
Do not guess coordinates, only say what each one is.
"kind" is one of: "restart" (starts the game over: Try again, New game, Play again, Restart),
"next" (goes on to the next level or round), "continue" (closes a message or resumes this game:
OK, Continue, Resume, Keep going), "refused" (signs in, makes an account, downloads, installs, pays,
or plays online against other people), "other" (anything else: a menu, a link, settings, a shop).
Reply with ONLY a JSON object, no other text:
{"situation":"<one short sentence describing what is on screen>",
 "buttons":[{"index":<number from the list>,"label":"<the words on that control>","kind":"<restart|next|continue|refused|other>"}],
 "recommended":<index of the control that continues play, or null if unsure>,
 "needsHuman":<true if choosing wrongly would lose progress or end the run, else false>}`;
}

/**
 * The list of controls sent with the image: their numbers, and where each is
 * in the image the model gets (`k` image pixels per frame pixel).
 */
export function controlList(found, k = 1) {
  return found.map((b, i) =>
    `${i}: at ${Math.round(b.cx * k)},${Math.round(b.cy * k)}, ${Math.round(b.w * k)}x${Math.round(b.h * k)}px`).join("\n");
}

// ── What the model said about the controls ─────────────────────────────────────

/**
 * The model's answer about the controls, read from its reply text: the first
 * JSON object in it, or null. Nothing in it is trusted beyond what is read
 * below (labels are shown, never obeyed).
 */
export function readLabels(text) {
  const m = typeof text === "string" ? text.match(/\{[\s\S]*\}/) : null;
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The index of the control the model recommends, if it names one of `count`. */
export function recommendedIndex(labelled, count) {
  const raw = labelled?.recommended;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < count ? n : null;
}

/**
 * Whether the operator must be asked, before looking at the options: true when
 * nothing was understood (no answer, or no recommendation) or the model says a
 * wrong choice would lose progress. Otherwise null, not false: then the options
 * decide (isRealChoice), and the operator is asked only when one of them carries
 * on from where the game is and another throws it away. It used to be a boolean
 * always, so the options were never consulted.
 */
export function needsHumanFrom(labelled, recIdx) {
  if (!labelled || recIdx == null) return true;
  if (labelled.needsHuman === true || labelled.needsHuman === "true") return true;
  return null;
}

const labelOf = hit => (typeof hit?.label === "string" && hit.label.trim() ? hit.label.trim().slice(0, 80) : null);

/**
 * Whether choosing a control of this kind throws the game as it stands away,
 * for isRealChoice: true for a restart, false for a control that carries on
 * from where the game is ("continue"), and undefined (not known) for the rest.
 * A "next" goes on to another level or round, and "other" could be anything
 * (a menu, a shop, a link): neither is known to keep the game as it is, so each
 * counts as one that may not, as an unlabelled control always has.
 */
export function restartsOf(kind) {
  if (kind === "restart") return true;
  if (kind === "continue") return false;
  return undefined;
}

/**
 * The decision built from the controls found (buttons.js candidates, in the
 * frame's pixels) and the model's answer about them (readLabels, or null).
 *   scale    the frame's scale, for toScreen (src/vision/frameMap.js)
 *   purpose  "stuck" (play stopped) or "claim" (the model said the game is over)
 *   playOn   offer "keep playing" with no click (no plugin)
 *   verify   check that a click changed the screen (no plugin)
 * Each option is {id: "btn-N", label, labelled, x, y, w, h, kind, restarts, end}.
 * A refused control (a sign-in, a download, a payment, online play) is never
 * the recommended one, and one on screen leaves the choice to the operator.
 */
export function genericDecision({ found = [], labelled = null, scale = null, purpose = "stuck", playOn = false, verify = false, where = null } = {}) {
  const options = found.map((b, i) => {
    const hit = Array.isArray(labelled?.buttons) ? labelled.buttons.find(x => Number(x?.index) === i) : null;
    const label = labelOf(hit);
    const kind = controlKind(label, hit?.kind);
    return {
      id: `btn-${i}`,
      label: label ?? `Button at ${b.cx},${b.cy}`,
      labelled: !!label,
      x: b.cx, y: b.cy, w: b.w, h: b.h,
      kind,
      restarts: restartsOf(kind),
      end: isEndControl(kind),
    };
  });
  const recIdx = recommendedIndex(labelled, options.length);
  const refused = options.some(o => o.kind === REFUSED);
  const situation = typeof labelled?.situation === "string" && labelled.situation.trim() ? labelled.situation.trim().slice(0, 300) : null;
  return {
    kind: "stuck", purpose,
    summary: situation ?? (purpose === "claim"
      ? "The model says the game is over, and something is on screen."
      : "The game has stopped responding and something is on screen."),
    options,
    needsHuman: refused ? true : needsHumanFrom(labelled, recIdx),
    recommended: recIdx != null && options[recIdx].kind !== REFUSED ? options[recIdx].id : null,
    fallback: NEXT_GAME,
    playOn, verify,
    searched: true, where, why: null,
    scale,
  };
}

/**
 * A decision with nothing to click: the screen was not searched (`why`, from
 * searchPlan), so the operator is asked whether to keep playing, start the
 * next game or stop. Nobody answering starts the next game, as play stopping
 * as stuck always has.
 */
export function askDecision({ why, purpose = "stuck", scale = null } = {}) {
  return {
    kind: "stuck", purpose,
    summary: `The game has stopped responding, and ${why}.`,
    options: [],
    needsHuman: true,
    recommended: null,
    fallback: NEXT_GAME,
    playOn: true, verify: true,
    searched: false, where: null, why,
    scale,
  };
}

// ── Was it there when the game began? ──────────────────────────────────────────
//
// Many games show "New Game" or "Restart" all the time, above the board, as
// 2048 does. Such a control says nothing about whether the game has ended, so a
// control counts as a sign of the end only if it appeared during the game: its
// part of the page's motion map (src/vision/motion.js) moved between the look
// taken as the game began and a look now.

/** A control's box in its frame's pixels (x, y are its centre), or a point for one with no size. */
export function optionBox(o) {
  const w = Number(o?.w) || 0, h = Number(o?.h) || 0;
  return { x: Number(o?.x) - w / 2, y: Number(o?.y) - h / 2, w, h };
}

/**
 * Whether `box` (in the maps' frame pixels) changed as a whole in a comparison
 * from motion.js's compare(): true when more than half its cells moved, false
 * when not, or null when that cannot be told (no comparison, or maps of a
 * different size: the view changed as a whole). The cells counted are those
 * whose centre is in the box, or the cell at its centre for a box smaller than
 * a cell. A control that appears changes all of its cells; one cell used to be
 * enough, and the pointer resting on a control that was there all along moves
 * one.
 */
export function movedInside(result, box) {
  if (!result || result.resized || !result.grid) return null;
  const { grid } = result;
  const cw = grid.width / grid.cols, ch = grid.height / grid.rows;
  const inside = new Set();
  for (let r = 0; r < grid.rows; r++) {
    const cy = grid.y + (r + 0.5) * ch;
    if (cy < box.y || cy > box.y + box.h) continue;
    for (let c = 0; c < grid.cols; c++) {
      const cx = grid.x + (c + 0.5) * cw;
      if (cx >= box.x && cx <= box.x + box.w) inside.add(r * grid.cols + c);
    }
  }
  if (!inside.size) {
    const c = Math.max(0, Math.min(grid.cols - 1, Math.floor((box.x + box.w / 2 - grid.x) / cw)));
    const r = Math.max(0, Math.min(grid.rows - 1, Math.floor((box.y + box.h / 2 - grid.y) / ch)));
    inside.add(r * grid.cols + c);
  }
  const moved = result.cells.filter(k => inside.has(k)).length;
  return moved * 2 > inside.size;
}

/**
 * The decision with `appeared` on each option: whether it appeared during this
 * game (true), was on screen when the game began (false), or cannot be told
 * (null: no look from the start of the game, or none now).
 *   start  {look, scale}: the page's look as the game began, and its frame's scale
 *   now    {look, scale}: a look now
 *   noise  the game's noise floor (calibrateNoise), or null
 */
export function withAppeared(decision, { start = null, now = null, noise = null } = {}) {
  if (!decision?.options?.length) return decision;
  const result = start?.look?.map && now?.look?.map ? compare(start.look.map, now.look.map, noise) : null;
  return {
    ...decision,
    options: decision.options.map(o => ({
      ...o,
      appeared: result ? movedInside(result, mapBox(optionBox(o), decision.scale, now.scale)) : null,
    })),
  };
}

// ── Choosing ───────────────────────────────────────────────────────────────────

/** Every choice a decision can end in: its options, then the built-in ones it offers. */
export function choicesOf(decision) {
  return [
    ...(decision?.options ?? []).map(o => o.id),
    ...(decision?.playOn ? [PLAY_ON] : []),
    NEXT_GAME, STOP,
  ];
}

/**
 * What the decision dialog does when nobody answers in time: the recommended
 * option's own id; else the 2048 plugin's "keep-going", when it is offered;
 * else the decision's fallback (next-game). The dialog used to fall back to
 * "keep-going" whatever it offered, which matches no control found on an
 * unknown screen (those are "btn-N"): the click found nothing to act on and
 * started the next game instead. Never a refused control (a sign-in, a
 * download, a payment): only the operator picks one of those.
 */
export function fallbackChoice(decision) {
  const ids = choicesOf(decision);
  const pick = decision?.recommended;
  const refused = (decision?.options ?? []).some(o => o.id === pick && o.kind === REFUSED);
  if (pick && ids.includes(pick) && !refused) return pick;
  if (ids.includes(DECISION_DEFAULT)) return DECISION_DEFAULT;
  return decision?.fallback && ids.includes(decision.fallback) ? decision.fallback : NEXT_GAME;
}

/**
 * Whether the operator is asked. Only when there is a real choice: when the
 * decision says so (needsHuman true), or, when it leaves it open (null), when
 * one option carries on from where the game is (restarts false) and another
 * throws the board away. If every option throws the board away ("Try again",
 * "New Game") they amount to the same thing, and the agent just acts.
 *
 * Whatever the decision says, the operator is asked when a refused control is
 * on screen, and, with no plugin (`playOn`), when the control the agent would
 * click is not known to start again, go on or carry on (a menu, a link, a
 * control with no label): on a game nobody vetted, that is the click most
 * likely to leave single-player play.
 */
export function isRealChoice(decision) {
  const options = decision?.options ?? [];
  if (decision?.needsHuman === true || options.some(o => o.kind === REFUSED)) return true;
  if (decision?.playOn && options.length) {
    const pick = options.find(o => o.id === actingChoice(decision));
    if (!ACTING_KINDS.includes(pick?.kind)) return true;
  }
  const canContinue = options.some(o => o.restarts === false);
  const canRestart = options.some(o => o.restarts !== false);
  return decision?.needsHuman ?? (canContinue && canRestart);
}

/** What the agent takes when there is no real choice to ask about: never a refused control. */
export function actingChoice(decision) {
  const options = (decision?.options ?? []).filter(o => o.kind !== REFUSED);
  return options.find(o => o.id === decision?.recommended)?.id ?? options[0]?.id ?? NEXT_GAME;
}

/** A choice as the operator reads it. */
export function choiceLabel(decision, id) {
  if (id === PLAY_ON) return "keep playing (no click)";
  if (id === NEXT_GAME) return "start the next game";
  if (id === STOP) return "stop the session";
  const opt = decision?.options?.find(o => o.id === id);
  return opt ? `"${opt.label}"` : `"${id}"`;
}

// ── What a snapshot of a decision says ─────────────────────────────────────────

/**
 * The controls a decision holds, one line each, for a snapshot's text and the
 * log file: what was searched, then each control with its label, its kind, where
 * it is in the frame and on the screen, and which the model recommended. This is
 * what measures the control finder: the frame in the same snapshot has each of
 * them outlined and numbered.
 */
export function candidateLines(decision) {
  if (!decision) return ["Nothing that can be clicked was found on screen."];
  if (decision.searched === false) return [`The screen was not searched: ${decision.why}.`];
  const options = decision.options ?? [];
  const lines = [`Controls found${decision.where ? ` in ${decision.where}` : ""}: ${options.length}.`];
  for (const [i, o] of options.entries()) {
    const screen = toScreen(o, decision.scale);
    const size = o.w && o.h ? `, ${o.w}×${o.h} px` : "";
    const since = o.appeared === true ? ", new during this game"
      : o.appeared === false ? ", on screen since the game began" : "";
    lines.push(`  ${i}. ${o.labelled === false ? "(no label)" : `"${o.label}"`} — ${o.kind ?? "unknown"}${since}` +
      `, at ${o.x},${o.y} in the frame${size}, ${screen.x},${screen.y} on the screen` +
      `${o.id === decision.recommended ? " — recommended" : ""}`);
  }
  if (options.some(o => o.kind === REFUSED)) {
    lines.push("A refused control (sign-in, download, payment, online play) is on screen: the agent never clicks one itself.");
  } else if (decision.needsHuman === true) {
    lines.push("The model's answer leaves this to the operator.");
  }
  return lines;
}

/** A decision snapshot's text: a heading, what is on screen, the controls, then any lines after. */
export function decisionText(heading, decision, after = []) {
  return [heading, "", decision?.summary ?? "", ...candidateLines(decision), ...(after.length ? ["", ...after] : [])]
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
    .join("\n");
}

// ── The model's word that the game is over ─────────────────────────────────────

// What a control's own words say it is, whatever the model said: the model
// that claims the game is over also names the controls, and its word alone
// ("restart", for a "Main menu") must not be what confirms its claim.
const kindByWords = o => (o?.labelled === false ? null : controlKind(o?.label));

/**
 * The option that says the game has ended, if one was found: a control whose
 * words say it ends a game ("Try again", "New game", "Next level") and that was
 * not on screen as the game began (withAppeared), a restart before a "next". A
 * control whose start cannot be told counts.
 */
export function endControlOf(decision) {
  const options = (decision?.searched === false ? [] : decision?.options ?? [])
    .filter(o => o.appeared !== false && o.kind !== REFUSED);
  return options.find(o => kindByWords(o) === "restart") ?? options.find(o => kindByWords(o) === "next") ?? null;
}

/**
 * Whether the model's claim that the game is over (signal_game_end, with
 * `outcome`) ends it, with no plugin to measure the game. It is accepted when
 *   - the model reports the game "stuck": the standing screen rule
 *     (src/agent/prompts.js) tells it to, when play cannot go on without
 *     signing in, downloading or the like, and a report that play cannot go on
 *     cannot inflate a result the way a made-up win can, or
 *   - the stuck rule already says nothing the model does changes the screen
 *     (`stuck`, noops.js's stuckVerdict on the streak as it stands), or
 *   - the screen handler found a control that ends a game (`decision`):
 *     "Try again", "New game", "Restart", "Next" and the like.
 * Otherwise it is not, and play goes on; `rejected` is how many claims in a row
 * have been turned down, and the one that reaches CLAIM_REJECTS_PER_GAME ends
 * the game as stuck instead (giveUp).
 * Returns {accept, how: "reported-stuck"|"no-op"|"control", control?, why} or
 * {accept: false, giveUp, why, forModel}: `why` for the log, which may quote
 * the controls' labels, and `forModel` for the model, which does not.
 */
export function claimVerdict({ outcome = null, stuck = null, decision = null, rejected = 0 } = {}) {
  if (outcome === "stuck") return { accept: true, how: "reported-stuck", why: "the model reported that play cannot go on" };
  if (stuck?.stuck) return { accept: true, how: "no-op", why: "nothing the model did changed the screen any more" };
  const control = endControlOf(decision);
  if (control) return { accept: true, how: "control", control, why: `the screen shows "${control.label}" (${kindByWords(control)})` };
  const found = decision?.options?.length ?? 0;
  const always = (decision?.options ?? []).filter(o => isEndControl(kindByWords(o)) && o.appeared === false);
  const were = always.length === 1 ? "was" : "were";
  const [why, forModel] = !decision
    ? ["nothing that can be clicked was found on screen", "nothing on screen that ends a game was found"]
    : decision.searched === false ? [decision.why, "the agent could not look at the screen for a control that ends a game"]
    : always.length ? [
      `${always.map(o => `"${o.label}"`).join(" and ")} ${were} already on screen when this game began, so that says nothing about it ending`,
      `${always.map(o => kindWords(kindByWords(o))).join(" and ")} ${were} already on screen when this game began, so that says nothing about it ending`,
    ]
    : [`none of the ${found} control${found === 1 ? "" : "s"} found on screen ends a game (restart, try again, new game, next)`,
      `none of the ${found} control${found === 1 ? "" : "s"} found on screen ends a game`];
  return { accept: false, giveUp: rejected + 1 >= CLAIM_REJECTS_PER_GAME, why, forModel };
}

/**
 * What the model is told when its claim is turned down, and play goes on: why,
 * in words of the agent's own (the verdict's forModel), and not to start a new
 * game itself. A game the model restarted would go on in the same record, two
 * games as one, and the first one's result lost.
 */
export function claimNudge({ outcome = null, verdict = null } = {}) {
  return `The agent did not end the game on your signal_game_end (${outcome ?? "ended"}): ` +
    `${verdict?.forModel ?? "nothing on screen confirmed it"}. The game goes on. ` +
    "Do not start a new game yourself (no New game, Try again, Play again or restart): if the game really has ended, " +
    "make a normal move; it will change nothing, and the agent will then end the game and start the next one. " +
    "Otherwise look at the screen and keep playing.";
}

/**
 * Whether a claim turned down earlier still stands, for the games loop:
 * `pending` is {claim, changesAt}, changesAt the count of the model's actions
 * that had changed the screen when it was turned down, and `changes` that count
 * now. Once one of its actions since has changed the screen, the game was not
 * over when the model said it was, and the claim is dropped: it used to stay
 * until the game next stalled, however much later, and then give the game its
 * outcome and score.
 */
export function claimStands(pending, changes = 0) {
  return !!pending?.claim && (Number(changes) || 0) <= (Number(pending.changesAt) || 0);
}

/** The log line for a claim dropped because the screen responded after it. */
export function claimDroppedLine(claim) {
  return `The screen responded after the model said the game was over (${claim?.outcome ?? "ended"}), ` +
    "so that claim is dropped and play goes on.";
}

/** The log line for a claim taken. */
export function claimAcceptedLine(verdict) {
  return verdict?.how === "reported-stuck"
    ? "Ending this game as stuck, as the model reported: play cannot go on."
    : `The game is over: ${verdict?.why ?? "the claim was taken"}.`;
}

/**
 * What the game-end snapshot adds about how a claim was taken: nothing for a
 * claim that was not weighed (a plugin playing), else why, and the controls
 * found when one of them confirmed it. `seen` is {verdict, decision}.
 */
export function claimTaken(seen) {
  if (!seen?.verdict?.accept) return "";
  const lines = ["", `Taken: ${seen.verdict.why}.`];
  if (seen.verdict.how === "control") lines.push(...candidateLines(seen.decision));
  return `\n${lines.join("\n")}`;
}

/** The log line for a claim turned down. */
export function claimRejectedLine({ outcome = null, why = "", rejected = 1 } = {}) {
  return `The model said the game is over (${outcome ?? "ended"}), but ${why}. Not ended: playing on ` +
    `(${rejected} of ${CLAIM_REJECTS_PER_GAME} claims in a row turned down).`;
}

// ── After the handler: what the games loop does ────────────────────────────────

/**
 * What the model is told when the handler got play going again: that play had
 * stopped, what happened then (`note`, afterStuckChoice's modelNote, which
 * names no label), and to go on.
 */
export function resumeNudge(note = null) {
  return `Play had stopped: your last actions changed nothing on screen. Then ${note ?? "the agent looked at the screen"}. ` +
    "Look at the screen again and carry on playing, and try something other than what changed nothing.";
}

/**
 * What the games loop does once the stuck rule fired and the screen handler
 * had its turn, with no plugin. `result` is resolveDecision's
 * {choice, clicked, changed} (null when the handler found nothing to click or
 * did not run, `why` then saying which), `claim` the model's last turned-down
 * claim that the game is over (signal_game_end's {outcome, ...}), and
 * `decision` the handler's.
 * Returns {next, outcome, stuckReason, startedNext, restartPoint, note}:
 *   play-on   keep playing this game: a control was clicked and the screen
 *             changed ("OK", "Continue", a "Next level" with no claim that the
 *             game is over), or the operator said to. The count of dead
 *             actions starts again. `modelNote` then says what happened for
 *             the model (resumeNudge), naming the control by what it does and
 *             not by its label; `note` is the log's
 *   end-game  this game is over, with `outcome`: the claim's, now that nothing
 *             responds, else "stuck"; or, after a restart control ("Try
 *             again", "New game") was clicked and changed the screen, the
 *             claim's or "ended" ("stuck" for a control on screen since the
 *             game began: that game was not over, only stuck). Then the click
 *             also started the next game (startedNext), from `restartPoint` on
 *             the screen, which later restarts can reuse. A "Next" ends the
 *             game this way only when the model had said it was over
 *   stop      the operator stopped the session here
 */
export function afterStuckChoice({ result = null, claim = null, decision = null, why = null } = {}) {
  const claimed = claim?.outcome ?? null;
  const ended = (extra = {}) => ({
    next: "end-game", outcome: claimed ?? "stuck", stuckReason: null, startedNext: false, restartPoint: null, note: why, ...extra,
  });
  if (!result) return ended();
  if (result.choice === STOP) return { ...ended(), next: "stop" };
  if (result.choice === PLAY_ON) {
    return { next: "play-on", note: "the operator said to keep playing", modelNote: "the operator said to keep playing" };
  }
  const opt = result.clicked;
  if (!opt) return ended();
  if (result.changed === true) {
    const restart = opt.kind === "restart";
    if (restart || (opt.kind === "next" && claimed)) {
      // A game-over "Try again" ends a game that was over. A "New Game" that was
      // on screen all along (appeared false) ends one that was only stuck.
      return ended({
        outcome: claimed ?? (opt.appeared === false ? "stuck" : "ended"),
        stuckReason: !claimed && opt.appeared === false ? `play was stuck, and "${opt.label}" started a new game` : null,
        startedNext: true, restartPoint: restart ? toScreen(opt, decision?.scale) : null,
        note: `"${opt.label}" ended this game and started the next`,
      });
    }
    return {
      next: "play-on", note: `"${opt.label}" was clicked and the screen changed`,
      modelNote: `the agent clicked ${kindWords(opt.kind)} on screen, and the screen changed`,
    };
  }
  return ended({
    stuckReason: `"${opt.label}" was clicked and the screen did not change`,
    note: `"${opt.label}" was clicked and the screen did not change`,
  });
}
