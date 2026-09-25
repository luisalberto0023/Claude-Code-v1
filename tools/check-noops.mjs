#!/usr/bin/env node
// Check how the agent counts actions that changed nothing.
//
//   node tools/check-noops.mjs
//
// Only press_key used to be counted: a click, a drag, a scroll, a hold, typing,
// the gamepad and a sequence's steps that changed nothing left the count where
// it was, so a mouse or controller game was never called stuck, and the turn
// after a click that missed could skip its screenshot as "unchanged". The count
// is now kept for every action (src/agent/noops.js, through executeTool's
// noteEffect in GameAgent.jsx), keyed on the action's signature. This checks:
//   - signatures: keys by name, clicks to about 16 px, a grid cell whatever
//     point in it, the pad's other button names, a stick by its direction
//   - the count: a change starts it again, the same dead action twice is one
//     signature (and the model is still told the action it sent), and an action
//     judged while input was halted, never sent (the backend down, restarting or
//     refusing the page), or with no frame to judge it by, is not counted; those
//     last two are counted on their own, and ten in a row pause play
//   - the stuck rule: 4 in a row across 3 different actions, or 10 in a row;
//     the reminders at 3 and 6, once each however the streak got there
//   - on the real Expert capture in tools/frames, a click that opens a covered
//     square is judged changed by the motion map and is NOT a no-op, even at the
//     end of a streak, where the legacy hash would have counted it as one; a
//     click on a square already open is, and clicking it again stays one action
//   - on the local Minesweeper's own pixels (bench/minesweeper), with its timer
//     ticking and the game calibrated, a scripted run of clicks: dead ones
//     count, a live one between them resets, and four dead clicks on three
//     squares end the game as stuck
//   - what the model is told: "changed nothing on screen" with the numbers it
//     was judged on, never a "direction" that is "BLOCKED"; "changed nothing
//     where it acted" when the motion map saw a change only away from a click
//   - the page's wiring: every action tool's wait, and every sequence step's,
//     goes through noteEffect; the next turn's nudge, its image skip and its
//     vision turn read the count; the games loop's stuck rule is stuckVerdict

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadFrame } from "./real-frames.mjs";
import { createCanvas } from "./fake-canvas.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const no = await import(src("agent", "noops.js"));
const cd = await import(src("agent", "changeDetection.js"));
const mo = await import(src("vision", "motion.js"));
const backendJs = await import(src("agent", "backend.js"));
const { MODEL_OUTCOME_CHOICES } = await import(src("agent", "outcomes.js"));
const msModule = await import(src("plugins", "minesweeper.js"));
const benchGame = await import(pathToFileURL(path.join(ROOT, "bench", "minesweeper", "game.js")).href);
const benchDraw = await import(pathToFileURL(path.join(ROOT, "bench", "minesweeper", "draw.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const show = v => JSON.stringify(v, (k, x) => (x instanceof Set ? [...x] : x));
const cases = (name, list) => {
  const bad = list.filter(([, got, test]) => !test(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check(name, !bad.length, bad.join("; "));
};
const sig = no.actionSignature;
const same = (tool, a, b) => sig(tool, a) === sig(tool, b);

// A wait's verdict as the page's waitChange gives it, with nothing waited for.
const watch = (before, after, action, { noise = null, detector = "motion" } = {}) =>
  cd.watchForChange(async () => after, before, { maxMs: 0, action, noise, detector, wait: async () => {}, now: () => 0 });
const lookOf = f => ({ map: mo.motionMap(f), hash: mo.legacyHash(f) });

// Run a list of steps through noteAction: {signature, changed} or a full
// confirm, with the backend's reply when it matters.
const confirmOf = changed => ({ changed, motion: { changed, why: changed ? "3 cells changed at the target" : "nothing moved past the noise", peak: changed ? 40 : 0.5, nearest: null } });
function play(steps, state = no.newNoOps()) {
  for (const s of steps) state = no.noteAction(state, { signature: s.signature, confirm: s.confirm ?? confirmOf(!!s.changed), reply: s.reply ?? null, halted: !!s.halted });
  return state;
}
// What the last action that changed nothing was counted as, and sent as.
const countedAs = s => s.lastNoOp?.countedAs;
const sentAs = s => s.lastNoOp?.signature;
const dead = signature => ({ signature, changed: false });
const live = signature => ({ signature, changed: true });

// ── Signatures ────────────────────────────────────────────────────────────────
console.log("signatures");
{
  cases("keys by name: arrow names, case, spaces, aliases and the order of a combo's modifiers are one key", [
    ["ArrowUp / up / UP / ' up '", [sig("press_key", { key: "ArrowUp" }), sig("press_key", { key: "UP" }), sig("press_key", { key: " up " })],
      v => v.every(s => s === "press_key up")],
    ["Escape / esc", same("press_key", { key: "Escape" }, { key: "esc" }), v => v],
    ["Return / enter", same("press_key", { key: "Return" }, { key: "enter" }), v => v],
    ["ctrl+Z / Control+z / z+ctrl", [sig("press_key", { key: "ctrl+Z" }), sig("press_key", { key: "Control+z" }), sig("press_key", { key: "z+ctrl" })],
      v => v.every(s => s === "press_key ctrl+z")],
    ["shift+ctrl+t / ctrl+shift+t", same("press_key", { key: "shift+ctrl+t" }, { key: "ctrl+shift+t" }), v => v],
    ["a space typed as ' '", sig("press_key", { key: " " }), v => v === "press_key space"],
    ["'+' on its own", sig("press_key", { key: "+" }), v => v === "press_key +"],
    ["up and down differ", same("press_key", { key: "up" }, { key: "down" }), v => !v],
    ["a press and a hold of one key differ", sig("press_key", { key: "right" }) !== sig("hold_key", { key: "right", duration: 1 }), v => v],
    ["a hold is its key, whatever its duration", same("hold_key", { key: "Right", duration: 0.5 }, { key: "right", duration: 3 }), v => v],
  ]);
  // Clicks are matched to a click that already changed nothing, when counted.
  const counted = (tool, inputs) => play(inputs.map(inp => dead(sig(tool, inp))));
  cases(`clicks within ${no.CLICK_NEAR_PX} px of one that changed nothing are that click; a square away is another`, [
    ["the signature", sig("click", { x: 595.4, y: 408 }), v => v === "click at 595,408"],
    ["595,408 / 592,401 / 607,415 / 600,404 (either side of any 16 px line)",
      counted("click", [{ x: 595, y: 408 }, { x: 592, y: 401 }, { x: 607, y: 415 }, { x: 600, y: 404 }]),
      s => s.streak === 4 && s.failed.size === 1 && countedAs(s) === "click at 595,408" && sentAs(s) === "click at 600,404"],
    ["407 and 408, the line a fixed grid would draw between them", counted("click", [{ x: 100, y: 407 }, { x: 100, y: 408 }]), s => s.failed.size === 1],
    ["30 px apart", counted("click", [{ x: 100, y: 100 }, { x: 130, y: 100 }]), s => s.failed.size === 2],
    ["17 px apart", counted("click", [{ x: 100, y: 100 }, { x: 100, y: 117 }]), s => s.failed.size === 2],
    ["a left click, said or not", same("click", { x: 10, y: 10 }, { x: 10, y: 10, button: "left", clicks: 1 }), v => v],
    ["right and left differ, at one place", counted("click", [{ x: 10, y: 10 }, { x: 10, y: 10, button: "right" }]),
      s => s.failed.size === 2 && countedAs(s) === "click at 10,10 (right)"],
    ["double and single differ", sig("click", { x: 10, y: 10, clicks: 2 }), v => v === "click at 10,10 (double)"],
    ["a click and a scroll at one place differ", play([dead(sig("click", { x: 10, y: 10 })), dead(sig("scroll", { x: 10, y: 10, amount: 1 }))]),
      s => s.failed.size === 2],
  ]);
  cases("click_grid by its cell, whatever point inside it", [
    ["c4 / C4 / C04 at other points", [sig("click_grid", { cell: "c4" }), sig("click_grid", { cell: "C4", dx: 0.1, dy: 0.9 }), sig("click_grid", { cell: "C04" })],
      v => v.every(s => s === "click_grid C4")],
    ["C5 differs", same("click_grid", { cell: "C4" }, { cell: "C5" }), v => !v],
    ["a right click differs", sig("click_grid", { cell: "C4", button: "right" }), v => v === "click_grid C4 (right)"],
  ]);
  cases("drags, scrolls, typing and the gamepad", [
    ["a drag a few pixels off", counted("drag", [{ x1: 100, y1: 100, x2: 300, y2: 100 }, { x1: 103, y1: 98, x2: 298, y2: 104 }]),
      s => s.failed.size === 1 && countedAs(s) === "drag 100,100 → 300,100" && sentAs(s) === "drag 103,98 → 298,104"],
    ["a drag to elsewhere", counted("drag", [{ x1: 100, y1: 100, x2: 300, y2: 100 }, { x1: 100, y1: 100, x2: 100, y2: 300 }]), s => s.failed.size === 2],
    ["scroll up by 3 or by 5", same("scroll", { x: 50, y: 50, amount: 3 }, { x: 50, y: 50, amount: 5 }), v => v],
    ["scroll up and down", same("scroll", { x: 50, y: 50, amount: 3 }, { x: 50, y: 50, amount: -3 }), v => !v],
    ["typed text as typed", [sig("type_text", { text: "hello" }), sig("type_text", { text: "Hello" })], v => v[0] === 'type_text "hello"' && v[0] !== v[1]],
    ["long text shortened, with its length", sig("type_text", { text: "x".repeat(40) }), v => v === `type_text "${"x".repeat(24)}"… (40 characters)`],
    ["south / A / a", [sig("gamepad_button", { button: "south" }), sig("gamepad_button", { button: "A" }), sig("gamepad_button", { button: "a", hold: 1 })],
      v => v.every(s => s === "gamepad_button a")],
    ["dpad_up / up", same("gamepad_button", { button: "dpad_up" }, { button: "up" }), v => v],
    ["a stick pushed right, near enough", same("gamepad_stick", { stick: "left", x: 1, y: 0 }, { stick: "left", x: 0.9, y: 0.1, duration: 2 }), v => v],
    ["...up-right, and barely at all", [sig("gamepad_stick", { stick: "left", x: 0.7, y: 0.7 }), sig("gamepad_stick", { stick: "right", x: 0.1, y: -0.1 })],
      v => v[0] === "gamepad_stick left up-right" && v[1] === "gamepad_stick right centre"],
    ["a trigger however far, and released", [sig("gamepad_trigger", { trigger: "right", value: 1 }), sig("gamepad_trigger", { trigger: "right", value: 0.4 }), sig("gamepad_trigger", { trigger: "right", value: 0 })],
      v => v[0] === v[1] && v[2] === "gamepad_trigger right released"],
  ]);
}

// ── The count and the stuck rule ──────────────────────────────────────────────
console.log("the count");
{
  const before = new Set(["press_key up"]);
  const start = { streak: 1, failed: before, lastNoOp: { signature: "press_key up", countedAs: "press_key up", away: false }, unknown: 0 };
  const after = no.noteAction(start, { signature: "press_key left", confirm: confirmOf(false) });
  cases("an action that changed nothing adds to the streak and the set; one that changed something starts both again", [
    ["no change", after, s => s.streak === 2 && s.failed.size === 2 && sentAs(s) === "press_key left" && countedAs(s) === "press_key left" && s.counted],
    ["the state given is left as it was", { size: before.size, streak: start.streak }, v => v.size === 1 && v.streak === 1],
    ["a change", no.noteAction(after, { signature: "press_key down", confirm: confirmOf(true) }),
      s => s.streak === 0 && s.failed.size === 0 && s.lastNoOp === null && s.counted],
  ]);
  const deadSpot = "click at 592,400";
  cases("the same dead spot clicked again and again is one action tried many times", [
    ["four times", play([dead(deadSpot), dead(deadSpot), dead(deadSpot), dead(deadSpot)]), s => s.streak === 4 && s.failed.size === 1],
  ]);
  // A click 16 px from one that changed nothing is counted as that one, but the
  // model is told the click it sent: it did not send the other.
  const steps = play([100, 116, 132, 148].map(x => dead(sig("click", { x, y: 100 }))));
  cases("a nearby click is counted as the earlier one, and still named as the model sent it", [
    ["the count", steps, s => s.streak === 4 && show(s.failed) === show(["click at 100,100", "click at 132,100"])],
    ["the last action", steps.lastNoOp, v => v.signature === "click at 148,100" && v.countedAs === "click at 132,100"],
  ]);

  const three = play([dead("click at 16,16"), dead("click at 16,16")]);
  const noFrame = { changed: false, motion: { changed: false, why: mo.NO_FRAME, peak: 0, nearest: null } };
  cases("an action judged while input was halted, or with no frame to judge it by, is not counted either way", [
    ["halted, no change", no.noteAction(three, { signature: "click at 48,48", confirm: confirmOf(false), halted: true }),
      s => s.streak === 2 && s.failed.size === 1 && countedAs(s) === "click at 16,16" && !s.counted && s.unknown === 0],
    ["halted, changed", no.noteAction(three, { signature: "click at 48,48", confirm: confirmOf(true), halted: true }),
      s => s.streak === 2 && !s.counted],
    ["no frame", no.noteAction(three, { signature: "click at 48,48", confirm: noFrame }),
      s => s.streak === 2 && s.failed.size === 1 && !s.counted && s.unknown === 1],
  ]);
  const judged = cd.judgeLooks(null, null, { action: cd.changeAction("click", { x: 1, y: 1 }) });
  check("a look that could not be taken is what judgeLooks calls no frame (motion.js NO_FRAME)", no.unseen(judged) && !judged.changed, show(judged.motion));

  // Replies as the page's backend() gives them: no answer at all, Vite's empty
  // 500 with the backend down, a backend restarted with a new token, the
  // backend's own server failing. None reached the game.
  const unreachable = { ok: false, error: "Failed to fetch", unreachable: true };
  const down = backendJs.readReply(500, "");
  const refused = { ok: false, error: "The backend refused this page's token. ...", refused: "token" };
  const crashed = backendJs.readReply(500, "Internal Server Error");
  // ...and the backend's own refusal of the action, which did reach it.
  const offScreen = { ok: false, error: "x, y outside the screen" };
  const badKey = { detail: [{ loc: ["body", "key"], msg: "Input should be a valid string" }] };
  cases("a reply that never reached the game is not sent; the backend's own refusal of the action is", [
    ["no answer, the backend down, the page refused, the server failing", [unreachable, down, refused, crashed].map(no.notSent), v => v.every(Boolean)],
    ["readReply marks the empty reply unreachable", down, r => r.unreachable === true && r.ok === false && !("crashed" in r)],
    ["an off-screen click, a bad key, a success", [offScreen, badKey, { ok: true }, null].map(no.notSent), v => v.every(x => !x)],
  ]);
  const outage = play([
    { signature: "click at 100,100", reply: unreachable }, { signature: "click at 300,100", reply: down },
    { signature: "click at 500,100", reply: refused }, { signature: "click at 100,100", reply: crashed },
  ], three);
  cases("clicks that never reached the game are not counted either way: four at three spots are not stuck", [
    ["the count", outage, s => s.streak === 2 && s.failed.size === 1 && countedAs(s) === "click at 16,16" && s.unknown === 4],
    ["the verdict", no.stuckVerdict({ streak: outage.streak, distinct: outage.failed.size }), v => !v.stuck],
    ["what the model is told", [no.effectText(confirmOf(false), { reply: unreachable }), no.stepText(confirmOf(false), { reply: down })],
      ([t, step]) => t === "Not sent (Failed to fetch), so whether it would have changed anything is not known."
        && step.startsWith("not sent (no reply from the backend (HTTP 500, empty)")],
    ["the backend's own refusal still counts", play([{ signature: "press_key foo", reply: offScreen }], three),
      s => s.streak === 3 && s.failed.size === 2 && s.unknown === 0],
  ]);

  // Acting blind: each action whose effect is not known adds to `unknown`, any
  // action sent and seen sets it back to 0, and ten in a row pause play.
  const blind = n => Array.from({ length: n }, (_, k) => ({ signature: `press_key ${["up", "down", "left", "right"][k % 4]}`, confirm: noFrame }));
  const tenBlind = play(blind(10));
  const nineThenSeen = play([...blind(9), dead("press_key up"), ...blind(9)]);
  cases(`${no.BLIND_PAUSE} actions in a row whose effect is not known pause play; one seen in between starts the count again`, [
    ["the number", no.BLIND_PAUSE, v => v === 10],
    ["10 with no frame", tenBlind, s => s.unknown === 10 && s.streak === 0 && no.stuckVerdict({ streak: s.streak, distinct: s.failed.size }).stuck === false],
    ["...pause", no.blindPause(tenBlind.unknown), t => typeof t === "string" && t.startsWith("⏸ Paused: the agent could not tell what its last 10 actions did") && t.includes("▶ Resume")],
    ["9, one seen, 9 more", nineThenSeen, s => s.unknown === 9 && s.streak === 1 && !no.blindPause(s.unknown)],
    ["a halt leaves it where it was", play([{ signature: "x", changed: false, halted: true }], play(blind(3))), s => s.unknown === 3],
    ["a change sets it back to 0", play([live("press_key up")], play(blind(3))), s => s.unknown === 0],
  ]);
}

console.log("the stuck rule");
{
  const verdict = steps => { const s = play(steps); return { ...no.stuckVerdict({ streak: s.streak, distinct: s.failed.size }), streak: s.streak, distinct: s.failed.size }; };
  const n = (count, signature) => Array.from({ length: count }, () => dead(signature));
  check(`the numbers: ${no.STUCK_STREAK} in a row across ${no.STUCK_DISTINCT} different actions, or ${no.STUCK_HARD_STOP} in a row`,
    no.STUCK_STREAK === 4 && no.STUCK_DISTINCT === 3 && no.STUCK_HARD_STOP === 10);
  cases("stuck only on strong evidence", [
    ["4 over 3 different", verdict([dead("a"), dead("b"), dead("c"), dead("a")]), v => v.stuck && v.exhausted && !v.hardStop],
    ["3 over 3 different", verdict([dead("a"), dead("b"), dead("c")]), v => !v.stuck],
    ["4 over 2 different", verdict([dead("a"), dead("b"), dead("a"), dead("b")]), v => !v.stuck],
    ["the same dead square 9 times", verdict(n(9, "click at 592,400")), v => !v.stuck],
    ["...and a 10th", verdict(n(10, "click at 592,400")), v => v.stuck && v.hardStop && !v.exhausted],
    ["3 different, a change, 3 more", verdict([dead("a"), dead("b"), dead("c"), live("d"), dead("a"), dead("b"), dead("c")]), v => !v.stuck && v.streak === 3],
    ["4 over 3, with halted actions among them", verdict([dead("a"), { signature: "x", changed: true, halted: true }, dead("b"), dead("c"), dead("a")]),
      v => v.stuck && v.streak === 4],
  ]);
  // The streak the games loop sees after each turn, and the reminders it gives.
  const reminders = streaks => {
    let given = 0;
    return streaks.map(n => { const r = no.noOpReminderDue(n, given); given = r.given; return r.remind; }).filter(Boolean);
  };
  check("the model is reminded at 3 and 6 in a row", show(no.NO_OP_REMINDERS) === show([3, 6]));
  cases("each reminder once a streak, however the streak got there", [
    ["one action a turn", reminders([1, 2, 3, 4, 5, 6, 7]), r => show(r) === show([3, 6])],
    ["a sequence taking it from 2 to 4, then 5 to 7", reminders([2, 4, 5, 7]), r => show(r) === show([3, 6])],
    ["turns that send nothing leave it at 3", reminders([3, 3, 3]), r => show(r) === show([3])],
    ["a change, and a new streak", reminders([3, 0, 1, 3]), r => show(r) === show([3, 3])],
    ["a change and one dead action within one turn", reminders([3, 1, 2, 3]), r => show(r) === show([3, 3])],
    ["straight past both", reminders([2, 7]), r => show(r) === show([6])],
  ]);
  const both = no.stuckVerdict({ streak: 10, distinct: 3 });
  const words = [both, no.stuckVerdict({ streak: 10, distinct: 1 })].flatMap(v => [v.reason, v.logLine]);
  check("the reason and the log line speak of actions, not directions",
    both.reason === "no moves available: 3 different actions all changed nothing over 10 actions"
      && both.logLine === "No moves available — 3 different actions all changed nothing on screen over 10 actions."
      && words.every(w => typeof w === "string" && !/direction|blocked/i.test(w)), show(words));
}

// ── The real Expert capture ───────────────────────────────────────────────────
// One covered square repainted with an opened square's own pixels, off the same
// capture: a click there that worked. The spec's review measured the old hash
// on exactly this: every correct click read as a no-op.
console.log("the real capture");
{
  const ms = msModule.default;
  const COVERED = msModule.UNKNOWN;
  const { canvas: real } = loadFrame("expert-midgame");
  const frame = { width: real.width, height: real.height, data: real.data };
  const state = ms.readState(real);
  const G = state?.grid;
  check("the Expert capture reads as a board", !!state && G?.pitch > 0, "not readable");
  if (state) {
    const square = (r, c) => ({ x: G.x + c * G.pitch, y: G.y + r * G.pitch });
    const centre = (r, c) => ({ x: G.x + c * G.pitch + G.pitch / 2, y: G.y + r * G.pitch + G.pitch / 2 });
    const where = test => {
      const out = [];
      for (let r = 0; r < state.rows; r++) for (let c = 0; c < state.cols; c++) if (test(state.board[r][c], r, c)) out.push([r, c]);
      return out;
    };
    const deep = where((v, r, c) => v === COVERED && [-1, 0, 1].every(dr => [-1, 0, 1].every(dc => state.board[r + dr]?.[c + dc] === COVERED)));
    const opened = where(v => v === 0);
    const [tr, tc] = deep[Math.floor(deep.length / 2)];
    const [br, bc] = opened[0];
    const repainted = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
    const from = square(br, bc), to = square(tr, tc);
    for (let dy = 0; dy < G.pitch; dy++) {
      const s = ((from.y + dy) * frame.width + from.x) * 4, t = ((to.y + dy) * frame.width + to.x) * 4;
      repainted.data.set(frame.data.subarray(s, s + G.pitch * 4), t);
    }
    const before = lookOf(frame), opens = lookOf(repainted), still = lookOf(frame);
    const at = centre(tr, tc);
    const clickThere = { x: Math.round(at.x), y: Math.round(at.y) };
    const action = cd.changeAction("click", clickThere);
    const byMotion = await watch(before, opens, action);
    const byLegacy = await watch(before, opens, action, { detector: "legacy" });
    // Three dead actions came before it: the click that works must end the streak.
    const streak = play([dead("click at 16,16"), dead("press_key up"), dead("click_grid A1")]);
    const afterGood = no.noteAction(streak, { signature: sig("click", clickThere), confirm: byMotion });
    const afterLegacy = no.noteAction(streak, { signature: sig("click", clickThere), confirm: byLegacy });
    cases("a click on a covered square that opens it is NOT a no-op: the motion map sees it, and the streak before it ends", [
      ["the motion map's verdict", byMotion, v => v.changed && v.by === "motion" && v.motion.nearest === 0],
      ["the count after it", afterGood, s => s.counted && s.streak === 0 && s.failed.size === 0 && s.lastNoOp === null],
      ["what the model is told", no.effectText(byMotion, { action, streak: afterGood.streak }), t => t.startsWith("Screen changed (motion map: ") && /peak \d+\.\d grey levels/.test(t)],
    ]);
    cases("...where the legacy hash would have counted it as the 4th in a row, three different: stuck", [
      ["the legacy hash", byLegacy, v => !v.changed && v.by === "legacy"],
      ["the count", afterLegacy, s => s.streak === 4 && no.stuckVerdict({ streak: s.streak, distinct: s.failed.size }).stuck],
    ]);

    const [or, oc] = opened[Math.floor(opened.length / 2)];
    const onOpen = centre(or, oc);
    const tries = [0, 1, 2].map(k => ({ x: Math.round(onOpen.x) + k * 3, y: Math.round(onOpen.y) - k * 2 }));
    let s = no.newNoOps();
    const confirms = [];
    for (const p of tries) {
      const c = await watch(before, still, cd.changeAction("click", p));
      confirms.push(c);
      s = no.noteAction(s, { signature: sig("click", p), confirm: c });
    }
    const told = no.effectText(confirms[2], { action: cd.changeAction("click", tries[2]), streak: s.streak });
    cases("a click on a square already open is a no-op, and clicking it again a few pixels off stays one action", [
      ["each judged", confirms, v => v.every(c => !c.changed && !no.unseen(c))],
      ["the count", s, v => v.streak === 3 && v.failed.size === 1 && countedAs(v) === sig("click", tries[0]) && sentAs(v) === sig("click", tries[2])],
      ["what the model is told", told,
        t => t.startsWith("That action changed nothing on screen (motion map: nothing moved past the noise, peak 0.0 grey levels near the target).")
          && t.endsWith("That is 3 actions in a row counted as changing nothing.")],
      ["...and the next turn", no.noOpNudge({ lastNoOp: s.lastNoOp, failed: s.failed }),
        t => t.startsWith(`Your last action (${sig("click", tries[2])}, the same spot as ${sig("click", tries[0])}) changed nothing on screen. Do not repeat it.`)],
    ]);
  }
}

// ── The local Minesweeper, played by a script ─────────────────────────────────
// Its own pixels (bench/minesweeper/draw.js), its timer ticking between the look
// before each click and the look after it, and the game calibrated on two idle
// frames first, as the page does at the start of each game.
console.log("the local Minesweeper");
{
  const SIZE = 24;
  const game = benchGame.newGame("expert", 42);
  const geo = benchDraw.geometry(game.rows, game.cols, SIZE);
  const draw = now => { const cv = createCanvas(geo.width, geo.height); benchDraw.drawGame(cv, game, { size: SIZE, now }); return lookOf(cv); };
  const at = (r, c) => ({ x: geo.grid.x + c * SIZE + SIZE / 2, y: geo.grid.y + r * SIZE + SIZE / 2 });
  let clock = 1_000_000;
  let state = no.newNoOps();
  let noise = null;
  const log = [];
  // One click as the page makes it: the look before, the click, the look after
  // 1.1 s later (the timer ticks in between), judged near where it landed.
  const click = async (r, c) => {
    const before = draw(clock);
    benchGame.reveal(game, r, c, clock + 50);
    clock += 1100;
    const after = draw(clock);
    clock += 200;
    const p = at(r, c);
    const confirm = await watch(before, after, cd.changeAction("click", p), { noise });
    state = no.noteAction(state, { signature: sig("click", p), confirm });
    const verdict = no.stuckVerdict({ streak: state.streak, distinct: state.failed.size });
    log.push({ r, c, changed: confirm.changed, streak: state.streak, distinct: state.failed.size, stuck: verdict.stuck });
    return confirm;
  };
  await click(12, 15); // the first click places the mines and opens an area
  const idle = [draw(clock), draw(clock + 1100)];
  clock += 1500;
  noise = mo.calibrateNoise(idle.map(l => l.map));
  const i = (r, c) => r * game.cols + c;
  // Squares in the middle rows, away from the header's timer.
  const squares = [];
  for (let r = 4; r < game.rows - 1; r++) for (let c = 1; c < game.cols - 1; c++) squares.push([r, c]);
  const openSquares = squares.filter(([r, c]) => game.open[i(r, c)]);
  const safeNumber = squares.find(([r, c]) => !game.open[i(r, c)] && !game.mine[i(r, c)] && game.count[i(r, c)] > 0);
  check("the scripted game has opened squares to click again and a covered number to open, with the timer ticking",
    game.status === "playing" && openSquares.length >= 3 && !!safeNumber && !!noise && noise.moving > 0,
    show({ status: game.status, open: openSquares.length, safeNumber, moving: noise?.moving }));
  if (openSquares.length >= 3 && safeNumber) {
    const [a, b, c] = [openSquares[0], openSquares[Math.floor(openSquares.length / 2)], openSquares[openSquares.length - 1]];
    await click(...a); await click(...a); await click(...a);
    const beforeLive = { ...log[log.length - 1] };
    await click(...safeNumber);
    const afterLive = { ...log[log.length - 1] };
    await click(...a); await click(...b); await click(...c);
    const threeDead = { ...log[log.length - 1] };
    await click(...a);
    const fourth = { ...log[log.length - 1] };
    cases("dead clicks count, however the timer ticks; the one that opens a covered number resets; four dead over three squares is stuck", [
      ["the first click", log[0], v => v.changed && v.streak === 0],
      ["the same open square three times", beforeLive, v => v.streak === 3 && v.distinct === 1 && !v.stuck],
      ["the covered number opened", afterLive, v => v.changed && v.streak === 0 && v.distinct === 0],
      ["three different open squares", threeDead, v => v.streak === 3 && v.distinct === 3 && !v.stuck],
      ["a fourth dead click", fourth, v => v.streak === 4 && v.distinct === 3 && v.stuck],
    ]);
  }
}

// ── What the model is told ────────────────────────────────────────────────────
console.log("what the model is told");
{
  const clickAction = cd.changeAction("click", { x: 100, y: 100 });
  const keyAction = cd.changeAction("press_key", { key: "up" });
  const deadClick = { changed: false, by: "motion", dist: 0.4, motion: { changed: false, why: "nothing moved past the noise", peak: 0.4 }, legacy: { changed: false, dist: 0.04, threshold: 2 } };
  const deadKey = { ...deadClick, motion: { ...deadClick.motion, peak: 1.25 } };
  const legacyDead = { ...deadClick, by: "legacy", dist: 0.04 };
  const liveClick = { changed: true, by: "motion", dist: 20.2, motion: { changed: true, why: "7 cells changed at the target", peak: 20.2 }, legacy: { changed: false, dist: 0.04, threshold: 2 } };
  const noFrame = { changed: false, by: "motion", dist: 0, motion: { changed: false, why: mo.NO_FRAME, peak: 0 } };
  // A counter repainted far from a click that changed nothing where it landed,
  // judged by the motion map on pixels: 60×20 px at (1100, 60) on a 1280×720
  // screen, the click at (200, 600).
  const screen = () => createCanvas(1280, 720, [40, 40, 40]);
  const plain = screen(), counter = screen();
  counter.rect(1100, 60, 60, 20, [230, 230, 230]);
  const farClick = cd.changeAction("click", { x: 200, y: 600 });
  const away = await watch(lookOf(plain), lookOf(counter), farClick);
  const awayState = no.noteAction(no.newNoOps(), { signature: sig("click", { x: 200, y: 600 }), confirm: away });
  const texts = [
    ["a dead click", no.effectText(deadClick, { action: clickAction, streak: 1 }),
      t => t === "That action changed nothing on screen (motion map: nothing moved past the noise, peak 0.4 grey levels near the target)."],
    ["a dead key, 3rd in a row", no.effectText(deadKey, { action: keyAction, streak: 3 }),
      t => t === "That action changed nothing on screen (motion map: nothing moved past the noise, peak 1.3 grey levels). That is 3 actions in a row counted as changing nothing."],
    ["by the legacy hash", no.effectText(legacyDead, { action: keyAction, streak: 1 }),
      t => t === "That action changed nothing on screen (legacy hash: dist 0.04, needs over 2.0)."],
    ["a click that worked", no.effectText(liveClick, { action: clickAction }), t => t === "Screen changed (motion map: 7 cells changed at the target, peak 20.2 grey levels)."],
    ["no frame", no.effectText(noFrame, { action: clickAction, streak: 0 }), t => /not known/.test(t) && !/changed nothing/.test(t)],
    ["a sequence's dead step", no.stepText(deadKey, { action: keyAction }), t => t === "changed nothing on screen (motion map: nothing moved past the noise, peak 1.3 grey levels)"],
    ["a sequence's step that worked", no.stepText(liveClick, { action: clickAction }), t => t === "changed"],
    ["a click where only a counter far off changed: judged", away, v => !v.changed && v.by === "motion" && v.motion.nearest > 0 && no.changedAway(v) && !no.unseen(v)],
    ["...counted, as changing nothing where it acted", awayState, s => s.streak === 1 && s.lastNoOp?.away === true],
    ["...what the model is told", no.effectText(away, { action: farClick, streak: 1 }),
      t => t.startsWith("That action changed nothing where it acted (motion map: only away from the target changed (")
        && t.endsWith("near the target). If that change elsewhere was its effect, it worked.") && !/on screen/.test(t)],
    ["...as a sequence's step", no.stepText(away, { action: farClick }), t => t.startsWith("changed nothing where it acted (motion map: only away from the target")],
    ["...the next turn", no.noOpNudge({ lastNoOp: awayState.lastNoOp, failed: awayState.failed }),
      t => t === "Your last action (click at 200,600) changed nothing where it acted; the screen changed only away from it. Unless that change was its effect, try something different now."],
    ["...the log file", no.noOpLine(awayState), t => t === "No-op 1 in a row: click at 200,600 changed nothing where it acted (1 different action since the screen last changed)."],
    ["...and not by the legacy hash, which judges the whole view", no.changedAway({ ...away, by: "legacy" }), v => v === false],
    ["the next turn's nudge", no.noOpNudge({ lastNoOp: { signature: "click at 592,400", countedAs: "click at 592,400" }, failed: new Set(["press_key up", "click at 592,400"]) }),
      t => t === "Your last action (click at 592,400) changed nothing on screen. Do not repeat it. Also changed nothing since the screen last changed: press_key up. Try something different now."],
    ["...after a click counted as one near it", no.noOpNudge({ lastNoOp: { signature: "click at 148,100", countedAs: "click at 132,100" }, failed: new Set(["click at 100,100", "click at 132,100"]) }),
      t => t === "Your last action (click at 148,100, the same spot as click at 132,100) changed nothing on screen. Do not repeat it. Also changed nothing since the screen last changed: click at 100,100. Try something different now."],
    ["no nudge after a change", no.noOpNudge({ lastNoOp: null, failed: new Set() }), t => t === ""],
    ["the reminder at 3 and 6", no.noOpReminder({ streak: 3, failed: new Set(["press_key up", "click_grid C4"]) }),
      t => t.startsWith("3 actions in a row changed nothing on screen (tried: press_key up, click_grid C4).") && t.includes(MODEL_OUTCOME_CHOICES)],
    ["the log file's line", no.noOpLine({ streak: 2, failed: new Set(["a", "b"]), lastNoOp: { signature: "click at 16,16", countedAs: "click at 16,16" } }),
      t => t === "No-op 2 in a row: click at 16,16 changed nothing on screen (2 different actions since the screen last changed)."],
    ["...for a click counted as one near it", no.noOpLine({ streak: 3, failed: new Set(["a", "click at 10,10"]), lastNoOp: { signature: "click at 14,12", countedAs: "click at 10,10" } }),
      t => t === "No-op 3 in a row: click at 14,12 (counted as click at 10,10) changed nothing on screen (2 different actions since the screen last changed)."],
    ["playing blind", no.blindPause(no.BLIND_PAUSE), t => !/changed nothing/.test(t)],
  ];
  cases("tool results say what the action did, with the numbers it was judged on", texts);
  const all = texts.map(([, t]) => t).join(" ");
  check("...and never call an action a direction, or blocked", !/direction|blocked/i.test(all));
}

// ── The page's wiring ─────────────────────────────────────────────────────────
console.log("GameAgent.jsx");
{
  const code = fs.readFileSync(path.join(ROOT, "src", "GameAgent.jsx"), "utf8").replace(/\r\n/g, "\n");
  const between = (from, to) => {
    const a = code.indexOf(from);
    const b = a < 0 ? -1 : code.indexOf(to, a + from.length);
    return a < 0 || b < 0 ? "" : code.slice(a, b);
  };
  const count = re => [...code.matchAll(re)].length;

  const tools = between("const executeTool = useCallback(", 'if (toolName === "update_memory")');
  const helper = between("const noteEffect = (tool, input, confirm, { at = null, reply = null } = {}) => {", "\n    };\n");
  check("noteEffect keys the count on the action's signature, keeps the four refs with noteAction, and passes the reply and the halt",
    /const signature = actionSignature\(tool, input\);/.test(helper)
      && /const next = noteAction\(\s*\{ streak: noOpStreakRef\.current, failed: lastFailedMovesRef\.current, lastNoOp: lastActionNoOpRef\.current, unknown: unknownEffectsRef\.current \},\s*\{ signature, confirm, reply, halted: haltedRef\.current \}\);/.test(helper)
      && /noOpStreakRef\.current = next\.streak;\s*lastFailedMovesRef\.current = next\.failed;\s*lastActionNoOpRef\.current = next\.lastNoOp;\s*unknownEffectsRef\.current = next\.unknown;/.test(helper)
      && /if \(next\.counted && !confirm\?\.changed\) addLog\(noOpLine\(next\), "info", \{ fileOnly: true \}\);/.test(helper)
      && /return \{ text: effectText\(confirm, \{ action, streak: next\.streak, reply \}\), step: stepText\(confirm, \{ action, reply \}\) \};/.test(helper),
    helper.slice(0, 300) || "noteEffect not found");

  // Each tool's own reply is the one passed: the request that sent the action.
  const REQUESTS = {
    click: "/mouse/click", click_grid: "/mouse/click", drag: "/mouse/drag", scroll: "/mouse/scroll",
    press_key: "/keyboard/press", hold_key: "/keyboard/hold", type_text: "/keyboard/type",
    gamepad_button: "/gamepad/button", gamepad_stick: "/gamepad/stick", gamepad_trigger: "/gamepad/trigger",
  };
  const ACTION_TOOLS = Object.keys(REQUESTS);
  const unwired = ACTION_TOOLS.filter(name => {
    const body = between(`if (toolName === "${name}") {`, "\n    }\n");
    return !(new RegExp(`const confirm = await waitChange\\([^;]*action: changeAction\\("${name}"[^;]*\\);\\s*const effect = noteEffect\\("${name}", toolInput, confirm, \\{ (at: \\{ x: imgX, y: imgY \\}, )?reply: res \\}\\);`).test(body)
      && /\$\{effect\.text\}/.test(body)
      && body.includes(`const res = await backend("${REQUESTS[name]}", `));
  });
  check(`every action tool's wait goes through noteEffect with the reply that sent it, and its result says what the action did (${ACTION_TOOLS.length - unwired.length} of ${ACTION_TOOLS.length})`,
    !unwired.length, unwired.join(", "));
  const sequence = between('if (toolName === "execute_sequence") {', "\n    }\n");
  check("...and every step of execute_sequence, each counted as its own action, with its reply",
    /const confirm = await waitChange\(lookNow, __base, \{ maxMs: timing\.confirmDelay, action: changeAction\(t, inp\) \}\);\s*executed\+\+;\s*(?:\/\/[^\n]*\s*)*const effect = noteEffect\(t, inp, confirm, \{ reply: r \}\);/.test(sequence)
      && /— \$\{effect\.step\}\$\{cutNote\}`\)/.test(sequence));
  check("a sequence stops at a step that never reached the game, and after 2 steps unseen or 2 that changed nothing, each said as what it was",
    /if \(notSent\(r\)\) \{\s*summary\.push\("Stopped here: that step never reached the game[^"]*"\);\s*break;\s*\}\s*if \(unseen\(confirm\)\) \{\s*if \(\+\+unseenSteps >= 2\) \{\s*summary\.push\("Stopped here: 2 steps in a row had no frame of the screen to compare\."\);\s*break;\s*\}\s*\} else \{\s*unseenSteps = 0;\s*if \(confirm\.changed\) \{\s*noChangeStreak = 0;\s*\} else if \(\+\+noChangeStreak >= 2\) \{\s*summary\.push\("Stopped here: 2 steps in a row changed nothing on screen\."\);\s*break;\s*\}\s*\}/.test(sequence));
  const waits = [...tools.matchAll(/await waitChange\(/g)].length;
  const noted = [...tools.matchAll(/(?:const effect = )noteEffect\(/g)].length;
  check(`no wait after an action in executeTool is left out (${waits} waits, ${noted} noteEffect calls)`,
    waits === ACTION_TOOLS.length + 1 && noted === waits);
  check("inside executeTool only noteEffect keeps the count",
    [...tools.matchAll(/(noOpStreakRef|lastFailedMovesRef|lastActionNoOpRef|unknownEffectsRef)\.current(\s*=[^=]|\+\+|\.add|\.clear)/g)].length === 4);
  // The screen handler getting play going again with no plugin (a control
  // clicked that changed the screen, or the operator's "keep playing",
  // src/agent/stuckScreen.js) starts the count again, as a new game does.
  check("elsewhere only the solver's own moves, the blind pause, the resets at ▶ Start and each game, and play going again after the screen handler, touch it",
    count(/noOpStreakRef\.current\+\+/g) === 1 && count(/lastFailedMovesRef\.current\.add\(/g) === 1
      && count(/lastActionNoOpRef\.current = null;/g) === 3 && count(/lastActionNoOpRef\.current = /g) === 4
      && count(/unknownEffectsRef\.current = 0;/g) === 3 && count(/unknownEffectsRef\.current = /g) === 4
      && /if \((\w+)\.next === "play-on"\) \{[^}]*?noOpStreakRef\.current = 0;\s*lastFailedMovesRef\.current = new Set\(\);\s*lastActionNoOpRef\.current = null;[\s\S]{0,400}?continue;\s*\}/.test(code));
  check("the solver's dead key goes in the shared set as the model's press of it, so the two are one action",
    /lastFailedMovesRef\.current\.add\(move\.key \? actionSignature\("press_key", \{ key: move\.key \}\) : moveId\);/.test(code)
      && /solverBlockedRef\.current\.add\(moveId\);/.test(code));
  check("no tool result or nudge calls an action a direction, or blocked",
    !/direction is BLOCKED|DIFFERENT direction|directions all blocked|that direction|every direction is blocked/i.test(code));

  // backend() marks a request that got no answer; readReply marks the empty one.
  const request = between("async function backend(path, body = null", "\n}\n");
  check("backend() marks a request that got no answer as unreachable, for notSent",
    /catch \(e\) \{\s*if \(signal\?\.aborted\) throw e;\s*(?:\/\/[^\n]*\s*)*return \{ ok: false, error: e\.message, unreachable: true \};/.test(request)
      && /refused: refused\.kind \};/.test(request));

  const turn = between("const playModelTurn = useCallback(", "const agentTurn = useCallback(");
  check("the turn after an action that changed nothing is a vision turn, its image never skipped, and the model told what did nothing (and the log file too)",
    /const lastNoOp = lastActionNoOpRef\.current;\s*const isStrategyTurn = forced \|\| !!lastNoOp \|\| /.test(turn)
      && /const a1Skip = turnCountRef\.current > 1 && !!sinceLast && !sinceLast\.changed && !lastNoOp;/.test(turn)
      && turn.indexOf("const lastNoOp = ") < turn.indexOf("const a1Skip = ")
      && /if \(lastNoOp\) \{\s*const nudge = noOpNudge\(\{ lastNoOp, failed: lastFailedMovesRef\.current \}\);\s*actNudge = `\$\{nudge\} \$\{actNudge\}`;\s*addLog\(`Told the model: \$\{nudge\}`, "info", \{ fileOnly: true \}\);\s*\}/.test(turn));
  const loop = between("// ── Acting blind", "const thisGame = gameEnding(");
  check("the games loop stops a game as stuck by stuckVerdict, and reminds the model at 3 and 6, once each, in words that fit any game",
    /stuckVerdict\(\{ streak: noOps, distinct: distinctFailed \}\)/.test(loop)
      && /const noOps = noOpStreakRef\.current;\s*const distinctFailed = lastFailedMovesRef\.current\.size;/.test(loop)
      && /const reminder = noOpReminderDue\(noOps, noOpsReminded\);\s*noOpsReminded = reminder\.given;/.test(loop)
      && /if \(reminder\.remind\) \{\s*convRef\.current\.push\(\{ role: "user", content: noOpReminder\(\{ streak: noOps, failed: lastFailedMovesRef\.current \}\) \}\);/.test(loop)
      && !/noOps === 3 \|\| noOps === 6/.test(loop)
      && /let noOpsReminded = 0;/.test(code)
      // With no plugin the screen handler has its turn before the game is
      // called stuck (check-stuck.mjs); the stuck rule's reason stands unless
      // it says another.
      && /if \(exhausted \|\| hardStop\) \{\s*addLog\(stuckLine, "warn"\);/.test(loop)
      && /stuckReason = gameOutcome === "stuck" \? (\w+)\.stuckReason \?\? stuckBecause : null;/.test(loop));
  check("...and pauses play, before the stuck rule, after a run of actions whose effect is not known",
    /const blind = blindPause\(unknownEffectsRef\.current\);\s*if \(blind\) \{\s*unknownEffectsRef\.current = 0;\s*pauseRef\.current = true;\s*setPaused\(true\);\s*addLog\(blind, "error"\);\s*continue;\s*\}/.test(loop)
      && loop.indexOf("blindPause(") < loop.indexOf("stuckVerdict("));
  check("the page imports the count from src/agent/noops.js", /from "\.\/agent\/noops\.js";/.test(code));

  // SETUP.md tells the operator what to expect.
  const setup = fs.readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  check("SETUP.md says every action type counts, in the words the model and the log use",
    setup.includes("changed nothing on screen") && setup.includes("No moves available — ") && setup.includes("No-op ")
      && /Test 19/.test(setup) && setup.includes("Told the model: Your last action (")
      && setup.includes("That is N actions in a row counted as changing nothing.")
      && setup.includes("changed nothing where it acted")
      && setup.includes(no.blindPause(no.BLIND_PAUSE).split(" (")[0])
      && !/next turn's message starts/.test(setup));
}

console.log(`\n${failures ? `${failures} FAILED` : "all no-op checks passed"}`);
process.exit(failures ? 1 : 0);
