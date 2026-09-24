#!/usr/bin/env node
// Check the local Minesweeper under bench/minesweeper/, and that the agent's
// Minesweeper reader reads it.
//
//   node tools/check-bench.mjs
//
// The page replaces minesweeper.online as the Minesweeper test bed (that site's
// rules call any program that clicks on its boards cheating; see
// src/agent/sitePolicy.js). A replacement is only worth having if the agent
// plays it the way it played the site, so the heart of this check is the reader
// in src/plugins/minesweeper.js, unchanged, reading boards that
// bench/minesweeper/draw.js drew into tools/fake-canvas.mjs: the same function,
// the same pixels, that the page puts on its canvas. Nothing here or in draw.js
// was tuned to the reader. If a read fails, that is a finding about the reader
// (or about how the page draws), to be reported, not papered over here.
//
// What it checks:
//   - the rules (game.js): the three levels are the shapes the reader knows,
//     the first click never loses, a seed always gives the same board, flags,
//     chords, a win and a loss behave as in the classic game
//   - the drawing (draw.js): squares are exactly ?size= pixels, clicks map back
//     to the square under them, the number colours are the classic ones
//   - the reader reads an Expert board in the middle of a game exactly, every
//     digit 1 to 8 included, at every square size the page offers; and a fresh
//     board, a lost one, a won one, and the Beginner and Intermediate shapes
//   - the face is found, and a click on it lands on the face
//   - whole games played by the reader and the solver alone: every read along
//     the way exact, every click on the square it was meant for
//   - the page (main.js, index.html) draws only through draw.js and loads
//     nothing from anywhere else
//   - the dev server serves the page at /bench/minesweeper/ (and sends the
//     address without the slash there), without the backend's token in it

import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BENCH = path.join(ROOT, "bench", "minesweeper");
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

