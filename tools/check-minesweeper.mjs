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
  renderBoard, levelOf, MINE, UNKNOWN, FLAG,
} from "../src/plugins/minesweeper.js";
import { drawBoard, sampleBoard, SKINS } from "./minesweeper-boards.mjs";

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
    for (let c = 0; c < 30; c++) {
      for (let r = 0; r < Math.min(16, step * 2); r++) cells[r][c] = (r + c) % 5 === 0 ? 0 : ((r + c) % 8) + 1;
    }
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

// ── The board as text ─────────────────────────────────────────────────────────
console.log("\nthe board as text");
{
  const text = renderBoard([[UNKNOWN, 1, 0], [FLAG, MINE, 8]]);
  check("one line per row plus a header", text.split("\n").length === 3, JSON.stringify(text));
  check("every kind of square has a mark", /·/.test(text) && /⚑/.test(text) && /✱/.test(text), text);
}

console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
