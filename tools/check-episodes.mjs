#!/usr/bin/env node
// Check the run records: what each run, game and turn writes, and how it gets
// to disk.
//
//   node tools/check-episodes.mjs
//
// No log used to say which commit wrote it, which provider and model played or
// with what settings, a game's result was a line of text, only the model's reply
// was timed, and a log batch the backend did not take was dropped without a
// word. So this checks, on the modules themselves (no page, no backend, no
// provider, no real input):
//   - src/agent/episodes.js: the page's commit and the backend's are compared as
//     they should be (a mismatch is an error that says to restart start.bat),
//     a run's id, run.json's fields, the RUN line, where a game's score came
//     from, and a game's line for logs/episodes.jsonl
//   - src/agent/turnClock.js: a turn's time is split by phase, outermost first,
//     with the tokens, inputs, screen changes and replies the page could not
//     use that the turn noted
//   - src/agent/logQueue.js: a batch that did not get through goes back in the
//     queue in order, bounded, a request the backend will never take (or keeps
//     crashing on) is dropped and said once, and a log line is cut on screen only
//   - the page's caps and names are agent_server.py's (the typed game record,
//     the score sources, the routes, the request caps)
//   - tools/git-version.mjs reads a commit from git or from .git's files, and
//     never throws; npm run dev puts it in the page on every load and sends no
//     hot updates, so a tab's code and commit change together (and a pull
//     without a restart shows as a mismatch), and npm run build fixes it in
//   - tools/episodes.mjs sums up tools/fixtures/episodes.jsonl as expected
// tools/check_backend.py checks the backend's side (its commit, the /episode
// routes), and tools/check-agent.mjs how the page is wired to these.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

