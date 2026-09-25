#!/usr/bin/env node
// Check the snapshots a run leaves behind: a frame and its text, written under
// logs/snapshots/<session>/.
//
//   node tools/check-snapshots.mjs
//
// Snapshots were taken only on the plugin paths, from the solver's own capture,
// so a game with no plugin (the case the agent exists for) left no frame at
// all, only log lines. This checks, against src/agent/snapshots.js and the code
// that uses it:
//   - a game's allowance of SNAPSHOTS_PER_GAME, with how a game ended (the
//     plugin's game-over and gave-up, the model's stuck and game-end) exempt
//   - the frame saved: the canvas given, else the solver's capture when this
//     run drew one, else the frame last sent to the model, saved as sent (a
//     JPEG, tagged lowres), else none
//   - the text holds the model's last reply whole: see, plan, text and actions
//   - the 3rd and 6th action in a row that changed nothing are saved once each,
//     however the streak got there (noOpSnapshot)
//   - snapshot() in GameAgent.jsx sends what prepareSnapshot builds, says once
//     a run when the backend wrote the text but dropped the frame (a backend
//     not restarted since), and the games loop takes one, with no plugin, on
//     the first turn of each game, at the 3rd and 6th no-op, at every pause for
//     a model that stopped answering, when play stops as stuck, and when the
//     model ends the game
//   - a game's snapshots and allowance start as the game before it is recorded,
//     so the restart between two games counts toward the game it starts
//   - the backend takes the JPEG, and SETUP.md says where it all goes
// The backend's side (the .jpg, the log folder's budget) is in
// tools/check_backend.py.

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { transform } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const sn = await import(pathToFileURL(path.join(ROOT, "src", "agent", "snapshots.js")).href);
const { SNAPSHOT_MAX_BYTES } = await import(pathToFileURL(path.join(ROOT, "src", "agent", "backend.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const show = v => JSON.stringify(v);
// Each case is [label, got, test(got)]; the check names the cases that failed.
const cases = (name, list) => {
  const bad = list.filter(([, got, test]) => !test(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check(name, !bad.length, bad.join("; "));
};

// A canvas as snapshot() sees one: only its size is read here, and the page's
// snapshotPng (passed in as encodePng) is the only thing that draws it.
const canvas = (width, height, label = "canvas") => ({ width, height, label });
const encoded = [];
const encodePng = (c, text) => { encoded.push({ canvas: c.label, text }); return { png: `PNG(${c.label})`, halvings: 0 }; };
const modelFrame = { data: "/9j/SENT", width: 1280, height: 720, turn: 7, grid: true, crop: false };

// ── The allowance ─────────────────────────────────────────────────────────────
console.log("the allowance");
{
  check("six a game, as before", sn.SNAPSHOTS_PER_GAME === 6, show(sn.SNAPSHOTS_PER_GAME));
  check("how a game ended is exempt: the plugin's game-over and gave-up, the model's stuck and game-end",
    ["game-over", "gave-up", "stuck", "game-end"].every(sn.isEnding) && sn.ENDING_TAGS.length === 4,
    show(sn.ENDING_TAGS));
  cases("the rest count toward it", [
    ["first-turn", sn.isEnding("first-turn"), v => v === false],
    ["no-op-3", sn.isEnding("no-op-3"), v => v === false],
    ["model-unreachable", sn.isEnding("model-unreachable"), v => v === false],
    ["the solver's read-clash", sn.isEnding("read-clash"), v => v === false],
    ["the solver's unreadable", sn.isEnding("unreadable"), v => v === false],
    ["the solver's guess", sn.isEnding("guess"), v => v === false],
  ]);

  let taken = 0;
  const kept = [];
  for (const tag of ["first-turn", "no-op-3", "model-unreachable", "no-op-6", "guess", "read-clash", "unreadable", "no-op-3"]) {
    const shot = sn.prepareSnapshot({ tag, modelFrame, taken, encodePng });
    if (shot) { kept.push(tag); taken = shot.taken; }
  }
  check("the first six are taken and counted, and the rest of the game gets none",
    kept.length === 6 && taken === 6, show({ kept, taken }));
  const endings = ["stuck", "game-end", "game-over", "gave-up"].map(tag => sn.prepareSnapshot({ tag, modelFrame, taken, encodePng }));
  check("an ending is still taken once the allowance is used up, and does not count",
    endings.every(s => s && s.taken === 6), show(endings.map(s => s?.taken)));
  // The screen handler's decisions (src/agent/stuckScreen.js) measure the
  // control finder, so they do not use up the game's allowance.
  const decisions = ["decision-ask", "decision-click", "claim-rejected"].map(tag => sn.prepareSnapshot({ tag, modelFrame, taken, encodePng }));
  check("the screen handler's decisions are taken once the allowance is used up, and do not count toward it",
    sn.DECISION_TAGS.length === 3 && decisions.every(s => s && s.taken === 6 && s.decisions === 1)
      && !sn.DECISION_TAGS.some(sn.isEnding) && !sn.ENDING_TAGS.some(sn.isDecision),
    show(decisions.map(s => [s?.taken, s?.decisions])));
  // They have an allowance of their own: with a plugin, a "Keep going" that
  // does not close 2048's overlay would otherwise ask and click, and save both,
  // on every pass.
  let decided = 0;
  const cycle = [];
  for (let i = 0; i < sn.DECISION_SNAPSHOTS_PER_GAME + 4; i++) {
    const shot = sn.prepareSnapshot({ tag: i % 2 ? "decision-click" : "decision-ask", modelFrame, taken: 0, decisions: decided, encodePng });
    cycle.push(!!shot);
    if (shot) decided = shot.decisions;
  }
  check(`the screen handler's decisions stop after ${sn.DECISION_SNAPSHOTS_PER_GAME} a game, and leave the game's allowance alone`,
    decided === sn.DECISION_SNAPSHOTS_PER_GAME && cycle.filter(Boolean).length === sn.DECISION_SNAPSHOTS_PER_GAME
      && sn.prepareSnapshot({ tag: "first-turn", modelFrame, taken: 0, decisions: decided, encodePng })?.taken === 1
      && sn.prepareSnapshot({ tag: "stuck", modelFrame, taken: 6, decisions: decided, encodePng }) !== null,
    show({ decided, cycle }));
}

// ── Which frame ───────────────────────────────────────────────────────────────
console.log("which frame");
{
  const given = canvas(800, 600, "given"), solver = canvas(4000, 2250, "solver"), empty = canvas(0, 0, "empty");
  cases("the canvas given, else the solver's capture, else the model's frame, else none", [
    ["a canvas given", sn.snapshotFrame({ canvas: given, solverCanvas: solver, modelFrame }), c => c.kind === "canvas" && c.canvas === given],
    ["an empty canvas given", sn.snapshotFrame({ canvas: empty, solverCanvas: solver, modelFrame }), c => c.kind === "solver"],
    ["the solver's capture", sn.snapshotFrame({ solverCanvas: solver, modelFrame }), c => c.kind === "solver" && c.canvas === solver],
    ["a solver canvas emptied at Start", sn.snapshotFrame({ solverCanvas: empty, modelFrame }), c => c.kind === "model" && c.frame === modelFrame],
    ["a canvas never drawn at all (height 0)", sn.snapshotFrame({ solverCanvas: canvas(300, 0), modelFrame }), c => c.kind === "model"],
    ["nothing captured yet", sn.snapshotFrame({ solverCanvas: empty, modelFrame: null }), c => c.kind === "none"],
    ["a model frame with no data", sn.snapshotFrame({ modelFrame: { width: 1 } }), c => c.kind === "none"],
  ]);
  cases("only the model's frame is tagged lowres", [
    ["model", sn.snapshotTag("no-op-3", { kind: "model" }), t => t === "no-op-3-lowres"],
    ["solver", sn.snapshotTag("game-over", { kind: "solver" }), t => t === "game-over"],
    ["none", sn.snapshotTag("stuck", { kind: "none" }), t => t === "stuck"],
  ]);
  const note = sn.frameNote({ kind: "model", frame: { ...modelFrame, crop: true } });
  check("the model's frame says what it is: lowres, its size, the turn it was sent with, the crop and the grid",
    note.includes("lowres") && note.includes("1280×720") && note.includes("turn 7") && note.includes("cropped")
      && note.includes("click grid") && /not a full-resolution capture/i.test(note), note);
  check("no frame says so", /No frame/.test(sn.frameNote({ kind: "none" })) && sn.frameNote({ kind: "solver" }) === null);
}

// ── The model's reply, whole ──────────────────────────────────────────────────
console.log("the model's reply");
{
  const long = "a long look at the board ".repeat(400); // 10,000 characters: the screen cuts at 224
  const jsonText = `{"see":${JSON.stringify(long)},"plan":"merge the 2s","tool":"press_key","input":{"key":"left"}}`;
  const json = sn.modelReply({ turn: 12, see: long, plan: "merge the 2s", text: jsonText,
    actions: [{ tool: "press_key", input: { key: "left" }, see: long, plan: "merge the 2s", score: 40 }] });
  check("JSON-action mode: turn, see, plan, the raw text, and each action's tool and input",
    json.turn === 12 && json.see === long && json.plan === "merge the 2s" && json.text === jsonText
      && show(json.actions) === show([{ tool: "press_key", input: { key: "left" } }]), show({ ...json, see: json.see?.length, text: json.text?.length }));
  const tools = sn.modelReply({ turn: 3, text: "The board has a 2 in the corner.",
    actions: [{ tool: "analyse_game_state", input: { analysis: long } }, { tool: "click", input: { x: 10, y: 20 } }] });
  check("tool calls: the text, and every call with its whole input (analyse_game_state's analysis included)",
    tools.see === null && tools.plan === null && tools.actions.length === 2 && tools.actions[0].input.analysis === long);
  const text = sn.snapshotText("3 actions in a row changed nothing.", json);
  check("the text holds the heading, then see, plan, text and actions, none of them cut short",
    text.startsWith("3 actions in a row changed nothing.\n\nThe model's last reply (turn 12):")
      && text.includes(`See: ${long}`) && text.includes("Plan: merge the 2s") && text.includes(`Text:\n${jsonText}`)
      && text.includes('Actions:\n  press_key {"key":"left"}') && !text.includes("…"),
    text.slice(0, 200));
  cases("a reply with nothing in it, and none at all", [
    ["no actions", sn.snapshotText("h", sn.modelReply({ turn: 1, text: "thinking" })), t => t.includes("Actions: none") && t.includes("Text:\nthinking")],
    ["blank see and plan", sn.modelReply({ see: "  ", plan: "" }), r => r.see === null && r.plan === null && r.turn === null],
    ["no reply yet", sn.snapshotText("h", null), t => t === "h\n\nNo reply from the model yet this run."],
    ["an action with no tool", sn.modelReply({ actions: [null, { input: {} }, { name: "click", input: { x: 1 } }] }).actions,
      a => show(a) === show([{ tool: "click", input: { x: 1 } }])],
  ]);
  // A game's streak after each turn, and the no-op snapshots those turns take.
  const noOpShots = streaks => {
    let saved = 0;
    return streaks.map(noOps => { const shot = sn.noOpSnapshot(noOps, saved); saved = shot.saved; return shot.take; })
      .filter(Boolean);
  };
  check("no-op snapshots are taken at 3 and 6 in a row", show(sn.NO_OP_SNAPSHOTS) === show([3, 6]));
  cases("each once a streak, however it got there", [
    ["one key a turn", noOpShots([1, 2, 3, 4, 5, 6, 7]), t => show(t) === show([3, 6])],
    ["turns that press no key leave it at 3", noOpShots([1, 2, 3, 3, 3, 3, 4]), t => show(t) === show([3])],
    ["two keys in one reply, past 3", noOpShots([2, 4, 5]), t => show(t) === show([3])],
    ["past 6", noOpShots([3, 5, 7]), t => show(t) === show([3, 6])],
    ["past both at once: the higher, once", noOpShots([2, 7, 8]), t => show(t) === show([6])],
    ["a move that works starts a new streak", noOpShots([3, 0, 1, 2, 3]), t => show(t) === show([3, 3])],
    ["broken and past 3 again within one turn", noOpShots([6, 4]), t => show(t) === show([6, 3])],
    ["nothing below 3", noOpShots([0, 1, 2, 1, 2]), t => !t.length],
  ]);
  cases("the game-end heading names the outcome, the score and the model's reason", [
    ["all three", sn.gameEndHeading({ outcome: "lost", finalScore: 1200, reason: "no moves left" }),
      h => h === "The model ended the game: lost, score 1200. Its reason: no moves left."],
    ["a score of 0", sn.gameEndHeading({ outcome: "won", finalScore: 0 }), h => h === "The model ended the game: won, score 0."],
    ["nothing but the outcome", sn.gameEndHeading({ outcome: "stuck" }), h => h === "The model ended the game: stuck."],
  ]);
}

// ── What snapshot() sends ─────────────────────────────────────────────────────
console.log("what is sent");
{
  encoded.length = 0;
  const reply = sn.modelReply({ turn: 7, see: "a board", plan: "go left", text: "{}", actions: [{ tool: "press_key", input: { key: "left" } }] });
  const words = sn.snapshotText("Game 1, first turn.", reply);
  const model = sn.prepareSnapshot({ tag: "first-turn", text: words, solverCanvas: canvas(0, 0), modelFrame, taken: 0, encodePng });
  check("with no plugin: the model's JPEG as sent, tagged lowres, and the text with the frame's note after it",
    model.frame === "model" && model.body.jpeg === modelFrame.data && model.body.png === null
      && model.body.tag === "first-turn-lowres" && model.body.text.startsWith(words)
      && model.body.text.endsWith(sn.frameNote({ kind: "model", frame: modelFrame })) && model.taken === 1
      && !encoded.length && !model.warnings.length,
    show({ ...model.body, text: model.body.text.slice(-120) }));

  const board = "Board as read:\n. . 1\n. 2 F";
  const solver = sn.prepareSnapshot({ tag: "unreadable", text: board, solverCanvas: canvas(4000, 2250, "solver"), modelFrame, taken: 2, encodePng });
  check("with a plugin: the solver's capture as a PNG, the tag and text exactly as the solver wrote them",
    solver.frame === "solver" && solver.body.png === "PNG(solver)" && !("jpeg" in solver.body)
      && solver.body.tag === "unreadable" && solver.body.text === board && solver.taken === 3
      && show(encoded) === show([{ canvas: "solver", text: board }]),
    show({ body: solver.body, encoded }));

  const none = sn.prepareSnapshot({ tag: "model-unreachable", text: "no answer", taken: 0, encodePng });
  check("nothing captured yet: the text alone, saying there is no frame",
    none.frame === "none" && none.body.png === null && !("jpeg" in none.body) && /No frame/.test(none.body.text), show(none));

  const huge = { ...modelFrame, data: "A".repeat(Math.ceil(SNAPSHOT_MAX_BYTES / 3) * 4 + 4) };
  const big = sn.prepareSnapshot({ tag: "no-op-6", text: "x", modelFrame: huge, taken: 0, encodePng });
  check("a model frame over the backend's limit is left out, and the log says so",
    !("jpeg" in big.body) && big.body.text && big.warnings.length === 1 && /too large/.test(big.warnings[0]), show(big.warnings));

  const halved = sn.prepareSnapshot({ tag: "guess", text: "t", solverCanvas: canvas(4000, 2250), taken: 0,
    encodePng: () => ({ png: "PNG", halvings: 2 }) });
  const lost = sn.prepareSnapshot({ tag: "guess", text: "t", solverCanvas: canvas(4000, 2250), taken: 0,
    encodePng: () => ({ png: null, halvings: 4 }) });
  const tainted = sn.prepareSnapshot({ tag: "guess", text: "t", solverCanvas: canvas(4000, 2250), taken: 0,
    encodePng: () => { throw new Error("tainted"); } });
  cases("a backend that wrote the text but not the model's frame is caught (one not restarted since)", [
    ["the .jpg dropped", sn.frameDropped(model.body, ["s/101010-first-turn-lowres.txt"]), v => v === true],
    ["the .jpg written", sn.frameDropped(model.body, ["s/101010-first-turn-lowres.jpg", "s/101010-first-turn-lowres.txt"]), v => v === false],
    ["a PNG sent, which every backend takes", sn.frameDropped(solver.body, ["s/101010-unreadable.txt"]), v => v === false],
    ["no frame sent", sn.frameDropped(none.body, ["s/101010-model-unreachable.txt"]), v => v === false],
    ["no files said", sn.frameDropped(model.body, undefined), v => v === false],
  ]);
  check("and the log says what to do about it", /start\.bat/.test(sn.FRAME_DROPPED_WARNING) && /frame/.test(sn.FRAME_DROPPED_WARNING));

  cases("a PNG too large is saved smaller, or left out, as before; a canvas that cannot be read leaves the text", [
    ["halved", halved.warnings, w => show(w) === show(["📷 The frame was too large to save whole; saving it at 1/4 size."])],
    ["lost", lost.warnings, w => show(w) === show(["📷 The frame was too large to save even at 1/16 size; saving the text only."])],
    ["tainted", tainted.body, b => b.png === null && b.text === "t"],
  ]);
}

// ── The page uses it ──────────────────────────────────────────────────────────
console.log("the page");
{
  const source = fs.readFileSync(path.join(ROOT, "src", "GameAgent.jsx"), "utf8");
  // Comments removed, so only code is matched.
  const { code } = await transform(source, { loader: "jsx", jsx: "automatic" });
  const count = pattern => [...code.matchAll(pattern)].length;
  const once = (name, pattern, want = 1) => {
    const found = count(pattern);
    check(name, found === want, found ? `found ${found}, wanted ${want} — has the page changed shape?` : "not found — has the page changed shape?");
  };
  const from = (a, b) => {
    const i = code.indexOf(a);
    const j = i < 0 ? -1 : code.indexOf(b, i + a.length);
    return i < 0 || j < 0 ? "" : code.slice(i, j);
  };

  once("snapshot() takes a canvas, and sends what prepareSnapshot builds from the solver's capture, the model's frame and this game's count",
    /const snapshot = useCallback\(async \(tag, text, canvas = null\) => \{\s*const (\w+) = prepareSnapshot\(\{\s*tag,\s*text,\s*canvas,\s*solverCanvas: solverCanvasRef\.current,\s*modelFrame: modelFrameRef\.current,\s*taken: snapshotsRef\.current,\s*decisions: decisionSnapshotsRef\.current,\s*encodePng: snapshotPng\s*\}\);\s*if \(!\1\) return;\s*snapshotsRef\.current = \1\.taken;\s*decisionSnapshotsRef\.current = \1\.decisions;[\s\S]{0,200}?backend\("\/log\/snapshot", \{ session: logSessionRef\.current, \.\.\.\1\.body \}\)/g);
  // The screen handler's decisions have an allowance of their own
  // (DECISION_SNAPSHOTS_PER_GAME), kept the same way.
  check("the allowances are counted in one place only (prepareSnapshot)",
    count(/\bsnapshotsRef\.current = /g) === 2 && /\bsnapshotsRef\.current = 0;/.test(code) && !/snapshotsRef\.current(\+\+| >=)/.test(code)
      && count(/decisionSnapshotsRef\.current = /g) === 2 && /decisionSnapshotsRef\.current = 0;/.test(code),
    "snapshotsRef or decisionSnapshotsRef is counted somewhere else too");
  const snap = from("const snapshot = useCallback(", "const addAction = useCallback(");
  check("a frame the backend dropped is said once a run, and ▶ Start clears that",
    /if \(frameDropped\((\w+)\.body, res\.files\) && !frameDroppedSaidRef\.current\) \{\s*frameDroppedSaidRef\.current = true;\s*addLog\(FRAME_DROPPED_WARNING, "warn"\);\s*\}/.test(snap)
      && count(/frameDroppedSaidRef\.current = /g) === 2
      && /frameDroppedSaidRef\.current = false;/.test(from("const startAgent = useCallback(", "runResearch(")));

  const turn = from("const playModelTurn = useCallback(", "const agentTurn = useCallback(");
  const frameAt = turn.search(/if \(sendImage\) \{\s*modelFrameRef\.current = \{\s*data: frame\.data,\s*width: frame\.imgW,\s*height: frame\.imgH,\s*turn: turnCountRef\.current,/);
  check("each turn keeps the frame it sends the model, before the request, so a turn that fails has it too",
    frameAt > 0 && frameAt < turn.indexOf("await callAI("), "modelFrameRef is not set where the image goes into the turn");
  check("each turn keeps the model's reply, in JSON-action mode and with tool calls",
    /lastReplyRef\.current = modelReply\(\{ turn: turnCountRef\.current, see: (\w+)\?\.see, plan: \1\?\.plan, text, actions: \w+ \}\);/.test(turn)
      && /lastReplyRef\.current = modelReply\(\{\s*turn: turnCountRef\.current,\s*text: \(resp\.content \?\? \[\]\)\.filter\(\(c\) => c\.type === "text"\)\.map\(\(c\) => c\.text\)\.join\("\\n"\),\s*actions: (\w+)\.map\(\((\w+)\) => \(\{ tool: \2\.name, input: \2\.input \}\)\)\s*\}\);/.test(turn),
    "expected two lastReplyRef.current = modelReply(...) in playModelTurn");
  check("nothing else sets them", count(/modelFrameRef\.current = /g) === 2 && count(/lastReplyRef\.current = /g) === 3);

  const start = from("const startAgent = useCallback(", "// Main play loop") || from("const startAgent = useCallback(", "setPhase(\"playing\")");
  check("▶ Start empties the model's frame and reply, and the solver's canvas, before anything plays",
    /modelFrameRef\.current = null;\s*lastReplyRef\.current = null;\s*if \(solverCanvasRef\.current\) \{\s*solverCanvasRef\.current\.width = 0;\s*solverCanvasRef\.current\.height = 0;\s*\}/.test(start)
      && start.indexOf("modelFrameRef.current = null;") > start.indexOf("stopRef.current = false;")
      && start.indexOf("modelFrameRef.current = null;") < start.indexOf("runResearch("),
    "the reset is not in startAgent's reset, before research");

  const loop = from("const session = { outage: null, abortReason: null };", "const thisGame = gameEnding(");
  // `canvas`: the screen handler's frame, with the controls it found outlined
  // (src/agent/stuckScreen.js), saved in place of the model's when given.
  once("with no plugin only, a snapshot on the model's path saves the model's last reply under a heading",
    /const modelPlays = !activePlugin;\s*const snapModel = \(tag, heading, canvas = null\) => modelPlays \? snapshot\(tag, snapshotText\(heading, lastReplyRef\.current\), canvas\) : null;/g);
  check("a pause for a model that stopped answering is saved before the wait",
    /const waitForTheModel = async \(outage, lastError\) => \{\s*await snapModel\(\s*"model-unreachable",[\s\S]{0,300}?\);\s*return waitForModel\(apiKey, outage, lastError\);\s*\};/.test(loop));
  check("the model ending the game is saved, with its outcome, score and reason, and how its claim was taken",
    /if \(turn\.loop === "end-game"\) \{[\s\S]{0,400}?await snapModel\(\s*"game-end",\s*gameEndHeading\(\{ \.\.\.turn, reason: gameEndRef\.current\?\.reason \}\) \+ claimTaken\(claimSeen\),\s*claimSeen\?\.decision\?\.canvas\s*\);\s*break;\s*\}/.test(loop));
  check("a claim that the game is over, turned down, is saved with the controls found",
    /await snapModel\(\s*"claim-rejected",\s*decisionText\([\s\S]{0,200}?\),\s*(\w+)\?\.canvas\s*\);/.test(loop));
  check("the first turn of each game that got through is saved once",
    /let firstTurnSnapped = false;/.test(loop)
      && /if \(turn\.loop !== "play"\) break;\s*if \(!firstTurnSnapped\) \{\s*firstTurnSnapped = true;\s*await snapModel\("first-turn", /.test(loop));
  check("the 3rd and 6th action in a row that changed nothing are saved once each (noOpSnapshot), after the stuck check",
    /let noOpsSnapped = 0;/.test(loop)
      && /const (\w+) = noOpSnapshot\(noOps, noOpsSnapped\);\s*noOpsSnapped = \1\.saved;\s*if \(\1\.take\) \{\s*await snapModel\(`no-op-\$\{\1\.take\}`, [\s\S]{0,300}?\);\s*\}\s*\}/.test(loop)
      && loop.indexOf('await snapModel("stuck"') > 0 && loop.indexOf('await snapModel("stuck"') < loop.indexOf("noOpSnapshot(noOps"));
  // With no plugin the screen handler has its turn first (faceStuckScreen), and
  // only a game it did not get going again is saved as stuck.
  check("play stopping as stuck is saved, before it leaves the game",
    /if \(exhausted \|\| hardStop\) \{[\s\S]{0,1200}?gameOutcome = (\w+)\.outcome;[\s\S]{0,500}?await snapModel\(\s*"stuck",\s*`Stuck: \$\{stuckBecause\}[^`]*`\s*\);\s*break;\s*\}/.test(loop));
  once("those are all the model-path snapshots", /\bsnapModel\(/g, 6);

  // The restart between two games (restartGame) can pause for the model, and
  // that snapshot is the next game's: it is in its record and its count.
  const games = from("const session = { outage: null, abortReason: null };", 'finalOutcome = "aborted";');
  const resetAt = games.search(/const newGameSnapshots = \(\) => \{\s*gameSnapshotsRef\.current = \[\];\s*snapshotsRef\.current = 0;\s*decisionSnapshotsRef\.current = 0;\s*\};\s*newGameSnapshots\(\);/);
  check("a game's snapshots start before the games loop, and again as soon as the game before is recorded",
    resetAt > 0 && resetAt < games.indexOf("for (let gameIdx = 0;")
      && /queueRecord\("game", gameRecord\(\{[\s\S]*?snapshots: gameSnapshotsRef\.current,[\s\S]*?\}\)\);\s*newGameSnapshots\(\);/.test(games)
      && games.indexOf("newGameSnapshots();", games.indexOf('queueRecord("game"')) < games.indexOf("await restartGame()", games.indexOf('queueRecord("game"'))
      && count(/newGameSnapshots\(\)/g) === 2 && count(/gameSnapshotsRef\.current = /g) === 1,
    "gameSnapshotsRef and snapshotsRef are not reset where the restart's snapshots count toward the next game");

  // Every tag the page names: endings are exempt from the allowance, so only
  // the ending tags may be ENDING_TAGS, and every ending must be one.
  const tags = [...code.matchAll(/\b(?:snapshot|snapModel|snap)\(\s*(?:"([^"]+)"|`([^`$]+)\$)/g)].map(m => m[1] ?? m[2]);
  const endingsUsed = tags.filter(sn.isEnding).sort();
  check("the endings the page saves are the exempt ones, and nothing else is",
    show(endingsUsed) === show(["game-end", "game-over", "gave-up", "stuck"]) && tags.includes("first-turn")
      && tags.includes("no-op-") && tags.includes("model-unreachable"),
    show(tags));
  // The screen handler's decisions are exempt too (DECISION_TAGS), and are
  // exactly the ones it saves: asking, clicking, and a claim turned down.
  const decisionsUsed = tags.filter(sn.isDecision).sort();
  check("the screen handler's decisions the page saves are the exempt ones",
    show(decisionsUsed) === show([...sn.DECISION_TAGS].sort()), show(tags));
}

// ── The backend and the docs ──────────────────────────────────────────────────
console.log("the backend and the docs");
{
  const server = fs.readFileSync(path.join(ROOT, "agent_server.py"), "utf8");
  check("the backend takes the model's frame as a JPEG and writes it as .jpg",
    /class Snapshot\(BaseModel\):[\s\S]{0,300}?\n\s+jpeg: Optional\[str\] = None/.test(server)
      && /\(b\.jpeg, "jpg"\)/.test(server));
  const budgetMb = Number(server.match(/^LOG_BUDGET_DEFAULT_MB\s*=\s*(\d+)\s*$/m)?.[1]);
  const envName = server.match(/^LOG_BUDGET_ENV\s*=\s*"([^"]+)"\s*$/m)?.[1];
  check("the backend keeps the log folder within a budget: AGENT_LOG_BUDGET_MB, 2048 MB by default",
    budgetMb === 2048 && envName === "AGENT_LOG_BUDGET_MB", show({ budgetMb, envName }));
  const setup = fs.readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  check("SETUP.md says where snapshots go, which are the model's (lowres, .jpg), and how the log folder is bounded",
    setup.includes("logs/snapshots/<session>/") && setup.includes("lowres") && setup.includes(envName ?? "AGENT_LOG_BUDGET_MB")
      && setup.includes(`${budgetMb} MB`));
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
