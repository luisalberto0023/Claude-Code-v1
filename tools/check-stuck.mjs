#!/usr/bin/env node
// Check what the agent does when play stops, with or without a plugin.
//
//   node tools/check-stuck.mjs
//
// The screen handler (analyseStuckScreen, resolveDecision in GameAgent.jsx)
// measures the controls on a stuck screen from pixels and asks the model only
// what each one is. It ran only when a plugin was playing, so a game with no
// plugin met every game-over panel with "try something else" until it was
// called stuck, and the model's word that a game was over ended it, right or
// wrong. Its click divided by the frame's scale and dropped the offsets, and
// its timeout fell back to "keep-going", which no control on an unknown screen
// is called. This checks, against src/vision/frameMap.js,
// src/agent/stuckScreen.js and the code that uses them:
//   - one frame-to-screen rule (multiply by the scale, add the offsets) through
//     capture, crop and shrink, for a browser share and a native window; the
//     old option click misses on a scaled or cropped frame
//   - where controls are looked for: with no plugin, only a frame cropped to
//     the game, and with no crop, nowhere (the operator is asked); on a
//     synthetic screen the real control finder (src/vision/buttons.js) finds the
//     browser's own buttons in the whole frame and only the game's in the crop,
//     and each is clicked on the right screen point
//   - which controls appeared during the game (a "Try again" over the board)
//     and which were there all along ("New Game" above it), from the page's
//     motion maps at another scale
//   - the decision: what a control is (a sign-in, download, payment or
//     online-play control is refused: never clicked, recommended or fallen back
//     to by the agent, and the operator is asked), when the operator is asked
//     (needsHuman no longer always true or false; with no plugin, also when the
//     control it would click is not known to restart, go on or carry on), what
//     nobody answering picks (the recommended option's own id), and what the
//     games loop does after it
//   - the model's claim that the game is over: a "stuck" report taken as it is
//     (the standing screen rule's way out); others taken on a control whose
//     words end a game and that appeared, or once nothing responds; otherwise
//     turned down, dropped once the model's moves change the screen, and the
//     third turned down in a row ends the game as stuck. What the model is told
//     quotes no label read off the screen
//   - the page's wiring: every click the page works out goes through toScreen,
//     the handler runs from the no-plugin stuck branch before it ends a game,
//     claims are weighed there, the dialog times out to fallbackChoice, and
//     every ask and click is snapshotted; the dialog renders with its choices
//   - SETUP.md and CLAUDE.md say so

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { transform } from "esbuild";
import { createCanvas } from "./fake-canvas.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const fm = await import(src("vision", "frameMap.js"));
const st = await import(src("agent", "stuckScreen.js"));
const mo = await import(src("vision", "motion.js"));
const sn = await import(src("agent", "snapshots.js"));
const { SCREEN_RULE } = await import(src("agent", "prompts.js"));
const { findClickableCandidates } = await import(src("vision", "buttons.js"));

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
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const inside = (p, r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

// ── One rule from a frame to the screen ───────────────────────────────────────
console.log("from a frame to the screen (src/vision/frameMap.js)");
{
  cases("a scale that is missing or not above 0 counts as 1, and missing offsets as 0", [
    ["null", fm.scaleOf(null), s => s.scale === 1 && s.offsetX === 0 && s.offsetY === 0],
    ["scale 0", fm.scaleOf({ scale: 0, offsetX: 5 }), s => s.scale === 1 && s.offsetX === 5],
    ["scale -2", fm.scaleOf({ scale: -2 }), s => s.scale === 1],
    ["scale NaN", fm.scaleOf({ scale: NaN, offsetY: 7 }), s => s.scale === 1 && s.offsetY === 7],
    ["scale 2.5", fm.scaleOf({ scale: 2.5, offsetX: 10, offsetY: 20 }), s => s.scale === 2.5 && s.offsetX === 10],
  ]);
  cases("toScreen multiplies by the scale, then adds the offsets, in whole pixels; toFrame undoes it", [
    ["scale 2, offsets 10,20", fm.toScreen({ x: 100, y: 50 }, { scale: 2, offsetX: 10, offsetY: 20 }), p => p.x === 210 && p.y === 120],
    ["scale 1, no offsets", fm.toScreen({ x: 33, y: 44 }, { scale: 1 }), p => p.x === 33 && p.y === 44],
    ["rounded", fm.toScreen({ x: 10.4, y: 10.6 }, { scale: 1.5 }), p => p.x === 16 && p.y === 16],
    ["undone", fm.toFrame(fm.toScreen({ x: 123, y: 77 }, { scale: 1.25, offsetX: 300, offsetY: 200 }), { scale: 1.25, offsetX: 300, offsetY: 200 }),
      p => near(p.x, 123, 0.5) && near(p.y, 77, 0.5)],
  ]);

  // A 2560×1440 screen shared by the browser, drawn 1280 wide (scale 2), cut
  // to the game by the crop (left 10%, top 20%, right 30%, bottom 10%), then
  // shrunk to a local model's 512 px.
  const captured = fm.capturedScale({ realW: 2560, realH: 1440, imgW: 1280, imgH: 720 });
  const box = fm.cropBox(1280, 720, { left: 10, top: 20, right: 30, bottom: 10 });
  const cropped = fm.croppedScale(captured, box);
  const shrunk = fm.shrunkScale(cropped, 512, Math.round(box.height * 512 / box.width));
  cases("capture, crop and shrink keep one scale: the crop moves the offsets, the shrink the scale", [
    ["captured", captured, s => s.scale === 2 && s.offsetX === 0 && s.offsetY === 0],
    ["the crop's box", box, b => b.left === 128 && b.top === 144 && b.width === 768 && b.height === 504],
    ["cropped", cropped, s => s.scale === 2 && s.offsetX === 256 && s.offsetY === 288 && s.realW === 1536],
    ["shrunk", shrunk, s => s.scale === 3 && s.offsetX === 256 && s.offsetY === 288],
  ]);
  // The point at (100, 50) of the 512-px frame is at 3× that, past the crop's
  // corner at (256, 288) on the screen.
  const point = { x: 100, y: 50 };
  const right = fm.toScreen(point, shrunk);
  check("a point of the shrunk, cropped frame lands where it is on the screen",
    right.x === 256 + 300 && right.y === 288 + 150, show(right));
  // The decision dialog's option used to be clicked at its point divided by
  // the scale, with the offsets dropped.
  const old = { x: Math.round(point.x / (shrunk.scale || 1)), y: Math.round(point.y / (shrunk.scale || 1)) };
  check("the old option click (divide by the scale, drop the offsets) lands elsewhere on that frame",
    Math.hypot(old.x - right.x, old.y - right.y) > 400, show({ old, right }));
  // Native capture of a window at (300, 200), 1600×900, sent 1280 wide.
  const native = fm.capturedScale({ realW: 1600, realH: 900, imgW: 1280, imgH: 720, offsetX: 300, offsetY: 200 });
  const nativeCrop = fm.croppedScale(native, fm.cropBox(1280, 720, { left: 25, top: 10 }));
  cases("native capture of a window: the window's corner is the frame's offset, and the crop adds to it", [
    ["the window", fm.toScreen({ x: 0, y: 0 }, native), p => p.x === 300 && p.y === 200],
    ["its far corner", fm.toScreen({ x: 1280, y: 720 }, native), p => p.x === 1900 && p.y === 1100],
    ["cropped", fm.toScreen({ x: 0, y: 0 }, nativeCrop), p => p.x === 300 + 400 && p.y === 200 + 90],
  ]);
  cases("a crop that leaves less than 16 px, or cuts nothing, is not applied", [
    ["too much", fm.cropBox(100, 100, { left: 50, right: 45 }), b => b === null],
    ["nothing", fm.cropBox(100, 100, {}), b => b === null],
    ["null margins", fm.cropBox(100, 100, null), b => b === null],
  ]);
  const b = fm.mapBox({ x: 100, y: 40, w: 60, h: 20 }, cropped, shrunk);
  const back = fm.mapBox(b, shrunk, cropped);
  check("a box moves between two frames of the same screen through the screen, and back",
    near(b.x, 100 * 2 / 3, 1e-9) && near(b.w, 40, 1e-9) && near(back.x, 100, 1e-9) && near(back.h, 20, 1e-9), show({ b, back }));
}

// ── A synthetic screen: a browser, a game, and a game over ────────────────────
// The browser's toolbar has buttons of its own (tabs, a sign-in), as a real one
// does; the game has "New Game" above its board all the time, and "Try again"
// over the board once it is over. Buttons are a solid fill with a label drawn
// on them, which is what the control finder looks for.
const W = 1600, H = 900;
const PANEL = { x: 400, y: 150, w: 800, h: 700 };      // the game, what the crop keeps
const NEW_GAME = { x: 1000, y: 180, w: 160, h: 50 };
const TRY_AGAIN = { x: 725, y: 520, w: 150, h: 50 };
const TOOLBAR = [{ x: 20, y: 25, w: 150, h: 40 }, { x: 190, y: 25, w: 150, h: 40 }, { x: 1420, y: 25, w: 150, h: 40 }];
const CROP = { left: 25, right: 25, top: 150 / 9, bottom: 50 / 9 };

function button(c, r, fill, ink = [255, 255, 255]) {
  c.rect(r.x, r.y, r.w, r.h, fill);
  const bw = Math.round(r.w * 0.18), bh = Math.round(r.h * 0.32);
  for (let i = 0; i < 3; i++) c.rect(r.x + Math.round(r.w * (0.16 + i * 0.25)), r.y + Math.round((r.h - bh) / 2), bw, bh, ink);
}
function screen({ over = false, tiles = [[0, 0], [1, 2]] } = {}) {
  const c = createCanvas(W, H, [236, 236, 236]);
  c.rect(0, 0, W, 90, [222, 225, 230]);
  button(c, TOOLBAR[0], [66, 110, 200]);
  button(c, TOOLBAR[1], [66, 110, 200]);
  button(c, TOOLBAR[2], [40, 150, 90]);
  c.rect(PANEL.x, PANEL.y, PANEL.w, PANEL.h, [250, 248, 239]);
  button(c, NEW_GAME, [143, 122, 102]);
  c.rect(450, 280, 700, 540, [187, 173, 160]);
  for (const [col, row] of tiles) {
    const x = 470 + col * 170, y = 300 + row * 130;
    c.rect(x, y, 110, 110, [238, 228, 218]);
    c.rect(x + 40, y + 35, 30, 40, [119, 110, 101]);
  }
  if (over) {
    c.rect(450, 280, 700, 540, [238, 228, 218]);
    c.rect(650, 420, 300, 40, [119, 110, 101]); // "Game over!"
    button(c, TRY_AGAIN, [143, 122, 102]);
  }
  return c;
}
// The page's crop (applyCrop), as a copy of the kept pixels.
function crop(c, box) {
  const out = createCanvas(box.width, box.height);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.top + y) * c.width + box.left) * 4;
    out.data.set(c.data.subarray(from, from + box.width * 4), y * box.width * 4);
  }
  return out;
}
// The model's frame: the crop shrunk k times (the page's downscaleCanvas).
function shrink(c, k) {
  const w = Math.floor(c.width / k), h = Math.floor(c.height / k);
  const out = createCanvas(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sum = [0, 0, 0];
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const p = c.get(x * k + dx, y * k + dy);
      sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2];
    }
    out.set(x, y, sum.map(v => Math.round(v / (k * k))));
  }
  return out;
}
const reply = labels => `Here is what I see: ${JSON.stringify(labels)}`;