const ep = await load("src/agent/episodes.js");
const tc = await load("src/agent/turnClock.js");
const lq = await load("src/agent/logQueue.js");
const backendJs = await load("src/agent/backend.js");
const { OUTCOMES } = await load("src/agent/outcomes.js");
const gv = await load("tools/git-version.mjs");
const sums = await load("tools/episodes.mjs");
const py = fs.readFileSync(path.join(ROOT, "agent_server.py"), "utf8");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);
// Cases as [label, got, ok(got)]; fails with the labels whose check failed.
const cases = (name, list) => {
  const bad = list.filter(([, got, ok]) => !ok(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check(name, !bad.length, bad.join("; "));
};

// ── Versions ──────────────────────────────────────────────────────────────────
console.log("versions");
{
  const full = "0123456789abcdef0123456789abcdef01234567";
  const v = (commit, extra = {}) => ep.readVersion({ commit, commitFull: commit ? `${commit}${full.slice(7)}` : null,
    dirty: false, branch: "b", source: "git", error: commit ? null : "no git", ...extra });
  const page = v("0123456"), backend = v("0123456"), other = v("fedcba9"), unknown = v(null);
  cases("a version is read from what git-version.mjs and GET /version give, and nothing else is one", [
    ["a version", ep.readVersion({ commit: "0123456", commitFull: full, dirty: true, branch: "main", source: "git", startedAt: "x" }),
      r => same(r, { commit: "0123456", commitFull: full, dirty: true, branch: "main", source: "git", error: null })],
    ["an older backend's 404", ep.readVersion({ detail: "Not Found" }), r => r === null],
    ["no reply", ep.readVersion({ ok: false, error: "no reply from the backend" }), r => r === null],
    ["nothing", [ep.readVersion(null), ep.readVersion("0123456")], r => same(r, [null, null])],
    ["a commit git could not read", ep.readVersion({ commit: null, error: "git is not on PATH; no .git" }),
      r => r?.commit === null && r.error === "git is not on PATH; no .git"],
  ]);
  check("a page not built by Vite knows it has no commit, and says why",
    ep.PAGE_VERSION?.commit === null && /not built by Vite/.test(ep.PAGE_VERSION.error ?? ""), show(ep.PAGE_VERSION));
  cases("the RUN line shows a version as its commit, + changes, or unknown", [
    ["clean", ep.versionLabel(page), r => r === "0123456"],
    ["dirty", ep.versionLabel(v("0123456", { dirty: true })), r => r === "0123456+changes"],
    ["unknown", [ep.versionLabel(unknown), ep.versionLabel(null)], r => same(r, ["unknown", "unknown"])],
  ]);
  const mismatch = ep.versionProblem(page, other);
  const old = ep.versionProblem(page, null, { failure: "Not Found" });
  cases("the page and the backend on different commits is an error that says to restart start.bat", [
    ["same commit", ep.versionProblem(page, backend), r => r === null],
    ["same commit, both with changes", ep.versionProblem(v("0123456", { dirty: true }), v("0123456", { dirty: true })), r => r === null],
    ["same commit, the page changed since the backend started", ep.versionProblem(v("0123456", { dirty: true }), backend),
      r => r?.type === "warn" && /both at 0123456/.test(r.text) && /page has uncommitted changes/.test(r.text) && /start\.bat/.test(r.text)],
    ["same commit, the backend's changes since put back", ep.versionProblem(page, v("0123456", { dirty: true })),
      r => r?.type === "warn" && /backend started with uncommitted changes/.test(r.text)],
    ["same commit, changes unknown on one side", ep.versionProblem(v("0123456", { dirty: null }), v("0123456", { dirty: true })), r => r === null],
    ["different commits", mismatch, r => r?.type === "error" && /MISMATCH/.test(r.text) && r.text.includes("0123456")
      && r.text.includes("fedcba9") && /start\.bat/.test(r.text)],
    ["same short commit, different full ones", ep.versionProblem(page, { ...backend, commitFull: `0123456${"f".repeat(33)}` }),
      r => r?.type === "error"],
    ["a backend with no /version", old, r => r?.type === "error" && r.text.includes("Not Found") && /older than this page/.test(r.text)
      && /start\.bat/.test(r.text)],
    ["a page with no commit", ep.versionProblem(unknown, backend), r => r?.type === "warn" && r.text.includes("no git")],
    ["a backend with no commit", ep.versionProblem(page, unknown), r => r?.type === "warn" && /backend could not read/.test(r.text)],
  ]);
}

// ── A run ─────────────────────────────────────────────────────────────────────
console.log("a run");
{
  const id = ep.runSessionId(new Date("2026-09-23T14:05:33.900Z"), () => 0.5);
  const ids = new Set([0, 0.25, 0.5, 0.999].map(r => ep.runSessionId(new Date("2026-09-23T14:05:33Z"), () => r)));
  check("a run's id is its start time and four hex digits, so two runs in one second get their own files",
    id === "2026-09-23-14-05-33-8000" && ids.size === 4 && [...ids].every(x => /^[0-9-]+-[0-9a-f]{4}$/.test(x)), show([id, ...ids]));

  cases("the memory hash tells memories apart, the same one alike, and is null for none (FNV-1a)", [
    ["known values", [ep.memoryHash("a"), ep.memoryHash("foobar")], r => same(r, ["e40c292c", "bf9cf968"])],
    ["space around it does not count", ep.memoryHash("\n\nPRIOR KNOWLEDGE:\nx  "), r => r === ep.memoryHash("PRIOR KNOWLEDGE:\nx")],
    ["no memory", [ep.memoryHash(""), ep.memoryHash("  \n"), ep.memoryHash(null)], r => same(r, [null, null, null])],
    ["not ASCII", ep.memoryHash("héllo"), r => /^[0-9a-f]{8}$/.test(r) && r !== ep.memoryHash("hello")],
  ]);

  const settings = {
    session: id, startedAt: "2026-09-23T14:05:33.000Z", page: ep.readVersion({ commit: "0123456" }),
    backend: ep.readVersion({ commit: "0123456" }), provider: "ollama", model: "qwen2.5vl:3b",
    controlScheme: { id: "browser-kbm", label: "🌐 Browser · KB/Mouse" }, jsonMode: true, captureSource: "browser",
    frameWidth: 640, frameQuality: 0.6, imageCap: 1, windowTurns: 6, strategyInterval: 1, grid: true, crop: false,
    timing: { profile: "arcade", label: "Arcade", confirmDelay: 1000, actionPace: 200, mouseSpeed: 0.1, typingInterval: 0.02 },
    pauseToThink: false, plugin: null, useSolver: true, skipResearch: false, maxTokens: 150000,
    gameDesc: "Tetris", gameKey: "tetris", gamesRequested: 3, ollama: { relay: true, base: "http://192.0.2.10:11434" },
    notAField: "left out",
  };
  const run = ep.runRecord(settings);
  // What the scope asks run.json to hold, each under its name here.
  const asked = ["page", "provider", "model", "controlScheme", "jsonMode", "frameWidth", "imageCap", "windowTurns", "timing",
    "plugin", "gameDesc", "gamesRequested"];
  check("run.json holds the page's commit, provider, model, scheme, JSON mode, frame width, image cap, window, timing, plugin, game and games",
    asked.every(k => ep.RUN_FIELDS.includes(k)) && same(Object.keys(run), [...ep.RUN_FIELDS])
      && run.timing.confirmDelay === 1000 && run.timing.profile === "arcade" && run.plugin === null && !("notAField" in run)
      && !("backend" in run),
    show(run));
  check("a field not given is null in run.json, not missing", same(ep.runRecord({}), Object.fromEntries(ep.RUN_FIELDS.map(k => [k, null]))),
    show(ep.runRecord({})));
  const header = ep.runHeader(settings);
  check("the RUN line names the run, both commits, the model, the settings and the game",
    header.startsWith(`RUN ${id} — page 0123456, backend 0123456`) && header.includes("ollama qwen2.5vl:3b")
      && header.includes(" · 🌐 Browser · KB/Mouse · JSON actions") && header.includes("frame 640px, 1 image, 6-turn window")
      && header.includes("timing Arcade (confirm 1000 ms, pace 200 ms)") && header.includes("no plugin") && header.includes('"Tetris", 3 games'),
    header);
  check("the RUN line says which plugin plays, and an unknown backend",
    /plugin 2048/.test(ep.runHeader({ ...settings, plugin: "2048", backend: null })) && /backend unknown/.test(ep.runHeader({ ...settings, backend: null })),
    ep.runHeader({ ...settings, plugin: "2048", backend: null }));
}

// ── One game ──────────────────────────────────────────────────────────────────
console.log("a game");
{
  cases("a game's score is the reported one first, as the loop's own, and says where it came from", [
    ["measured end", ep.scoreOf({ reported: 1234, reportedSource: "measured", current: 99, currentSource: "model" }),
      r => same(r, { score: 1234, scoreSource: "measured" })],
    ["the model's end", ep.scoreOf({ reported: 1234, reportedSource: "model", current: 99, currentSource: "measured" }),
      r => same(r, { score: 1234, scoreSource: "model" })],
    ["no end score: the running one", ep.scoreOf({ reported: null, current: 99, currentSource: "measured" }),
      r => same(r, { score: 99, scoreSource: "measured" })],
    ["a source never recorded counts as the model's", ep.scoreOf({ current: 5 }), r => same(r, { score: 5, scoreSource: "model" })],
    ["a number as text", ep.scoreOf({ reported: "42", reportedSource: "model" }), r => same(r, { score: 42, scoreSource: "model" })],
    ["no score", [ep.scoreOf({}), ep.scoreOf({ reported: "lots", current: 3 })],
      r => same(r, [{ score: null, scoreSource: "none" }, { score: null, scoreSource: "none" }])],
  ]);
  const run = { page: { commit: "0123456", dirty: true }, provider: "gemini", model: "gemini-3.8-flash", plugin: "2048",
    gameDesc: "2048", gameKey: "2048", gamesRequested: 2, memoryHash: "0badc0de" };
  const game = ep.gameRecord({ run, game: 2, outcome: "won", turns: 41.6, startedAt: 1_000_000, endedAt: 1_061_500,
    score: 2048, scoreSource: "measured", stuckReason: null, snapshots: ["a.png", "a.png", "b.txt", 7] });
  check("a game's line holds its number, outcome, turns, duration, score and source, stuck reason, snapshots, memory, model and commit",
    same(game, {
      game: 2, outcome: "won", stopped: false, turns: 42, durationMs: 61500, score: 2048, scoreSource: "measured", stuckReason: null,
      snapshots: ["a.png", "b.txt"], memoryHash: "0badc0de", gameDesc: "2048", gameKey: "2048", plugin: "2048",
      provider: "gemini", model: "gemini-3.8-flash", pageCommit: "0123456", pageDirty: true, gamesRequested: 2,
      startedAt: new Date(1_000_000).toISOString(),
    }), show(game));
  const outcomes = ["win", "Won", "lost", "stuck", "aborted", "victory", null].map(o => ep.gameRecord({ run, game: 1, outcome: o }).outcome);
  check("a game's outcome is one of the shared names ('win' is 'won', anything else 'ended')",
    same(outcomes, ["won", "won", "lost", "stuck", "aborted", "ended", "ended"]) && outcomes.every(o => OUTCOMES.includes(o)), show(outcomes));
  const stoppedGame = ep.gameRecord({ run, game: 1, outcome: "ended", stopped: true });
  check("a game ■ Stop ended is \"ended\", and marked as stopped",
    stoppedGame.outcome === "ended" && stoppedGame.stopped === true && ep.gameRecord({ run, game: 1, outcome: "ended", stopped: "yes" }).stopped === false,
    show(stoppedGame));
  const bare = ep.gameRecord({ run: null, game: 1, outcome: "stuck", turns: -3, stuckReason: "x".repeat(900) });
  check("a game with no run, no score and a long stuck reason still makes a valid line",
    bare.turns === 0 && bare.score === null && bare.scoreSource === "none" && bare.stuckReason.length === 500
      && bare.pageCommit === null && bare.startedAt === null, show(bare));

  // What the backend types (GameRecord in agent_server.py) is in every line.
  const typed = py.match(/^class GameRecord\(BaseModel\):([\s\S]*?)^class /m)?.[1] ?? "";
  const fields = [...typed.matchAll(/^    (\w+): /gm)].map(m => m[1]).filter(f => f !== "model_config");
  check("every field the backend's GameRecord types is in a game's line",
    fields.length >= 8 && fields.every(f => f in game), `backend types ${show(fields)}`);
  const sources = py.match(/^ScoreSource\s*=\s*Literal\[([^\]]*)\]/m)?.[1];
  const pySources = sources ? [...sources.matchAll(/["']([^"']+)["']/g)].map(m => m[1]) : null;
  check("the score sources are the backend's", same(pySources, [...ep.SCORE_SOURCES]), show({ backend: pySources, page: ep.SCORE_SOURCES }));
}

// ── A turn ────────────────────────────────────────────────────────────────────
console.log("a turn");
{
  let now = 1000;
  const turn = tc.startTurn({ kind: "model", turn: 7, game: 2, now: () => now, clock: () => Date.UTC(2026, 8, 23, 12) });
  const tick = ms => { now += ms; };
  // The model: 100 ms, of which nothing else counts.
  let done = turn.enter("llm"); tick(100);
  turn.enter("backend")(); tick(5); // opened inside llm: times nothing
  done();
  tick(3); // the page's own work
  // A click: 20 ms at the backend, then a 50 ms confirm wait with a 10 ms grab inside it.
  done = turn.enter("backend"); tick(20); done();
  done = turn.enter("confirm"); tick(15);
  const grab = turn.enter("capture"); tick(10); grab();
  tick(25); done();
  done = turn.enter("pace"); tick(200); done();
  done(); // ended twice: nothing more
  turn.enter("thinking")(); // not a phase
  // A capture left open when the turn ends counts up to the end.
  turn.enter("capture"); tick(7);
  turn.note({ usage: { in: 100, out: 20, cached: null } });
  turn.note({ usage: { in: 50, out: 5, cached: 30 } });
  turn.note({ usage: null });
  turn.note({ input: true }); turn.note({ input: false }); turn.note({ input: true });
  turn.note({ tools: 1 }); turn.note({ tools: 1 });
  turn.note({ changed: false }); turn.note({ changed: true }); turn.note({ changed: false });
  turn.note({ image: true });
  turn.note({ violation: "\"fly\" is not one of the tools offered" }); turn.note({ violation: "no JSON action in the reply" });
  const record = turn.finish({ kind: "action" });
  tick(1000);
  turn.note({ input: true });
  const again = turn.finish({ kind: "stopped" });
  check("a turn's time is split by phase, outermost first, and the rest is other_ms",
    same(record, {
      turn: 7, game: 2, kind: "model", result: "action", at: "2026-09-23T12:00:00.000Z",
      ms: 385, capture_ms: 7, llm_ms: 105, backend_ms: 20, confirm_ms: 50, pace_ms: 200, other_ms: 3,
      tokens_in: 150, tokens_out: 25, tokens_cached: 30, image: true, tools: 2, actions: 2, changed: true,
      schemaViolation: "\"fly\" is not one of the tools offered; no JSON action in the reply",
    }), show(record));
  check("a finished turn stays as it was", again === record && record.actions === 2, show(again));

  let t2 = 0;
  const quiet = tc.startTurn({ kind: "plugin", turn: 1, game: 1, now: () => t2 }).finish({ ok: true, changed: false });
  check("a turn that noted nothing has no tokens, no screen change, and no tool calls for a plugin",
    quiet.tokens_in === null && quiet.tokens_cached === null && quiet.changed === null && quiet.image === null
      && quiet.tools === null && quiet.actions === 0 && quiet.schemaViolation === null && quiet.result === "move", show(quiet));
  const unchanged = tc.startTurn({ kind: "plugin", now: () => t2 });
  unchanged.note({ changed: false });
  check("a turn whose actions all changed nothing says so", unchanged.finish({ ok: true }).changed === false);

  cases("what a turn came to, in a word", [
    ["model", ["action", "game-ended", "transport-error", "fatal-error", "stopped"].map(k => tc.turnResultName("model", { kind: k })),
      r => same(r, ["action", "game-ended", "transport-error", "fatal-error", "stopped"])],
    ["plugin", [{ halted: true }, { stuck: true }, { gameOver: true }, { ok: true }, { fallback: true }, {}].map(x => tc.turnResultName("plugin", x)),
      r => same(r, ["halted", "stuck", "game-over", "move", "fallback", "error"])],
    ["a turn that threw", [tc.turnResultName("model", null), tc.turnResultName("plugin", undefined)], r => same(r, ["error", "error"])],
  ]);
  cases("input routes are backend time and actions; the rest are neither", [
    ["timed", ["/mouse/click", "/keyboard/press", "/gamepad/button", "/game/speed"].map(tc.backendPhase),
      r => r.every(x => x === "backend")],
    ["not timed", ["/session/state", "/log/append", "/episode/turns", "/capture/frame", "/llm/ollama", "/mouse", null].map(tc.backendPhase),
      r => r.every(x => x === null)],
    ["actions", ["/mouse/move", "/keyboard/type", "/gamepad/stick", "/game/speed", "/session/halt"].map(tc.sendsInput),
      r => same(r, [true, true, true, false, false])],
  ]);
}

// ── The queues ────────────────────────────────────────────────────────────────
console.log("getting lines and records to disk");
{
  cases("the on-screen log cuts a long line, the file gets it whole", [
    ["cut", lq.onScreen("abcdef", 3), r => r === "abc…"],
    ["short enough", lq.onScreen("abc", 3), r => r === "abc"],
    ["no limit", [lq.onScreen("abcdef", null), lq.onScreen("abcdef", NaN), lq.onScreen(null, 3)], r => same(r, ["abcdef", "abcdef", ""])],
  ]);
  cases("a batch that may get through later is retried, one the backend will never take is dropped", [
    ["written", lq.sendVerdict({ ok: true }), r => r === "sent"],
    ["no answer", [lq.sendVerdict({ ok: false, error: "no reply from the backend (HTTP 500, empty)" }), lq.sendVerdict(undefined),
      lq.sendVerdict({ ok: false, error: "disk full" })], r => r.every(x => x === "retry")],
    ["the page's token refused (reload)", lq.sendVerdict({ ok: false, refused: "token", detail: "x", error: "x" }), r => r === "retry"],
    ["over a cap", lq.sendVerdict({ ok: false, tooLarge: true, error: "over" }), r => r === "drop"],
    ["a body refused", lq.sendVerdict({ detail: [{ loc: ["body", "x"], msg: "bad" }] }), r => r === "drop"],
    ["a route an older backend lacks", lq.sendVerdict({ detail: "Not Found" }), r => r === "drop"],
  ]);

  const q = { items: ["n1", "n2"], dropped: 0 };
  const dropped = lq.putBack(q, ["u1", "u2", "u3"], { max: 3 });
  check("what did not get through goes back in front, and the oldest go when the queue is full",
    dropped === 2 && same(q.items, ["u3", "n1", "n2"]) && q.dropped === 2, show(q));
  const kept = { items: [{ kind: "turn", n: 4 }, { kind: "game", n: 5 }], dropped: 0 };
  lq.putBack(kept, [{ kind: "run", n: 1 }, { kind: "turn", n: 2 }, { kind: "turn", n: 3 }], { max: 3, keep: lq.keepRecord });
  check("a full record queue drops turns before a run's or a game's record",
    same(kept.items.map(i => i.n), [1, 4, 5]) && kept.dropped === 2, show(kept));
  const all = { items: [], dropped: 0 };
  lq.putBack(all, [{ kind: "run", n: 1 }, { kind: "game", n: 2 }, { kind: "game", n: 3 }], { max: 2, keep: lq.keepRecord });
  check("...and the oldest of those when nothing else is left", same(all.items.map(i => i.n), [2, 3]), show(all));

  const lines = [
    ...Array.from({ length: 1001 }, (_, i) => ({ session: "a", line: `a${i}` })),
    { session: "b", line: "b0" }, { session: "a", line: "a-again" },
  ];
  const lineBatches = lq.logLineBatches(lines);
  check("log lines go in batches of one session each, within the backend's caps, each with the lines it came from",
    same(lineBatches.map(b => [b.path, b.body.session, b.body.lines.length, b.items.length]),
      [["/log/append", "a", 1000, 1000], ["/log/append", "a", 1, 1], ["/log/append", "b", 1, 1], ["/log/append", "a", 1, 1]])
      && lineBatches[3].body.lines[0] === "a-again" && lineBatches.every(b => same(b.items.map(i => i.line), b.body.lines)),
    show(lineBatches.map(b => [b.body.session, b.body.lines.length])));

  const rec = (kind, session, n) => ({ session, kind, record: { n } });
  const recs = [rec("run", "s1", 0), ...Array.from({ length: 1001 }, (_, i) => rec("turn", "s1", i + 1)),
    rec("game", "s1", 9), rec("turn", "s1", 10), rec("turn", "s2", 11), rec("nonsense", "s1", 12)];
  const recBatches = lq.recordBatches(recs);
  check("records go as one request per run or game, and turns of one session together within the caps, in order",
    same(recBatches.map(b => [b.path, b.body.session, b.items.length]), [
      ["/episode/run", "s1", 1], ["/episode/turns", "s1", 1000], ["/episode/turns", "s1", 1], ["/episode/game", "s1", 1],
      ["/episode/turns", "s1", 1], ["/episode/turns", "s2", 1]])
      && same(recBatches[0].body, { session: "s1", run: { n: 0 } }) && same(recBatches[3].body, { session: "s1", game: { n: 9 } })
      && same(recBatches[2].body.records, [{ n: 1001 }]) && recBatches.every(b => !("bytes" in b)),
    show(recBatches.map(b => [b.path, b.items.length])));
  // What the backend counts against TURN_RECORDS_MAX_BYTES: each line as it
  // writes it, {"format":1,...} added, and its newline.
  const backendBytes = batch => batch.body.records
    .reduce((n, r) => n + new TextEncoder().encode(JSON.stringify({ format: 1, ...r })).length + 1, 0);
  // Two of these fit by the page's own count, but not once the backend has
  // stamped each line.
  const half = Array.from({ length: 3 }, (_, i) => ({ session: "s", kind: "turn",
    record: { note: "x".repeat(lq.TURN_RECORDS_MAX_BYTES / 2 - 23), i } }));
  const halves = lq.recordBatches(half);
  check("turn records are split by bytes too, as the backend counts them (its stamp on each line included)",
    same(halves.map(b => b.items.length), [1, 1, 1]) && 2 * (JSON.stringify(half[0].record).length + 1) <= lq.TURN_RECORDS_MAX_BYTES,
    show(halves.map(b => [b.items.length, backendBytes(b)])));
  const many = Array.from({ length: 3000 }, (_, i) => ({ session: "s", kind: "turn",
    record: { turn: i, note: "é".repeat(100 + (i * 37) % 600), ms: i * 1.5 } }));
  const packed = lq.recordBatches(many);
  check("every batch of turn records is within the backend's caps as it counts them, and none is lost",
    packed.length > 1 && packed.every(b => b.items.length <= lq.TURN_RECORDS_MAX && backendBytes(b) <= lq.TURN_RECORDS_MAX_BYTES)
      && packed.reduce((n, b) => n + b.items.length, 0) === many.length,
    show(packed.map(b => [b.items.length, backendBytes(b)])));

  // drainQueue with a stand-in backend that takes the first batch, refuses the
  // second for good, and does not answer the third; a line is logged meanwhile.
  const queue = lq.newQueue();
  queue.items.push(...["x1", "x2", "x3", "x4"].map(line => ({ session: "s", line })));
  const replies = [{ ok: true }, { detail: "Not Found" }, { ok: false, error: "no reply" }];
  const sent = [];
  const out = await lq.drainQueue(queue, {
    plan: items => items.map(it => ({ items: [it], path: "/log/append", body: { lines: [it.line] } })),
    send: async batch => { sent.push(batch.body.lines[0]); queue.items.push({ session: "s", line: `new-${sent.length}` }); return replies.shift(); },
    max: 10,
  });
  check("a flush sends in order, drops what is refused for good, and puts back what did not get through ahead of what came since",
    same(sent, ["x1", "x2", "x3"]) && out.sent === 1 && out.refused.length === 1 && out.refused[0].reason === "Not Found"
      && out.waiting === "no reply" && same(queue.items.map(i => i.line), ["x3", "x4", "new-1", "new-2", "new-3"]),
    show({ sent, out: { ...out, refused: out.refused.map(r => r.reason) }, queue: queue.items.map(i => i.line) }));
  const thrown = lq.newQueue();
  thrown.items.push({ session: "s", line: "y" });
  const outThrown = await lq.drainQueue(thrown, { plan: lq.logLineBatches, send: async () => { throw new Error("aborted"); } });
  check("a write that timed out (or threw) is sent again later", outThrown.waiting === "aborted" && thrown.items.length === 1, show(outThrown));
  check("an empty queue sends nothing", (await lq.drainQueue(lq.newQueue(), { plan: () => { throw new Error("planned"); }, send: null })).sent === 0);

  // A route that raises on one batch (uvicorn's plain "Internal Server Error")
  // fails the same way at every flush, and used to hold back everything queued
  // after it for as long as the page was open.
  cases("a server error with no JSON is a crash; an empty one (the backend down, Vite's proxy answering) is not", [
    ["crashed", backendJs.readReply(500, "Internal Server Error"), r => r.crashed === true && r.ok === false && /HTTP 500/.test(r.error)],
    ["down", [backendJs.readReply(500, ""), backendJs.readReply(502, " \n")], r => r.every(x => !("crashed" in x) && x.ok === false)],
    ["not a server error", backendJs.readReply(404, "Not Found"), r => !("crashed" in r)],
    ["JSON", backendJs.readReply(500, "{\"ok\":false,\"error\":\"disk full\"}"), r => same(r, { ok: false, error: "disk full" })],
  ]);
  const crashy = lq.newQueue();
  crashy.items.push(...["bad", "next"].map(line => ({ session: "s", line })));
  const crashPlan = items => items.map(it => ({ items: [it], path: "/log/append", body: { lines: [it.line] } }));
  const crashSent = [];
  const crashReply = line => (line === "bad" ? backendJs.readReply(500, "Internal Server Error") : { ok: true });
  const flushes = [];
  for (let n = 0; n < lq.CRASH_RETRIES; n++) {
    flushes.push(await lq.drainQueue(crashy, { plan: crashPlan, send: async b => { crashSent.push(b.body.lines[0]); return crashReply(b.body.lines[0]); } }));
  }
  const last = flushes[flushes.length - 1];
  check(`a batch the backend crashes on ${lq.CRASH_RETRIES} flushes in a row is dropped and said, and what waited behind it goes`,
    flushes.slice(0, -1).every(f => f.sent === 0 && f.waiting && !f.refused.length)
      && last.refused.length === 1 && /Internal Server Error, 5 times in a row/.test(last.refused[0].reason) && last.sent === 1
      && crashSent.filter(l => l === "next").length === 1 && crashy.items.length === 0 && crashy.crashes === null,
    show({ flushes: flushes.map(f => [f.sent, f.waiting, f.refused.map(r => r.reason)]), crashSent, left: crashy.items }));
  const down = lq.newQueue();
  down.items.push({ session: "s", line: "waiting" });
  for (let n = 0; n < lq.CRASH_RETRIES * 3; n++) {
    await lq.drainQueue(down, { plan: crashPlan, send: async () => backendJs.readReply(500, "") });
  }
  const between = lq.newQueue();
  between.items.push({ session: "s", line: "bad" });
  const replies2 = [...Array(lq.CRASH_RETRIES - 1).fill("crash"), "down", ...Array(lq.CRASH_RETRIES - 1).fill("crash")];
  for (const r of replies2) {
    await lq.drainQueue(between, { plan: crashPlan, send: async () => backendJs.readReply(500, r === "crash" ? "Internal Server Error" : "") });
  }
  check("a backend that is down, however long, drops nothing, and a crash count starts again after anything else",
    down.items.length === 1 && down.crashes === null && between.items.length === 1 && between.crashes?.count === lq.CRASH_RETRIES - 1,
    show({ down, between: between.crashes }));

  const logQueue = { items: [], dropped: 12 };
  const recordQueue = { items: [], dropped: 3 };
  const notes = lq.flushNotes({
    lines: { sent: 5, refused: [{ batch: { items: [1, 2] }, reason: "lines: bad" }] },
    records: { sent: 1, refused: [{ batch: { items: [1], path: "/episode/turns" }, reason: "Not Found" }] },
    logQueue, recordQueue,
  });
  check("a flush says what was dropped for room once lines get through, and what the backend refused, keyed to say once",
    notes.length === 4 && /12 log lines were dropped/.test(notes[0].text) && notes[0].key === null
      && notes[1].key === "lines:lines: bad" && /3 run records/.test(notes[2].text)
      && notes[3].key === "records:/episode/turns:Not Found" && /restart start\.bat/.test(notes[3].text)
      && logQueue.dropped === 0 && recordQueue.dropped === 0, show(notes));
  const waiting = { items: [], dropped: 4 };
  check("nothing is said of dropped lines while nothing gets through",
    lq.flushNotes({ lines: { sent: 0, refused: [] }, records: null, logQueue: waiting, recordQueue: null }).length === 0 && waiting.dropped === 4);
}

// ── The page and the backend agree ────────────────────────────────────────────
console.log("page and backend");
{
  // A plain number or a product such as 64 * 1024, with or without a comment.
  const pyNumber = name => {
    const m = py.match(new RegExp(`^${name}\\s*=\\s*([\\d\\s*]+?)\\s*(?:#.*)?$`, "m"));
    return m ? m[1].split("*").reduce((a, b) => a * Number(b.trim()), 1) : null;
  };
  const caps = ["EPISODE_RECORD_MAX_BYTES", "TURN_RECORDS_MAX", "TURN_RECORDS_MAX_BYTES"].map(n => [n, pyNumber(n), lq[n]]);
  check("the page's record caps are agent_server.py's", caps.every(([, b, p]) => b != null && b === p), show(caps));
  const stamp = `"format":${pyNumber("RECORD_FORMAT")},`;
  check("the page leaves room for the format stamp the backend adds to each turn line",
    pyNumber("RECORD_FORMAT") != null && stamp.length <= lq.TURN_RECORD_STAMP_BYTES, show({ stamp, room: lq.TURN_RECORD_STAMP_BYTES }));
  const routes = ["/episode/run", "/episode/game", "/episode/turns", "/version"].filter(r => !py.includes(`@app.${r === "/version" ? "get" : "post"}("${r}")`));
  check("the backend has the routes the page sends records to, and GET /version", !routes.length, `missing: ${routes.join(", ")}`);
  const pyArgs = py.match(/^GIT_STATUS_ARGS\s*=\s*\[([^\]]*)\]/m)?.[1];
  const pyList = pyArgs ? [...pyArgs.matchAll(/"([^"]*)"/g)].map(m => m[1]) : null;
  check("the page reads its commit with the backend's git command, cut to the same length",
    same(pyList, ["git", ...gv.GIT_STATUS_ARGS]) && pyNumber("SHORT_COMMIT") === gv.SHORT_COMMIT,
    show({ backend: pyList, page: gv.GIT_STATUS_ARGS }));
}