const game = await load("bench/minesweeper/game.js");
const draw = await load("bench/minesweeper/draw.js");
const reader = await load("src/plugins/minesweeper.js");
const { solve } = await load("src/plugins/minesweeper-solver.js");
const { createCanvas } = await load("tools/fake-canvas.mjs");
const { UNKNOWN, FLAG, MINE } = reader;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const show = v => JSON.stringify(v);
const cases = (name, list) => {
  const bad = list.filter(([, got, test]) => !test(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check(name, !bad.length, bad.join("; "));
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Where the board sits on the "screen": the page is white around it (as
// index.html is), with the board off the top left corner as it is in a browser
// window. The reader has to find it there, as it does on a real capture.
const AT = { x: 37, y: 131 };
const MARGIN = 48;

/**
 * A screen showing `g`: the board drawn by draw.js straight into a fake canvas
 * of its own size, then put on a white page. Returns {canvas, geo}.
 */
function screenOf(g, { size = draw.SIZE_DEFAULT, now = g.startedAt ?? 0 } = {}) {
  const geo = draw.geometry(g.rows, g.cols, size);
  const board = createCanvas(geo.width, geo.height);
  draw.drawGame(board, g, { size, now });
  const canvas = createCanvas(AT.x + geo.width + MARGIN, AT.y + geo.height + MARGIN);
  const row = geo.width * 4;
  for (let y = 0; y < geo.height; y++) {
    canvas.data.set(board.data.subarray(y * row, (y + 1) * row), ((AT.y + y) * canvas.width + AT.x) * 4);
  }
  return { canvas, geo };
}

// What the reader should say each square is, from the game itself. A flag the
// lost game shows crossed out is drawn as a mine with a red cross, and a mine is
// what it is read as.
const AS_READ = { covered: UNKNOWN, flag: FLAG, mine: MINE, "wrong-flag": MINE };
const truth = g => Array.from({ length: g.rows }, (_, r) => Array.from({ length: g.cols }, (_, c) => {
  const v = game.cellView(g, r, c);
  return v.kind === "open" ? v.n : AS_READ[v.kind];
}));

/** The squares a read got wrong, as "r3c4: 5 read as 8", or [] for none. */
function misread(g, board) {
  const want = truth(g), out = [];
  const name = v => v === UNKNOWN ? "covered" : v === FLAG ? "flag" : v === MINE ? "mine" : String(v);
  if (!board || board.length !== g.rows || board[0]?.length !== g.cols) {
    return [`read a ${board?.length ?? 0}×${board?.[0]?.length ?? 0} board, not ${g.rows}×${g.cols}`];
  }
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      if (board[r][c] !== want[r][c]) out.push(`r${r}c${c}: ${name(want[r][c])} read as ${name(board[r][c])}`);
    }
  }
  return out;
}

/** Read `g` as the agent would: a fresh look, no grid carried over. */
function readFresh(g, opts) {
  const { canvas, geo } = screenOf(g, opts);
  reader.resetGrid();
  const state = reader.readState(canvas);
  return { state, canvas, geo, why: state ? null : (reader.lastReadFailure() ?? "no grid found") };
}

const digitsOn = g => [...new Set(truth(g).flat().filter(v => Number.isInteger(v) && v > 0))].sort();

// An Expert board laid out square by square so that every digit shows: an 8 in
// a ring of eight mines, a 7, 6, 5 and 4 in rings with gaps, and the rest of the
// 99 mines along the bottom rows, where the edge of the opened area shows 1 to 3.
// No random board shows a 7 or an 8 often enough to test them.
function everyDigitBoard() {
  const mines = [];
  const ring = (r, c, gaps = []) => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((dr || dc) && !gaps.some(([gr, gc]) => gr === r + dr && gc === c + dc)) mines.push([r + dr, c + dc]);
      }
    }
  };
  ring(2, 2);
  ring(2, 7, [[3, 8]]);
  ring(2, 12, [[3, 12], [3, 13]]);
  ring(2, 17, [[3, 16], [3, 17], [3, 18]]);
  ring(2, 22, [[2, 23], [3, 21], [3, 22], [3, 23]]);
  const spots = [];
  for (let r = 11; r < 16; r++) for (let c = 0; c < 30; c++) spots.push([r, c]);
  let s = 7;                                            // a fixed shuffle, the same every run
  while (mines.length < 99) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    mines.push(spots.splice(s % spots.length, 1)[0]);
  }
  const g = game.gameWithMines({ rows: 16, cols: 30 }, mines);
  game.reveal(g, 7, 25, 1000);                          // opens the empty middle of the board
  for (const [r, c] of [[2, 2], [2, 7], [2, 12], [2, 17], [2, 22]]) game.reveal(g, r, c, 1000);
  game.toggleFlag(g, 1, 1);
  game.toggleFlag(g, 1, 6);
  game.toggleFlag(g, 12, 0);
  return g;
}

// A seeded Expert game part-way through, played on the truth by the solver's
// certain moves only, so it is an ordinary board of the kind a run meets.
function playedBoard(seed, rounds) {
  const g = game.newGame("expert", seed);
  game.reveal(g, 8, 15, 1000);
  for (let i = 0; i < rounds && g.status === "playing"; i++) {
    const result = solve(truth(g), g.mines);
    if (!result.certain || !result.actions.length) break;
    for (const a of result.actions) {
      if (a.type === "flag") { if (!g.flag[a.r * g.cols + a.c]) game.toggleFlag(g, a.r, a.c); } else game.reveal(g, a.r, a.c, 2000);
    }
  }
  return g;
}