// ── Where controls are looked for ─────────────────────────────────────────────
console.log("\nwhere controls are looked for");
let decisionScale, cropBoxOnScreen;
{
  cases("with no plugin: only a frame cropped to the game; with no crop or no frame, nowhere, and the operator is asked", [
    ["cropped", st.searchPlan({ drawn: true, cropped: true }), p => p.search === true && p.region === null && p.where === "the crop"],
    ["no crop", st.searchPlan({ drawn: true, cropped: false }), p => p.search === false && p.why === st.NO_CROP_WHY],
    ["no frame", st.searchPlan({ drawn: false }), p => p.search === false && p.why === st.NO_FRAME_WHY],
    ["a plugin with a layout for this frame", st.searchPlan({ plugin: true, layout: { boardRect: { x: 100, y: 100, w: 400, h: 400 }, capture: { w: 1600 } }, frameWidth: 1600 }),
      p => p.search && p.region && near(p.region.x, 100 - 140) === false && p.region.x === 0 && near(p.region.w, 680)],
    ["a plugin with none", st.searchPlan({ plugin: true, frameWidth: 1600 }), p => p.search && p.region === null],
  ]);
  check("the operator is told how to let it look", /Crop to game area/.test(st.NO_CROP_WHY) && /browser/.test(st.NO_CROP_WHY));

  const whole = findClickableCandidates(screen({ over: true }));
  const chrome = whole.filter(b => !inside({ x: b.cx, y: b.cy }, PANEL));
  check("a search of the whole screen finds the browser's own buttons too (why there is none without a crop)",
    chrome.length >= 3, show(whole.map(b => [b.cx, b.cy])));

  cropBoxOnScreen = fm.cropBox(W, H, CROP);
  decisionScale = fm.croppedScale(fm.capturedScale({ realW: W, realH: H, imgW: W, imgH: H }), cropBoxOnScreen);
  const found = findClickableCandidates(crop(screen({ over: true }), cropBoxOnScreen));
  const onScreen = found.map(b => fm.toScreen({ x: b.cx, y: b.cy }, decisionScale));
  check("the crop is the game's panel", show(cropBoxOnScreen) === show({ left: 400, top: 150, width: 800, height: 700 }), show(cropBoxOnScreen));
  check("in the crop it finds the game's two buttons and nothing of the browser's, in reading order",
    found.length === 2 && inside(onScreen[0], NEW_GAME) && inside(onScreen[1], TRY_AGAIN), show({ found: found.map(b => [b.cx, b.cy, b.w, b.h]), onScreen }));
  // The same frame from a screen twice its size (a 3200×1800 display shared
  // at 1600): every point lands at twice the place.
  const doubled = fm.croppedScale(fm.capturedScale({ realW: W * 2, realH: H * 2, imgW: W, imgH: H }), cropBoxOnScreen);
  const twice = fm.toScreen({ x: found[1]?.cx, y: found[1]?.cy }, doubled);
  const oldClick = { x: Math.round((found[1]?.cx ?? 0) / 2), y: Math.round((found[1]?.cy ?? 0) / 2) };
  const TRY_AGAIN_2X = { x: TRY_AGAIN.x * 2, y: TRY_AGAIN.y * 2, w: TRY_AGAIN.w * 2, h: TRY_AGAIN.h * 2 };
  check("on a screen twice the frame's size \"Try again\" is still clicked on the button, where the old click missed it",
    inside(twice, TRY_AGAIN_2X) && !inside(oldClick, TRY_AGAIN_2X), show({ twice, oldClick }));
}

