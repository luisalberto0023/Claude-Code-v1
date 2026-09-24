// ── Which code ran, with what, and how each game went ─────────────────────────
//
// No log said which commit wrote it, which provider and model played, or with
// what settings: only the control scheme was logged, and the session id was a
// bare timestamp. The test PC gets code only through git pull, and a backend
// started before a pull keeps running the old code while a reloaded page runs
// the new, so a run could not even be tied to one version of the agent, let
// alone compared with another. A game's result was a line of log text.
//
// So every run is stamped. At ▶ Start the page logs a RUN line with its own
// commit and the backend's (and says loudly when they differ), and the backend
// writes logs/runs/<session>/run.json with the run's settings. Each game played
// adds one line to logs/episodes.jsonl, every run into the same file, which
// tools/episodes.mjs sums up by commit, provider, model and game. That is what
// lets a number from one run on a game the agent has never seen be set beside
// another: same game, other model; same model, other commit.
//
// This module builds those records; agent_server.py ("Run records") writes
// them, adding its own commit. The turn records are in turnClock.js, and how
// they all reach the backend in logQueue.js. tools/check-episodes.mjs checks
// this module.

import { normalizeOutcome } from "./outcomes.js";
import { sitePolicyLabel } from "./sitePolicy.js";

// ── Versions ──────────────────────────────────────────────────────────────────

const text = v => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * A version as git-version.mjs and the backend's GET /version give it,
 * {commit, commitFull, dirty, branch, source, error}, or null when `value` is
 * not one.
 */
export function readVersion(value) {
  if (!value || typeof value !== "object" || !("commit" in value)) return null;
  const commit = text(value.commit);
  return {
    commit,
    commitFull: text(value.commitFull),
    dirty: typeof value.dirty === "boolean" ? value.dirty : null,
    branch: text(value.branch),
    source: text(value.source),
    error: commit ? null : (text(value.error) ?? "unknown"),
  };
}

/* global __AGENT_VERSION__ */
// The page's own commit, from git (tools/git-version.mjs): in `npm run dev` the
// dev server puts it in the page again on every load, so a page reloaded after a
// pull names the commit it now runs; `npm run build` fixes it in with a define.
// Read once, when the page loads, which holds because the page's code changes
// only then: hot updates are off (vite.config.js). Anything that bundles the
// page without Vite (the checks) has none.
export const PAGE_VERSION = readVersion(typeof __AGENT_VERSION__ === "undefined" ? null : __AGENT_VERSION__)
  ?? readVersion({ commit: null, error: "the page was not built by Vite from a git checkout" });

/** A version as the RUN line says it: 842fa64, 842fa64+changes, or unknown. */
export function versionLabel(version) {
  if (!version?.commit) return "unknown";
  return `${version.commit}${version.dirty ? "+changes" : ""}`;
}

function sameCommit(a, b) {
  if (a.commitFull && b.commitFull) return a.commitFull === b.commitFull;
  return a.commit === b.commit;
}

// What the operator does about either one being out of date.
const RESTART = "Close the backend window and the start.bat window, run start.bat again, and reload this tab.";

/**
 * What is wrong with the page's and the backend's versions for this run, as
 * {type, text} for the log, or null when both are known and the same.
 * `backend` is readVersion of the backend's GET /version reply (null when it
 * gave none), and `failure` what that reply said instead.
 */
export function versionProblem(page, backend, { failure = null } = {}) {
  if (!backend) {
    return {
      type: "error",
      text: `⚠ The backend did not say which commit it runs${failure ? ` (${failure})` : ""}: it is older than this page, ` +
        `or not answering. ${RESTART} Until then, this run's records cannot say which backend played it.`,
    };
  }
  if (page?.commit && backend.commit && !sameCommit(page, backend)) {
    return {
      type: "error",
      text: `⚠ VERSION MISMATCH: this page is at ${page.commit} but the backend runs ${backend.commit}. ` +
        `A backend keeps the code it started with, so one of them is out of date and this run tests neither ` +
        `commit alone. ${RESTART} The run's records carry both commits.`,
    };
  }
  if (!page?.commit) {
    return { type: "warn", text: `This page does not know its commit (${page?.error ?? "unknown"}): its records say "unknown".` };
  }
  if (!backend.commit) {
    return { type: "warn", text: `The backend could not read its commit (${backend.error}): its records say "unknown".` };
  }
  // One commit, but tracked files changed on one side only: edited after the
  // backend started (and the tab reloaded), or put back since. Either may run
  // code the other has not. Where git could not tell (dirty null), say nothing.
  if (typeof page.dirty === "boolean" && typeof backend.dirty === "boolean" && page.dirty !== backend.dirty) {
    return {
      type: "warn",
      text: `⚠ The page and the backend are both at ${page.commit}, but ${page.dirty
        ? "the page has uncommitted changes the backend did not start with"
        : "the backend started with uncommitted changes the page no longer has"}: one of them may run other code. ${RESTART}`,
    };
  }
  return null;
}

// ── The run ───────────────────────────────────────────────────────────────────

/**
 * A new run's id, which names its log file, its snapshot folder and its run
 * records: the start time (UTC, as the session id always was) and four hex
 * digits, so a run restarted within the same second gets files of its own.
 */
export function runSessionId(date = new Date(), random = Math.random) {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tag = Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
  return `${stamp}-${tag}`;
}