// ── The rules ─────────────────────────────────────────────────────────────────
console.log("the rules (bench/minesweeper/game.js)");
{
  cases("the three levels are the board shapes and mine counts the reader knows", Object.entries(game.LEVELS).map(([key, lv]) => [
    key, { rows: lv.rows, cols: lv.cols, mines: lv.mines, known: reader.levelOf(lv.rows, lv.cols)?.mines },
    got => got.known === got.mines && reader.LEVELS[key]?.rows === got.rows && reader.LEVELS[key]?.cols === got.cols,
  ]));
  check("Expert is the default, as on the real captures", game.DEFAULT_LEVEL === "expert"
    && game.levelFrom("") === game.LEVELS.expert && game.levelFrom("BEGINNER") === game.LEVELS.beginner
    && game.levelFrom("nightmare") === game.LEVELS.expert);

  cases("?seed= takes a whole number as it is, and hashes anything else the same way every time", [
    ["a number", game.seedFrom("42"), v => v === 42],
    ["the largest", game.seedFrom("4294967295"), v => v === 4294967295],
    ["too large is hashed", game.seedFrom("4294967296"), v => Number.isInteger(v) && v !== 4294967296 && v >= 0 && v <= 0xffffffff],
    ["a word", game.seedFrom("monday"), v => v === game.seedFrom("monday") && v !== game.seedFrom("tuesday")],
    ["spaces trimmed", game.seedFrom(" 7 "), v => v === 7],
    ["none", game.seedFrom(""), v => v === null],
    ["missing", game.seedFrom(null), v => v === null],
  ]);
  check("the next game's seed is one more, wrapping at 2^32", game.nextSeed(41) === 42 && game.nextSeed(0xffffffff) === 0);

  // The first click never loses and always opens an area, on every level.
  const bad = [];
  for (const lv of Object.values(game.LEVELS)) {
    for (let seed = 1; seed <= 150; seed++) {
      const g = game.newGame(lv.key, seed);
      const r = seed % lv.rows, c = (seed * 7) % lv.cols;
      game.reveal(g, r, c, 0);
      const mines = g.mine.reduce((a, b) => a + b, 0);
      if (g.status !== "playing" || g.opened < 2 || g.count[r * lv.cols + c] !== 0 || mines !== lv.mines) {
        bad.push(`${lv.key} seed ${seed} first click r${r}c${c}: ${g.status}, ${g.opened} opened, ${mines} mines`);
      }
    }
  }
  check("the first click never loses and opens an area (150 seeds on each level)", !bad.length, bad.slice(0, 3).join("; "));

  const a = game.newGame("expert", 1234), b = game.newGame("expert", 1234), other = game.newGame("expert", 1235);
  game.reveal(a, 5, 5, 0); game.reveal(b, 5, 5, 0); game.reveal(other, 5, 5, 0);
  check("the same seed and first click give the same board; the next seed another",
    a.mine.join("") === b.mine.join("") && a.mine.join("") !== other.mine.join(""));

  // Flags, chords, a loss and a win on a board chosen square by square:
  //   row 0: mine at c0; row 2: mine at c3
  const g = game.gameWithMines({ rows: 5, cols: 5 }, [[0, 0], [2, 3]]);
  game.reveal(g, 1, 1, 1000);
  check("a number opens alone", g.opened === 1 && game.cellView(g, 1, 1).n === 1, show(game.cellView(g, 1, 1)));
  check("a flag goes on a covered square and off again, and not on an opened one",
    game.toggleFlag(g, 0, 0) && game.minesLeft(g) === 1 && !game.toggleFlag(g, 1, 1)
      && game.toggleFlag(g, 0, 1) && game.minesLeft(g) === 0 && game.toggleFlag(g, 0, 1) && game.minesLeft(g) === 1);
  check("a flagged square does not open", !game.reveal(g, 0, 0, 1000) && game.cellView(g, 0, 0).kind === "flag");
  game.chord(g, 1, 1, 1000);
  check("a chord opens around a number with its mines flagged", ["open", "open", "open"]
    .every((k, i) => game.cellView(g, [0, 1, 2][i], [1, 0, 0][i]).kind === k), show(game.cellView(g, 0, 1)));
  check("the timer stops at 999", game.secondsPlayed({ startedAt: 0, endedAt: null }, 5_000_000) === game.MAX_SECONDS
    && game.secondsPlayed(game.newGame("beginner", 1), 99999) === 0);

  const lose = game.gameWithMines({ rows: 5, cols: 5 }, [[0, 0], [2, 3]]);
  game.reveal(lose, 4, 0, 1000);
  game.toggleFlag(lose, 1, 3);                          // a flag with no mine under it
  game.reveal(lose, 2, 3, 2000);
  check("opening a mine loses, shows every mine, and crosses out a wrong flag",
    lose.status === "lost" && game.cellView(lose, 2, 3).exploded === true && game.cellView(lose, 0, 0).kind === "mine"
      && game.cellView(lose, 1, 3).kind === "wrong-flag" && !game.reveal(lose, 4, 4, 3000),
    show({ status: lose.status, hit: game.cellView(lose, 2, 3), flag: game.cellView(lose, 1, 3) }));

  const win = game.gameWithMines({ rows: 5, cols: 5 }, [[0, 0], [2, 3]]);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (!win.mine[r * 5 + c]) game.reveal(win, r, c, 1000);
  check("opening every safe square wins, with every mine flagged", win.status === "won" && game.minesLeft(win) === 0
    && game.cellView(win, 0, 0).kind === "flag", show({ status: win.status, left: game.minesLeft(win) }));
}