// ── What the controls are, and which appeared during the game ─────────────────
console.log("\nwhat the controls are, and which appeared during the game");
let over, midGame;
{
  cases("a control's kind comes from its words first, then from what the model said", [
    ["Try again", st.controlKind("Try again"), k => k === "restart"],
    ["New Game", st.controlKind("New Game"), k => k === "restart"],
    ["PLAY AGAIN", st.controlKind("PLAY AGAIN"), k => k === "restart"],
    ["Next level", st.controlKind("Next level"), k => k === "next"],
    ["Keep going", st.controlKind("Keep going"), k => k === "continue"],
    ["OK", st.controlKind("OK"), k => k === "continue"],
    ["Shop, said other", st.controlKind("Shop", "other"), k => k === "other"],
    ["Go!, said continue", st.controlKind("Go!", "continue"), k => k === "continue"],
    ["Settings, said something unknown", st.controlKind("Settings", "banana"), k => k === "other"],
    ["no label", st.controlKind("", "restart"), k => k === null],
    ["Rematch", st.controlKind("Rematch"), k => k === "restart"],
  ]);
  // The standing screen rule forbids signing in, downloading, paying and online
  // play, and "continue" in a label used to make a control one that carries on.
  cases("a sign-in, download, payment or online-play control is refused, whatever else its words say", [
    ["Continue with Google", st.controlKind("Continue with Google"), k => k === st.REFUSED],
    ["Sign in to continue", st.controlKind("Sign in to continue"), k => k === st.REFUSED],
    ["Download to continue", st.controlKind("Download to continue"), k => k === st.REFUSED],
    ["Log in", st.controlKind("Log in"), k => k === st.REFUSED],
    ["Play Online", st.controlKind("Play Online"), k => k === st.REFUSED],
    ["Play again online", st.controlKind("Play again online"), k => k === st.REFUSED],
    ["Buy 100 gems", st.controlKind("Buy 100 gems", "continue"), k => k === st.REFUSED],
    ["Join match", st.controlKind("Join match"), k => k === st.REFUSED],
    ["Go!, said refused", st.controlKind("Go!", "refused"), k => k === st.REFUSED],
    ["no label, said refused", st.controlKind("", "refused"), k => k === st.REFUSED],
    ["Replay is not pay", st.controlKind("Replay"), k => k === "restart"],
  ]);
  cases("only a restart is known to throw the game away, and only a continue to keep it", [
    ["restart", st.restartsOf("restart"), v => v === true],
    ["continue", st.restartsOf("continue"), v => v === false],
    ["next", st.restartsOf("next"), v => v === undefined],
    ["other", st.restartsOf("other"), v => v === undefined],
    ["refused", st.restartsOf(st.REFUSED), v => v === undefined],
    ["unknown", st.restartsOf(null), v => v === undefined],
  ]);

  // A control appeared when most of its box changed, not one cell of it: the
  // pointer resting on "New Game" moves one.
  const grid = { x: 0, y: 0, width: 100, height: 100, cols: 10, rows: 10 };
  const box = { x: 0, y: 0, w: 50, h: 10 };          // cells 0-4 of the top row
  cases("a control appeared when more than half of its cells changed, not when one did", [
    ["one of five", st.movedInside({ grid, cells: [2] }, box), v => v === false],
    ["two of five", st.movedInside({ grid, cells: [0, 1, 55] }, box), v => v === false],
    ["three of five", st.movedInside({ grid, cells: [0, 1, 2] }, box), v => v === true],
    ["all", st.movedInside({ grid, cells: [0, 1, 2, 3, 4] }, box), v => v === true],
    ["a box smaller than a cell, its cell changed", st.movedInside({ grid, cells: [11] }, { x: 12, y: 12, w: 2, h: 2 }), v => v === true],
    ["no comparison", st.movedInside(null, box), v => v === null],
  ]);

  // The page's looks: its own frame (the crop, shrunk 2×), with its own scale.
  const lookScale = fm.shrunkScale(decisionScale, 400, 350);
  const lookOf = c => ({ look: { map: mo.motionMap(shrink(crop(c, cropBoxOnScreen), 2)) }, scale: lookScale });
  const start = lookOf(screen());
  const found = findClickableCandidates(crop(screen({ over: true }), cropBoxOnScreen));
  const labels = {
    situation: "Game over: the board is full.",
    buttons: [{ index: 0, label: "New Game", kind: "restart" }, { index: 1, label: "Try again", kind: "restart" }],
    recommended: 1, needsHuman: false,
  };
  const decision = st.genericDecision({ found, labelled: st.readLabels(reply(labels)), scale: decisionScale, playOn: true, verify: true, where: "the crop" });
  over = st.withAppeared(decision, { start, now: lookOf(screen({ over: true, tiles: [[2, 1], [3, 3]] })) });
  cases("the decision holds each control with its label, kind and frame point, and the model's pick", [
    ["options", over.options.map(o => [o.id, o.label, o.kind, o.restarts, o.end]),
      o => show(o) === show([["btn-0", "New Game", "restart", true, true], ["btn-1", "Try again", "restart", true, true]])],
    ["recommended", over.recommended, r => r === "btn-1"],
    ["the model's summary", over.summary, s => s === "Game over: the board is full."],
    ["keeps playing and checks its click (no plugin)", [over.playOn, over.verify], v => v[0] === true && v[1] === true],
  ]);
  cases("\"Try again\" appeared over the board during the game; \"New Game\" was there as it began", [
    ["New Game", over.options[0].appeared, v => v === false],
    ["Try again", over.options[1].appeared, v => v === true],
    ["no look from the start", st.withAppeared(decision, { start: null, now: lookOf(screen({ over: true })) }).options.map(o => o.appeared), v => v.every(a => a === null)],
  ]);

  // Mid-game: nothing is over, and only "New Game" is on screen.
  const midFound = findClickableCandidates(crop(screen({ tiles: [[0, 0], [1, 2], [2, 2]] }), cropBoxOnScreen));
  midGame = st.withAppeared(st.genericDecision({
    found: midFound, scale: decisionScale, purpose: "claim", playOn: true, verify: true, where: "the crop",
    labelled: { situation: "A 2048 board in play.", buttons: [{ index: 0, label: "New Game", kind: "restart" }], recommended: 0, needsHuman: false },
  }), { start, now: lookOf(screen({ tiles: [[0, 0], [1, 2], [2, 2]] })) });
  check("mid-game the crop holds only \"New Game\", there since the game began",
    midGame.options.length === 1 && midGame.options[0].label === "New Game" && midGame.options[0].appeared === false,
    show(midGame.options));

  const lines = st.candidateLines(over);
  const tryPoint = fm.toScreen(over.options[1], decisionScale);
  check("a snapshot's text lists each control: label, kind, new or not, where in the frame and on the screen, the pick",
    lines[0] === "Controls found in the crop: 2."
      && lines.some(l => l.includes('"Try again" — restart, new during this game') && l.includes(`${tryPoint.x},${tryPoint.y} on the screen`) && l.endsWith("— recommended"))
      && lines.some(l => l.includes('"New Game" — restart, on screen since the game began')),
    show(lines));
  check("...and a screen that was not searched says why",
    st.candidateLines(st.askDecision({ why: st.NO_CROP_WHY }))[0] === `The screen was not searched: ${st.NO_CROP_WHY}.`);
  const text = st.decisionText("The operator was asked what to do.", over, ["If nobody answers in 90s: \"Try again\"."]);
  check("a decision's snapshot text: heading, what is on screen, the controls, then what happens next",
    text.startsWith("The operator was asked what to do.\n\nGame over: the board is full.\nControls found in the crop: 2.")
      && text.endsWith('\n\nIf nobody answers in 90s: "Try again".'), text);
}

