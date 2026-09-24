#!/usr/bin/env node
// Sum up logs/episodes.jsonl: how each commit, provider, model and game did,
// with a plugin and without.
//
//   npm run episodes
//   node tools/episodes.mjs [file] [--by commit,provider,model,game,plugin] [--json]
//
// Each line of the file is one game the agent played (the backend writes it,
// POST /episode/game; src/agent/episodes.js says what is in it). Every run
// adds to the same file, so this is where a change is measured: the same game
// before and after a commit, one model against another, a game with a plugin
// against one the model plays alone.
//
// Games are grouped by the columns --by names (all five by default):
//   commit    the page's commit, "+" when it had uncommitted changes, and
//             "/<backend commit>" (with its own "+") when the backend ran other
//             code: another commit, or the same one with or without changes (a
//             run that mixed two versions, which the RUN line warned about)
//   provider, model, game (the game's key: its name as memory stores it)
//   plugin    the plugin whose solver played, or "none" when the model played
//             alone. A solver's games say nothing about the model, and the
//             games with none are the ones that measure the agent on a game it
//             has no plugin for.
// For each group: games; how many ended won, lost, stuck, ended and aborted;
// how many ■ Stop cut short, counted apart (the game did not end, the operator
// ended it); the mean number of turns; and the mean score over the games that
// have one (with how many that is). The outcome counts and the means leave out
// the games ■ Stop cut short: a game stopped after five turns says nothing of
// how long a game lasts or how it goes. Lines that are not JSON are counted and
// skipped.
//
// The file is logs/episodes.jsonl in the project folder, or in AGENT_LOG_DIR
// when that is set, read as the backend reads it (log_dir_from in
// agent_server.py). tools/check-episodes.mjs checks this on
// tools/fixtures/episodes.jsonl.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export const GROUP_BY = Object.freeze(["commit", "provider", "model", "game", "plugin"]);
export const OUTCOME_COLUMNS = Object.freeze(["won", "lost", "stuck", "ended", "aborted"]);

/**
 * The default file: episodes.jsonl in AGENT_LOG_DIR, or in logs/ in the project
 * folder. Read as log_dir_from in agent_server.py reads it: a leading ~ alone or
 * before a slash is the home folder, and a path that is not absolute is taken
 * from the project folder.
 */
export function defaultFile(env = process.env, { home = os.homedir() } = {}) {
  const dir = (env.AGENT_LOG_DIR ?? "").trim();
  if (!dir) return path.join(ROOT, "logs", "episodes.jsonl");
  const expanded = /^~(?:[/\\]|$)/.test(dir) ? path.join(home, dir.slice(1)) : dir;
  const logs = path.isAbsolute(expanded) ? expanded : path.join(ROOT, expanded);
  return path.join(logs, "episodes.jsonl");
}

/** The games in a file's text, and how many lines were not one. */
export function readEpisodes(text) {
  const episodes = [];
  let bad = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) episodes.push(value);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { episodes, bad };
}

/**
 * A game's commit column: the page's commit, + when it had uncommitted
 * changes, and /the backend's (with its own +) when that is not the same.
 */
export function commitOf(e) {
  const page = `${e.pageCommit ?? "unknown"}${e.pageDirty ? "+" : ""}`;
  const backend = `${e.backendCommit ?? "unknown"}${e.backendDirty ? "+" : ""}`;
  return backend === page ? page : `${page}/${backend}`;
}

const COLUMN = {
  commit: commitOf,
  provider: e => e.provider ?? "unknown",
  model: e => e.model ?? "unknown",
  game: e => e.gameKey ?? e.gameDesc ?? "unknown",
  plugin: e => e.plugin ?? "none",
};

const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const isNumber = v => typeof v === "number" && Number.isFinite(v);

/**
 * One row per group, in the order each group first appears in the file (so a
 * newer commit comes after an older one): {key, games, outcomes, stopped,
 * meanTurns, meanScore, scored}. `outcomes` and the means count only the games
 * ■ Stop did not cut short; `stopped` counts those.
 */
export function summarise(episodes, { by = GROUP_BY } = {}) {
  const columns = by.filter(c => COLUMN[c]);
  const groups = new Map();
  for (const e of episodes) {
    const key = Object.fromEntries(columns.map(c => [c, String(COLUMN[c](e))]));
    const id = JSON.stringify(columns.map(c => key[c]));
    if (!groups.has(id)) groups.set(id, { key, games: [] });
    groups.get(id).games.push(e);
  }
  return [...groups.values()].map(({ key, games }) => {
    const played = games.filter(g => g.stopped !== true);
    const outcomes = Object.fromEntries(OUTCOME_COLUMNS.map(o => [o, 0]));
    for (const g of played) if (g.outcome in outcomes) outcomes[g.outcome]++;
    const scores = played.map(g => g.score).filter(isNumber);
    const turns = played.map(g => g.turns).filter(isNumber);
    return {
      key, games: games.length, outcomes, stopped: games.length - played.length,
      meanTurns: mean(turns), meanScore: mean(scores), scored: scores.length,
    };
  });
}

const shown = (v, digits = 1) => (v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(digits));

/** The rows as a plain-text table. */
export function formatTable(rows, { by = GROUP_BY } = {}) {
  const columns = by.filter(c => COLUMN[c]);
  const head = [...columns, "games", ...OUTCOME_COLUMNS, "stopped", "mean turns", "mean score"];
  const body = rows.map(r => [
    ...columns.map(c => r.key[c]),
    String(r.games),
    ...OUTCOME_COLUMNS.map(o => String(r.outcomes[o])),
    String(r.stopped),
    shown(r.meanTurns),
    r.meanScore == null ? "—" : `${shown(r.meanScore)} (${r.scored})`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)));
  const line = cells => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map(w => "-".repeat(w))), ...body.map(line)].join("\n");
}

function parseArgs(argv) {
  const opts = { file: null, by: [...GROUP_BY], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--by") opts.by = String(argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a.startsWith("--by=")) opts.by = a.slice(5).split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.file = a;
  }
  return opts;
}

export function main(argv = process.argv.slice(2), { log = console.log, env = process.env } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(`node tools/episodes.mjs [file] [--by ${GROUP_BY.join(",")}] [--json]`);
    return 0;
  }
  const unknown = opts.by.filter(c => !COLUMN[c]);
  if (unknown.length || !opts.by.length) {
    log(`--by takes some of ${GROUP_BY.join(", ")}${unknown.length ? `, not ${unknown.join(", ")}` : ""}.`);
    return 2;
  }
  const file = opts.file ?? defaultFile(env);
  if (!fs.existsSync(file)) {
    log(`No games recorded yet: ${file} does not exist. It is written as each game ends.`);
    return 1;
  }
  const { episodes, bad } = readEpisodes(fs.readFileSync(file, "utf8"));
  const rows = summarise(episodes, { by: opts.by });
  if (opts.json) {
    log(JSON.stringify({ file, games: episodes.length, skipped: bad, rows }, null, 2));
    return 0;
  }
  log(`${episodes.length} games in ${file}${bad ? ` (${bad} lines skipped: not JSON)` : ""}`);
  if (rows.length) log("\n" + formatTable(rows, { by: opts.by }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