// ── The drawing ───────────────────────────────────────────────────────────────
console.log("\nthe drawing (bench/minesweeper/draw.js)");
{
  check("the classic number colours: 1 blue, 2 green, 3 red, 4 navy, 5 maroon, 6 teal, 7 black, 8 grey",
    show(draw.NUMBER_COLOURS) === show({
      1: [0, 0, 255], 2: [0, 128, 0], 3: [255, 0, 0], 4: [0, 0, 128],
      5: [128, 0, 0], 6: [0, 128, 128], 7: [0, 0, 0], 8: [128, 128, 128],
    }), show(draw.NUMBER_COLOURS));
  cases("?size= is 24 unless it asks for 12 to 48", [
    ["none", draw.sizeFrom(null), v => v === 24 && draw.SIZE_DEFAULT === 24],
    ["30", draw.sizeFrom("30"), v => v === 30],
    ["too small", draw.sizeFrom("4"), v => v === draw.SIZE_MIN && v === 12],
    ["too large", draw.sizeFrom("500"), v => v === draw.SIZE_MAX && v === 48],
    ["not a number", draw.sizeFrom("big"), v => v === 24],
  ]);

  // Every square is `size` pixels, and a click anywhere on it finds it.
  const bad = [];
  for (const size of [draw.SIZE_MIN, 17, draw.SIZE_DEFAULT, draw.SIZE_MAX]) {
    const geo = draw.geometry(16, 30, size);
    if (geo.grid.w !== 30 * size || geo.grid.h !== 16 * size || geo.grid.size !== size) bad.push(`${size}: grid ${geo.grid.w}×${geo.grid.h}`);
    for (const [r, c] of [[0, 0], [15, 29], [7, 13]]) {
      for (const [dx, dy] of [[0, 0], [size - 1, size - 1], [size >> 1, size >> 1]]) {
        const h = draw.hit(geo, geo.grid.x + c * size + dx, geo.grid.y + r * size + dy);
        if (h?.kind !== "cell" || h.r !== r || h.c !== c) bad.push(`${size}: r${r}c${c}+${dx},${dy} hit ${show(h)}`);
      }
    }
    const face = draw.hit(geo, geo.face.x + (geo.face.w >> 1), geo.face.y + (geo.face.h >> 1));
    if (face?.kind !== "face") bad.push(`${size}: the face's middle hit ${show(face)}`);
    if (draw.hit(geo, 0, 0) !== null || draw.hit(geo, geo.grid.x - 1, geo.grid.y) !== null) bad.push(`${size}: the frame hit something`);
    if (geo.face.y + geo.face.h > geo.grid.y || geo.face.x < geo.grid.x) bad.push(`${size}: the face is not over the grid`);
  }
  check("squares are exactly ?size= pixels, and a click on a square or the face finds it", !bad.length, bad.slice(0, 3).join("; "));

  const g = game.newGame("beginner", 1);
  const small = createCanvas(10, 10);
  let refused = null;
  try { draw.drawGame(small, g); } catch (e) { refused = e.message; }
  check("drawing refuses a canvas of the wrong size", /needs a \d+×\d+ target/.test(refused ?? ""), refused ?? "drew");

  // A number is painted in its colour, on the flat grey of an opened square.
  const d = everyDigitBoard();
  const { canvas, geo } = screenOf(d);
  const painted = n => {
    const board = truth(d);
    const r = board.findIndex(row => row.includes(n));
    if (r < 0) return false;
    const c = board[r].indexOf(n);
    const x0 = AT.x + geo.grid.x + c * geo.size, y0 = AT.y + geo.grid.y + r * geo.size;
    const seen = new Set();
    for (let y = y0; y < y0 + geo.size; y++) for (let x = x0; x < x0 + geo.size; x++) seen.add(canvas.get(x, y).join(","));
    return seen.has(draw.NUMBER_COLOURS[n].join(","));
  };
  const unpainted = [1, 2, 3, 4, 5, 6, 7, 8].filter(n => !painted(n));
  check("each number is painted in its own colour", !unpainted.length, `not found for ${unpainted.join(", ")}`);
}