/**
 * A short hash of the memory text a run put in its prompt, or null when it put
 * none: two games with the same hash were played knowing the same things.
 * 32-bit FNV-1a over the UTF-8 bytes, as eight hex digits; enough to tell
 * memories apart, and quick to compute anywhere.
 */
export function memoryHash(memoryText) {
  const s = String(memoryText ?? "").trim();
  if (!s) return null;
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// What run.json holds, in this order. The backend adds its own commit
// ("backend"), the record's format and when it was written.
//   controlScheme  {id, label}             timing  {profile, label, confirmDelay,
//   ollama         {relay, base} or null            actionPace, mouseSpeed, typingInterval}
//   plugin         the plugin's short name, or null when the model plays
//   sitePolicy     why this game may be played unattended: {kind: "local-bench",
//                  url} or {kind: "acknowledged", …} (src/agent/sitePolicy.js)
export const RUN_FIELDS = Object.freeze([
  "session", "startedAt", "page", "provider", "model", "controlScheme", "jsonMode", "captureSource",
  "frameWidth", "frameQuality", "imageCap", "windowTurns", "strategyInterval", "grid", "crop", "timing",
  "pauseToThink", "plugin", "useSolver", "skipResearch", "maxTokens", "gameDesc", "gameKey",
  "gamesRequested", "ollama", "sitePolicy",
]);

/** The body of run.json for a run: RUN_FIELDS, each null when not given. */
export function runRecord(run) {
  return Object.fromEntries(RUN_FIELDS.map(k => [k, run?.[k] ?? null]));
}

/** The RUN line that opens a run's log: which code, which model, which settings. */
export function runHeader(run) {
  const t = run?.timing ?? {};
  const parts = [
    `page ${versionLabel(run?.page)}, backend ${run?.backend ? versionLabel(run.backend) : "unknown"}`,
    `${run?.provider ?? "?"} ${run?.model ?? "?"}`,
    run?.controlScheme?.label ?? run?.controlScheme?.id ?? "?",
    run?.jsonMode ? "JSON actions" : "tool calls",
    `frame ${run?.frameWidth ?? "?"}px, ${run?.imageCap ?? "?"} image${run?.imageCap === 1 ? "" : "s"}, ${run?.windowTurns ?? "?"}-turn window`,
    `timing ${t.label ?? t.profile ?? "?"} (confirm ${t.confirmDelay ?? "?"} ms, pace ${t.actionPace ?? "?"} ms)`,
    run?.plugin ? `plugin ${run.plugin}` : "no plugin",
    `"${run?.gameDesc ?? ""}", ${run?.gamesRequested ?? 1} game${run?.gamesRequested === 1 ? "" : "s"}`,
    sitePolicyLabel(run?.sitePolicy),
  ];
  return `RUN ${run?.session ?? "?"} — ${parts.join(" · ")}`;
}

// ── One game ──────────────────────────────────────────────────────────────────

// Where a game's score came from. "measured": the agent read it itself (a
// plugin's board, the game's own score on screen). "model": the model said so
// (signal_game_end, report_progress, a JSON action's "score"), which a small
// model has got wildly wrong before. "none": no score.
export const SCORE_SOURCES = Object.freeze(["measured", "model", "none"]);

function asScore(value) {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * A game's score and where it came from, in the games loop's own order: the
 * score the game's end reported when there is one, else the running score. A
 * source that was not recorded counts as the model's, the less trusted.
 */
export function scoreOf({ reported = null, reportedSource = null, current = null, currentSource = null } = {}) {
  const [value, source] = reported != null ? [reported, reportedSource] : [current, currentSource];
  const score = asScore(value);
  if (score == null) return { score: null, scoreSource: "none" };
  return { score, scoreSource: source === "measured" ? "measured" : "model" };
}

/**
 * One game's line for logs/episodes.jsonl. `run` is what the RUN line was
 * built from (plus memoryHash); the backend adds the session, its own commit
 * and when it wrote the line. `startedAt` and `endedAt` are Date.now() values.
 * `stopped` marks a game ■ Stop ended before anything else did: it is recorded
 * as "ended", as the games loop always has, and this tells it apart from a game
 * that ended by itself.
 */
export function gameRecord({ run, game, outcome, turns, startedAt, endedAt, score = null, scoreSource = null,
                             stuckReason = null, snapshots = [], stopped = false }) {
  const scored = scoreOf({ current: score, currentSource: scoreSource });
  return {
    game,
    outcome: normalizeOutcome(outcome) ?? "ended",
    stopped: stopped === true,
    turns: Math.max(0, Math.round(turns ?? 0)),
    durationMs: Math.max(0, Math.round((endedAt ?? 0) - (startedAt ?? 0))),
    score: scored.score,
    scoreSource: scored.scoreSource,
    stuckReason: stuckReason ? String(stuckReason).slice(0, 500) : null,
    snapshots: [...new Set((snapshots ?? []).filter(s => typeof s === "string"))].slice(0, 200),
    memoryHash: run?.memoryHash ?? null,
    gameDesc: run?.gameDesc ?? null,
    gameKey: run?.gameKey ?? null,
    plugin: run?.plugin ?? null,
    provider: run?.provider ?? null,
    model: run?.model ?? null,
    pageCommit: run?.page?.commit ?? null,
    pageDirty: run?.page?.dirty ?? null,
    gamesRequested: run?.gamesRequested ?? null,
    startedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
  };
}
