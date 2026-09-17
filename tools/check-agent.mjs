#!/usr/bin/env node
// Check agent logic that is not tied to one game, and the names the page and the
// backend have to agree on.
//
//   node tools/check-agent.mjs
//
// Outcome names come first, because they drifted once already: the solver path
// recorded a win as "win", while the signal_game_end tool offered "won" and the
// backend counted "won". Wins were split across two keys, outcomes.won stayed at
// 0, and the guard against a model inventing a win compared against "win" and so
// could never fire. Nothing failed; the numbers were just quietly wrong. So this
// checks, from the code itself rather than from a copy of the list:
//   - src/agent/outcomes.js is consistent, and normalizeOutcome maps what it should
//   - agent_server.py's Outcome Literal holds the same names in the same order
//   - the signal_game_end tool offers exactly MODEL_OUTCOMES, and the model is
//     told those names wherever it is asked how a game ended: the tool's
//     description, the JSON-action mode tool list (where no enum holds a model
//     to anything) and the prompt lines that say to call signal_game_end
//   - GameAgent.jsx has no "win" outcome left, assigns no outcome outside
//     OUTCOMES, and gives every outcome a colour
//
// Then failed model requests, because a request that failed used to end the
// game: the turn returned stop:"api-error", the loop recorded the game as
// "ended", clicked New Game on a live board and saved that to memory. So this
// checks that:
//   - classifyLlmError sorts failures into retry, fatal and stopped as intended
//     (401/403/404 and cloud 400 fatal, an Ollama 400 fatal only when it names
//     a capability the model lacks)
//   - decideAfterTurn ends a game only for "game-ended", waits for the model on
//     a transport error until the cap, and aborts on a fatal one or on a Stop
//     while the model is failing; decideAfterWait resumes play only when the
//     model answered, so a Stop during the wait gives the session up instead
//     of recording the game
//   - settleModelCall and gameEnding, which the games loop runs, do that for
//     each kind of model call, and a game gets a result only with an outcome
//     or a Stop of a healthy run
//   - callAI puts every provider request under a deadline and the Stop signal,
//     does not retry a fatal error, stops at once when Stop is pressed, and
//     reads the Ollama relay's own timeout as a deadline, not a dropped
//     connection, from an old backend too (tools/check_backend.py checks the
//     relay's side of that)
//   - every model call in GameAgent.jsx passes the Stop signal, and the games
//     loop is wired to settleModelCall and gameEnding with nothing in between
//     that could turn a failed call into a game result
//
// Then who may use the backend, because any web page open in the browser can send
// requests to localhost, and the backend's routes move the real mouse. The
// backend refuses a request without its launch token or from another origin
// (tools/check_backend.py checks that). This checks the page's side:
//   - the token header, token file, token pattern, page origins and size caps
//     are the same in agent_server.py, src/agent/backend.js and the Vite plugin
//   - Vite, run with the project's vite.config.js in middleware mode, puts the
//     token in the page on every load of one running server, refuses to serve
//     .agent-token by URL (asked on a free local port), keeps port 5173 with
//     CORS off, and leaves the token out of `npm run build`
//   - the installed Vite and package.json's Vite are new enough to check the
//     Host header, and the plugin stops an older Vite from starting
//   - backend() sends the token with every request and reports a 401 or 403 with
//     what to do, and the Ollama relay turned away that way fails at once
//   - nothing else in GameAgent.jsx fetches /api, and nothing reads /health
//   - logBatches and snapshotBytes keep the page's writes inside the caps
//
// Values that live inside GameAgent.jsx (TOOLS, GAMEPAD_TOOLS, GAME_PLUGINS,
// pluginName, buildActionReference, callAI, setOllamaViaBackend, backend,
// onBackendRefused) are
// read by bundling it with a line that exports them added at the end, the same
// way check-render.mjs bundles it, so the check sees what the page really
// builds. Agent logic that can live in its own module under src/agent/ is
// imported directly instead, which needs no bundling.

import { build, transform } from "esbuild";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const AGENT = path.join(ROOT, "src", "GameAgent.jsx");
const BACKEND = path.join(ROOT, "agent_server.py");

const { OUTCOMES, MODEL_OUTCOMES, MODEL_OUTCOME_CHOICES, normalizeOutcome } =
  await import(pathToFileURL(path.join(ROOT, "src", "agent", "outcomes.js")).href);