// ── Asking, and what nobody answering picks ───────────────────────────────────
console.log("\nasking the operator, and what nobody answering picks");
{
  cases("needsHuman is true when nothing was understood or the model says so, and otherwise left to the options (never false)", [
    ["no answer", st.needsHumanFrom(null, null), v => v === true],
    ["no pick", st.needsHumanFrom({ buttons: [] }, null), v => v === true],
    ["the model says so", st.needsHumanFrom({ needsHuman: true }, 0), v => v === true],
    ["\"true\" as text", st.needsHumanFrom({ needsHuman: "true" }, 0), v => v === true],
    ["understood", st.needsHumanFrom({ needsHuman: false }, 0), v => v === null],
    ["understood, silent", st.needsHumanFrom({}, 1), v => v === null],
  ]);
  const opt = (id, kind) => ({ id, label: id, kind, restarts: st.restartsOf(kind) });
  const win = { needsHuman: null, recommended: "btn-0", options: [opt("btn-0", "continue"), opt("btn-1", "restart")], fallback: st.NEXT_GAME, playOn: true };
  cases("the operator is asked only when one control keeps the game and another may throw it away", [
    ["Try again and New Game", st.isRealChoice(over), v => v === false],
    ["Keep going and Try again", st.isRealChoice(win), v => v === true],
    ["OK alone", st.isRealChoice({ needsHuman: null, options: [opt("btn-0", "continue")] }), v => v === false],
    ["Try again and a shop", st.isRealChoice({ needsHuman: null, options: [opt("btn-0", "restart"), opt("btn-1", "other")] }), v => v === false],
    ["the model says ask", st.isRealChoice({ ...over, needsHuman: true }), v => v === true],
    ["nothing searched", st.isRealChoice(st.askDecision({ why: "x" })), v => v === true],
  ]);
  // With no plugin (playOn), the agent clicks by itself only a control known
  // to start again, go on or carry on; with a plugin, as before.
  const alone = (kind, label = kind) => ({ needsHuman: null, playOn: true, recommended: "btn-0",
    options: [{ id: "btn-0", label, kind, restarts: st.restartsOf(kind) }] });
  cases("with no plugin the operator is asked when the control the agent would click is not known to start again, go on or carry on", [
    ["OK alone", st.isRealChoice(alone("continue", "OK")), v => v === false],
    ["Try again alone", st.isRealChoice(alone("restart", "Try again")), v => v === false],
    ["Next level alone", st.isRealChoice(alone("next", "Next level")), v => v === false],
    ["a menu alone", st.isRealChoice(alone("other", "Menu")), v => v === true],
    ["a control with no label", st.isRealChoice(alone(null, "Button at 10,10")), v => v === true],
    ["Try again, with a shop picked", st.isRealChoice({ ...alone("restart"), recommended: "btn-1",
      options: [opt("btn-0", "restart"), opt("btn-1", "other")] }), v => v === true],
    ["a menu alone, with a plugin", st.isRealChoice({ ...alone("other", "Menu"), playOn: false }), v => v === false],
  ]);
  check("with no real choice the agent takes the recommended control, else the first",
    st.actingChoice(over) === "btn-1" && st.actingChoice({ ...over, recommended: null }) === "btn-0"
      && st.actingChoice({ options: [] }) === st.NEXT_GAME);

  // A sign-in wall: the finder finds its buttons, the model names them.
  const wall = st.genericDecision({
    found: [{ cx: 400, cy: 300, w: 220, h: 50 }, { cx: 400, cy: 380, w: 220, h: 50 }, { cx: 400, cy: 460, w: 120, h: 40 }],
    labelled: { situation: "A sign-in wall.", recommended: 1, needsHuman: false, buttons: [
      { index: 0, label: "Sign in to continue", kind: "continue" }, { index: 1, label: "Continue with Google", kind: "continue" },
      { index: 2, label: "OK", kind: "continue" }] },
    scale: { scale: 1 }, playOn: true, verify: true, where: "the crop",
  });
  cases("a refused control on screen leaves it to the operator, and is never what the agent clicks, recommends or falls back to", [
    ["kinds", wall.options.map(o => o.kind), v => show(v) === show([st.REFUSED, st.REFUSED, "continue"])],
    ["the model's pick of Continue with Google is not recommended", wall.recommended, v => v === null],
    ["the operator is asked", [wall.needsHuman, st.isRealChoice(wall)], v => v[0] === true && v[1] === true],
    ["...whatever the decision says, with a plugin too", st.isRealChoice({ ...wall, needsHuman: false, playOn: false }), v => v === true],
    ["nobody answering starts the next game", st.fallbackChoice(wall), v => v === st.NEXT_GAME],
    ["a refused pick, recommended by hand", st.fallbackChoice({ ...wall, recommended: "btn-1" }), v => v === st.NEXT_GAME],
    ["acting would take OK", st.actingChoice({ ...wall, recommended: "btn-0" }), v => v === "btn-2"],
    ["the snapshot says so", st.candidateLines(wall).at(-1), v => /never clicks one itself/.test(v)],
  ]);

  // The dialog used to fall back to "keep-going" whatever it offered, and no
  // control on an unknown screen is called that.
  check("the old fallback (\"keep-going\") is not a choice on an unknown screen",
    !st.choicesOf(over).includes(st.DECISION_DEFAULT) && st.DECISION_DEFAULT === "keep-going", show(st.choicesOf(over)));
  const plugin2048 = { options: [{ id: "keep-going", label: "Keep going" }, { id: "try-again", label: "Try again" }], recommended: "keep-going", fallback: st.NEXT_GAME };
  cases("nobody answering takes the recommended option's own id, else the plugin's keep-going, else the next game", [
    ["the model's pick on an unknown screen", st.fallbackChoice(over), v => v === "btn-1"],
    ["Keep going recommended", st.fallbackChoice(win), v => v === "btn-0"],
    ["2048's win overlay", st.fallbackChoice(plugin2048), v => v === "keep-going"],
    ["2048's, nothing recommended", st.fallbackChoice({ ...plugin2048, recommended: null }), v => v === "keep-going"],
    ["nothing recommended", st.fallbackChoice({ ...over, recommended: null }), v => v === st.NEXT_GAME],
    ["a recommendation that is not on offer", st.fallbackChoice({ ...over, recommended: "btn-7" }), v => v === st.NEXT_GAME],
    ["nothing searched", st.fallbackChoice(st.askDecision({ why: st.NO_CROP_WHY })), v => v === st.NEXT_GAME],
    ["no decision", st.fallbackChoice(null), v => v === st.NEXT_GAME],
  ]);
  cases("every choice reads as what it does", [
    ["an option", st.choiceLabel(over, "btn-1"), v => v === '"Try again"'],
    ["play on", st.choiceLabel(over, st.PLAY_ON), v => v === "keep playing (no click)"],
    ["next game", st.choiceLabel(over, st.NEXT_GAME), v => v === "start the next game"],
    ["stop", st.choiceLabel(over, st.STOP), v => v === "stop the session"],
  ]);
  check("with no plugin \"keep playing\" is offered; with a plugin it is not",
    st.choicesOf(over).includes(st.PLAY_ON) && !st.choicesOf(plugin2048).includes(st.PLAY_ON));

  const prompt = st.labelPrompt("stuck");
  check("the model is asked only what each numbered control is, and its reply format is the last thing it reads",
    /outlined and numbered/.test(prompt) && /Do not guess coordinates/.test(prompt) && /"kind"/.test(prompt)
      && /Reply with ONLY a JSON object[\s\S]*"needsHuman":<[^>]*>\}$/.test(prompt) && !prompt.includes(SCREEN_RULE), prompt);
  // The model that made the claim names the controls: it is not told its answer
  // weighs its own claim.
  const claimAsk = st.labelPrompt("claim").split("\n")[0];
  check("a claim's question is a neutral one, saying nothing of a claim or a game that is over",
    /say what each control on it is/i.test(claimAsk) && !/over|said|claim|ended/i.test(claimAsk), claimAsk);
  check("the model may name a control refused (sign in, download, pay, online)", /"refused" \(signs in/.test(prompt) && /restart\|next\|continue\|refused\|other/.test(prompt));
  cases("the model's answer is read from the first JSON object in its reply, and nothing else", [
    ["in prose", st.readLabels('Sure. {"recommended": 1} Done.'), v => v?.recommended === 1],
    ["not JSON", st.readLabels("{not json}"), v => v === null],
    ["an array", st.readLabels("[1,2]"), v => v === null],
    ["nothing", st.readLabels(undefined), v => v === null],
  ]);
  check("the list sent with the image gives each control's place in the image the model gets",
    st.controlList([{ cx: 100, cy: 50, w: 80, h: 20 }], 0.5) === "0: at 50,25, 40x10px");
}

