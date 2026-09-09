#!/usr/bin/env node
// Exercise the Minesweeper reader against drawn boards.
//
//   node tools/check-minesweeper.mjs
//
// See tools/minesweeper-boards.mjs for what these fixtures do and do not prove.
// In short: they test geometry, covered-vs-opened, mines, flags and extent
// across skins that share no colours; they do NOT test digit identification,
// which is agreement by construction here and only a real screenshot can settle.

import {
  readState, findGrid, resetGrid, contradicts, outcomeOf, describeState,
  renderBoard, levelOf, implausible, chooseMove, MINE, UNKNOWN, FLAG,
} from "../src/plugins/minesweeper.js";
import { drawBoard, sampleBoard, SKINS } from "./minesweeper-boards.mjs";
import { loadFrame, listFrames } from "./real-frames.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const expected = cells => cells.map(row => row.map(
  v => v === null ? UNKNOWN : v === "F" ? FLAG : v === "*" ? MINE : v));

// ── Reading a board, across skins and cell sizes ──────────────────────────────
console.log("reading boards");
for (const skin of Object.keys(SKINS)) {
  for (const pitch of [16, 24, 32]) {
    resetGrid();
    const cells = sampleBoard(16, 30);
    const { canvas, grid } = drawBoard(cells, { skin, pitch });
    const found = findGrid(canvas);
    const geometry = found &&
      found.rows === 16 && found.cols === 30 && found.pitch === pitch &&
      Math.abs(found.x - grid.x) <= 1 && Math.abs(found.y - grid.y) <= 1;
    check(`${skin} @${pitch}px: grid 16×30`, !!geometry,
      found ? `got ${found.rows}×${found.cols} pitch ${found.pitch} at ${found.x},${found.y}` : "no grid");

    resetGrid();
    const state = readState(canvas);
    if (!state || state.rows !== 16 || state.cols !== 30) {
      check(`${skin} @${pitch}px: every square read`, false,
        state ? `read a ${state.rows}×${state.cols} board` : "read returned null");
      continue;
    }
    const want = expected(cells);
    let wrong = null, n = 0;
    for (let r = 0; r < want.length; r++) {
      for (let c = 0; c < want[r].length; c++) {
        if (state.board[r][c] !== want[r][c]) {
          n++;
          wrong ??= `r${r}c${c}: wanted ${want[r][c]}, got ${state.board[r][c]}`;
        }
      }
    }
    check(`${skin} @${pitch}px: every square read`, n === 0, `${n} wrong, first ${wrong}`);
  }
}

// ── Real captures from minesweeper.online ─────────────────────────────────────
// The part the drawn fixtures cannot do. These came off the real site through
// the agent's own capture path, cursor included.
console.log("\nreal captures");
for (const name of listFrames()) {
  resetGrid();
  const { canvas } = loadFrame(name);
  const state = readState(canvas);
  if (!state) {
    check(`${name}: reads`, false, "read returned null");
    continue;
  }
  check(`${name}: Expert board`, state.rows === 16 && state.cols === 30,
    `got ${state.rows}×${state.cols}`);
  // The strongest statement available without hand-labelling 480 squares: a
  // number can never exceed its own count of unopened neighbours. The read this
  // fixture was taken from failed it — a corner 7 beside two adjacent 8s.
  check(`${name}: the board could exist`, implausible(state.board) === null,
    implausible(state.board) ?? "");
  check(`${name}: every square read`, !state.unreadable?.length,
    `${state.unreadable?.length ?? 0} unreadable`);

  const { opened, flags, covered, mines } = (await import("../src/plugins/minesweeper.js")).tally(state.board);
  console.log(`        ${opened} opened, ${flags} flagged, ${covered} covered, ${mines} mines`);
  if (name.includes("lost")) {
    check(`${name}: the lost board shows its mines`, mines > 50, `${mines} mines visible`);
  } else {
    check(`${name}: a live board shows no mines`, mines === 0, `${mines} mines visible`);
    const move = chooseMove(state);
    check(`${name}: the solver finds a move`, !!move, "no move");
    if (move) console.log(`        solver: ${move.reason}`);
  }
}

