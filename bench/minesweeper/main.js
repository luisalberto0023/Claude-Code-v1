// ── The local Minesweeper page ────────────────────────────────────────────────
//
// Wires game.js (the rules) and draw.js (the pixels) to the page at
// http://localhost:5173/bench/minesweeper/. See game.js for why the agent plays
// Minesweeper here and not on a public site.
//
//   ?level=beginner|intermediate|expert   the board (Expert when not given)
//   ?seed=N                               a repeatable board: N, then N+1 for
//                                         the next game, and so on
//   ?size=24                              square size in screen pixels (12-48)
//
// Left click opens a square, right click flags it, a middle click (or both
// buttons) on a number opens around it, and the face (or F2) starts a new game.
//
// Everything on the canvas is drawn by draw.js into an ImageData and put on the
// canvas whole; nothing here draws on the canvas itself, so what the node check
// reads is what the screen shows (tools/check-bench.mjs checks that too).
//
// This page is served from the same address as the agent page, so it could ask
// the dev server for anything the agent page can see. It is written for this
// project and loads nothing from anywhere else, and it must stay that way.

import { LEVELS, levelFrom, seedFrom, randomSeed, nextSeed, newGame, reveal, toggleFlag, chord, secondsPlayed } from "./game.js";
import { geometry, drawGame, hit, sizeFrom } from "./draw.js";

const params = new URLSearchParams(location.search);
const level = levelFrom(params.get("level"));
const size = sizeFrom(params.get("size"));
const askedSeed = seedFrom(params.get("seed"));

let seed = askedSeed ?? randomSeed();
let game = newGame(level.key, seed);
let press = null;          // what the held mouse button is on: hit()'s answer
let chording = false;      // the press will open around a number
let shownSecond = -1;

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const geo = geometry(level.rows, level.cols, size);
canvas.width = geo.width;
canvas.height = geo.height;
const image = ctx.createImageData(geo.width, geo.height);

// One canvas pixel to one screen pixel, whatever the display scaling, so the
// squares are exactly `size` pixels on screen and nothing is smoothed.
function fit() {
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${geo.width / ratio}px`;
  canvas.style.height = `${geo.height / ratio}px`;
}

function draw() {
  const now = Date.now();
  shownSecond = secondsPlayed(game, now);
  drawGame(image, game, { size, press: chording ? null : press, now });
  ctx.putImageData(image, 0, 0);
  const status = document.getElementById("status");
  status.textContent = game.status === "lost" ? "Game over: a mine was opened. Click the face to play again."
    : game.status === "won" ? "Board cleared. Click the face to play again."
    : "";
  document.title = `Minesweeper · ${level.label} · board ${game.seed} — game-agent bench`;
  document.getElementById("seed").textContent = String(game.seed);
}

function restart() {
  seed = nextSeed(seed);
  game = newGame(level.key, seed);
  press = null;
  chording = false;
  draw();
}

// Where the pointer is, in canvas pixels.
function at(e) {
  const box = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - box.left) * canvas.width / box.width);
  const y = Math.floor((e.clientY - box.top) * canvas.height / box.height);
  return hit(geo, x, y);
}

canvas.addEventListener("contextmenu", e => e.preventDefault());

canvas.addEventListener("mousedown", e => {
  e.preventDefault();
  const target = at(e);
  if (e.button === 2 && !(e.buttons & 1)) {
    // Flags go on as the button goes down, as they do in the classic game.
    if (target?.kind === "cell") toggleFlag(game, target.r, target.c);
    draw();
    return;
  }
  chording = e.button === 1 || (e.buttons & 3) === 3;
  press = target;
  draw();
});

canvas.addEventListener("mousemove", e => {
  if (!press) return;
  const target = at(e);
  // Dragging off the face lets it go; dragging across squares moves the press.
  press = press.kind === "face" ? (target?.kind === "face" ? target : { kind: "off" }) : target;
  if (!chording) draw();
});

canvas.addEventListener("mouseup", e => {
  if (!press) return;
  const target = at(e);
  const was = press, both = chording;
  press = null;
  chording = false;
  if (was.kind === "face" && target?.kind === "face") return restart();
  if (target?.kind === "cell" && was.kind === "cell" && target.r === was.r && target.c === was.c) {
    if (both) chord(game, target.r, target.c);
    else if (e.button === 0) reveal(game, target.r, target.c);
  }
  draw();
});

canvas.addEventListener("mouseleave", () => {
  if (press) { press = null; chording = false; draw(); }
});

window.addEventListener("keydown", e => {
  if (e.key === "F2") { e.preventDefault(); restart(); }
});

// The timer: drawn again only when the second it shows changes.
setInterval(() => {
  if (game.status === "playing" && secondsPlayed(game) !== shownSecond) draw();
}, 200);

window.addEventListener("resize", fit);

// The ratio can change with no resize event: moved to a display with other
// Windows scaling, the window keeps its size in Windows' own units. A query for
// the ratio now stops matching when it changes, so fit again then, and ask
// about the new ratio.
function watchRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    .addEventListener("change", () => { fit(); watchRatio(); }, { once: true });
}
watchRatio();

// The level links keep the size and seed asked for.
const nav = document.getElementById("levels");
for (const lv of Object.values(LEVELS)) {
  const link = document.createElement("a");
  const next = new URLSearchParams(params);
  next.set("level", lv.key);
  link.href = `?${next}`;
  link.textContent = `${lv.label} (${lv.cols}×${lv.rows}, ${lv.mines} mines)`;
  if (lv.key === level.key) link.setAttribute("aria-current", "page");
  nav.append(link);
}

fit();
draw();