// ── The reader reads the page ─────────────────────────────────────────────────
// src/plugins/minesweeper.js as it is, on pixels drawn by draw.js as the page
// draws them. A failure here is a finding about the reader or the drawing.
console.log("\nthe Minesweeper reader on the local page");
{
  const d = everyDigitBoard();
  check("the test board is an Expert game in progress, with every digit 1 to 8 on it",
    d.status === "playing" && d.rows === 16 && d.cols === 30 && d.mines === 99 && digitsOn(d).join("") === "12345678"
      && truth(d).flat().includes(FLAG), `${d.status}, digits ${digitsOn(d).join("")}`);
  for (const size of [12, 16, 20, 24, 28, 32, 40, 48]) {
    const { state, why } = readFresh(d, { size });
    const wrong = state ? misread(d, state.board) : [why];
    const where = !state || state.grid.pitch === size ? "" : ` (read as ${state.grid.pitch}px squares)`;
    check(`every square of it reads exactly at ${size}px squares${size === draw.SIZE_DEFAULT ? " (the default)" : ""}`,
      !!state && !wrong.length && !state.unreadable?.length && !where,
      state ? `${wrong.length} wrong${where}: ${wrong.slice(0, 4).join("; ")}` : `not read: ${why}`);
  }

  const SEEDS = [3, 6, 7];
  const played = SEEDS.map(seed => playedBoard(seed, 12));
  const playedWrong = played.flatMap((g, i) => {
    const { state, why } = readFresh(g);
    return (state ? misread(g, state.board) : [why]).map(w => `seed ${SEEDS[i]}: ${w}`);
  });
  check("seeded Expert games part-way through read exactly", !playedWrong.length
    && played.every(g => g.status === "playing" && g.opened > 100),
    playedWrong.slice(0, 4).join("; ") || show(played.map(g => [g.status, g.opened])));

  const fresh = readFresh(game.newGame("expert", 9));
  check("a fresh board reads as untouched, and as a new game",
    !!fresh.state && fresh.state.board.flat().every(v => v === UNKNOWN) && reader.looksLikeNewGame(fresh.state), fresh.why ?? "");

  for (const lv of [game.LEVELS.beginner, game.LEVELS.intermediate]) {
    const g = game.newGame(lv.key, 5);
    game.reveal(g, 4, 4, 1000);
    const { state, why } = readFresh(g);
    const wrong = state ? misread(g, state.board) : [why];
    check(`${lv.label} reads exactly, and is recognised by its shape`, !wrong.length
      && reader.levelOf(state.rows, state.cols)?.label === lv.label, wrong.slice(0, 3).join("; "));
  }

  const lost = playedBoard(3, 12);
  const coveredSafe = lost.mine.findIndex((m, i) => !m && !lost.open[i] && !lost.flag[i]);
  game.toggleFlag(lost, Math.floor(coveredSafe / 30), coveredSafe % 30);        // a wrong flag
  const mineAt = lost.mine.findIndex((m, i) => m && !lost.flag[i]);
  game.reveal(lost, Math.floor(mineAt / 30), mineAt % 30, 3000);
  const lostRead = readFresh(lost);
  check("a lost board reads exactly (every mine shown as a mine) and as lost",
    lost.status === "lost" && !!lostRead.state && !misread(lost, lostRead.state.board).length
      && reader.outcomeOf(lostRead.state).result === "lost",
    lostRead.state ? misread(lost, lostRead.state.board).slice(0, 3).join("; ") || reader.outcomeOf(lostRead.state).detail : lostRead.why);

  const won = game.gameWithMines({ rows: 16, cols: 30 }, [...Array(99)].map((_, i) => [Math.floor(i / 30) * 5, i % 30]));
  for (let i = 0; i < 480; i++) if (!won.mine[i]) game.reveal(won, Math.floor(i / 30), i % 30, 1000);
  const wonRead = readFresh(won);
  check("a won board reads exactly and as won", won.status === "won" && !!wonRead.state
    && !misread(won, wonRead.state.board).length && reader.outcomeOf(wonRead.state).result === "won",
    wonRead.state ? reader.outcomeOf(wonRead.state).detail : wonRead.why);

  // One size for each face it wears: playing, lost (dead) and won (sunglasses).
  const faces = [[d, draw.SIZE_MIN], [lost, draw.SIZE_DEFAULT], [won, draw.SIZE_MAX]].map(([g, size]) => {
    const { state, canvas, geo } = readFresh(g, { size });
    const face = state && reader.findRestartButton(canvas, state.grid);
    const at = face && draw.hit(geo, face.x - AT.x, face.y - AT.y);
    return at?.kind === "face" ? null : `${size}px, ${g.status}: ${show(face)} → ${show(at)}`;
  }).filter(Boolean);
  check("the reader finds the face, playing, lost and won, and a click there lands on it", !faces.length, faces.join("; "));
}