// ── The model's word that the game is over ────────────────────────────────────
console.log("\nthe model's claim that the game is over");
{
  const accepted = st.claimVerdict({ decision: over });
  check("taken when a control that ends a game appeared on screen",
    accepted.accept && accepted.how === "control" && accepted.control.label === "Try again", show(accepted));
  const always = st.claimVerdict({ decision: midGame });
  check("not taken on a \"New Game\" that was there all along, saying so",
    !always.accept && !always.giveUp && /"New Game" was already on screen when this game began/.test(always.why), show(always));
  const noCrop = st.claimVerdict({ decision: st.askDecision({ why: st.NO_CROP_WHY }) });
  check("not taken when the screen was not searched (no crop)", !noCrop.accept && noCrop.why === st.NO_CROP_WHY, show(noCrop));
  const none = st.claimVerdict({ decision: null });
  check("not taken when nothing clickable was found", !none.accept && /nothing that can be clicked/.test(none.why));
  const continueOnly = st.claimVerdict({ decision: { searched: true, options: [{ label: "OK", kind: "continue", appeared: true }] } });
  check("not taken on controls that do not end a game", !continueOnly.accept && /none of the 1 control found/.test(continueOnly.why), show(continueOnly));
  const stuck = st.claimVerdict({ stuck: { stuck: true }, decision: midGame });
  check("taken once nothing the model does changes the screen any more", stuck.accept && stuck.how === "no-op", show(stuck));
  const turnedDown = [0, 1, 2].map(rejected => st.claimVerdict({ decision: midGame, rejected }).giveUp);
  check(`the ${st.CLAIM_REJECTS_PER_GAME}rd claim turned down in a row gives the game up as stuck`,
    show(turnedDown) === show([false, false, true]) && st.CLAIM_REJECTS_PER_GAME === 3, show(turnedDown));

  // The standing screen rule tells the model to report the game stuck when play
  // cannot go on without signing in, downloading and the like: that report is
  // the rule's way out, and is taken as it is, with or without a look.
  const signIn = st.withAppeared(st.genericDecision({
    found: [{ cx: 400, cy: 300, w: 220, h: 50 }, { cx: 400, cy: 380, w: 220, h: 50 }],
    labelled: { buttons: [{ index: 0, label: "Sign in to continue" }, { index: 1, label: "Continue with Google" }], recommended: 0 },
    scale: { scale: 1 }, purpose: "claim", playOn: true, verify: true, where: "the crop",
  }), {});
  cases("a report that play cannot go on (stuck) is taken as it is; any other claim at a sign-in wall is not", [
    ["stuck, no look", st.claimVerdict({ outcome: "stuck" }), v => v.accept && v.how === "reported-stuck"],
    ["stuck, at the wall", st.claimVerdict({ outcome: "stuck", decision: signIn, rejected: 2 }), v => v.accept && v.how === "reported-stuck"],
    ["lost, at the wall", st.claimVerdict({ outcome: "lost", decision: signIn }), v => !v.accept && /none of the 2 controls/.test(v.why)],
  ]);
  check("a stuck report is logged as the game ending stuck",
    /Ending this game as stuck, as the model reported/.test(st.claimAcceptedLine(st.claimVerdict({ outcome: "stuck" })))
      && st.claimAcceptedLine(accepted) === 'The game is over: the screen shows "Try again" (restart).');

  // The model that made the claim also names the controls: only a control's
  // own words make it one that ends a game.
  const menu = { searched: true, options: [{ id: "btn-0", label: "Main menu", labelled: true, kind: "restart", appeared: true }] };
  const unlabelled = { searched: true, options: [{ id: "btn-0", label: "Button at 5,5", labelled: false, kind: "restart", appeared: true }] };
  cases("a control the model called a restart confirms nothing unless its words say so", [
    ["Main menu, said restart", st.claimVerdict({ decision: menu }), v => !v.accept],
    ["no label, said restart", st.claimVerdict({ decision: unlabelled }), v => !v.accept],
    ["Play again, said other", st.claimVerdict({ decision: { searched: true, options: [{ label: "Play again", labelled: true, kind: "other", appeared: true }] } }),
      v => v.accept && v.how === "control"],
    ["Play again online (refused)", st.claimVerdict({ decision: { searched: true, options: [{ label: "Play again online", labelled: true, kind: st.REFUSED, appeared: true }] } }),
      v => !v.accept],
  ]);

  const nudge = st.claimNudge({ outcome: "lost", verdict: always });
  check("the model is told why, in the agent's words, not to restart the game itself, and to play on",
    /did not end the game/.test(nudge) && nudge.includes(always.forModel) && /Do not start a new game yourself/.test(nudge)
      && /keep playing/.test(nudge), nudge);
  cases("nothing the model is told about a claim quotes a label read off the screen", [
    ["always there", always.forModel, v => typeof v === "string" && !v.includes('"') && !/New Game/.test(v) && /already on screen/.test(v)],
    ["the nudge", nudge, v => !v.includes('"New Game"')],
    ["nothing found", none.forModel, v => typeof v === "string" && !v.includes('"')],
    ["not searched", noCrop.forModel, v => typeof v === "string" && !v.includes('"')],
  ]);
  check("the log line says how many claims in a row were turned down",
    st.claimRejectedLine({ outcome: "won", why: "x", rejected: 2 }) === "The model said the game is over (won), but x. Not ended: playing on (2 of 3 claims in a row turned down).");

  // A claim turned down stands only until the model's actions change the
  // screen: it used to stay for the rest of the game, and give the game its
  // outcome and score whenever play next stalled.
  const pending = { claim: { outcome: "won", finalScore: 2048 }, changesAt: 7 };
  cases("a claim turned down stands until an action of the model's changes the screen", [
    ["no change since", st.claimStands(pending, 7), v => v === true],
    ["an action changed the screen", st.claimStands(pending, 8), v => v === false],
    ["no claim", st.claimStands(null, 0), v => v === false],
  ]);
  const stall = changes => st.afterStuckChoice({ claim: st.claimStands(pending, changes) ? pending.claim : null,
    why: "nothing that can be clicked was found on screen" });
  cases("a claim, then moves that changed the screen, then a stall: the game ends stuck, not with the claim's outcome", [
    ["the claim still stands", stall(7), a => a.outcome === "won"],
    ["the screen responded after it", stall(8), a => a.outcome === "stuck"],
  ]);
  check("dropping a claim is logged", /so that claim is dropped and play goes on/.test(st.claimDroppedLine(pending.claim)));
  check("the game-end snapshot says how a claim was taken, with the controls when one confirmed it",
    st.claimTaken({ verdict: accepted, decision: over }).includes("Taken: the screen shows \"Try again\" (restart).")
      && st.claimTaken({ verdict: accepted, decision: over }).includes("Controls found in the crop: 2.")
      && st.claimTaken(null) === "");
}

