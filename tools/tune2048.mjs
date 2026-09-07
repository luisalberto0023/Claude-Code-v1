#!/usr/bin/env node
// ── Weight tuning by self-play ────────────────────────────────────────────────
//
// Searches for evaluation weights that play 2048 better than the current ones,
// and writes the result into the agent's memory so it carries into real games.
//
// Two things make the answer trustworthy rather than a coincidence. Every
// candidate plays the SAME games — tile spawns come from a seeded generator, so
// two settings meet identical boards and a difference between them is the
// setting rather than luck, which matters enormously in a game this random. And
// a candidate only replaces the incumbent if it wins a head-to-head over more
// games than the search used, so a setting that merely got a good draw during
// the search does not get promoted on that basis.
//
//   node tools/tune2048.mjs [--games 40] [--rounds 25] [--write]
//
// Without --write it reports what it found and changes nothing.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyMove, isTerminal, chooseMove, setTuning, getTuning, DEFAULT_TUNING,
} from "../src/plugins/game2048.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(HERE, "..", "game-agent-memory.json");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const GAMES = arg("games", 40);
const ROUNDS = arg("rounds", 25);
const WRITE = process.argv.includes("--write");

// Deterministic RNG so a given seed always produces the same game.
function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playGame(seed) {
  const rand = rng(seed);
  const empties = b => {
    const out = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!b[r][c]) out.push([r, c]);
    return out;
  };
  const spawn = b => {
    const e = empties(b);
    if (!e.length) return;
    const [r, c] = e[Math.floor(rand() * e.length)];
    b[r][c] = rand() < 0.9 ? 2 : 4;
  };
  let b = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  spawn(b); spawn(b);
  let score = 0, moves = 0;
  while (moves < 20000 && !isTerminal({ board: b })) {
    const m = chooseMove({ board: b });
    if (!m) break;
    const { board: nb, moved, gained } = applyMove(b, m.key);
    if (!moved) break;
    b = nb; score += gained; spawn(b); moves++;
  }
  let max = 0;
  for (const row of b) for (const v of row) if (v > max) max = v;
  return { score, max };
}

function assess(params, seeds) {
  setTuning(params);
  const results = seeds.map(playGame);
  const scores = results.map(r => r.score);
  return {
    params,
    // Median, not mean: one lucky game should not carry a setting.
    median: scores.slice().sort((a, b) => a - b)[scores.length >> 1],
    mean: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    reached2048: results.filter(r => r.max >= 2048).length,
    reached4096: results.filter(r => r.max >= 4096).length,
    n: seeds.length,
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function jitter(p, rand, strength) {
  const f = () => 1 + (rand() * 2 - 1) * strength;
  return {
    base: p.base,                                   // scales with ratio; left fixed
    ratio: clamp(p.ratio * f(), 1.3, 3.2),
    empty: clamp(p.empty * f(), 500, 120000),
    smooth: clamp(p.smooth * f(), 0, 60000),
  };
}

const fmt = p => `ratio ${p.ratio.toFixed(2)}, empty ${Math.round(p.empty)}, smooth ${Math.round(p.smooth)}`;

console.log(`Tuning 2048 by self-play — ${ROUNDS} candidates x ${GAMES} games each.\n`);

const searchSeeds = Array.from({ length: GAMES }, (_, i) => 5000 + i);
const rand = rng(20260905);

let best = assess({ ...DEFAULT_TUNING }, searchSeeds);
console.log(`current : ${fmt(best.params)}`);
console.log(`          median ${best.median}, mean ${best.mean}, 2048 in ${best.reached2048}/${best.n}\n`);

for (let round = 1; round <= ROUNDS; round++) {
  // Narrow the search as it goes: broad early, refining around the leader later.
  const strength = 0.55 * (1 - round / (ROUNDS + 1)) + 0.08;
  const candidate = assess(jitter(best.params, rand, strength), searchSeeds);
  const better = candidate.median > best.median;
  console.log(
    `${String(round).padStart(3)}/${ROUNDS}  ${fmt(candidate.params).padEnd(46)} ` +
    `median ${String(candidate.median).padStart(6)}  2048 ${candidate.reached2048}/${candidate.n}` +
    (better ? "   <- leads" : ""));
  if (better) best = candidate;
}

console.log(`\nBest from the search: ${fmt(best.params)}`);
console.log(`  median ${best.median}, mean ${best.mean}, 2048 in ${best.reached2048}/${best.n}`);

// Confirm on games the search never saw, so a setting cannot win by having been
// lucky on the seeds it was selected against.
const holdout = Array.from({ length: Math.max(GAMES, 60) }, (_, i) => 90000 + i);
console.log(`\nConfirming on ${holdout.length} fresh games…`);
const incumbentH = assess({ ...DEFAULT_TUNING }, holdout);
const candidateH = assess(best.params, holdout);
const report = r => `median ${String(r.median).padStart(6)}  mean ${String(r.mean).padStart(6)}  2048 ${r.reached2048}/${r.n}  4096 ${r.reached4096}/${r.n}`;
console.log(`  current : ${report(incumbentH)}`);
console.log(`  tuned   : ${report(candidateH)}`);

const gain = candidateH.median - incumbentH.median;
const wins = candidateH.reached2048 >= incumbentH.reached2048;
const accept = gain > 0 && wins;

setTuning(DEFAULT_TUNING);   // leave the module as it was found

if (!accept) {
  console.log(`\nKeeping the current weights — the candidate did not hold up (median ${gain >= 0 ? "+" : ""}${gain}).`);
  process.exit(0);
}
console.log(`\nTuned weights win by ${gain} median points and reach 2048 at least as often.`);

if (!WRITE) {
  console.log("Run again with --write to store this in the agent's memory.");
  process.exit(0);
}

let memory = {};
if (fs.existsSync(MEMORY_FILE)) {
  try { memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")); } catch { memory = {}; }
}
const key = "2048";
const entry = memory[key] || { gameKey: key, gameDesc: "2048" };
entry.tuning = {
  ...best.params,
  measuredAt: new Date().toISOString(),
  holdoutMedian: candidateH.median,
  holdoutMean: candidateH.mean,
  holdoutGames: candidateH.n,
  reached2048: candidateH.reached2048,
  reached4096: candidateH.reached4096,
  previousMedian: incumbentH.median,
};
memory[key] = entry;
fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");
console.log(`Stored in ${MEMORY_FILE} — the agent will use these next session.`);