// ── Whole games, played by the reader and the solver ─────────────────────────
// What a run does: look, choose, click, look again. The clicks go through
// draw.js's hit(), as the page's mouse handlers do, and every read is compared
// with the game itself, so one misread anywhere in a game fails the check.
console.log("\nwhole games: read, choose, click");
{
  // Two games, so the new game started from the face is played too. Both were
  // won when this was written; a solver change can make one a loss, which is
  // fine as long as one of them is won.
  const SEEDS = [1, 2];
  const ends = [];
  let reads = 0, clicks = 0, problem = null;
  let g = game.newGame("expert", SEEDS[0]);
  for (let n = 0; n < SEEDS.length && !problem; n++) {
    if (n > 0) {
      // A new game, as the agent starts one: find the face and click it.
      const { state, canvas, geo } = readFresh(g);
      const face = state && reader.findRestartButton(canvas, state.grid);
      const at = face && draw.hit(geo, face.x - AT.x, face.y - AT.y);
      if (at?.kind !== "face") { problem = `game ${n + 1}: the face was not found (${show(face)})`; break; }
      g = game.newGame("expert", SEEDS[n]);             // the page's restart(), with this game's seed
    }
    reader.resetGrid();
    for (let step = 0; step < 600 && (g.status === "ready" || g.status === "playing"); step++) {
      const { canvas, geo } = screenOf(g);
      const state = reader.readState(canvas);
      reads++;
      if (!state) { problem = `seed ${SEEDS[n]}, read ${step + 1}: ${reader.lastReadFailure() ?? "no grid"}`; break; }
      const wrong = misread(g, state.board);
      if (wrong.length) { problem = `seed ${SEEDS[n]}, read ${step + 1}: ${wrong.slice(0, 3).join("; ")}`; break; }
      if (step === 0 && !reader.looksLikeNewGame(state)) { problem = `seed ${SEEDS[n]}: the new board did not look new`; break; }
      const move = reader.chooseMove(state);
      if (!move) { problem = `seed ${SEEDS[n]}, read ${step + 1}: the solver found no move`; break; }
      for (const a of move.actions) {
        clicks++;
        const at = draw.hit(geo, a.x - AT.x, a.y - AT.y);
        const [, r, c] = /r(\d+)c(\d+)$/.exec(a.label) ?? [];
        if (at?.kind !== "cell" || at.r !== +r || at.c !== +c) { problem = `seed ${SEEDS[n]}: "${a.label}" clicked ${show(at)}`; break; }
        if (a.button === "right") { if (!g.flag[at.r * g.cols + at.c]) game.toggleFlag(g, at.r, at.c); } else game.reveal(g, at.r, at.c, 1000 + step);
        if (g.status === "won" || g.status === "lost") break;
      }
      if (problem) break;
    }
    if (problem) break;
    const last = readFresh(g);
    const said = last.state && reader.outcomeOf(last.state).result;
    if (said !== g.status) { problem = `seed ${SEEDS[n]}: the game was ${g.status}, the reader said ${said ?? last.why}`; break; }
    ends.push(`${SEEDS[n]}:${g.status}`);
  }
  check(`${SEEDS.length} Expert games played to the end, every read exact and every click on its square`,
    !problem && ends.length === SEEDS.length, problem ?? ends.join(" "));
  check("at least one of them won (the whole way round works, not only losing)", ends.some(e => e.endsWith(":won")), ends.join(" "));
  console.log(`        ${ends.join(", ")} — ${reads} reads, ${clicks} clicks`);
}