// ── After the screen handler ──────────────────────────────────────────────────
console.log("\nwhat the games loop does after the screen handler (no plugin)");
{
  const [newGame, tryAgain] = over.options;
  const ok = { id: "btn-0", label: "OK", kind: "continue", end: false, appeared: true };
  const next = { id: "btn-0", label: "Next level", kind: "next", end: true, appeared: true };
  const clicked = (o, changed) => ({ choice: st.NEXT_GAME, clicked: o, changed });
  const tryPoint = fm.toScreen(tryAgain, decisionScale);
  cases("a control that changed the screen plays on, or, for a restart, ends this game and has started the next", [
    ["OK", st.afterStuckChoice({ result: clicked(ok, true), decision: over }), a => a.next === "play-on" && /"OK" was clicked and the screen changed/.test(a.note)],
    ["Try again", st.afterStuckChoice({ result: clicked(tryAgain, true), decision: over }),
      a => a.next === "end-game" && a.outcome === "ended" && a.startedNext && a.restartPoint.x === tryPoint.x && a.restartPoint.y === tryPoint.y && a.stuckReason === null],
    ["Try again, the model had said lost", st.afterStuckChoice({ result: clicked(tryAgain, true), claim: { outcome: "lost" }, decision: over }),
      a => a.next === "end-game" && a.outcome === "lost" && a.startedNext],
    ["New Game, there all along", st.afterStuckChoice({ result: clicked(newGame, true), decision: over }),
      a => a.next === "end-game" && a.outcome === "stuck" && a.startedNext && /started a new game/.test(a.stuckReason)],
    ["Next level", st.afterStuckChoice({ result: clicked(next, true), decision: over }), a => a.next === "play-on"],
    ["Next level, the model had said won", st.afterStuckChoice({ result: clicked(next, true), claim: { outcome: "won" }, decision: over }),
      a => a.next === "end-game" && a.outcome === "won" && a.startedNext && a.restartPoint === null],
  ]);
  cases("otherwise the game ends: as the model said once nothing responds, else stuck", [
    ["a click that changed nothing", st.afterStuckChoice({ result: clicked(tryAgain, false), decision: over }),
      a => a.next === "end-game" && a.outcome === "stuck" && !a.startedNext && /"Try again" was clicked and the screen did not change/.test(a.stuckReason)],
    ["nothing found", st.afterStuckChoice({ why: "nothing that can be clicked was found on screen" }),
      a => a.next === "end-game" && a.outcome === "stuck" && a.note === "nothing that can be clicked was found on screen"],
    ["nothing found, the model had said lost", st.afterStuckChoice({ claim: { outcome: "lost" } }), a => a.outcome === "lost"],
    ["the operator's next game", st.afterStuckChoice({ result: { choice: st.NEXT_GAME } }), a => a.next === "end-game" && !a.startedNext],
    ["the operator's keep playing", st.afterStuckChoice({ result: { choice: st.PLAY_ON } }), a => a.next === "play-on"],
    ["the operator's stop", st.afterStuckChoice({ result: { choice: st.STOP } }), a => a.next === "stop" && a.outcome === "stuck"],
  ]);
  const resumed = st.afterStuckChoice({ result: clicked(ok, true), decision: over });
  const told = st.resumeNudge(resumed.modelNote);
  check("the model is told play had stopped, what happened, and to carry on, naming the control by what it does and not its label",
    /Play had stopped/.test(told) && /clicked a control that closes a message or carries play on/.test(told) && !told.includes('"OK"')
      && /the operator said to keep playing/.test(st.resumeNudge(st.afterStuckChoice({ result: { choice: st.PLAY_ON } }).modelNote)), told);
  check(`the handler gets play going again at most ${st.STUCK_LOOKS_PER_GAME} times a game`, st.STUCK_LOOKS_PER_GAME === 3);
  check("its snapshots are exempt from the game's allowance, and have one of their own (src/agent/snapshots.js)",
    show(sn.DECISION_TAGS) === show(["decision-ask", "decision-click", "claim-rejected"])
      && sn.DECISION_TAGS.every(t => sn.snapshotAllowance(t, 99).take && !sn.snapshotAllowance(t, 99).counted)
      && sn.DECISION_SNAPSHOTS_PER_GAME === 12
      && sn.DECISION_TAGS.every(t => sn.snapshotAllowance(t, 0, 11).take && !sn.snapshotAllowance(t, 0, 12).take));
}