// ── The other two board shapes ────────────────────────────────────────────────
console.log("\nthe standard levels");
for (const [rows, cols, label] of [[9, 9, "Beginner"], [16, 16, "Intermediate"]]) {
  resetGrid();
  const cells = sampleBoard(rows, cols);
  const { canvas } = drawBoard(cells, { skin: "classic", pitch: 24 });
  const state = readState(canvas);
  const right = state && state.rows === rows && state.cols === cols;
  check(`${label} reads as ${rows}×${cols}`, !!right,
    state ? `got ${state.rows}×${state.cols}` : "read returned null");
  if (right) check(`${label} is recognised by shape`, levelOf(rows, cols)?.label === label);
}

// ── The grid stays locked as the board fills ──────────────────────────────────
// The bug this guards: findGrid measures spacing from where brightness changes,
// so what it sees depends on what is drawn. Re-deriving it every frame let the
// geometry drift as squares opened, and a board sampled a couple of pixels out
// reads as untouched — which is what produced "best guess — 20.6%", the density
// of an empty board, on a board with a hundred squares open.
console.log("\nthe grid survives a filling board");
{
  resetGrid();
  const cells = Array.from({ length: 16 }, () => new Array(30).fill(null));
  const first = drawBoard(cells, { skin: "classic", pitch: 24 });
  const opening = readState(first.canvas);
  check("empty board reads", !!opening && opening.board.flat().every(v => v === UNKNOWN));

  // Open more of it, a stripe at a time, and require the geometry to hold.
  let held = true, note = "";
  for (let step = 1; step <= 8 && held; step++) {
    const filled = sampleBoard(16, 30, { open: step / 8, seed: 11 });
    for (let r = 0; r < 16; r++) for (let c = 0; c < 30; c++) cells[r][c] = filled[r][c];
    const { canvas, grid } = drawBoard(cells, { skin: "classic", pitch: 24 });
    const state = readState(canvas);
    if (!state) { held = false; note = `read failed at step ${step}`; break; }
    if (state.grid.x !== grid.x || state.grid.y !== grid.y || state.grid.pitch !== 24) {
      held = false;
      note = `geometry moved at step ${step}: ${state.grid.x},${state.grid.y} pitch ${state.grid.pitch}`;
    }
  }
  check("geometry holds as squares open", held, note);
}

// ── Contradiction detection ───────────────────────────────────────────────────
console.log("\ncatching a misread");
{
  const a = [[1, 2, UNKNOWN], [UNKNOWN, 0, FLAG]];
  check("a board agrees with itself", contradicts({ board: a }, { board: a }) === null);

  const opened = [[1, 2, 3], [UNKNOWN, 0, FLAG]];
  check("opening a square is progress, not a clash",
    contradicts({ board: a }, { board: opened }) === null);

  const reverted = [[1, UNKNOWN, UNKNOWN], [UNKNOWN, 0, FLAG]];
  check("an opened square going covered is caught",
    /r0c1 was 2, now covered/.test(contradicts({ board: a }, { board: reverted }) ?? ""));

  const renumbered = [[1, 5, UNKNOWN], [UNKNOWN, 0, FLAG]];
  check("a number changing is caught",
    /r0c1 was 2, now 5/.test(contradicts({ board: a }, { board: renumbered }) ?? ""));

  check("a board that changed size is caught",
    /changed size/.test(contradicts({ board: a }, { board: [[1]] }) ?? ""));

  check("nothing to compare against is not a clash",
    contradicts(null, { board: a }) === null);
}