// ── Reading a commit ──────────────────────────────────────────────────────────
console.log("reading a commit (tools/git-version.mjs)");
{
  const full = "0123456789abcdef0123456789abcdef01234567";
  const other = "fedcba9876543210fedcba9876543210fedcba98";
  const status = ({ oid = full, head = "main", dirty = false } = {}) =>
    [`# branch.oid ${oid}`, `# branch.head ${head}`, "# branch.ab +0 -0", ...(dirty ? ["1 .M N... 100644 100644 100644 a b src/x.js"] : [])].join("\r\n");
  cases("git's status gives the commit, the branch and whether tracked files changed", [
    ["clean", gv.parseGitStatus(status()), r => same(r, { full, branch: "main", dirty: false })],
    ["dirty", gv.parseGitStatus(status({ dirty: true })).dirty, r => r === true],
    ["detached", gv.parseGitStatus(status({ head: "(detached)" })).branch, r => r === null],
    ["no commit yet", gv.parseGitStatus(status({ oid: "(initial)" })).full, r => r === null],
  ]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "game-agent-git-"));
  try {
    const checkout = (name, head, files = {}) => {
      const root = path.join(tmp, name);
      fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "HEAD"), `${head}\n`);
      for (const [f, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, ".git", f)), { recursive: true });
        fs.writeFileSync(path.join(root, ".git", f), text);
      }
      return root;
    };
    const loose = checkout("loose", "ref: refs/heads/main", { "refs/heads/main": `${other}\n` });
    const packed = checkout("packed", "ref: refs/heads/feature/y", { "packed-refs": `# pack-refs\n${other} refs/heads/feature/y\n` });
    const detached = checkout("detached", other);
    const noGit = () => { const e = new Error("spawn git ENOENT"); e.code = "ENOENT"; throw e; };
    const refused = () => { const e = new Error("Command failed"); e.stderr = Buffer.from("fatal: detected dubious ownership\nhint"); throw e; };
    cases("where git cannot run or cannot tell, the commit comes from .git's own files, with dirty unknown", [
      ["git not on PATH", gv.gitVersion(loose, { run: noGit }),
        r => r.commitFull === other && r.commit === other.slice(0, 7) && r.branch === "main" && r.dirty === null && /git is not on PATH/.test(r.source)],
      ["git refuses the folder", gv.gitVersion(packed, { run: refused }),
        r => r.commitFull === other && r.branch === "feature/y" && /dubious ownership/.test(r.source) && r.error === null],
      ["a detached HEAD", gv.gitVersion(detached, { run: () => status({ oid: "(initial)" }) }),
        r => r.commitFull === other && r.branch === null && /no commit yet/.test(r.source)],
    ]);
    const git = gv.gitVersion(tmp, { run: () => status({ dirty: true, head: "claude/x" }) });
    check("git's answer gives the commit cut to 7, the branch and the dirty flag",
      same(git, { commit: full.slice(0, 7), commitFull: full, dirty: true, branch: "claude/x", source: "git", error: null }), show(git));
    const none = gv.gitVersion(path.join(tmp, "nothing-here"), { run: noGit });
    check("with neither, there is no commit and the reason, and nothing is thrown",
      none.commit === null && none.source === null && /git is not on PATH/.test(none.error ?? ""), show(none));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // This checkout, as git itself says, where it runs.
  let head = null;
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* no git here */ }
  const mine = gv.gitVersion(ROOT);
  check(`this checkout's commit is read${head ? "" : " (git is not available here: only that it does not throw)"}`,
    head ? mine.commitFull === head && mine.commit === head.slice(0, 7) : typeof mine === "object", show(mine));

  // How the page learns it. npm run build fixes the commit into dist/ with a
  // define; npm run dev reads it again for every page load, so a page reloaded
  // after a pull names the commit it now runs, and a backend left running from
  // before the pull shows up as a mismatch instead of matching the old one.
  const hostile = { ...mine, branch: "x</script><script>alert(1)//" };
  const script = gv.versionScript(hostile);
  check("the version script cannot end the page's script early, whatever the branch is called",
    !script.includes("</") && JSON.parse(script.replace(/^window\.__AGENT_VERSION__ = /, "").replace(/;$/, "")).branch === hostile.branch,
    script);
  const reads = [
    { commit: "1111111", commitFull: "1".repeat(40), dirty: false, branch: "b", source: "git", error: null },
    { commit: "2222222", commitFull: "2".repeat(40), dirty: true, branch: "b", source: "git", error: null },
  ];
  const plugin = gv.agentVersion({ root: ROOT, read: () => reads.shift() });
  const loads = [plugin.transformIndexHtml(), plugin.transformIndexHtml()];
  check("the dev server reads the commit again for every page load, and puts it before the page's own scripts",
    plugin.apply === "serve" && loads.every(l => l.length === 1 && l[0].injectTo === "head-prepend")
      && loads[0][0].children.includes("1111111") && loads[1][0].children.includes("2222222"),
    show(loads));

  // The real path: Vite serves a module only from under its root as it resolves
  // it, and the temporary folder can be named by a short (8.3) path on Windows.
  const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "game-agent-vite-")));
  try {
    const { resolveConfig, createServer } = await import("vite");
    const inline = { configFile: path.join(ROOT, "vite.config.js"), root: tmpRoot, logLevel: "silent" };
    const built = await resolveConfig(inline, "build");
    const inBuild = ep.readVersion(JSON.parse(built.define?.__AGENT_VERSION__ ?? "null"));
    check("npm run build fixes this checkout's commit into the page",
      inBuild?.commitFull === mine.commitFull && inBuild?.commit === mine.commit && !built.plugins.some(p => p.name === "agent-version"),
      show(inBuild));
    const served = await resolveConfig(inline, "serve");
    check("npm run dev defines no commit once for all page loads, and uses the plugin instead",
      !("__AGENT_VERSION__" in (served.define ?? {})) && served.plugins.some(p => p.name === "agent-version"),
      show(served.define));
    // A real Vite, with vite.config.js, in middleware mode, so nothing listens
    // on a port: the page it serves carries the commit, and Vite's own client
    // (/@vite/env, which runs after that script) does not set it back to one
    // read when Vite started.
    const vite = await createServer({ ...inline, appType: "custom",
      server: { middlewareMode: true, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      const html = await vite.transformIndexHtml("/", "<!doctype html><html><head></head><body><script type=\"module\" src=\"/src/main.jsx\"></script></body></html>");
      const given = html.match(/window\.__AGENT_VERSION__ = (\{[^<]*?\});/)?.[1];
      const value = given ? ep.readVersion(JSON.parse(given)) : null;
      const env = (await vite.transformRequest("/@vite/env"))?.code ?? "";
      check("in npm run dev, the page Vite serves names this checkout's commit, before the page's own scripts",
        value?.commitFull === mine.commitFull && html.indexOf("__AGENT_VERSION__") < html.indexOf("type=\"module\"")
          && !env.includes("__AGENT_VERSION__"),
        given ?? html.slice(0, 300));
      // The page's commit is read when it loads, so it is true only if its code
      // changes then and at no other time. With hot updates on, a pull swapped
      // the new GameAgent.jsx into a tab already open (@vitejs/plugin-react
      // makes every component module accept its own updates), and the tab went
      // on naming the old commit, as old as a backend left running: no mismatch.
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "src", "App.jsx"), "export default function App() { return null; }\n");
      const component = (await vite.transformRequest("/src/App.jsx"))?.code ?? "";
      check("npm run dev sends no hot updates: a component module (as GameAgent.jsx is) cannot be swapped into an open tab",
        served.server.hmr === false && vite.config.server.hmr === false && component.includes("function App")
          && !/import\.meta\.hot|RefreshRuntime/.test(component),
        show({ hmr: served.server.hmr, code: component.slice(0, 300) }));
    } finally {
      await vite.close();
    }
  } catch (e) {
    check("vite.config.js loads and gives the page its commit", false, e?.stack ?? String(e));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── Summing up episodes.jsonl ─────────────────────────────────────────────────
console.log("tools/episodes.mjs");
{
  const fixture = path.join(HERE, "fixtures", "episodes.jsonl");
  const { episodes, bad } = sums.readEpisodes(fs.readFileSync(fixture, "utf8"));
  check("the fixture's games are read, and lines that are not a game skipped", episodes.length === 10 && bad === 2, show({ games: episodes.length, bad }));
  const rows = sums.summarise(episodes).map(r => [Object.values(r.key).join(" | "), r.games,
    sums.OUTCOME_COLUMNS.map(o => r.outcomes[o]).join(""), r.stopped, r.meanTurns, r.meanScore, r.scored]);
  // The last two lines are the model playing 2048 alone, with the same commit,
  // provider and model as the solver's first three, and one of them ■ Stop cut
  // short after six turns.
  check("games are grouped by commit, provider, model, game and plugin, in the order they first appear",
    same(rows, [
      ["aaaaaaa | gemini | gemini-3.8-flash | 2048 | 2048", 3, "11100", 0, 60, 14000, 2],
      ["aaaaaaa | ollama | qwen2.5vl:3b | minesweeper-expert | Minesweeper", 1, "01000", 0, 20, 12, 1],
      ["bbbbbbb+ | ollama | qwen2.5vl:3b | minesweeper-expert | Minesweeper", 2, "10010", 0, 25, 381, 1],
      ["bbbbbbb/aaaaaaa | gemini | gemini-3.8-flash | 2048 | none", 1, "10000", 0, 90, 16000, 1],
      ["unknown/aaaaaaa | gemini | gemini-3.8-flash | 2048 | 2048", 1, "00010", 0, 5, null, 0],
      ["aaaaaaa | gemini | gemini-3.8-flash | 2048 | none", 2, "01000", 1, 40, 1024, 1],
    ]), show(rows));
  const byPlayer = sums.summarise(episodes, { by: ["game", "plugin"] })
    .map(r => [r.key.game, r.key.plugin, r.games, r.stopped, r.meanTurns, r.meanScore]);
  check("a solver's games and the model's own are never summed together, and a game ■ Stop cut short is in neither mean",
    same(byPlayer, [["2048", "2048", 4, 0, 46.25, 14000], ["minesweeper-expert", "Minesweeper", 3, 0, 70 / 3, 196.5],
      ["2048", "none", 3, 1, 65, 8512]]), show(byPlayer));
  const byModel = sums.summarise(episodes, { by: ["model"] }).map(r => [r.key.model, r.games, r.stopped, r.meanTurns, r.meanScore, r.scored]);
  check("--by model sums across commits, games and plugins",
    same(byModel, [["gemini-3.8-flash", 7, 1, 52.5, 11256, 4], ["qwen2.5vl:3b", 3, 0, 70 / 3, 196.5, 2]]), show(byModel));
  cases("the commit column says when the backend ran other code than the page", [
    ["same, clean", sums.commitOf({ pageCommit: "abc1234", pageDirty: false, backendCommit: "abc1234", backendDirty: false }), r => r === "abc1234"],
    ["same, both with changes", sums.commitOf({ pageCommit: "abc1234", pageDirty: true, backendCommit: "abc1234", backendDirty: true }), r => r === "abc1234+"],
    ["the backend changed, the page not", sums.commitOf({ pageCommit: "abc1234", pageDirty: false, backendCommit: "abc1234", backendDirty: true }),
      r => r === "abc1234/abc1234+"],
    ["the page changed, the backend not", sums.commitOf({ pageCommit: "abc1234", pageDirty: true, backendCommit: "abc1234", backendDirty: false }),
      r => r === "abc1234+/abc1234"],
    ["changes unknown on one side", sums.commitOf({ pageCommit: "abc1234", pageDirty: null, backendCommit: "abc1234", backendDirty: false }),
      r => r === "abc1234"],
    ["other commits", sums.commitOf({ pageCommit: "abc1234", backendCommit: "def5678" }), r => r === "abc1234/def5678"],
  ]);
  const said = [];
  const code = sums.main([fixture], { log: t => said.push(t) });
  const table = said.join("\n");
  check("the table says how many games, what was skipped, and a row per group",
    code === 0 && table.startsWith(`10 games in ${fixture} (2 lines skipped: not JSON)`)
      && /^commit\s+provider\s+model\s+game\s+plugin\s+games\s+won\s+lost\s+stuck\s+ended\s+aborted\s+stopped\s+mean turns\s+mean score$/m.test(table)
      && /^aaaaaaa\s+gemini\s+gemini-3\.8-flash\s+2048\s+2048\s+3\s+1\s+1\s+1\s+0\s+0\s+0\s+60\s+14000 \(2\)$/m.test(table)
      && /^aaaaaaa\s+gemini\s+gemini-3\.8-flash\s+2048\s+none\s+2\s+0\s+1\s+0\s+0\s+0\s+1\s+40\s+1024 \(1\)$/m.test(table)
      && /^unknown\/aaaaaaa .* 5\s+—$/m.test(table), table);
  const json = [];
  sums.main([fixture, "--json", "--by", "provider"], { log: t => json.push(t) });
  const parsed = JSON.parse(json.join("\n"));
  check("--json gives the same sums for scripts", parsed.games === 10 && parsed.skipped === 2
    && same(parsed.rows.map(r => [r.key.provider, r.games, r.outcomes.won, r.stopped]), [["gemini", 7, 2, 1], ["ollama", 3, 1, 0]]), show(parsed.rows));
  const quiet = [];
  check("a missing file or an unknown column is said, not thrown",
    sums.main([path.join(HERE, "fixtures", "no-such.jsonl")], { log: t => quiet.push(t) }) === 1
      && sums.main([fixture, "--by", "colour"], { log: t => quiet.push(t) }) === 2
      && /No games recorded yet/.test(quiet[0]) && /colour/.test(quiet[1]), show(quiet));
  // The same cases as the backend's log_dir_from test in tools/check_backend.py.
  const home = path.join(os.tmpdir(), "home");
  const file = dir => sums.defaultFile(dir == null ? {} : { AGENT_LOG_DIR: dir }, { home });
  cases("the default file follows AGENT_LOG_DIR as the backend's log folder does, ~ included", [
    ["not set", [file(null), file("  ")], r => same(r, Array(2).fill(path.join(ROOT, "logs", "episodes.jsonl")))],
    ["relative", file("runs/today"), r => r === path.join(ROOT, "runs", "today", "episodes.jsonl")],
    ["absolute", file(path.join(os.tmpdir(), "x")), r => r === path.join(os.tmpdir(), "x", "episodes.jsonl")],
    ["the home folder", [file("~"), file("~/agent-logs"), file("~\\agent-logs")],
      r => same(r, [path.join(home, "episodes.jsonl"), ...Array(2).fill(path.join(home, "agent-logs", "episodes.jsonl"))])],
    ["~ not followed by a slash is a folder name", file("~old/logs"), r => r === path.join(ROOT, "~old", "logs", "episodes.jsonl")],
  ]);
}

process.exit(failures ? 1 : 0);