// ── The page uses it ──────────────────────────────────────────────────────────
console.log("\nthe page");
{
  const source = fs.readFileSync(path.join(ROOT, "src", "GameAgent.jsx"), "utf8");
  // Comments removed, so only code is matched.
  const { code } = await transform(source, { loader: "jsx", jsx: "automatic" });
  const count = pattern => [...code.matchAll(pattern)].length;
  const from = (a, b) => {
    const i = code.indexOf(a);
    const j = i < 0 ? -1 : code.indexOf(b, i + a.length);
    return i < 0 || j < 0 ? "" : code.slice(i, j);
  };

  // One mapping for every click the page works out itself.
  const analyse = from("const analyseStuckScreen = useCallback(", "const resolveDecision = useCallback(");
  const resolve = from("const resolveDecision = useCallback(", "const noteBestTile = useCallback(");
  const solver = from("const playSolverTurn = useCallback(", "const solverTurn = useCallback(");
  const restart = from("const attemptRestart = useCallback(", "const testSolver = useCallback(");
  const tools = from("const executeTool = useCallback(", 'if (toolName === "update_memory")');
  check("a decision's option is clicked where it is: toScreen with the decision's own scale",
    /const clickOption = async \((\w+)\) => \{\s*const \{ x, y \} = toScreen\(\1, decision\.scale\);/.test(resolve), "clickOption not found");
  check("...and nothing divides by a scale any more, or works out offsets by hand",
    !/\/ \(?\w*\.?scale\b/.test(code) && !/offsetX \?\? 0\) \+/.test(code) && !/opt\.x \//.test(code));
  check("the solver's clicks and park point go through toScreen with its capture's scale",
    /const scale = solverScaleRef\.current;/.test(solver) && /\.\.\.toScreen\(a, scale\)/.test(solver) && /toScreen\(park, scale\)/.test(solver));
  check("the restart's plugin button, remembered point and pointer baseline go through the same rule",
    /toScreen\(pt, solverScaleRef\.current\)/.test(restart) && /toScreen\(\{ x: Number\(m\[1\]\), y: Number\(m\[2\]\) \}, scaleRef\.current\)/.test(restart)
      && /toFrame\(\{ x, y \}, scaleRef\.current\)/.test(restart));
  check("the model's clicks too", /const scaled = \(x, y\) => toScreen\(\{ x, y \}, scaleRef\.current\);/.test(tools));
  check("the page takes the rule from src/vision/frameMap.js", /from "\.\/vision\/frameMap\.js";/.test(code));

  // Frames through the page's own capture, crop included.
  check("with no plugin the handler draws the page's capture (native or browser, cropped) at full size on its own canvas",
    /const drawn = await drawFrame\(\{ canvas, scale: decisionScaleRef, full: true \}\);/.test(analyse)
      && /plan = searchPlan\(\{ drawn: !!drawn, cropped: !!drawn\?\.cropped \}\);/.test(analyse)
      && count(/captureFrame\(videoRef\.current, canvas, solverScaleRef, SOLVER_CAPTURE_W\)/g) >= 1
      && (analyse.match(/captureFrame\(/g) ?? []).length === 1 && analyse.indexOf("captureFrame(") < analyse.indexOf("} else {"));
  check("...and with no crop it clicks nothing: it warns, and the operator is asked",
    /if \(!plan\.search\) \{\s*addLog\(`[^`]*\$\{plan\.why\}[^`]*`, "warn"\);\s*return \{ \.\.\.askDecision\(\{ why: plan\.why, purpose, scale \}\)/.test(analyse));
  check("drawFrame applies the crop to the canvas it is given, and a full frame is not shrunk",
    /if \(applyCrop\(canvas, scale, cropRef\.current\)\) \{\s*mutated = true;\s*cropped = true;/.test(code) && /if \(!full && canvas\.width > MAX_FRAME_W\)/.test(code));
  check("the model labels the controls on the frame they were found on, outlined and numbered, with the rule first",
    /const marked = markCandidates\(canvas, found\);/.test(analyse) && /jpegOf\(marked\.canvas, MAX_FRAME_W\)/.test(analyse)
      && /`\$\{SCREEN_RULE\}\s*\$\{labelPrompt\(purpose\)\}`/.test(analyse) && /controlList\(found, marked\.k \* \w+\.k\)/.test(analyse)
      && /\{ signal: stopCtrlRef\.current\.signal \}/.test(analyse));
  check("with no plugin, which controls appeared is judged against the look taken as the game began",
    /withAppeared\(decision, \{\s*start: gameStartLookRef\.current,/.test(analyse) && /gameStartLookRef\.current = null;/.test(code));

  // Asking, and what nobody answering picks.
  check("the dialog's wait ends in fallbackChoice's pick, which the log names",
    /const fallback = fallbackChoice\(decision\);/.test(resolve) && /resolve\(fallback\);/.test(resolve)
      && !/DECISION_DEFAULT/.test(code) && !/"keep-going"\s*\)?;?\s*\}\s*,\s*waitSec/.test(code));
  check("the operator is asked only when isRealChoice says so; otherwise the agent takes actingChoice's",
    /if \(!isRealChoice\(decision\)\) \{\s*const (\w+) = actingChoice\(decision\);/.test(resolve));
  check("every ask and every click is snapshotted with the controls found",
    /const snap = \(tag, heading, after = \[\]\) => snapshot\(tag, decisionText\(heading, decision, after\), decision\.canvas \?\? null\);/.test(resolve)
      && /await snap\(\s*"decision-ask",/.test(resolve) && resolve.indexOf('"decision-ask"') < resolve.indexOf("setPendingDecision({")
      && /if \(click\.clicked\) \{\s*await snap\(\s*"decision-click",/.test(resolve));
  check("with no plugin a click is judged like the model's: pointer first, baseline, then whether the screen changed near it",
    /if \(decision\.verify\) \{\s*const moved = await sendWhenLive\("\/mouse\/move"[\s\S]{0,200}?base = await settledBaseline\(lookNow, at\);/.test(resolve)
      && /: await waitChange\(lookNow, base, \{ maxMs: [^}]*action: changeAction\("click", \{\}, at\) \}\);/.test(resolve));
  check("...and a control that ends the game (a restart, or a Next after a claim) by a new screen, as attemptRestart judges a restart",
    /const newGame = opt\.kind === "restart" \|\| opt\.kind === "next" && !!decision\.claimed;/.test(resolve)
      && /const confirm = newGame \? await waitChange\(lookNow, base, \{ maxMs: [^}]*threshold: LEGACY_RESTART_THRESHOLD, action: changeAction\("restart"\) \}\) :/.test(resolve));
  check("■ Stop answers an open dialog at once, and one that has not opened yet does not wait",
    /const stopAgent = useCallback\(\(\) => \{\s*stopRef\.current = true;\s*answerDecision\(STOP\);/.test(code)
      && /if \(stopRef\.current\) return \{ choice: STOP \};\s*setPendingDecision\(\{/.test(resolve));

  // The games loop: with no plugin the handler runs before a game is called stuck.
  const loop = from("const session = { outage: null, abortReason: null };", "const thisGame = gameEnding(");
  check("the no-plugin stuck branch faces the screen before it ends the game, and plays on when the handler got play going",
    /if \(exhausted \|\| hardStop\) \{\s*addLog\(stuckLine, "warn"\);\s*const (\w+) = modelPlays \? await faceStuckScreen\(\{ claim: pendingClaim\?\.claim \?\? null, looks: screenLooks \}\) : afterStuckChoice\(\);\s*if \(\1\.next === "play-on"\) \{\s*screenLooks\+\+;\s*pendingClaim = null;\s*rejectedClaims = 0;[\s\S]{0,500}?convRef\.current\.push\(\{ role: "user", content: resumeNudge\(\1\.modelNote\) \}\);\s*continue;\s*\}\s*gameOutcome = \1\.outcome;/.test(loop));
  check("faceStuckScreen looks (analyseStuckScreen with no plugin), acts or asks (resolveDecision), and reads what came of it",
    /const faceStuckScreen = async \(\{ claim, looks \}\) => \{\s*if \(looks >= STUCK_LOOKS_PER_GAME\) \{[\s\S]{0,300}?\}\s*const decision = await analyseStuckScreen\(null, apiKey\);[\s\S]{0,300}?afterStuckChoice\(\{ result: await resolveDecision\(\{ \.\.\.decision, claimed: !!claim \}\), claim, decision \}\)/.test(loop));
  check("a control that ended the game and started the next is not restarted a second time",
    /if \((\w+)\.startedNext\) \{\s*nextGameStarted = true;\s*if \(\1\.restartPoint\) restartPointRef\.current = \1\.restartPoint;\s*\}/.test(loop)
      && /const (\w+) = nextGameStarted \? \{ ok: true \} : await restartGame\(\);/.test(code));

  // Claims.
  const claimAt = loop.indexOf('if (turn.loop === "end-game" && modelPlays) {');
  const claimBlock = claimAt < 0 ? "" : loop.slice(claimAt, loop.indexOf('if (turn.loop === "end-game") {', claimAt));
  check("with no plugin the model's claim is weighed, between a retry and the end of the game",
    claimBlock.length > 0 && /let claimSeen = null;\s*$/.test(loop.slice(0, claimAt))
      && loop.indexOf('if (turn.loop === "retry") continue;') < claimAt
      && /claimSeen = await weighClaim\(claim, rejectedClaims\);/.test(claimBlock));
  check("a claim ■ Stop came before is not weighed, and gives the game no result of the model's: no outcome, score or reason",
    /^if \(turn\.loop === "end-game" && modelPlays\) \{\s*if \(stopRef\.current\) \{\s*gameEndRef\.current = null;\s*setGameResult\(null\);\s*break;\s*\}\s*const claim = \{ \.\.\.gameEndRef\.current \};/.test(claimBlock));
  check("a restart control that confirmed a claim is where the next game starts from",
    /if \(verdict\.control\?\.kind === "restart"\) restartPointRef\.current = toScreen\(verdict\.control, decision\.scale\);/.test(claimBlock));
  const outcomes = [...claimBlock.matchAll(/gameOutcome = ([^;]+);/g)].map(m => m[1]);
  check("both nudges to look at the screen again come with a screenshot, not skipped as unchanged",
    /content: claimNudge\([^;]*\);\s*forceStrategyRef\.current = true;\s*lastTurnLookRef\.current = null;\s*continue;/.test(claimBlock)
      && /forceStrategyRef\.current = true;\s*lastTurnLookRef\.current = null;\s*convRef\.current\.push\(\{ role: "user", content: resumeNudge\(/.test(loop));
  check("a claim turned down plays on with the model told why, or ends the game as stuck, and nothing else",
    /if \(!(\w+)\.accept\) \{/.test(claimBlock) && /content: claimNudge\(/.test(claimBlock) && /continue;/.test(claimBlock)
      && show(outcomes) === show(['"stuck"']) && /if \(verdict\.giveUp\) \{\s*gameOutcome = "stuck";/.test(claimBlock)
      && /await snapModel\(\s*"claim-rejected",/.test(claimBlock) && /gameEndRef\.current = null;/.test(claimBlock), show(outcomes));
  check("weighClaim takes a stuck report, or a claim the stuck rule confirms, without a look; otherwise it looks at the screen, as a claim",
    /const weighClaim = async \(claim, rejected\) => \{\s*const stuck = stuckVerdict\(\{ streak: noOpStreakRef\.current, distinct: lastFailedMovesRef\.current\.size \}\);\s*const (\w+) = claimVerdict\(\{ outcome: claim\.outcome, stuck, rejected \}\);\s*if \(\1\.accept\) return \{ verdict: \1, decision: null \};\s*const decision = await analyseStuckScreen\(null, apiKey, \{ purpose: "claim" \}\);\s*return \{ verdict: claimVerdict\(\{ outcome: claim\.outcome, stuck, decision, rejected \}\), decision \};/.test(loop));
  check("a claim turned down stands with the count of screen changes it was turned down at, and the model is told why without labels",
    /pendingClaim = \{ claim, changesAt: screenChangesRef\.current \};\s*convRef\.current\.push\(\{ role: "user", content: claimNudge\(\{ outcome: claim\.outcome, verdict \}\) \}\);/.test(claimBlock));
  check("every action judged to have changed the screen is counted, in noteEffect alone",
    /if \(next\.counted && confirm\?\.changed\) screenChangesRef\.current\+\+;/.test(tools)
      && count(/screenChangesRef\.current(\+\+|\s*=[^=])/g) === 1);
  const dropAt = loop.indexOf("if (pendingClaim && !claimStands(pendingClaim, screenChangesRef.current)) {");
  check("after each turn of play, a claim the screen has responded to since is dropped, and the count of claims in a row starts again",
    /if \(pendingClaim && !claimStands\(pendingClaim, screenChangesRef\.current\)\) \{\s*addLog\(claimDroppedLine\(pendingClaim\.claim\), "info"\);\s*pendingClaim = null;\s*rejectedClaims = 0;\s*\}/.test(loop)
      && dropAt > loop.indexOf('if (turn.loop !== "play") break;') && dropAt < loop.indexOf("stuckVerdict({ streak: noOps"));
  check("a claim turned down, and still standing when nothing responds, is the game's result",
    /if \(pendingClaim\) takeClaim\(pendingClaim\.claim\);/.test(loop));
  check("with no plugin signal_game_end tells the model it is noted, not recorded",
    /if \(!solverActiveRef\.current\) \{\s*addLog\(`The model says the game is over:[^`]*`, "info"\);\s*return toolResult\(`Game end noted:/.test(code));

  // The plugin path keeps its own frames and readers.
  check("with a plugin the handler still reads the solver's own capture, and the plugin's overlay first",
    /if \(plugin\) \{\s*canvas = solverCanvasRef\.current;[\s\S]{0,200}?const known = plugin\.readOverlay\?\.\(canvas\);/.test(analyse)
      && count(/analyseStuckScreen\(activePlugin, apiKey\)/g) === 3);
}

// ── The dialog renders ────────────────────────────────────────────────────────
// check-render.mjs renders the page as it first loads, with no dialog open.
// This renders it open, as the screen handler leaves it with no plugin and as
// the 2048 plugin's win leaves it, so a fault there fails here.
console.log("\nthe decision dialog, rendered");
{
  const { build } = await import("esbuild");
  const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
  const entry = path.join(ROOT, "src", "GameAgent.jsx");
  const CLOSED = "const [pendingDecision, setPendingDecision] = useState(null);";
  const source = fs.readFileSync(entry, "utf8");
  check("the dialog starts closed", source.includes(CLOSED), `expected "${CLOSED}" in GameAgent.jsx`);
  const render = async (open) => {
    const bundlePath = path.join(os.tmpdir(), `game-agent-decision-${process.pid}-${randomUUID()}.mjs`);
    try {
      await build({
        entryPoints: [entry], bundle: true, platform: "node", format: "esm", jsx: "automatic",
        outfile: bundlePath, logLevel: "silent",
        plugins: [{
          name: "open-the-dialog",
          setup(b) {
            // React from the repo's node_modules, outside the bundle (see check-render.mjs).
            b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, a => ({ path: pathToFileURL(requireFromRoot.resolve(a.path)).href, external: true }));
            b.onLoad({ filter: /GameAgent\.jsx$/ }, () => ({
              contents: source.replace(CLOSED, `const [pendingDecision, setPendingDecision] = useState(${JSON.stringify(open)});`),
              loader: "jsx", resolveDir: path.dirname(entry),
            }));
          },
        }],
      });
      const { renderToString } = requireFromRoot("react-dom/server");
      const { createElement } = requireFromRoot("react");
      const mod = await import(pathToFileURL(bundlePath).href);
      return renderToString(createElement(mod.default))
        .replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    } finally {
      fs.rmSync(bundlePath, { force: true });
    }
  };
  try {
    const generic = {
      kind: over.kind, summary: over.summary, score: null, bestTile: 0,
      options: over.options.map(({ id, label }) => ({ id, label })), recommended: over.recommended,
      fallback: st.fallbackChoice(over), playOn: true, deadline: null,
    };
    const html = await render(generic);
    const missing = [
      "Play has stopped — what should the agent do?", "Game over: the board is full.", "New Game", "Try again  (recommended)",
      `value="${st.PLAY_ON}"`, "Keep playing (no click)", "Start the next game", "Stop the session", 'If nobody answers: "Try again".',
    ].filter(text => !html.includes(text));
    check("with no plugin: the controls, the model's pick, keep playing, the next game, stop, and what nobody answering does",
      !missing.length, `missing: ${missing.join(" | ")}`);
    const asked = st.askDecision({ why: st.NO_CROP_WHY });
    const htmlAsk = await render({ kind: asked.kind, summary: asked.summary, options: [], recommended: null, fallback: st.fallbackChoice(asked), playOn: true, deadline: null });
    check("with no crop: why nothing was searched, and nobody answering starts the next game",
      htmlAsk.includes(asked.summary) && htmlAsk.includes("If nobody answers: start the next game.") && htmlAsk.includes("Keep playing (no click)"));
    const win = await render({
      kind: "win", summary: "Won", score: 20480, bestTile: 2048, recommended: "keep-going", fallback: "keep-going", playOn: false, deadline: null,
      options: [{ id: "keep-going", label: "Keep going" }, { id: "try-again", label: "Try again" }],
    });
    check("2048's win, with its plugin: as before, and no keep playing without a click",
      win.includes("Game won — reached the 2048 tile") && win.includes("Keep going  (recommended)") && !win.includes("Keep playing (no click)")
        && win.includes('If nobody answers: "Keep going".'));
  } catch (e) {
    check("the dialog renders", false, e?.errors?.length ? e.errors.map(x => x.text).join("; ") : (e?.stack ?? String(e)));
  }
}

// ── The docs ──────────────────────────────────────────────────────────────────
console.log("\nthe docs");
{
  const setup = fs.readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  const missing = [
    "### When play stops: the screen handler", "Test 20", "decision-ask", "decision-click", "claim-rejected",
    "Keep playing (no click)", "Not looking for the game's buttons", "Crop to game area", "The model said the game is over",
    "The next game was started by the control clicked on the last screen.",
    "claims in a row turned down", st.claimDroppedLine({ outcome: "lost" }), st.claimAcceptedLine({ how: "reported-stuck" }),
    "`refused`", "Continue with Google", "12 a game of their own",
  ].filter(text => !setup.includes(text));
  check("SETUP.md explains the handler with no plugin, its log lines and snapshots, and a test for it", !missing.length, `missing: ${missing.join(" | ")}`);
  check("CLAUDE.md lists this check", claude.includes("tools/check-stuck.mjs"));
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