// ── Outcomes, in Minesweeper's terms ──────────────────────────────────────────
console.log("\nreporting an ending");
{
  const blank = (rows, cols, fill) => Array.from({ length: rows }, () => new Array(cols).fill(fill));

  const playing = { board: blank(16, 30, UNKNOWN), rows: 16, cols: 30 };
  playing.board[0][0] = 1;
  check("a live board is playing", outcomeOf(playing).result === "playing");

  const lost = { board: blank(16, 30, UNKNOWN), rows: 16, cols: 30 };
  lost.board[3][4] = MINE;
  const lostOut = outcomeOf(lost);
  check("a revealed mine is a loss", lostOut.result === "lost", JSON.stringify(lostOut));
  check("a loss says how far it got", /opened a mine/.test(lostOut.detail), lostOut.detail);

  const won = { board: blank(16, 30, 0), rows: 16, cols: 30 };
  for (let i = 0; i < 99; i++) won.board[Math.floor(i / 30)][i % 30] = FLAG;
  check("every safe square opened is a win", outcomeOf(won).result === "won");

  check("no 2048 words in the description",
    !/tile|score/i.test(describeState(playing)), describeState(playing));
  check("the level is named", /Expert/.test(describeState(playing)), describeState(playing));
}

// ── Boards that could not exist ───────────────────────────────────────────────
console.log("\ncatching a board that could not exist");
{
  const grid = (rows, cols, fill) => Array.from({ length: rows }, () => new Array(cols).fill(fill));

  const corner = grid(16, 30, UNKNOWN);
  corner[0][0] = 7;
  check("a 7 in a corner is impossible",
    /r0c0 reads 7 but has only 3/.test(implausible(corner) ?? ""), implausible(corner) ?? "accepted");

  // The exact shape the run produced: 1 2 1 1 2 misread as 1 8 1 1 8.
  const row = grid(16, 30, UNKNOWN);
  [1, 8, 1, 1, 8].forEach((v, i) => { row[1][i] = v; });
  check("adjacent 8s are impossible", implausible(row) !== null, "accepted");

  const real = grid(16, 30, UNKNOWN);
  real[5][5] = 3; real[5][6] = 2; real[6][5] = 1;
  check("an ordinary position is accepted", implausible(real) === null, implausible(real) ?? "");

  const cleared = grid(16, 30, 0);
  check("a fully cleared board is accepted", implausible(cleared) === null, implausible(cleared) ?? "");
}

// ── Knowing a new game when it sees one ───────────────────────────────────────
console.log("\nrecognising a fresh board");
{
  const ms = await import("../src/plugins/minesweeper.js");
  const fresh = { board: Array.from({ length: 16 }, () => new Array(30).fill(UNKNOWN)) };
  check("an untouched board is a new game", ms.looksLikeNewGame(fresh));
  const played = { board: fresh.board.map(r => r.slice()) };
  played.board[0][0] = 1;
  check("a board with one square open is not", !ms.looksLikeNewGame(played));
  const flagged = { board: fresh.board.map(r => r.slice()) };
  flagged.board[0][0] = FLAG;
  check("nor is one with a flag on it", !ms.looksLikeNewGame(flagged));

  resetGrid();
  const { canvas } = loadFrame("expert-midgame");
  const state = readState(canvas);
  const park = ms.parkPoint(state);
  const onBoard = park && park.x >= state.grid.x && park.x < state.grid.x + state.cols * state.grid.pitch
    && park.y >= state.grid.y && park.y < state.grid.y + state.rows * state.grid.pitch;
  check("the pointer is parked off the board", !!park && !onBoard, JSON.stringify(park));
}

// ── The board as text ─────────────────────────────────────────────────────────
console.log("\nthe board as text");
{
  const text = renderBoard([[UNKNOWN, 1, 0], [FLAG, MINE, 8]]);
  check("one line per row plus a header", text.split("\n").length === 3, JSON.stringify(text));
  check("every kind of square has a mark", /·/.test(text) && /⚑/.test(text) && /✱/.test(text), text);
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