// ── The page ──────────────────────────────────────────────────────────────────
console.log("\nthe page (bench/minesweeper/main.js, index.html)");
{
  const code = file => fs.readFileSync(path.join(BENCH, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");     // comments out
  const main = code("main.js");
  const html = fs.readFileSync(path.join(BENCH, "index.html"), "utf8");
  const imports = [...main.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
  check("main.js imports only the game and the drawing, from its own folder",
    show(imports.sort()) === show(["./draw.js", "./game.js"]), show(imports));
  const used = [...new Set([...main.matchAll(/\bctx\.(\w+)/g)].map(m => m[1]))].sort();
  check("the canvas gets only what draw.js drew (createImageData and putImageData, nothing drawn by the browser)",
    show(used) === show(["createImageData", "putImageData"]) && /drawGame\(image,/.test(main), show(used));
  const reaching = ["main.js", "game.js", "draw.js"].flatMap(f => {
    const c = code(f);
    return [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\s*\(/, /https?:\/\//, /localStorage|sessionStorage|indexedDB/, /document\.cookie/]
      .filter(re => re.test(c)).map(re => `${f}: ${re}`);
  });
  check("the game loads nothing, sends nothing and stores nothing: it is served beside the agent page", !reaching.length, reaching.join("; "));
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  check("index.html loads ./main.js and nothing from anywhere else",
    scripts.length === 1 && /type="module"/.test(scripts[0]) && /src="\.\/main\.js"/.test(scripts[0])
      && !/<link\b|https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, "")), show(scripts));
  check("the page around the board is white, not grey (the reader finds the board as the largest flat grey)",
    /body\s*\{[^}]*background:\s*#fff\b/.test(html), "expected body { background: #fff }");
  check("the level links, seed and square size are read from the address",
    /params\.get\("level"\)/.test(main) && /params\.get\("seed"\)/.test(main) && /params\.get\("size"\)/.test(main));
  check("one canvas pixel is one screen pixel, whatever the display scaling, and when it changes with no resize",
    /devicePixelRatio/.test(main) && /canvas\.style\.width = `\$\{geo\.width \/ ratio\}px`/.test(main)
      && /window\.addEventListener\("resize", fit\)/.test(main)
      && /matchMedia\(`\(resolution: \$\{window\.devicePixelRatio \|\| 1\}dppx\)`\)\s*\.addEventListener\("change", \(\) => \{ fit\(\); watchRatio\(\); \}, \{ once: true \}\)/.test(main)
      && /\nwatchRatio\(\);/.test(main));
}

// ── Served by the dev server ──────────────────────────────────────────────────
// The project's vite.config.js, in middleware mode on a free local port, with a
// temp folder as the root holding a copy of the game and a test token, so the
// real .agent-token is never read.
console.log("\nserved at /bench/minesweeper/");
{
  const bench = await load("tools/vite-bench.mjs");
  const token = await load("tools/vite-agent-token.mjs");
  cases("only the agent page is given the backend's token", [
    ["/", token.isAgentPage("/"), v => v === true],
    ["/index.html", token.isAgentPage("/index.html"), v => v === true],
    ["/index.html?x=1", token.isAgentPage("/index.html?x=1"), v => v === true],
    ["the game", token.isAgentPage("/bench/minesweeper/index.html"), v => v === false],
    ["another page", token.isAgentPage("/other.html"), v => v === false],
    ["nothing", token.isAgentPage(undefined), v => v === false],
  ]);
  cases("an address without the slash goes to the one with it, and only for a game that exists", [
    ["no slash", bench.benchRedirect("/bench/minesweeper", ROOT), v => v === "/bench/minesweeper/"],
    ["with a query", bench.benchRedirect("/bench/minesweeper?seed=4&level=beginner", ROOT), v => v === "/bench/minesweeper/?seed=4&level=beginner"],
    ["already has it", bench.benchRedirect("/bench/minesweeper/", ROOT), v => v === null],
    ["no such game", bench.benchRedirect("/bench/tetris", ROOT), v => v === null],
    ["a path out", bench.benchRedirect("/bench/..", ROOT), v => v === null],
    ["elsewhere", bench.benchRedirect("/minesweeper", ROOT), v => v === null],
  ]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "game-agent-bench-"));
  const testToken = "T".repeat(20) + "bench" + "k".repeat(20);
  try {
    fs.mkdirSync(path.join(tmp, "bench", "minesweeper"), { recursive: true });
    for (const f of fs.readdirSync(BENCH)) fs.copyFileSync(path.join(BENCH, f), path.join(tmp, "bench", "minesweeper", f));
    fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><html><head><title>Game Agent</title></head><body></body></html>");
    fs.writeFileSync(path.join(tmp, token.TOKEN_FILE_NAME), testToken);

    const { createServer, resolveConfig } = await import("vite");
    const inline = { configFile: path.join(ROOT, "vite.config.js"), root: tmp, logLevel: "silent" };
    const vite = await createServer({ ...inline, appType: "spa",
      server: { middlewareMode: true, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
    let listener = null;
    try {
      listener = http.createServer(vite.middlewares);
      await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${listener.address().port}`;
      const get = async url => {
        const reply = await fetch(base + url, { redirect: "manual" });
        return { status: reply.status, location: reply.headers.get("location"), type: reply.headers.get("content-type") ?? "", text: await reply.text() };
      };
      const [bare, query, page, script, agent] = await Promise.all([
        get("/bench/minesweeper"), get("/bench/minesweeper?seed=4"), get("/bench/minesweeper/"),
        get("/bench/minesweeper/main.js"), get("/"),
      ]);
      check("/bench/minesweeper is sent on to /bench/minesweeper/, query and all",
        bare.status === 302 && bare.location === "/bench/minesweeper/" && query.status === 302 && query.location === "/bench/minesweeper/?seed=4",
        show([bare.status, bare.location, query.status, query.location]));
      check("/bench/minesweeper/ is the game, with no backend token in it",
        page.status === 200 && page.text.includes('<canvas id="board">') && page.text.includes("./main.js")
          && !page.text.includes("__AGENT_TOKEN__") && !page.text.includes(testToken),
        `${page.status}: ${page.text.slice(0, 160)}`);
      check("its script is served", script.status === 200 && /javascript/.test(script.type) && script.text.includes("drawGame"),
        `${script.status} ${script.type}`);
      check("the agent page still gets the token", agent.status === 200 && agent.text.includes(`window.__AGENT_TOKEN__ = "${testToken}";`),
        `${agent.status}: ${agent.text.slice(0, 160)}`);
    } finally {
      await new Promise(resolve => (listener ? listener.close(resolve) : resolve()));
      await vite.close();
    }
    const built = await resolveConfig(inline, "build");
    check("npm run build builds the agent page only: the bench pages are for the dev server",
      !built.plugins.some(p => p.name === "bench-pages") && built.build.rollupOptions?.input === undefined,
      show(built.build.rollupOptions?.input));
  } catch (e) {
    check("the dev server serves the bench page", false, e?.stack ?? String(e));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
