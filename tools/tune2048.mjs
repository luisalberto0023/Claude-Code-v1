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
  const sorted = scores.slice().sort((a, b) => a - b);
  return {
    params,
    // Judged on how far the games got, averaged over their tiles.
    //
    // Not on the median score, which was the first choice and turned out to be
    // the worst available. Scores here cluster around whether a game managed a
    // 4096, so the middle game sits on one side of that gap or the other and the
    // median jumps 30% between settings whose averages differ by 7% — it reports
    // which side of the gap a single game landed, not which setting is better.
    // The exponent is steady because it is bounded and every game contributes.
    progress: results.reduce((a, r) => a + (r.max ? Math.log2(r.max) : 0), 0) / results.length,
    median: sorted[sorted.length >> 1],
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

// Two independent sets of games. A candidate that looks better on the first has
// to prove it on the second before it takes the lead.
//
// This is not caution for its own sake. A tuning run on 24 games promoted a
// setting that scored 61% above the incumbent there and then came in 30% BELOW
// it on fresh games — the search had simply found weights that suited those
// particular boards. Scores in 2048 vary so widely that a single set of games
// will keep handing out results like that, and a search that chases them walks
// away from a good setting rather than toward a better one.
const searchSeeds = Array.from({ length: GAMES }, (_, i) => 5000 + i);
const checkSeeds = Array.from({ length: GAMES }, (_, i) => 40000 + i);
const rand = rng(20260905);

let best = assess({ ...DEFAULT_TUNING }, searchSeeds);
let bestCheck = assess(best.params, checkSeeds);
console.log(`current : ${fmt(best.params)}`);
console.log(`          progress ${best.progress.toFixed(2)} / ${bestCheck.progress.toFixed(2)} on the two sets, mean ${best.mean}\n`);

for (let round = 1; round <= ROUNDS; round++) {
  // Narrow the search as it goes: broad early, refining around the leader later.
  const strength = 0.55 * (1 - round / (ROUNDS + 1)) + 0.08;
  const params = jitter(best.params, rand, strength);
  const candidate = assess(params, searchSeeds);

  let note = "";
  let promote = false;
  if (candidate.progress > best.progress) {
    // Promising on the first set — check it against the second before believing it.
    const second = assess(params, checkSeeds);
    promote = second.progress > bestCheck.progress;
    note = promote
      ? `   <- leads (holds at ${second.progress.toFixed(2)})`
      : `   (only on one set: ${second.progress.toFixed(2)} vs ${bestCheck.progress.toFixed(2)})`;
    if (promote) { best = candidate; bestCheck = second; }
  }
  console.log(
    `${String(round).padStart(3)}/${ROUNDS}  ${fmt(params).padEnd(46)} ` +
    `progress ${candidate.progress.toFixed(2)}  mean ${String(candidate.mean).padStart(6)}  4096 ${candidate.reached4096}/${candidate.n}${note}`);
}

console.log(`\nBest from the search: ${fmt(best.params)}`);
console.log(`  progress ${best.progress.toFixed(2)}, mean ${best.mean}, 2048 in ${best.reached2048}/${best.n}`);

// Confirm on games the search never saw, so a setting cannot win by having been
// lucky on the seeds it was selected against.
const holdout = Array.from({ length: Math.max(GAMES, 60) }, (_, i) => 90000 + i);
console.log(`\nConfirming on ${holdout.length} fresh games…`);
const incumbentH = assess({ ...DEFAULT_TUNING }, holdout);
const candidateH = assess(best.params, holdout);
const report = r => `progress ${r.progress.toFixed(2)}  mean ${String(r.mean).padStart(6)}  2048 ${r.reached2048}/${r.n}  4096 ${r.reached4096}/${r.n}`;
console.log(`  current : ${report(incumbentH)}`);
console.log(`  tuned   : ${report(candidateH)}`);

const gain = candidateH.progress - incumbentH.progress;
const wins = candidateH.reached4096 >= incumbentH.reached4096;
const accept = gain > 0 && wins;

setTuning(DEFAULT_TUNING);   // leave the module as it was found

if (!accept) {
  console.log(`\nKeeping the current weights — the candidate did not hold up (progress ${gain >= 0 ? "+" : ""}${gain.toFixed(2)}).`);
  process.exit(0);
}
console.log(`\nTuned weights get further (progress +${gain.toFixed(2)}) and reach 4096 at least as often.`);

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
  holdoutProgress: Number(candidateH.progress.toFixed(3)),
  holdoutMedian: candidateH.median,
  holdoutMean: candidateH.mean,
  holdoutGames: candidateH.n,
  reached2048: candidateH.reached2048,
  reached4096: candidateH.reached4096,
  previousProgress: Number(incumbentH.progress.toFixed(3)),
  previousMedian: incumbentH.median,
};
memory[key] = entry;
fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");
console.log(`Stored in ${MEMORY_FILE} — the agent will use these next session.`);