const access = await import(pathToFileURL(path.join(ROOT, "src", "agent", "backend.js")).href);
const { backendFailure, readReply } = access;
const llmErrors = await import(pathToFileURL(path.join(ROOT, "src", "agent", "llmErrors.js")).href);
const turns = await import(pathToFileURL(path.join(ROOT, "src", "agent", "turnResult.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);

// ── The outcome module on its own ─────────────────────────────────────────────
console.log("outcome names");
check("OUTCOMES has no repeats", new Set(OUTCOMES).size === OUTCOMES.length, show(OUTCOMES));
check("MODEL_OUTCOMES are all in OUTCOMES",
  MODEL_OUTCOMES.every(o => OUTCOMES.includes(o)), `${show(MODEL_OUTCOMES)} vs ${show(OUTCOMES)}`);
check("the model cannot report \"aborted\"", !MODEL_OUTCOMES.includes("aborted"), show(MODEL_OUTCOMES));
check("\"win\" is not an outcome name", !OUTCOMES.includes("win"), show(OUTCOMES));

const normalized = [
  ...OUTCOMES.map(o => [o, o]),
  ["win", "won"], [" Won ", "won"], ["WIN", "won"], ["LOST", "lost"],
  ["victory", null], ["winner", null], ["", null], ["constructor", null], ["__proto__", null],
  [null, null], [undefined, null], [1, null], [{ outcome: "won" }, null],
];
const wrongly = normalized
  .map(([input, want]) => [input, want, normalizeOutcome(input)])
  .filter(([, want, got]) => got !== want);
check("normalizeOutcome maps names, legacy \"win\" and junk", !wrongly.length,
  wrongly.map(([i, w, g]) => `${show(i)} gave ${show(g)}, wanted ${show(w)}`).join("; "));
const quotedChoices = MODEL_OUTCOMES.map(o => `"${o}"`);
check("MODEL_OUTCOME_CHOICES names every model outcome, quoted, in order",
  typeof MODEL_OUTCOME_CHOICES === "string" &&
    quotedChoices.every((q, i) => MODEL_OUTCOME_CHOICES.indexOf(q) > (i ? MODEL_OUTCOME_CHOICES.indexOf(quotedChoices[i - 1]) : -1)) &&
    !/"aborted"/.test(MODEL_OUTCOME_CHOICES),
  show(MODEL_OUTCOME_CHOICES));

// ── The backend's Literal ─────────────────────────────────────────────────────
const py = fs.readFileSync(BACKEND, "utf8");
const literal = py.match(/^Outcome\s*=\s*Literal\[([\s\S]*?)\]/m);
const pyNames = literal ? [...literal[1].matchAll(/["']([^"']*)["']/g)].map(m => m[1]) : null;
check("agent_server.py Outcome Literal matches OUTCOMES, in order",
  !!pyNames && same(pyNames, [...OUTCOMES]),
  pyNames ? `backend ${show(pyNames)}, page ${show(OUTCOMES)}` : "no `Outcome = Literal[...]` found");
check("MemoryPatch.outcome is typed with it",
  /^\s+outcome:\s*Optional\[Outcome\]/m.test(py), "expected `outcome: Optional[Outcome]` in MemoryPatch");
const legacy = py.match(/^LEGACY_OUTCOMES\s*=\s*\{([\s\S]*?)\}/m);
const pyLegacy = legacy ? [...legacy[1].matchAll(/["']([^"']*)["']\s*:\s*["']([^"']*)["']/g)].map(m => [m[1], m[2]]) : null;
check("the backend maps legacy names the way normalizeOutcome does",
  !!pyLegacy && pyLegacy.length > 0 && pyLegacy.every(([old, now]) => normalizeOutcome(old) === now && OUTCOMES.includes(now)),
  pyLegacy ? show(pyLegacy) : "no `LEGACY_OUTCOMES = {...}` found");

// ── What GameAgent.jsx builds ─────────────────────────────────────────────────
console.log("GameAgent.jsx");
const source = fs.readFileSync(AGENT, "utf8");

// React stays outside the bundle and resolves to the repo's own copy, as in
// check-render.mjs; the bundle sits in the temp directory, where a bare "react"
// would not resolve.
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const reactFromRepo = {
  name: "react-from-repo",
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, a => ({
      path: pathToFileURL(requireFromRoot.resolve(a.path)).href,
      external: true,
    }));
  },
};

const bundlePath = path.join(os.tmpdir(), `game-agent-check-${process.pid}-${randomUUID()}.mjs`);
let agent = null;
try {
  await build({
    stdin: {
      contents: `${source}\nexport { TOOLS as __TOOLS, GAMEPAD_TOOLS as __GAMEPAD_TOOLS, GAME_PLUGINS as __GAME_PLUGINS, pluginName as __pluginName, buildActionReference as __buildActionReference, callAI as __callAI, setOllamaViaBackend as __setOllamaViaBackend, backend as __backend, onBackendRefused as __onBackendRefused };\n`,
      resolveDir: path.join(ROOT, "src"),
      sourcefile: "GameAgent.jsx",
      loader: "jsx",
    },
    bundle: true, platform: "node", format: "esm", jsx: "automatic",
    outfile: bundlePath, logLevel: "silent", plugins: [reactFromRepo],
  });
  agent = await import(pathToFileURL(bundlePath).href);
} catch (e) {
  const detail = e?.errors?.length
    ? e.errors.map(x => `${x.location?.line ?? ""} ${x.text}`).join("; ")
    : (e?.stack ?? String(e));
  check("GameAgent.jsx bundles and exposes TOOLS, GAMEPAD_TOOLS, GAME_PLUGINS, pluginName, buildActionReference, callAI, setOllamaViaBackend, backend and onBackendRefused", false, detail);
} finally {
  fs.rmSync(bundlePath, { force: true });
}

if (agent) {
  const endTool = agent.__TOOLS.find(t => t.name === "signal_game_end");
  const offered = endTool?.input_schema?.properties?.outcome?.enum;
  check("signal_game_end offers exactly MODEL_OUTCOMES",
    same(offered, [...MODEL_OUTCOMES]), endTool ? `offers ${show(offered)}` : "no signal_game_end tool");
  check("signal_game_end requires an outcome",
    !!endTool?.input_schema?.required?.includes("outcome"), show(endTool?.input_schema?.required));
  const described = endTool?.description ?? "";
  check("signal_game_end's description names every model outcome",
    MODEL_OUTCOMES.every(o => described.includes(`"${o}"`)), show(described));

  // JSON-action mode: this tool list is all a small local model sees of the
  // tools, and nothing holds it to an enum it is not shown.
  const reference = agent.__buildActionReference([...agent.__TOOLS, ...agent.__GAMEPAD_TOOLS]).split("\n");
  const endLine = reference.find(l => l.startsWith("- signal_game_end ")) ?? "";
  check("JSON-action mode lists the outcome names for signal_game_end",
    endLine.includes(`"outcome": ${MODEL_OUTCOMES.map(o => `"${o}"`).join("|")}`), show(endLine));
  const padLine = reference.find(l => l.startsWith("- gamepad_button ")) ?? "";
  check("JSON-action mode leaves long value lists out (gamepad buttons)",
    padLine.startsWith("- gamepad_button { \"button\", ") && !padLine.includes("|"), show(padLine));

  const names = agent.__GAME_PLUGINS.map(p => [p.id, agent.__pluginName(p)]);
  check("every plugin has a short name for the UI",
    names.every(([, n]) => typeof n === "string" && n && !n.includes("(")) &&
      new Set(names.map(([, n]) => n)).size === names.length,
    show(names));
}

// Scanned with comments removed, so a comment is free to talk about "win".
const { code } = await transform(source, { loader: "jsx", jsx: "automatic" });
const context = i => code.slice(Math.max(0, i - 50), i + 20).replace(/\s+/g, " ").trim();

// A "win" is still allowed as the KIND of a decision point: the 2048 plugin
// reports its "You win!" overlay that way, and that names what is on screen,
// not how the game ended.
const strayWins = [...code.matchAll(/(["'`])win\1/g)]
  .filter(m => !/\bkind\s*(?:===|!==|==|!=|:)\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index)))
  .map(m => context(m.index));
check("no \"win\" outcome literal", !strayWins.length, strayWins.join("  |  "));

// Every string assigned as an outcome must be a known name.
const assigned = [];
for (const m of code.matchAll(/\b(?:gameOutcome|finalOutcome|\w+\.outcome)\s*=(?![=>])([^;]*);/g)) {
  for (const s of m[1].matchAll(/(["'`])([^"'`]*)\1/g)) assigned.push([s[2], context(m.index + 40)]);
}
for (const m of code.matchAll(/\boutcome\s*:\s*(["'`])([^"'`]*)\1/g)) assigned.push([m[2], context(m.index)]);
const unknown = assigned.filter(([name]) => !OUTCOMES.includes(name));
check(`outcomes assigned are all in OUTCOMES (${assigned.length} found)`,
  assigned.length > 0 && !unknown.length,
  unknown.length ? unknown.map(([n, at]) => `${show(n)} at: ${at}`).join("  |  ") : "found none — has the loop changed shape?");

// The prompts that tell the model to call signal_game_end name the choices from
// MODEL_OUTCOME_CHOICES, not in their own words: "win/loss/game-over" got "loss"
// back, which is not an outcome and counted as "ended".
const promptLines = [...code.matchAll(/\bcall signal_game_end\b[^\n]*/gi)].map(m => m[0]);
const unnamed = promptLines.filter(l => !l.includes("${MODEL_OUTCOME_CHOICES}"));
check(`prompts asking for signal_game_end name the outcomes (${promptLines.length} found)`,
  promptLines.length > 0 && !unnamed.length,
  unnamed.length ? unnamed.join("  |  ") : "found none — have the prompts changed shape?");

const colours = code.match(/\boutcomeColors\s*=\s*\{([^}]*)\}/);
const coloured = colours ? [...colours[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]) : null;
check("outcomeColors has one colour per outcome",
  !!coloured && same([...coloured].sort(), [...OUTCOMES].sort()),
  coloured ? `colours for ${show(coloured)}` : "no outcomeColors object found");

// ── Reading backend replies ───────────────────────────────────────────────────
console.log("backend replies");
const replies = [
  [{ ok: true, entry: {} }, null],
  [{ ok: false, error: "Backend offline" }, "Backend offline"],
  [{ detail: [{ type: "literal_error", loc: ["body", "outcome"], msg: "Input should be 'won', 'lost', 'stuck', 'ended' or 'aborted'" }] },
    "outcome: Input should be 'won', 'lost', 'stuck', 'ended' or 'aborted'"],
  [{ detail: "Not Found" }, "Not Found"],
  [{}, "the backend did not confirm it"],
  [{ gameKey: "2048" }, "the backend did not confirm it"],
  [null, "the backend did not confirm it"],
  [undefined, "the backend did not confirm it"],
];
const misread = replies
  .map(([reply, want]) => [reply, want, backendFailure(reply)])
  .filter(([, want, got]) => got !== want);
check("backendFailure reads success, errors, FastAPI refusals and silence", !misread.length,
  misread.map(([r, w, g]) => `${show(r)} gave ${show(g)}, wanted ${show(w)}`).join("; "));

// backend() reads a reply as text and hands it to readReply. JSON, refusals
// included, passes through untouched; anything else becomes a failure that says
// what came back. The empty HTTP 500 is what Vite's proxy sends when the backend
// is down, and it used to reach the log as "Unexpected end of JSON input".
const refusal = { detail: [{ loc: ["body", "outcome"], msg: "Input should be 'won'" }] };
const bodies = [
  [200, "{\"ok\":true,\"entry\":{}}", { ok: true, entry: {} }, null],
  [422, JSON.stringify(refusal), refusal, "outcome: Input should be 'won'"],
  [500, "", null, "no reply from the backend (HTTP 500, empty); check that the backend window is running"],
  [502, "  \n", null, "no reply from the backend (HTTP 502, empty); check that the backend window is running"],
  [500, "Internal Server Error", null, "the backend replied HTTP 500: Internal Server Error"],
  [200, "null", null, "the backend did not confirm it"],
];
const misparsed = bodies
  .map(([status, text, want, failure]) => {
    const got = readReply(status, text);
    const bad = (want !== null && !same(got, want)) || backendFailure(got) !== failure;
    return bad ? `HTTP ${status} ${show(text)} gave ${show(got)} (${show(backendFailure(got))})` : null;
  })
  .filter(Boolean);
check("readReply passes JSON through and names a reply that is not JSON", !misparsed.length, misparsed.join("; "));

// ── Who may use the backend ───────────────────────────────────────────────────
// Any web page open in the browser can send requests to localhost, and the
// backend's routes move the real mouse. So the backend takes requests only with
// its launch token, from the agent page's origin (tools/check_backend.py checks
// that side). Here: the page gets the token from Vite and sends it on every
// request, says what to do when it is refused, and stays inside the backend's
// size caps, with the numbers the backend uses.
console.log("backend access");
{
  const pyString = name => py.match(new RegExp(`^${name}\\s*=\\s*["']([^"']*)["']`, "m"))?.[1];
  const pyProduct = name => {
    const m = py.match(new RegExp(`^${name}\\s*=\\s*([\\d\\s*]+)$`, "m"));
    return m ? m[1].split("*").reduce((a, b) => a * Number(b.trim()), 1) : null;
  };
  const pyPattern = py.match(/^TOKEN_PATTERN\s*=\s*re\.compile\(r["']([^"']*)["']\)/m)?.[1];
  const pyOrigins = [...(py.match(/^PAGE_ORIGINS\s*=\s*\(([^)]*)\)/m)?.[1] ?? "").matchAll(/["']([^"']*)["']/g)].map(m => m[1]);
  const pyHosts = [...(py.match(/^BACKEND_HOSTS\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/["']([^"']*)["']/g)].map(m => m[1]);
  const plugin = await import(pathToFileURL(path.join(ROOT, "tools", "vite-agent-token.mjs")).href);

  check("the token header is named the same on both sides", pyString("TOKEN_HEADER") === access.TOKEN_HEADER,
    show({ py: pyString("TOKEN_HEADER"), page: access.TOKEN_HEADER }));
  check("the token file is named the same on both sides", py.includes(`TOKEN_FILE = Path(__file__).parent / "${plugin.TOKEN_FILE_NAME}"`),
    `agent_server.py has no TOKEN_FILE = Path(__file__).parent / "${plugin.TOKEN_FILE_NAME}"`);
  check("a token looks the same to the backend and to Vite",
    pyPattern !== undefined && `^${pyPattern}$` === plugin.TOKEN_PATTERN.source, show({ py: pyPattern, vite: plugin.TOKEN_PATTERN.source }));
  check("the backend accepts the page where the page says it is, and nothing else",
    same(pyOrigins, [access.PAGE_ADDRESS, "http://127.0.0.1:5173"]), show(pyOrigins));
  check("the backend trusts only local Host names", same(pyHosts, ["localhost", "127.0.0.1"]), show(pyHosts));
  const caps = ["LOG_APPEND_MAX_LINES", "LOG_APPEND_MAX_BYTES", "SNAPSHOT_MAX_BYTES"].map(n => [n, pyProduct(n), access[n]]);
  check("the page's size caps are the backend's", caps.every(([, a, b]) => typeof a === "number" && a === b), show(caps));

  const token = "Aa0_-".repeat(9);
  const tokens = [
    [{ __AGENT_TOKEN__: token }, token], [{ __AGENT_TOKEN__: null }, null], [{}, null], [undefined, null],
    [{ __AGENT_TOKEN__: "short" }, null], [{ __AGENT_TOKEN__: `${token}"` }, null], [{ __AGENT_TOKEN__: 42 }, null],
  ].map(([scope, want]) => [scope, want, access.pageToken(scope)]).filter(([, want, got]) => want !== got);
  check("pageToken takes a real token and nothing else", !tokens.length, show(tokens));
  check("backendHeaders sends the token, and a content type only with a body",
    same(access.backendHeaders(token), { "X-Agent-Token": token }) &&
      same(access.backendHeaders(token, { json: true }), { "Content-Type": "application/json", "X-Agent-Token": token }) &&
      same(access.backendHeaders(null, { json: true }), { "Content-Type": "application/json" }),
    show([access.backendHeaders(token), access.backendHeaders(null, { json: true })]));
  const refusals = [[401, token, "token", "reload"], [401, null, "no-token", "start.bat"], [403, token, "origin", "5173"],
    [200, token, null], [422, token, null], [500, null, null], [400, token, null]]
    .map(([status, t, kind, words]) => [status, t, kind, words, access.accessRefusal(status, t)])
    .filter(([, , kind, words, got]) => (got?.kind ?? null) !== kind || (kind && !got.message.includes(words)));
  check("accessRefusal tells a restarted backend from a page without a token or at the wrong address", !refusals.length,
    show(refusals.map(([s, t, k, , g]) => ({ status: s, token: !!t, want: k, got: g }))));

  // Log batches: split to fit, in order, with nothing lost but the middle of a
  // line too long to send at all.
  const small = { maxLines: 3, maxBytes: 20 };
  const batchCases = [
    [[], [], "no lines"],
    [["a", "b", "c", "d", "e", "f", "g"], [["a", "b", "c"], ["d", "e", "f"], ["g"]], "more lines than a batch holds"],
    [["123456789", "123456789", "x"], [["123456789", "123456789"], ["x"]], "more bytes than a batch holds"],
    [["é".repeat(5), "é".repeat(5)], [["é".repeat(5)], ["é".repeat(5)]], "bytes, not characters"],
  ].map(([lines, want, label]) => [label, want, access.logBatches(lines, small)]).filter(([, want, got]) => !same(want, got));
  check("logBatches splits lines into batches the backend accepts, in order", !batchCases.length, show(batchCases));
  const bytes = lines => lines.reduce((n, l) => n + new TextEncoder().encode(l).length + 1, 0);
  const cuts = [["x", 3 * 1024 * 1024], ["€", 1024 * 1024]].map(([ch, count]) => {
    const got = access.logBatches(["before", ch.repeat(count), "after"]);
    const size = new TextEncoder().encode(ch.repeat(count)).length + 1;
    const flat = got.flat();
    const ok = got.every(b => bytes(b) <= access.LOG_APPEND_MAX_BYTES) && flat.length === 3 && flat[0] === "before" && flat[2] === "after" &&
      flat[1].endsWith(`[cut: the line was ${size} bytes]`) && bytes([flat[1]]) > access.LOG_APPEND_MAX_BYTES - 100;
    return ok ? null : { ch, batches: got.map(b => ({ lines: b.length, bytes: bytes(b) })), end: flat[1]?.slice(-40) };
  }).filter(Boolean);
  check("logBatches cuts a line too long to send alone to what fits, and says so", !cuts.length, show(cuts));
  const many = access.logBatches(Array.from({ length: 2500 }, (_, i) => `line ${i}`));
  check("logBatches keeps a long queue whole, a thousand lines at a time",
    same(many.map(b => b.length), [1000, 1000, 500]) && many.flat()[2499] === "line 2499", show(many.map(b => b.length)));
  check("snapshotBytes measures as the backend does (base64 length * 3 // 4, plus the text's UTF-8)",
    access.snapshotBytes("A".repeat(10), "é") === 9 && access.snapshotBytes(null, null) === 0 && access.snapshotBytes("AAAA", "") === 3,
    show([access.snapshotBytes("A".repeat(10), "é"), access.snapshotBytes(null, null)]));

  // The Vite plugin, on its own.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "game-agent-token-"));
  try {
    const file = path.join(tmp, plugin.TOKEN_FILE_NAME);
    const reads = [];
    reads.push(["no file", plugin.readAgentToken(file), null]);
    fs.writeFileSync(file, `${token}\r\n`);
    reads.push(["a token and a newline", plugin.readAgentToken(file), token]);
    fs.writeFileSync(file, "</script><script>alert(1)</script>");
    reads.push(["not a token", plugin.readAgentToken(file), null]);
    const badReads = reads.filter(([, got, want]) => got !== want);
    check("the plugin reads a token from the file, and nothing else", !badReads.length, show(badReads));
    check("the plugin's script sets window.__AGENT_TOKEN__, to null when there is no token",
      plugin.tokenScript(token) === `window.__AGENT_TOKEN__ = "${token}";` && plugin.tokenScript(null) === "window.__AGENT_TOKEN__ = null;" &&
        plugin.tokenScript("</script>") === "window.__AGENT_TOKEN__ = null;",
      show([plugin.tokenScript(token), plugin.tokenScript("</script>")]));

    // An older Vite does not check the Host header, so a DNS-rebinding site could
    // read the token from the page. package-lock.json is not in git and start.bat
    // installs Node packages only once, so the plugin refuses such a Vite at start.
    const versions = [["5.4.11", false], ["5.4.12", true], ["5.4.21", true], ["5.10.0", true], ["6.0.0-beta.1", true],
      ["4.5.14", false], ["5.4", false], ["", false], [undefined, false]]
      .map(([v, want]) => [v, want, plugin.viteChecksHost(v)]).filter(([, want, got]) => want !== got);
    check("viteChecksHost accepts Vite 5.4.12 or newer and nothing else", !versions.length, show(versions));
    const tooOld = (() => {
      try {
        plugin.default({ viteVersion: "5.4.11" }).configResolved({ root: tmp });
        return null;
      } catch (e) {
        return e.message;
      }
    })();
    check("the plugin stops Vite on a version too old to check the Host header, and says to run npm install",
      typeof tooOld === "string" && tooOld.includes("5.4.11") && tooOld.includes("npm install"), show(tooOld));
    const wanted = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).devDependencies?.vite;
    check("package.json asks for a Vite that checks the Host header, so npm install brings one",
      typeof wanted === "string" && /^\^5\./.test(wanted) && plugin.viteChecksHost(wanted.slice(1)), show(wanted));

    // Vite itself, with the project's vite.config.js, in middleware mode. The root
    // is the temp folder, so the real .agent-token is never read.
    const { createServer, resolveConfig, version: viteVersion } = await import("vite");
    check("the installed Vite checks the Host header", plugin.viteChecksHost(viteVersion),
      `Vite ${viteVersion} is older than ${plugin.MIN_VITE_VERSION}: run npm install`);
    const configFile = path.join(ROOT, "vite.config.js");
    const inline = { configFile, root: tmp, logLevel: "silent" };
    fs.writeFileSync(file, token);
    fs.writeFileSync(path.join(tmp, `${plugin.TOKEN_FILE_NAME}.123.tmp`), token);  // the backend's copy while it writes
    fs.writeFileSync(path.join(tmp, ".env"), "NOT_A_KEY=1\n");
    fs.writeFileSync(path.join(tmp, "page.js"), "export default 1;\n");
    const vite = await createServer({ ...inline, appType: "custom",
      server: { middlewareMode: true, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
    let listener = null;
    try {
      const html = await vite.transformIndexHtml("/", "<!doctype html><html><head></head><body></body></html>");
      const tokenAt = html.indexOf(`window.__AGENT_TOKEN__ = "${token}";`);
      check("Vite puts the token in the page, before the page's own scripts",
        tokenAt >= 0 && tokenAt < html.indexOf("type=\"module\""), html.slice(0, 200));
      // A reload asks the same, still running Vite for the page again, so the
      // second load has to be on this server: a new server would load the plugin
      // afresh and hide a plugin that keeps the first token.
      const newToken = `${token.slice(1)}X`;
      fs.writeFileSync(file, newToken);
      const html2 = await vite.transformIndexHtml("/", "<html><head></head><body></body></html>");
      check("Vite reads the token again for each page load, so a reload picks up a new one",
        html2.includes(`window.__AGENT_TOKEN__ = "${newToken}";`), html2.slice(0, 200));

      // The page is the only way to the token: Vite must not serve the file by
      // its path. Served on a free local port for these few requests.
      listener = http.createServer(vite.middlewares);
      await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${listener.address().port}`;
      const fsPath = `/@fs/${tmp.split(path.sep).join("/")}`;
      const fetched = await Promise.all([
        "/.agent-token", "/.agent-token?raw", "/.agent-token?import", "/.agent-token?url", "/.AGENT-TOKEN", "/%2Eagent-token",
        `${fsPath}/.agent-token`, `${fsPath}/.agent-token?raw`, "/.agent-token.123.tmp?raw", "/.env", "/page.js",
      ].map(async url => {
        const reply = await fetch(base + url);
        return { url, status: reply.status, token: (await reply.text()).includes(token.slice(1, -1)) };
      }));
      const leaks = fetched.filter(f => f.url === "/page.js" ? f.status !== 200 : f.status !== 403 || f.token);
      check("Vite refuses to serve .agent-token (or .env) by URL, and still serves the page's own files", !leaks.length, show(leaks));
    } finally {
      await new Promise(resolve => (listener ? listener.close(resolve) : resolve()));
      await vite.close();
    }

    const served = await resolveConfig(inline, "serve");
    // Not strictPort: see vite.config.js for why a second Vite must not exit.
    check("the dev server is on port 5173, with no CORS, and does not exit when the port is taken",
      served.server.port === 5173 && !served.server.strictPort && served.server.cors === false,
      show({ port: served.server.port, strictPort: served.server.strictPort, cors: served.server.cors }));
    const proxy = served.server.proxy?.["/api"];
    check("/api goes to the backend with the Host rewritten to localhost",
      proxy?.target === "http://localhost:8765" && proxy.changeOrigin === true && proxy.rewrite?.("/api/health") === "/health",
      show(proxy && { target: proxy.target, changeOrigin: proxy.changeOrigin }));
    const built = await resolveConfig(inline, "build");
    check("npm run build leaves the token out of dist/",
      served.plugins.some(p => p.name === "agent-token") && !built.plugins.some(p => p.name === "agent-token"),
      show(built.plugins.filter(p => p.name === "agent-token").map(p => p.name)));
  } catch (e) {
    check("the Vite plugin and vite.config.js load", false, e?.stack ?? String(e));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Failed model requests ─────────────────────────────────────────────────────
console.log("model request failures");
{
  const { classifyLlmError, httpError, networkError, timeoutError, stoppedError, backendRefusedError,
          OLLAMA_400_RETRIES } = llmErrors;
  const PROVIDERS = ["anthropic", "openai", "gemini", "ollama"];
  const CLOUD = ["anthropic", "openai", "gemini"];
  const cases = [];
  const expect = (label, err, provider, kind, reason, opts) => cases.push({ label, err, provider, kind, reason, opts });

  for (const p of PROVIDERS) {
    expect(`${p} Stop`, stoppedError(), p, "stopped", "stopped");
    expect(`${p} deadline`, timeoutError(90_000), p, "retry", "timeout");
    expect(`${p} 429`, httpError(429, "slow down"), p, "retry", "rate-limited");
    for (const s of [500, 502, 503, 504, 529]) expect(`${p} ${s}`, httpError(s, "busy"), p, "retry", "server-error");
    expect(`${p} no HTTP answer`, networkError("Failed to fetch"), p, "retry", "network");
    expect(`${p} unreadable reply`, new SyntaxError("Unexpected token < in JSON"), p, "retry", "unexpected");
    expect(`${p} 401`, httpError(401, "invalid x-api-key"), p, "fatal", "auth");
    expect(`${p} 403`, httpError(403, "permission denied"), p, "fatal", "forbidden");
    expect(`${p} 404`, httpError(404, "model not found"), p, "fatal", "not-found");
    expect(`${p} 422`, httpError(422, "unprocessable"), p, "fatal", "rejected");
    expect(`${p} relay refused by the backend`, backendRefusedError("payload: Field required"), p, "fatal", "backend-refused");
  }
  for (const p of CLOUD) {
    expect(`${p} 400`, httpError(400, "API key not valid"), p, "fatal", "bad-request");
    expect(`${p} 400 even the first time`, httpError(400, "bad"), p, "fatal", "bad-request", { previous400s: 0 });
  }
  // An Ollama 400 that is not a missing capability is most likely a request cut
  // off in transit: worth retrying however many came before, since the games
  // loop's wait and its cap bound it, not a count.
  for (let n = 0; n <= OLLAMA_400_RETRIES + 3; n++) {
    expect(`ollama 400 after ${n} before`, httpError(400, "HTTP 400 after 150.0s: unexpected EOF"), "ollama", "retry", "bad-request", { previous400s: n });
  }
  // A capability the model lacks is the same 400 every time: fatal the first time.
  expect("ollama 400 naming a missing capability, the first time", httpError(400, "HTTP 400 after 0.2s: {\"error\":\"registry.ollama.ai/library/qwen2.5vl:3b does not support tools\"}"),
    "ollama", "fatal", "unsupported", { previous400s: 0 });
  expect("ollama 400 naming missing vision", httpError(400, "\"llama3.2:3b\" does not support vision"), "ollama", "fatal", "unsupported");
  // Stop wins over everything else the error carries.
  const stoppedWithStatus = httpError(500, "busy"); stoppedWithStatus.stopped = true;
  expect("Stop on an error that also has a status", stoppedWithStatus, "openai", "stopped", "stopped");
  expect("nothing at all thrown", undefined, "gemini", "retry", "unexpected");

  const wrong = cases
    .map(c => ({ ...c, got: classifyLlmError(c.err, c.provider, c.opts) }))
    .filter(c => c.got?.kind !== c.kind || c.got?.reason !== c.reason || typeof c.got?.userText !== "string" || !c.got.userText);
  check(`classifyLlmError sorts ${cases.length} failures into retry, fatal and stopped`, !wrong.length,
    wrong.map(c => `${c.label}: got ${show(c.got)}, wanted ${c.kind}/${c.reason}`).join("; "));

  // A fatal error is shown to the operator in the provider's own words.
  const said = classifyLlmError(httpError(401, "invalid x-api-key"), "anthropic");
  check("a fatal verdict keeps the provider's words and status",
    said.userText.includes("invalid x-api-key") && said.userText.includes("401") && said.userText.includes("Anthropic"), show(said));
  const tools400 = classifyLlmError(httpError(400, "HTTP 400 after 0.1s: model does not support tools"), "ollama");
  check("an Ollama 400 naming tools points at Small-model mode, without repeating \"HTTP 400 after\"",
    /Small-model mode/.test(tools400.userText) && tools400.userText.includes("does not support tools") && !/HTTP 400 after/.test(tools400.userText),
    show(tools400));
  const cut400 = classifyLlmError(httpError(400, "HTTP 400 after 150.0s: unexpected EOF"), "ollama", { previous400s: OLLAMA_400_RETRIES });
  check("a repeated Ollama 400 says how often, and points at a request cut off on the way",
    cut400.userText.includes(`${OLLAMA_400_RETRIES + 1} times in a row`) && /cut off/.test(cut400.userText) && !/Small-model mode/.test(cut400.userText),
    show(cut400));

  // Deadlines and sleeps, with real timers kept short.
  const { withDeadline, sleep } = llmErrors;
  const settle = (p, ms) => Promise.race([p.then(v => ({ v }), e => ({ e })), new Promise(r => setTimeout(() => r({ hung: true }), ms))]);
  const aborted = sig => new Promise((_, reject) => sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

  {
    const d = withDeadline(null, 30);
    const r = await settle(aborted(d.signal), 1000);
    const why = d.explain(r.e); d.done();
    check("withDeadline aborts when the time is up, and says it timed out", !r.hung && why?.timedOut === true, show(r.hung ? "never aborted" : why?.message));
  }
  {
    const stop = new AbortController();
    const d = withDeadline(stop.signal, 5000);
    setTimeout(() => stop.abort(), 20);
    const t0 = Date.now();
    const r = await settle(aborted(d.signal), 1000);
    const why = d.explain(r.e); d.done();
    check("withDeadline aborts at once on Stop, and says it was stopped", !r.hung && why?.stopped === true && Date.now() - t0 < 1000,
      show(r.hung ? "never aborted" : why?.message));
  }
  {
    const stop = new AbortController(); stop.abort();
    const d = withDeadline(stop.signal, 5000);
    const why = d.explain(new Error("x")); d.done();
    check("withDeadline on a run already stopped is aborted from the start", d.signal.aborted && why?.stopped === true, show(why?.message));
  }
  {
    const d = withDeadline(null, 5000);
    const plain = new Error("plain");
    const same = d.explain(plain) === plain; d.done();
    check("withDeadline leaves an error it did not cause alone", same && !d.signal.aborted);
  }
  {
    const stop = new AbortController();
    const t0 = Date.now();
    setTimeout(() => stop.abort(), 20);
    const r = await settle(sleep(5000, stop.signal), 1000);
    check("sleep ends early with a stopped error when Stop is pressed",
      !r.hung && r.e?.stopped === true && Date.now() - t0 < 1000, show(r));
    const ok = await settle(sleep(10, new AbortController().signal), 1000);
    check("sleep resolves when nothing stops it", !ok.hung && !ok.e, show(ok));
  }
  check("the page waits longer for the Ollama relay than the relay waits for Ollama",
    llmErrors.OLLAMA_RELAY_PAGE_TIMEOUT_MS > llmErrors.OLLAMA_RELAY_TIMEOUT_S * 1000 &&
      llmErrors.requestTimeoutMs("ollama", { viaBackend: true }) === llmErrors.OLLAMA_RELAY_PAGE_TIMEOUT_MS,
    `page ${llmErrors.OLLAMA_RELAY_PAGE_TIMEOUT_MS} ms, relay ${llmErrors.OLLAMA_RELAY_TIMEOUT_S} s`);
  // A shorter deadline for the page shortens the relay's, with the same margin,
  // but never below the 30 s the backend holds to.
  const { relayTimeoutS, relayTimedOut, OLLAMA_RELAY_TIMEOUT_S, OLLAMA_RELAY_PAGE_TIMEOUT_MS } = llmErrors;
  const pyFloor = py.match(/timeout=max\(([\d.]+),/);
  check("the relay's timeout follows the page's deadline, above the backend's floor",
    relayTimeoutS(null) === OLLAMA_RELAY_TIMEOUT_S && relayTimeoutS(OLLAMA_RELAY_PAGE_TIMEOUT_MS) === OLLAMA_RELAY_TIMEOUT_S &&
      relayTimeoutS(120_000) === 90 && relayTimeoutS(40) === 30 &&
      !!pyFloor && Number(pyFloor[1]) === 30,
    show({ none: relayTimeoutS(null), page: relayTimeoutS(OLLAMA_RELAY_PAGE_TIMEOUT_MS), check: relayTimeoutS(120_000), tiny: relayTimeoutS(40), backendFloor: pyFloor?.[1] }));
  const relayReplies = [
    ["timedOut true", { ok: false, status: 0, timedOut: true, error: "TimeoutError: timed out" }, true],
    ["timedOut false, whatever the text", { ok: false, status: 0, timedOut: false, error: "TimeoutError: timed out" }, false],
    ["a backend from before timedOut, read timeout", { ok: false, status: 0, elapsed: 600.0, error: "TimeoutError: timed out" }, true],
    ["a backend from before timedOut, connect timeout", { ok: false, status: 0, elapsed: 21.0, error: "URLError: <urlopen error timed out>" }, true],
    ["a backend from before timedOut, refused", { ok: false, status: 0, elapsed: 0.1, error: "URLError: <urlopen error [WinError 10061] refused>" }, false],
    ["an HTTP status is not a relay timeout", { ok: false, status: 400, error: "timed out" }, false],
    ["no reply", null, false],
  ];
  const misreadRelay = relayReplies.filter(([, reply, want]) => relayTimedOut(reply) !== want);
  check(`relayTimedOut tells the relay's own timeout from other failures, old backends included (${relayReplies.length} cases)`,
    !misreadRelay.length, misreadRelay.map(([label]) => label).join("; "));
  check("every provider gets a finite deadline",
    PROVIDERS.every(p => [true, false].every(viaBackend => {
      const ms = llmErrors.requestTimeoutMs(p, { viaBackend });
      return Number.isFinite(ms) && ms > 0;
    })));
}

// ── What the games loop does after a turn ─────────────────────────────────────
console.log("turn results");
{
  const { TURN_KINDS, MODEL_WAIT_CAP_MS, MODEL_CHECK_DELAYS_MS, MODEL_CHECK_TIMEOUT_MS, MODEL_CHECK_MIN_TIMEOUT_MS,
          decideAfterTurn, decideAfterWait, nextModelCheck, modelCheckTimeoutMs, turnFailure } = turns;
  const { classifyLlmError, httpError, networkError, stoppedError } = llmErrors;
  const transport = turnFailure(classifyLlmError(networkError("Failed to fetch"), "ollama"));
  const fatal = turnFailure(classifyLlmError(httpError(401, "invalid x-api-key"), "anthropic"));
  const stopped = turnFailure(classifyLlmError(stoppedError(), "gemini"));
  // What callAI throws when Stop lands in the wait before a retry.
  const stoppedAfterFailure = turnFailure({ ...classifyLlmError(stoppedError(), "ollama"),
    afterFailure: classifyLlmError(networkError("connection refused"), "ollama") });

  check("turnFailure maps retry, fatal and stopped to turn kinds",
    transport.kind === "transport-error" && fatal.kind === "fatal-error" && stopped.kind === "stopped" &&
      [transport, fatal, stopped].every(r => TURN_KINDS.includes(r.kind)),
    show([transport.kind, fatal.kind, stopped.kind]));
  check("turnFailure keeps the failure a Stop landed after, and adds none to a plain Stop",
    stoppedAfterFailure.kind === "stopped" && stoppedAfterFailure.afterFailure?.reason === "network" && !("afterFailure" in stopped),
    show([stoppedAfterFailure, stopped]));

  const ongoing = { lostMs: 60_000, probes: 3 };
  const table = [
    ["action", { kind: "action" }, ongoing, s => s.next === "continue" && s.outage === null],
    ["game-ended won", { kind: "game-ended", outcome: "won", finalScore: 2048 }, ongoing,
      s => s.next === "end-game" && s.outcome === "won" && s.finalScore === 2048 && s.outage === null],
    ["game-ended legacy win", { kind: "game-ended", outcome: "win" }, null, s => s.next === "end-game" && s.outcome === "won" && s.finalScore === null],
    ["game-ended with a name that is not an outcome", { kind: "game-ended", outcome: "victory" }, null, s => s.next === "end-game" && s.outcome === "ended"],
    ["game-ended cannot be aborted by the model", { kind: "game-ended", outcome: "aborted" }, null, s => s.next === "end-game" && s.outcome === "ended"],
    ["transport-error, first", transport, null,
      s => s.next === "wait-for-model" && s.outage?.lostMs === 5000 && s.outage?.probes === 0 && s.outcome === undefined],
    ["transport-error, during an outage", transport, ongoing,
      s => s.next === "wait-for-model" && s.outage?.lostMs === 65_000 && s.outage?.probes === 3 && s.outcome === undefined],
    ["transport-error at the cap", transport, { lostMs: MODEL_WAIT_CAP_MS - 1000, probes: 9 },
      s => s.next === "abort-session" && s.outcome === "aborted" && /not answered/.test(s.message)],
    ["fatal-error", fatal, null, s => s.next === "abort-session" && s.outcome === "aborted" && s.message.includes("invalid x-api-key")],
    ["stopped while the model answers", stopped, null, s => s.next === "stop" && s.outcome === undefined],
    // A Stop while the model is failing is the operator giving up on it, as a
    // Stop during the wait is: the game did not end, so no "ended" for it.
    ["stopped during an outage (the turn after a check answered)", stopped, ongoing,
      s => s.next === "abort-session" && s.outcome === "aborted" && /stopped while the model was not answering/.test(s.message)],
    ["stopped in the wait before a retry", stoppedAfterFailure, null,
      s => s.next === "abort-session" && s.outcome === "aborted" && s.message.includes("connection refused")],
    ["the old {stop: true} shape", { stop: true, reason: "api-error" }, null, s => s.next === "abort-session" && s.outcome === "aborted"],
    ["nothing", undefined, null, s => s.next === "abort-session" && s.outcome === "aborted"],
  ];
  const misjudged = table
    .map(([label, result, outage, ok]) => [label, decideAfterTurn(result, outage, 5000), ok])
    .filter(([, step, ok]) => !ok(step));
  check(`decideAfterTurn decides each kind of turn (${table.length} cases)`, !misjudged.length,
    misjudged.map(([label, step]) => `${label}: ${show(step)}`).join("; "));

  // The rule the whole change is for: nothing but a game the model said was
  // over ends a game, so nothing else can restart one or reach memory as one.
  const endings = TURN_KINDS
    .map(kind => [kind, kind === "transport-error" ? transport : kind === "fatal-error" ? fatal : kind === "stopped" ? stopped : { kind, outcome: "lost" }])
    .map(([kind, result]) => [kind, decideAfterTurn(result, null, 0)])
    .filter(([, step]) => step.next === "end-game")
    .map(([kind]) => kind);
  check("only a game-ended turn ends the game", same(endings, ["game-ended"]), show(endings));
  const outcomes = [transport, fatal, stopped, stoppedAfterFailure]
    .map(r => decideAfterTurn(r, null, 0).outcome)
    .filter(o => o !== undefined && o !== "aborted");
  check("a failed turn never carries a game outcome, only \"aborted\"", !outcomes.length, show(outcomes));

  // Once a wait for the model is over: only an answer resumes play. Stop during
  // the wait gives the session up like the cap does, instead of letting the
  // live game be recorded as "ended".
  const waits = [
    ["answered", { kind: "answered" }, s => s.next === "continue" && s.outcome === undefined],
    ["gave up at the cap", { kind: "gave-up", message: "the model has not answered for 15 minutes" },
      s => s.next === "abort-session" && s.outcome === "aborted" && s.message.includes("15 minutes")],
    ["stopped during the wait", { kind: "stopped" },
      s => s.next === "abort-session" && s.outcome === "aborted" && /stopped/.test(s.message)],
    ["nothing", undefined, s => s.next === "abort-session" && s.outcome === "aborted"],
  ];
  const waitedWrong = waits
    .map(([label, waited, ok]) => [label, decideAfterWait(waited), ok])
    .filter(([, step, ok]) => !ok(step));
  check(`decideAfterWait resumes only on an answer, and aborts otherwise (${waits.length} cases)`, !waitedWrong.length,
    waitedWrong.map(([label, step]) => `${label}: ${show(step)}`).join("; "));

  const delays = [];
  const outage = { lostMs: 0, probes: 0 };
  for (let d = nextModelCheck(outage); d != null && delays.length < 100; d = nextModelCheck(outage)) {
    delays.push(d);
    outage.lostMs += d;
    outage.probes++;
  }
  check("checks for the model back off 15 s, 30 s, 60 s, then every 120 s",
    same(delays.slice(0, 5), [15_000, 30_000, 60_000, 120_000, 120_000]) &&
      same([...MODEL_CHECK_DELAYS_MS], [15_000, 30_000, 60_000, 120_000]),
    show(delays.slice(0, 6)));
  const total = delays.reduce((a, b) => a + b, 0);
  check("waiting stops exactly at the cap, and the cap is about 15 minutes",
    total === MODEL_WAIT_CAP_MS && MODEL_WAIT_CAP_MS >= 10 * 60_000 && MODEL_WAIT_CAP_MS <= 20 * 60_000 &&
      nextModelCheck({ lostMs: MODEL_WAIT_CAP_MS, probes: 0 }) === null,
    `${delays.length} checks, ${total} ms`);

  // A check that hangs cannot carry the wait far past the cap: its deadline is
  // short, shorter still near the cap, and never so short a loading model fails.
  const relayMs = llmErrors.requestTimeoutMs("ollama", { viaBackend: true });
  const checkDeadlines = [
    ["start of an outage, Ollama relay", { lostMs: 0, probes: 0 }, relayMs, MODEL_CHECK_TIMEOUT_MS],
    ["start of an outage, cloud", { lostMs: 0, probes: 0 }, llmErrors.CLOUD_TIMEOUT_MS, llmErrors.CLOUD_TIMEOUT_MS],
    ["50 s left", { lostMs: MODEL_WAIT_CAP_MS - 50_000, probes: 6 }, relayMs, 50_000],
    ["5 s left", { lostMs: MODEL_WAIT_CAP_MS - 5_000, probes: 9 }, relayMs, MODEL_CHECK_MIN_TIMEOUT_MS],
  ];
  const badDeadlines = checkDeadlines
    .map(([label, o, requestMs, want]) => [label, modelCheckTimeoutMs(o, requestMs), want])
    .filter(([, got, want]) => got !== want);
  check(`a check for the model gets a short deadline of its own (${checkDeadlines.length} cases)`,
    !badDeadlines.length && MODEL_CHECK_TIMEOUT_MS <= 3 * 60_000 && MODEL_CHECK_MIN_TIMEOUT_MS < MODEL_CHECK_TIMEOUT_MS,
    badDeadlines.map(([label, got, want]) => `${label}: ${got}, wanted ${want}`).join("; "));
  {
    // Worst case, a relay that hangs: the turn uses its whole deadline, then
    // every check uses its whole deadline too, until the cap.
    const o = { lostMs: relayMs, probes: 0 };
    let checksRun = 0;
    for (let d = nextModelCheck(o); d != null && checksRun < 100; d = nextModelCheck(o)) {
      o.lostMs += d + modelCheckTimeoutMs(o, relayMs);
      o.probes++;
      checksRun++;
    }
    check("a model that hangs is given up within the cap and one check's deadline",
      o.lostMs <= MODEL_WAIT_CAP_MS + MODEL_CHECK_TIMEOUT_MS && checksRun < 100,
      `${Math.round(o.lostMs / 1000)} s lost after ${checksRun} checks`);
  }
}

// ── What the loop does with a model call, and which games get a result ────────
// settleModelCall and gameEnding are what the games loop in GameAgent.jsx runs
// (that wiring is checked further down), so what the loop does for each kind of
// model call is checked here, with a stand-in for the page's wait.
console.log("games loop decisions");
{
  const { turnFailure, settleModelCall, gameEnding, MODEL_WAIT_CAP_MS } = turns;
  const { classifyLlmError, httpError, networkError, stoppedError } = llmErrors;
  const transport = turnFailure(classifyLlmError(networkError("Failed to fetch"), "ollama"));
  const fatal = turnFailure(classifyLlmError(httpError(401, "invalid x-api-key"), "anthropic"));
  const stopped = turnFailure(classifyLlmError(stoppedError(), "gemini"));

  // One model call through settleModelCall, then gameEnding for the game, as the
  // loop runs them: "retry" and "play" stay on the game, "end-game" names the
  // outcome, and anything else leaves play with none.
  const play = async ({ result, outage = null, waited = null, stop = false, failedForMs = 5000 }) => {
    const session = { outage, abortReason: null };
    const waits = [];
    const waitForModel = async (o, lastError) => {
      waits.push({ outage: { ...o }, lastError });
      if (waited instanceof Error) throw waited;
      return waited;
    };
    const turn = await settleModelCall(result, session, failedForMs, waitForModel);
    const game = turn.loop === "play" || turn.loop === "retry"
      ? null
      : gameEnding({
          outcome: turn.loop === "end-game" ? turn.outcome : null,
          abortReason: session.abortReason,
          stopped: stop || turn.loop === "stop",
        });
    return { turn, session, waits, game };
  };
  const recorded = r => r.game?.record === true;

  const cases = [
    ["an answered turn plays on, and ends an outage", { result: { kind: "action" }, outage: { lostMs: 9000, probes: 2 } },
      r => r.turn.loop === "play" && r.session.outage === null && !r.waits.length && !r.session.abortReason],
    ["a game the model ended is recorded with its outcome", { result: { kind: "game-ended", outcome: "lost", finalScore: 12 } },
      r => r.turn.loop === "end-game" && r.turn.finalScore === 12 && recorded(r) && r.game.outcome === "lost"],
    ["a transport error waits for the model, then plays the turn again once it answers",
      { result: transport, waited: { kind: "answered" } },
      r => r.turn.loop === "retry" && r.waits.length === 1 && r.waits[0].outage.lostMs === 5000 &&
        r.waits[0].lastError?.reason === "network" && r.game === null && !r.session.abortReason],
    ["a wait that reaches the cap gives the session up, and records no game",
      { result: transport, waited: { kind: "gave-up", message: "the model has not answered for 15 minutes" } },
      r => r.turn.loop === "give-up" && /15 minutes/.test(r.session.abortReason) && !recorded(r)],
    ["Stop during the wait gives the session up, and records no game",
      { result: transport, waited: { kind: "stopped" }, stop: true },
      r => r.turn.loop === "give-up" && /stopped/.test(r.session.abortReason) && !recorded(r)],
    ["a wait that throws is not an answer", { result: transport, waited: new Error("boom") },
      r => r.turn.loop === "give-up" && /boom/.test(r.session.abortReason) && !recorded(r)],
    ["a transport error past the cap gives up without waiting", { result: transport, outage: { lostMs: MODEL_WAIT_CAP_MS, probes: 9 } },
      r => r.turn.loop === "give-up" && !r.waits.length && !recorded(r)],
    ["a fatal error gives the session up at once, and records no game", { result: fatal },
      r => r.turn.loop === "give-up" && r.session.abortReason.includes("invalid x-api-key") && !r.waits.length && !recorded(r)],
    ["Stop while the model answers records the game as ended, as before", { result: stopped, stop: true },
      r => r.turn.loop === "stop" && recorded(r) && r.game.outcome === "ended" && !r.session.abortReason],
    ["Stop during an outage records no game", { result: stopped, outage: { lostMs: 60_000, probes: 3 }, stop: true },
      r => r.turn.loop === "give-up" && !recorded(r) && /not answering/.test(r.session.abortReason)],
    ["Stop in the wait before a retry records no game",
      { result: { kind: "stopped", afterFailure: classifyLlmError(networkError("refused"), "ollama") }, stop: true },
      r => r.turn.loop === "give-up" && !recorded(r)],
    ["a result nothing recognises records no game", { result: { stop: true, reason: "api-error" } },
      r => r.turn.loop === "give-up" && !recorded(r)],
  ];
  const handledWrong = [];
  for (const [label, input, ok] of cases) {
    const r = await play(input);
    if (!ok(r)) handledWrong.push(`${label}: ${show({ turn: r.turn, session: r.session, waits: r.waits.length, game: r.game })}`);
  }
  check(`settleModelCall and gameEnding handle each kind of model call (${cases.length} cases)`, !handledWrong.length,
    handledWrong.join("; "));

  // Which games get a result, whatever ended play on them.
  const endings = [
    ["an outcome play named", { outcome: "stuck" }, g => g.record && g.outcome === "stuck"],
    ["a legacy name", { outcome: "win" }, g => g.record && g.outcome === "won"],
    ["Stop with no outcome", { outcome: null, stopped: true }, g => g.record && g.outcome === "ended"],
    ["Stop after an outcome keeps the outcome", { outcome: "won", stopped: true }, g => g.record && g.outcome === "won"],
    ["a session given up, even with an outcome", { outcome: "lost", abortReason: "the model has not answered" }, g => !g.record],
    ["play left with no outcome and no Stop (a page bug)", { outcome: null }, g => !g.record && /without an outcome/.test(g.abortReason)],
    ["an outcome that is not a name", { outcome: "api-error" }, g => !g.record && !!g.abortReason],
    ["\"aborted\" is not a game's result", { outcome: "aborted" }, g => !g.record],
  ];
  const endedWrong = endings.map(([label, input, ok]) => [label, gameEnding(input), ok]).filter(([, g, ok]) => !ok(g));
  check(`gameEnding records a game only with an outcome or a Stop (${endings.length} cases)`, !endedWrong.length,
    endedWrong.map(([label, g]) => `${label}: ${show(g)}`).join("; "));
}

// ── callAI, against a stand-in fetch ──────────────────────────────────────────
// No request leaves this process: global fetch is replaced for these checks and
// put back afterwards. Hanging requests settle only when their signal aborts, so
// a request sent without a signal shows up as "hung" instead of passing.
if (agent) {
  console.log("callAI");
  const realFetch = globalThis.fetch;
  const calls = [];
  let respond = () => { throw new Error("no stand-in response set"); };
  globalThis.fetch = (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  const hang = (_url, init) => new Promise((_, reject) => {
    const s = init?.signal;
    if (!s) return;
    if (s.aborted) { reject(s.reason ?? new Error("aborted")); return; }
    s.addEventListener("abort", () => reject(s.reason ?? new Error("aborted")), { once: true });
  });
  // callAI waits seconds between retries (2 s, 4 s, 8 s). A check that has to
  // sit through several runs with `quick`, which shortens every timer of 1 to
  // 62 s set meanwhile to that many milliseconds. Deadlines (90 s and more) keep
  // their length, and the checks' own timers use the real setTimeout.
  const realSetTimeout = globalThis.setTimeout;
  const quick = async (fn) => {
    globalThis.setTimeout = (cb, ms, ...args) => realSetTimeout(cb, ms >= 1000 && ms <= 62_000 ? ms / 1000 : ms, ...args);
    try { return await fn(); } finally { globalThis.setTimeout = realSetTimeout; }
  };
  const run = async (provider, opts = {}, { relay = true } = {}) => {
    agent.__setOllamaViaBackend(relay);
    calls.length = 0;
    const retries = [];
    const t0 = Date.now();
    // A run that has not settled after 4 s is reported as hung and then
    // cancelled, so a retry it still has pending cannot land in the next run's
    // count. Cancelling is Stop, which every settled or failing run ignores.
    const leftover = new AbortController();
    const p = agent.__callAI(provider, "test-model", "system", [{ role: "user", content: "hi" }], [], "test-key",
      m => retries.push(m), { signal: leftover.signal, ...opts });
    let timer;
    const r = await Promise.race([
      p.then(v => ({ v }), e => ({ e })),
      new Promise(res => { timer = realSetTimeout(() => res({ hung: true }), 4000); }),
    ]);
    clearTimeout(timer);
    const result = { ...r, calls: calls.length, retries, ms: Date.now() - t0, sent: [...calls] };
    leftover.abort();
    // A request sent without any signal cannot be cancelled, so do not wait on
    // it for ever.
    await Promise.race([p.catch(() => {}), new Promise(res => realSetTimeout(res, 1000))]);
    return result;
  };
  const routes = [
    ["anthropic", {}], ["openai", {}], ["gemini", {}],
    ["ollama", { relay: true }], ["ollama", { relay: false }],
  ];
  const routeName = (p, o) => p === "ollama" ? `ollama ${o.relay ? "via the relay" : "direct"}` : p;

  try {
    // Every route: under a deadline, not retried after it, and under Stop.
    for (const [provider, o] of routes) {
      respond = hang;
      const timed = await run(provider, { timeoutMs: 40 }, o);
      check(`${routeName(provider, o)}: a request past its deadline is abandoned, once, as a timeout`,
        !timed.hung && timed.e?.verdict?.kind === "retry" && timed.e.verdict.reason === "timeout" && timed.calls === 1,
        show(timed.hung ? "hung: the request had no working deadline" : { verdict: timed.e?.verdict, calls: timed.calls }));

      const stop = new AbortController();
      setTimeout(() => stop.abort(), 30);
      const stoppedRun = await run(provider, { signal: stop.signal }, o);
      check(`${routeName(provider, o)}: Stop ends a request in flight at once, as a Stop of a healthy request`,
        !stoppedRun.hung && stoppedRun.e?.verdict?.kind === "stopped" && !stoppedRun.e.verdict.afterFailure &&
          stoppedRun.calls === 1 && stoppedRun.ms < 2000,
        show(stoppedRun.hung ? "hung: Stop did not reach the request" : { verdict: stoppedRun.e?.verdict, calls: stoppedRun.calls }));
    }

    // Fatal errors are not retried, and keep the provider's words.
    for (const [provider, status, body] of [
      ["anthropic", 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }],
      ["openai", 404, { error: { message: "The model `gpt-4o` does not exist" } }],
      ["gemini", 400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }],
      ["gemini", 403, { error: { code: 403, message: "Permission denied" } }],
    ]) {
      respond = () => json(status, body);
      const r = await run(provider);
      check(`${provider} HTTP ${status} fails at once, without a retry, in the provider's words`,
        !r.hung && r.e?.verdict?.kind === "fatal" && r.calls === 1 && !r.retries.length &&
          r.e.verdict.userText.includes(body.error.message),
        show({ verdict: r.e?.verdict, calls: r.calls, retries: r.retries }));
    }

    // The relay: Ollama's refusal comes back inside a 200 from the backend.
    respond = (url) => url === "/api/llm/ollama"
      ? json(200, { ok: false, status: 404, elapsed: 0.1, error: "{\"error\":{\"message\":\"model \\\"test-model\\\" not found, try pulling it first\"}}" })
      : hang(url, {});
    const missing = await run("ollama", {}, { relay: true });
    check("ollama via the relay: a model that is not pulled fails at once",
      !missing.hung && missing.e?.verdict?.kind === "fatal" && missing.e.verdict.reason === "not-found" && missing.calls === 1,
      show({ verdict: missing.e?.verdict, calls: missing.calls }));
    const relayBody = missing.sent[0]?.init?.body ? JSON.parse(missing.sent[0].init.body) : null;
    check("the relay is asked to give Ollama OLLAMA_RELAY_TIMEOUT_S",
      relayBody?.timeout === llmErrors.OLLAMA_RELAY_TIMEOUT_S, show(relayBody && { timeout: relayBody.timeout }));
    // The check made while waiting for the model has a shorter deadline, and so
    // must the relay, or the backend waits on Ollama long after the page gave up.
    const shortRun = await run("ollama", { timeoutMs: 120_000, retry: false }, { relay: true });
    const shortBody = shortRun.sent[0]?.init?.body ? JSON.parse(shortRun.sent[0].init.body) : null;
    check("a request with a shorter deadline asks the relay for a shorter timeout too",
      shortBody?.timeout === llmErrors.relayTimeoutS(120_000) && shortBody.timeout < llmErrors.OLLAMA_RELAY_TIMEOUT_S,
      show(shortBody && { timeout: shortBody.timeout }));

    // The relay's own timeout is a deadline that ran out, not retried here; any
    // other failure to reach Ollama is a dropped connection, worth asking again.
    respond = () => json(200, { ok: false, status: 0, elapsed: 600.0, timedOut: true, error: "TimeoutError: timed out" });
    const relayTimedOut = await run("ollama", {}, { relay: true });
    check("ollama via the relay: the relay running out of time is a timeout, not retried",
      !relayTimedOut.hung && relayTimedOut.e?.verdict?.kind === "retry" && relayTimedOut.e.verdict.reason === "timeout" &&
        relayTimedOut.calls === 1 && !relayTimedOut.retries.length,
      show({ verdict: relayTimedOut.e?.verdict, calls: relayTimedOut.calls, retries: relayTimedOut.retries }));
    // A backend started before timedOut existed: the same timeout, told from its
    // error text. Read as a dropped connection it was retried three more times,
    // each waiting ten minutes on a real relay.
    respond = () => json(200, { ok: false, status: 0, elapsed: 600.0, error: "TimeoutError: timed out" });
    const oldRelayTimedOut = await quick(() => run("ollama", {}, { relay: true }));
    check("ollama via a backend not yet restarted: the relay running out of time is still a timeout, not retried",
      !oldRelayTimedOut.hung && oldRelayTimedOut.e?.verdict?.reason === "timeout" && oldRelayTimedOut.calls === 1 && !oldRelayTimedOut.retries.length,
      show({ verdict: oldRelayTimedOut.e?.verdict, calls: oldRelayTimedOut.calls, retries: oldRelayTimedOut.retries }));

    // Ollama's 400s: a missing capability fails at once; any other is retried a
    // few times here, then handed to the loop's wait as worth retrying.
    respond = () => json(200, { ok: false, status: 400, elapsed: 0.2, error: "{\"error\":\"\\\"test-model\\\" does not support tools\"}" });
    const noTools = await quick(() => run("ollama", {}, { relay: true }));
    check("ollama: a 400 naming a missing capability fails at once",
      !noTools.hung && noTools.e?.verdict?.kind === "fatal" && noTools.e.verdict.reason === "unsupported" && noTools.calls === 1,
      show({ verdict: noTools.e?.verdict, calls: noTools.calls }));
    respond = () => json(200, { ok: false, status: 400, elapsed: 150.0, error: "{\"error\":\"unexpected EOF\"}" });
    const cutOff = await quick(() => run("ollama", {}, { relay: true }));
    check(`ollama: any other 400 is tried ${llmErrors.OLLAMA_400_RETRIES + 1} times in all, then left to the loop as worth retrying`,
      !cutOff.hung && cutOff.e?.verdict?.kind === "retry" && cutOff.e.verdict.reason === "bad-request" &&
        cutOff.calls === llmErrors.OLLAMA_400_RETRIES + 1 && cutOff.retries.length === llmErrors.OLLAMA_400_RETRIES,
      show({ verdict: cutOff.e?.verdict, calls: cutOff.calls, retries: cutOff.retries }));

    respond = () => json(200, { ok: false, status: 0, elapsed: 0.1, timedOut: false, error: "URLError: <urlopen error [WinError 10061] refused>" });
    const relayRefused = await run("ollama", { retry: false }, { relay: true });
    check("ollama via the relay: Ollama not running is a network failure, worth retrying",
      !relayRefused.hung && relayRefused.e?.verdict?.kind === "retry" && relayRefused.e.verdict.reason === "network",
      show({ verdict: relayRefused.e?.verdict, calls: relayRefused.calls }));

    respond = () => json(422, { detail: [{ loc: ["body", "payload"], msg: "Field required" }] });
    const refused = await run("ollama", {}, { relay: true });
    check("ollama via the relay: a request the backend refuses fails at once",
      !refused.hung && refused.e?.verdict?.reason === "backend-refused" && refused.calls === 1,
      show({ verdict: refused.e?.verdict, calls: refused.calls }));

    // A retry that works: one server error, then an answer.
    let n = 0;
    respond = () => (n++ === 0 ? json(503, { error: { message: "overloaded" } })
      : json(200, { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
    const recovered = await run("openai");
    check("a server error is retried, and the answer that follows is returned",
      !recovered.hung && !recovered.e && recovered.v?.content?.[0]?.text === "OK" && recovered.calls === 2 && recovered.retries.length === 1,
      show({ error: recovered.e?.message, calls: recovered.calls, retries: recovered.retries }));

    // retry: false (the check made while waiting for the model) tries once.
    respond = () => json(503, { error: { message: "overloaded" } });
    const once = await run("anthropic", { retry: false });
    check("retry: false makes one request and reports it as worth retrying",
      !once.hung && once.e?.verdict?.kind === "retry" && once.calls === 1, show({ verdict: once.e?.verdict, calls: once.calls }));

    // Stop during the wait between retries ends it then, not after the wait.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const waiting = await run("gemini", { signal: stop.signal });
    check("Stop during the wait before a retry ends the call at once, and says what had failed",
      !waiting.hung && waiting.e?.verdict?.kind === "stopped" && waiting.e.verdict.afterFailure?.reason === "server-error" &&
        waiting.calls === 1 && waiting.ms < 1500,
      show(waiting.hung ? "hung" : { verdict: waiting.e?.verdict, calls: waiting.calls, ms: waiting.ms }));

    // Stop during the retry itself is a Stop after a failure as well.
    let m = 0;
    respond = (url, init) => (m++ === 0 ? json(503, { error: { message: "overloaded" } }) : hang(url, init));
    const stopRetry = new AbortController();
    const inRetry = await quick(() => {
      const watch = realSetTimeout(() => { if (calls.length >= 2) stopRetry.abort(); else realSetTimeout(() => stopRetry.abort(), 50); }, 100);
      return run("openai", { signal: stopRetry.signal }).finally(() => clearTimeout(watch));
    });
    check("Stop during a retry in flight says what had failed",
      !inRetry.hung && inRetry.e?.verdict?.kind === "stopped" && inRetry.e.verdict.afterFailure?.reason === "server-error" && inRetry.calls === 2,
      show(inRetry.hung ? "hung" : { verdict: inRetry.e?.verdict, calls: inRetry.calls }));

    // ── backend(): the token on every request, and a refusal said once ──────────
    console.log("backend()");
    const token = "Tt0_-".repeat(9);
    const heard = [];
    agent.__onBackendRefused(r => heard.push(r));
    const headerOf = (sent, name) => Object.entries(sent?.init?.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    try {
      globalThis.__AGENT_TOKEN__ = token;
      calls.length = 0;
      respond = () => json(200, { width: 1920, height: 1080, platform: "Windows" });
      const info = await agent.__backend("/screen/info");
      await agent.__backend("/mouse/click", { x: 1, y: 2 });
      await agent.__backend("/memory/some-game", null, { method: "DELETE" });
      const [get, post, del] = calls;
      check("backend() sends the page's token with every request, and a content type only with a body",
        info.width === 1920 && get?.url === "/api/screen/info" && headerOf(get, "X-Agent-Token") === token && !headerOf(get, "Content-Type") &&
          post?.init?.method === "POST" && headerOf(post, "X-Agent-Token") === token && headerOf(post, "Content-Type") === "application/json" &&
          del?.init?.method === "DELETE" && headerOf(del, "X-Agent-Token") === token && !heard.length,
        show(calls.map(c => ({ url: c.url, method: c.init?.method, headers: c.init?.headers })).concat(heard)));

      // The backend's access check: a backend restarted since the page loaded.
      respond = () => json(401, { ok: false, detail: "missing or wrong X-Agent-Token: reload the agent page" });
      const refused = await agent.__backend("/mouse/click", { x: 1, y: 2 });
      check("a 401 is reported once to the page, with what to do, and read as a failure that names it",
        heard.length === 1 && heard[0].kind === "token" && refused.ok === false && refused.refused === "token" &&
          backendFailure(refused).includes("reload this page") && refused.detail,
        show({ heard, refused }));
      delete globalThis.__AGENT_TOKEN__;
      calls.length = 0;
      await agent.__backend("/screen/info");
      check("a page served without a token sends none, and is told how to get one",
        calls.length === 1 && headerOf(calls[0], "X-Agent-Token") === undefined && heard[1]?.kind === "no-token",
        show({ headers: calls[0]?.init?.headers, heard: heard[1] }));
      respond = () => json(403, { ok: false, detail: "requests from 'http://localhost:5174' are not accepted" });
      await agent.__backend("/screen/info");
      check("a 403 tells the operator where to open the page", heard[2]?.kind === "origin" && heard[2].message.includes("http://localhost:5173"),
        show(heard[2]));

      // The Ollama relay turned away the same way cannot be fixed by asking again.
      globalThis.__AGENT_TOKEN__ = token;
      respond = () => json(401, { ok: false, detail: "missing or wrong X-Agent-Token" });
      const relayLocked = await run("ollama", {}, { relay: true });
      check("ollama via the relay: a backend that refuses the page's token fails at once, saying to reload",
        !relayLocked.hung && relayLocked.e?.verdict?.kind === "fatal" && relayLocked.e.verdict.reason === "backend-refused" &&
          relayLocked.calls === 1 && headerOf(relayLocked.sent[0], "X-Agent-Token") === token && /reload/i.test(relayLocked.e.verdict.userText),
        show({ verdict: relayLocked.e?.verdict, calls: relayLocked.calls }));
    } finally {
      agent.__onBackendRefused(null);
      delete globalThis.__AGENT_TOKEN__;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Every request to the backend must carry the token, and only backend() adds
// it, so nothing else may fetch /api. /health answers without the token and
// says nothing else, so nothing may read the screen size from it any more.
{
  const direct = [...code.matchAll(/\bfetch\(\s*[`"']\/api/g)].map(m => context(m.index));
  check("only backend() fetches /api (so every request carries the token)", direct.length === 1, direct.join("  |  "));
  const fromHealth = [...code.matchAll(/screen_width|screen_height|["'`]\/(?:api\/)?health["'`]/g)].map(m => context(m.index));
  check("the page reads nothing from /health", !fromHealth.length, fromHealth.join("  |  "));
  const infoReads = [...code.matchAll(/backend\("\/screen\/info"/g)].length;
  check("the page's backend check and watchdog ask /screen/info, which needs the token", infoReads === 2, `found ${infoReads}`);
}

// ── Every model call can be stopped ───────────────────────────────────────────
{
  // Each callAI(...) call in the page, other than its definition, must pass the
  // run's Stop signal: a call without it cannot be cut short by Stop, and waits
  // out its whole deadline instead.
  const callsWithoutSignal = [];
  let count = 0;
  for (const m of code.matchAll(/\bcallAI\s*\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    count++;
    const args = code.slice(m.index, i + 1);
    if (!/\bsignal\b/.test(args)) callsWithoutSignal.push(context(m.index + 40));
  }
  check(`every model call passes the Stop signal (${count} found)`, count > 0 && !callsWithoutSignal.length,
    callsWithoutSignal.length ? callsWithoutSignal.join("  |  ") : "found no callAI calls — has callAI been renamed?");

  const oldShape = [...code.matchAll(/\bstop\s*:\s*(?:true|false)\b|["'`]api-error["'`]|\bresult\.stop\b/g)].map(m => context(m.index));
  check("no turn ends in the old {stop, reason: \"api-error\"} shape", !oldShape.length, oldShape.join("  |  "));
}

// ── The games loop acts on those decisions ────────────────────────────────────
// settleModelCall and gameEnding are checked above, but the bug this guards
// against lived in the loop: a failed turn broke out of play, fell through to
// "Game finished", was recorded as "ended", restarted and saved to memory. The
// loop is a React callback that moves the mouse, so it is not run here; instead
// its wiring is read from the page, as esbuild prints it (comments gone, quotes
// and spacing normalised), and each piece that keeps a failed call from reaching
// a game result must be there.
{
  const wiring = (name, pattern, want = 1) => {
    const found = [...code.matchAll(pattern)].length;
    check(`${name}${want > 1 ? ` (${want} places)` : ""}`, found === want,
      found ? `found ${found}, wanted ${want} — has the loop changed shape?` : "not found — has the loop changed shape?");
  };

  // Every model turn of play goes through settleModelCall, and nothing but its
  // decision moves play on: "retry" goes round again, "end-game" names the
  // game's outcome, and anything that is not "play" leaves play with no outcome.
  const turnsPlayed = [...code.matchAll(/\bagentTurn\(/g)].length;
  check("agentTurn is called in one place only", turnsPlayed === 1, `found ${turnsPlayed}`);
  wiring("every turn of play is settled by settleModelCall, and only its decision ends play",
    /const (\w+) = await agentTurn\([^;]*\);\s*const (\w+) = await settleModelCall\(\1, session,[^;]*\);\s*if \(\2\.loop === "retry"\) continue;\s*if \(\2\.loop === "end-game"\) \{\s*gameOutcome = \2\.outcome;[\s\S]{0,300}?break;\s*\}\s*if \(\2\.loop !== "play"\) break;/g);

  // A restart that asked the model and got no answer is settled the same way.
  const restarts = [...code.matchAll(/\battemptRestart\(/g)].length;
  wiring("every restart is settled by settleModelCall",
    /const (\w+) = await attemptRestart\([^;]*\);\s*const (\w+) = await settleModelCall\(\s*\1\.failure \?\? \{ kind: "action" \},\s*session,[\s\S]{0,120}?\);\s*if \(\2\.loop === "retry"\) continue;\s*return \1;/g,
    restarts);

  // A game is recorded only once gameEnding says it has a result, and with the
  // outcome gameEnding gives: play starts each game with no outcome, so a way
  // out of play that names none cannot become "ended".
  wiring("each game starts with no outcome", /let gameOutcome = null;/g);
  wiring("a game is recorded only after gameEnding says it has a result",
    /const (\w+) = gameEnding\(\{ outcome: gameOutcome, abortReason: session\.abortReason, stopped: stopRef\.current \}\);\s*if \(!\1\.record\) \{\s*session\.abortReason = session\.abortReason \|\| \1\.abortReason;\s*break;\s*\}\s*const thisScore = [^;]*;\s*const thisBestTile = [^;]*;\s*gameScoresRef\.current = \[\s*\.\.\.gameScoresRef\.current,\s*\{[^}]*outcome: \1\.outcome\s*\}\s*\];[\s\S]{0,400}?finalOutcome = \1\.outcome;/g);
  const recordings = [...code.matchAll(/gameScoresRef\.current = \[\s*\.\.\.gameScoresRef\.current/g)].length;
  check("games are recorded in that one place only", recordings === 1, `found ${recordings}`);
  // The declaration's starting value aside, which only a session that never
  // reached its first game keeps.
  const finalAssignments = [...code.matchAll(/(?<!\blet )\bfinalOutcome = ([^;]*);/g)].map(m => m[1].trim());
  const strayFinal = finalAssignments.filter(v => v !== "\"aborted\"" && !/^\w+\.outcome$/.test(v));
  check("the session's outcome is only a recorded game's or \"aborted\"", finalAssignments.length > 0 && !strayFinal.length,
    strayFinal.length ? show(strayFinal) : "no assignments found");

  // A turn, or a restart question, the model did not answer is taken back
  // before the failure is returned, so asking again does not send it twice.
  const noCatchBetween = "(?:(?!\\bcatch \\()[\\s\\S])*?";
  wiring("agentTurn takes back a turn the model did not answer",
    new RegExp(`catch \\((\\w+)\\) \\{\\s*convRef\\.current = convRef\\.current\\.filter\\(\\(m\\) => m !== turnMessage\\);${noCatchBetween}return turnFailure\\(`, "g"));
  wiring("attemptRestart takes back a question the model did not answer",
    new RegExp(`catch \\((\\w+)\\) \\{\\s*convRef\\.current = convRef\\.current\\.filter\\(\\(m\\) => m !== question\\);${noCatchBetween}failure: turnFailure\\(`, "g"));

  // While the model is not answering, a check has a short deadline of its own.
  wiring("the check for the model has a deadline of its own",
    /const timeoutMs = modelCheckTimeoutMs\([^;]*\);\s*await callAI\([^;]*\{ signal: \w+, retry: false, timeoutMs \}\s*\);/g);

  // Pause-to-think: a game frozen for a turn the model did not answer stays
  // frozen while the run waits (only a Stop or a fatal error lets it run at
  // once), and runs again when the model answers.
  wiring("a turn the model did not answer leaves a frozen game frozen for the wait",
    new RegExp(`m !== turnMessage\\);${noCatchBetween}if \\((\\w+)\\.kind !== "retry"\\) await setGameSpeed\\(1\\);${noCatchBetween}return turnFailure\\(\\1\\);`, "g"));
  wiring("the game runs again once the model answers",
    /addLog\("\\u25B6 The model is answering again[^;]*;\s*await setGameSpeed\(1\);\s*return \{ kind: "answered" \};/g);

  // A solver move that changed the board is play getting through, so a later
  // outage starts its own count (turnResult.js).
  wiring("a solver move that changes the board ends a model outage",
    /if \(sr\.ok\) \{\s*solverFailRef\.current = 0;\s*if \(sr\.changed\) session\.outage = null;/g);
}

process.exit(failures ? 1 : 0);
