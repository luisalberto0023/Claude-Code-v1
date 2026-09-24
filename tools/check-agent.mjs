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
// Then which Ollama server model requests go to, because the relay used to send
// each one wherever the page's request named, which made the backend a proxy
// into the LAN. It now relays only to the server it started with
// (tools/check_backend.py checks that side). Here:
//   - the relay request carries no address, and the page has no base_url left;
//     direct calls from the browser (relay off) still use the field
//   - the page and the backend agree on the default server and the variable
//     that overrides it, and git ignores agent-config.json
//   - what the OLLAMA SERVER field says (a save waiting for a restart included),
//     when Save does anything, and that a session does not start while the
//     field and the relay's server differ, as the backend says at Start, or
//     while the backend has not said; and no typed password reaches the log
//
// Then how long one action may hold and how much it may type, because hold_key
// with a duration of 600 held a key down for ten minutes that Stop could not end.
// The backend bounds holds and typed text (tools/check_backend.py checks that).
// Here:
//   - the page's limits (src/agent/inputLimits.js) are the backend's numbers, and
//     the hold_key, type_text and gamepad schemas state them, as does JSON-action
//     mode's tool list
//   - the tool result says what the backend really held or typed, and every hold
//     or type in GameAgent.jsx, execute_sequence's steps included, reports it
//
// Then the kill switch, because moving the mouse into a screen corner never
// stopped keys sent with SendInput, and Stop only stopped the page asking for
// more. The backend halts input on Ctrl+Alt+Pause, Ctrl+Alt+Shift+H or Stop and
// refuses input with HTTP 423 until Resume (tools/check_backend.py checks that).
// Here:
//   - the page (src/agent/killSwitch.js) and the backend agree on the status and
//     the reasons for a halt, and the page reads the state, shows the banner,
//     logs changes and refuses ▶ Start as it should
//   - backend() reports a halted input route at once, and Stop aborts the model
//     request in flight and halts input already sent, lifting only its own halt
//   - the games loop waits while input is halted, and no halted reply is counted
//     as a no-op, a failed solver move or a failed restart click
//
// Then how model requests are sent, because the cloud requests had gone stale
// (max_tokens to OpenAI, the Gemini key in the URL, Gemini's thought signatures
// dropped, no browser header for Anthropic) and a retired model id showed only
// once a session was under way. tools/check-llm.mjs checks src/llm/ on its own;
// here:
//   - callAI puts on the wire what src/llm/requests.js builds, for every cloud
//     provider, a Gemini function call's thought signature included
//   - ▶ Start checks the chosen model (src/llm/models.js) before the run's reset,
//     and a failed check starts nothing; the picker has a free-text model field
//     and lists models through backend() for the Ollama relay
//
// Then what the model is told about the screen it is looking at, because none of
// the prompts said that a screen the agent did not choose — ads, fake "Download"
// buttons, a sign-in wall, text written for whatever model is reading it — is
// content and not instructions, while the model holds the real mouse. So:
//   - the rule in src/agent/prompts.js still says what it is for, and is short
//     enough to resend every turn on a 4k-context local model
//   - callAI adds it where the provider request is built, and it is on the wire
//     for every provider, after the caller's own prompt
// (tools/check-secrets.mjs checks the other half of the same threat model: that
// no key can reach the build output.)
//
// Values that live inside GameAgent.jsx (TOOLS, GAMEPAD_TOOLS, GAME_PLUGINS,
// pluginName, buildActionReference, callAI, setOllamaViaBackend, setOllamaBase,
// backend, onBackendRefused, onInputHalted) are
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
const { SCREEN_RULE, withScreenRule } = await import(pathToFileURL(path.join(ROOT, "src", "agent", "prompts.js")).href);

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
      contents: `${source}\nexport { TOOLS as __TOOLS, GAMEPAD_TOOLS as __GAMEPAD_TOOLS, GAME_PLUGINS as __GAME_PLUGINS, pluginName as __pluginName, buildActionReference as __buildActionReference, callAI as __callAI, setOllamaViaBackend as __setOllamaViaBackend, setOllamaBase as __setOllamaBase, backend as __backend, onBackendRefused as __onBackendRefused, onInputHalted as __onInputHalted, beginTurn as __beginTurn, endTurn as __endTurn };\n`,
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
  check("GameAgent.jsx bundles and exposes TOOLS, GAMEPAD_TOOLS, GAME_PLUGINS, pluginName, buildActionReference, callAI, setOllamaViaBackend, setOllamaBase, backend, onBackendRefused, onInputHalted, beginTurn and endTurn", false, detail);
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

// ── Which Ollama server ───────────────────────────────────────────────────────
console.log("ollama server");
{
  const ollama = await import(pathToFileURL(path.join(ROOT, "src", "agent", "ollamaServer.js")).href);
  const pyString = name => py.match(new RegExp(`^${name}\\s*=\\s*["']([^"']*)["']`, "m"))?.[1];
  check("the page and the backend agree on the default Ollama server and the variable that overrides the config",
    pyString("OLLAMA_DEFAULT_BASE") === ollama.OLLAMA_DEFAULT_BASE && pyString("OLLAMA_BASE_ENV") === ollama.OLLAMA_BASE_ENV,
    show({ py: [pyString("OLLAMA_DEFAULT_BASE"), pyString("OLLAMA_BASE_ENV")], page: [ollama.OLLAMA_DEFAULT_BASE, ollama.OLLAMA_BASE_ENV] }));
  const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  check("agent-config.json, and the backend's half-written copy, stay out of git",
    py.includes(`CONFIG_FILE = Path(__file__).parent / "agent-config.json"`) &&
      /^agent-config\.json\r?$/m.test(ignored) && /^agent-config\.json\.\*\.tmp\r?$/m.test(ignored),
    "expected CONFIG_FILE = Path(__file__).parent / \"agent-config.json\" in agent_server.py and both names in .gitignore");

  const LAN = "http://192.168.1.50:11434";
  const HOME = ollama.OLLAMA_DEFAULT_BASE;
  const fromConfig = { base: LAN, source: "agent-config.json", error: null, saved: LAN };
  const savedNotStarted = { base: HOME, source: "default", error: null, saved: LAN };
  const fromEnv = { base: "http://10.0.0.9:11434", source: "OLLAMA_BASE_URL", error: null, saved: LAN };
  const broken = { base: null, source: "agent-config.json", error: "ollamaBase in agent-config.json is not a usable Ollama address: 'x'", saved: null };
  const brokenEnv = { base: null, source: "OLLAMA_BASE_URL", error: "OLLAMA_BASE_URL is not a usable Ollama address: 'x'", saved: LAN };
  const notes = [
    ["relay on, the field is the relay's server (spaces and a slash aside)", { field: ` ${LAN}/ `, relay: true, server: fromConfig },
      n => n.tone === "ok" && !n.canSave && n.text.includes("agent-config.json")],
    ["relay on, the field names another server", { field: HOME, relay: true, server: fromConfig },
      n => n.tone === "warn" && n.canSave && n.text.includes(LAN) && n.text.includes("restart start.bat")],
    ["relay on, the field is saved but the backend has not restarted", { field: LAN, relay: true, server: savedNotStarted },
      n => n.tone === "warn" && !n.canSave && /Restart start\.bat/.test(n.text) && n.text.includes(HOME)],
    // After a reload the field shows the server in use again: the save waiting
    // for a restart is still named, or it looks lost. Saving the field takes it back.
    ["relay on, the field is the server in use, and another is saved for the next start", { field: HOME, relay: true, server: savedNotStarted },
      n => n.tone === "warn" && n.canSave && n.text.includes(LAN) && /restart start\.bat/.test(n.text)],
    ["relay on, an empty field, and another server saved for the next start", { field: "", relay: true, server: savedNotStarted },
      n => !n.canSave && n.text.includes(HOME) && n.text.includes(LAN) && /restart start\.bat/.test(n.text)],
    ["relay on, OLLAMA_BASE_URL decides: a saved address is not waiting for a restart", { field: "http://10.0.0.9:11434", relay: true, server: fromEnv },
      n => n.tone === "ok" && !n.canSave && !n.text.includes(LAN)],
    ["relay on, saved but OLLAMA_BASE_URL wins", { field: LAN, relay: true, server: fromEnv },
      n => n.tone === "warn" && !n.canSave && n.text.includes("OLLAMA_BASE_URL") && n.text.includes("10.0.0.9")],
    ["relay on, an empty field", { field: "  ", relay: true, server: fromConfig }, n => !n.canSave && n.text.includes(LAN)],
    ["relay on, the backend has not said", { field: LAN, relay: true, server: null }, n => n.tone === "warn" && !n.canSave],
    ["relay on, the relay has no usable server", { field: LAN, relay: true, server: broken },
      n => n.tone === "error" && n.canSave && n.text.includes(broken.error)],
    ["relay on, OLLAMA_BASE_URL is not usable: saving does not help", { field: "http://10.0.0.7:11434", relay: true, server: brokenEnv },
      n => n.tone === "error" && n.text.includes(brokenEnv.error) && /clear OLLAMA_BASE_URL/.test(n.text) && !/Save a working/.test(n.text)],
    ["relay off, the field is what is saved", { field: LAN, relay: false, server: fromConfig },
      n => n.tone === "info" && !n.canSave && n.text.includes("OLLAMA_ORIGINS")],
    ["relay off, a new address", { field: "http://10.0.0.7:11434", relay: false, server: fromConfig }, n => n.canSave],
  ];
  const badNotes = notes.map(([label, input, ok]) => [label, ollama.ollamaServerNote(input), ok]).filter(([, n, ok]) => !ok(n));
  check(`ollamaServerNote says where model requests go, and when Save does anything (${notes.length} cases)`, !badNotes.length,
    badNotes.map(([label, n]) => `${label}: ${show(n)}`).join("; "));

  const starts = [
    ["the field is the relay's server", { field: `${LAN}/`, relay: true, server: fromConfig }, p => p === null],
    ["the field names another server", { field: HOME, relay: true, server: fromConfig }, p => !!p && p.includes(HOME) && p.includes(LAN)],
    ["saved but not restarted", { field: LAN, relay: true, server: savedNotStarted }, p => !!p && p.includes(HOME)],
    ["the relay has no usable server", { field: LAN, relay: true, server: broken }, p => !!p && p.includes(broken.error)],
    // Start needs the backend online, so this is a backend older than the page:
    // its relay wants a base_url and would refuse the first turn.
    ["the backend has not said", { field: LAN, relay: true, server: null },
      p => !!p && /older than this page/.test(p) && /Restart start\.bat/.test(p)],
    ["OLLAMA_BASE_URL decides and the field names another: saving would not help", { field: LAN, relay: true, server: fromEnv },
      p => !!p && p.includes("10.0.0.9") && /change OLLAMA_BASE_URL and restart start\.bat/.test(p) && !/Save the address/.test(p)],
    ["OLLAMA_BASE_URL is not usable", { field: LAN, relay: true, server: brokenEnv },
      p => !!p && p.includes(brokenEnv.error) && /clear OLLAMA_BASE_URL/.test(p) && !/Save a working/.test(p)],
    ["the field holds a password: the log does not", { field: "http://agent:S3cretTok@192.168.1.50:11434", relay: true, server: fromConfig },
      p => !!p && !p.includes("S3cretTok") && !p.includes("agent:") && p.includes("http://***@192.168.1.50:11434")],
    ["relay off: the browser calls the field", { field: "http://10.0.0.7:11434", relay: false, server: fromConfig }, p => p === null],
    ["relay off: what the backend says does not matter", { field: "http://10.0.0.7:11434", relay: false, server: null }, p => p === null],
  ];
  const badStarts = starts.map(([label, input, ok]) => [label, ollama.ollamaStartProblem(input), ok]).filter(([, p, ok]) => !ok(p));
  check(`ollamaStartProblem stops a session whose model requests would go elsewhere (${starts.length} cases)`, !badStarts.length,
    badStarts.map(([label, p]) => `${label}: ${show(p)}`).join("; "));

  const saves = [
    ["saved, restart needed", { ok: true, saved: LAN, active: HOME, restartRequired: true, overriddenBy: null },
      m => m.type === "success" && m.text.includes(LAN) && m.text.includes(HOME) && /Restart start\.bat/.test(m.text)],
    ["saved, already in use", { ok: true, saved: LAN, active: LAN, restartRequired: false, overriddenBy: null },
      m => m.type === "success" && /already relays/.test(m.text)],
    ["saved, but OLLAMA_BASE_URL wins", { ok: true, saved: LAN, active: "http://10.0.0.9:11434", restartRequired: true, overriddenBy: "OLLAMA_BASE_URL" },
      m => m.type === "warn" && m.text.includes("OLLAMA_BASE_URL")],
    ["saved, but an unusable OLLAMA_BASE_URL wins", { ok: true, saved: LAN, active: null, restartRequired: true, overriddenBy: "OLLAMA_BASE_URL" },
      m => m.type === "warn" && m.text.includes("no usable server") && !m.text.includes("null")],
    ["saved, while the relay has no usable server", { ok: true, saved: LAN, active: null, restartRequired: true, overriddenBy: null },
      m => m.type === "success" && m.text.includes("no usable server") && !m.text.includes("null")],
    ["refused as not an address", { ok: false, error: "'x' does not start with http:// or https://" },
      m => m.type === "warn" && m.text.includes("does not start with http://")],
    ["a backend older than the route", { detail: "Not Found" }, m => m.type === "warn" && /restart start\.bat/.test(m.text)],
    ["the page refused (already said)", { ok: false, refused: "token", error: "reload" }, m => m === null],
  ];
  const badShown = [
    ["http://192.168.1.50:11434/", "http://192.168.1.50:11434"],
    ["https://agent:S3cretTok@ollama.example", "https://***@ollama.example"],
    ["http://agent:p@S3cretTok@192.168.1.50:11434", "http://***@192.168.1.50:11434"],
    ["agent:S3cretTok//x@192.168.1.50:11434", "***@192.168.1.50:11434"],
  ].filter(([typed, want]) => ollama.shownOllamaBase(typed) !== want);
  check("shownOllamaBase hides a user name and password before the log keeps them", !badShown.length,
    badShown.map(([typed]) => typed + " -> " + ollama.shownOllamaBase(typed)).join("; "));

  const badSaves = saves.map(([label, reply, ok]) => [label, ollama.ollamaSavedMessage(reply), ok]).filter(([, m, ok]) => !ok(m));
  check(`ollamaSavedMessage says what Save did and when it takes effect (${saves.length} cases)`, !badSaves.length,
    badSaves.map(([label, m]) => `${label}: ${show(m)}`).join("; "));

  const model = name => ({ name });
  const lists = [
    ["two models", { ok: true, base: LAN, models: [model("qwen2.5vl:3b"), model("gemma3:4b")] },
      m => m.type === "success" && m.text.includes(LAN) && m.text.includes("2 models") && m.text.includes("gemma3:4b")],
    ["many models", { ok: true, base: LAN, models: Array.from({ length: 10 }, (_, i) => model(`m${i}`)) },
      m => m.type === "success" && m.text.includes("and 2 more") && !m.text.includes("m9")],
    ["no models", { ok: true, base: LAN, models: [] }, m => m.type === "warn" && m.text.includes("ollama pull")],
    ["no answer", { ok: false, base: LAN, status: 0, error: "URLError: <urlopen error [WinError 10061] refused>" },
      m => m.type === "warn" && m.text.includes(LAN) && m.text.includes("10061")],
    ["no usable server", { ok: false, detail: `${broken.error}. Fix it, then restart the backend (start.bat).` },
      m => m.type === "error" && m.text.includes(broken.error)],
    ["a backend older than the route", { detail: "Not Found" }, m => m.type === "warn" && /restart start\.bat/.test(m.text)],
    ["the page refused (already said)", { ok: false, refused: "token" }, m => m === null],
  ];
  const badLists = lists.map(([label, reply, ok]) => [label, ollama.ollamaModelsMessage(reply), ok]).filter(([, m, ok]) => !ok(m));
  check(`ollamaModelsMessage reports the relay's server and its models (${lists.length} cases)`, !badLists.length,
    badLists.map(([label, m]) => `${label}: ${show(m)}`).join("; "));
}

// ── How long one action may hold, and how much it may type ────────────────────
// hold_key with a duration of 600 held a key down for ten minutes that Stop could
// not end, and type_text took text of any length. The backend now bounds both, and
// the gamepad's holds (tools/check_backend.py checks that side). Here: the page
// states the backend's numbers in the tool schemas and in JSON-action mode's tool
// list, and every hold or type the model asks for tells it what was really done.
console.log("input limits");
{
  const limits = await import(pathToFileURL(path.join(ROOT, "src", "agent", "inputLimits.js")).href);
  const pyNumber = name => {
    const m = py.match(new RegExp(`^${name}\\s*=\\s*([\\d.]+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const numbers = ["KEY_HOLD_MAX_S", "GAMEPAD_HOLD_MAX_S", "GAMEPAD_BUTTON_MIN_S", "TYPE_TEXT_MAX_CHARS"]
    .map(n => [n, pyNumber(n), limits[n]]);
  check("the page's hold and typing limits are the backend's", numbers.every(([, a, b]) => typeof a === "number" && a === b), show(numbers));
  const { KEY_HOLD_MAX_S, GAMEPAD_HOLD_MAX_S, GAMEPAD_BUTTON_MIN_S, TYPE_TEXT_MAX_CHARS } = limits;

  if (agent) {
    const tool = name => [...agent.__TOOLS, ...agent.__GAMEPAD_TOOLS].find(t => t.name === name);
    const prop = (name, field) => tool(name)?.input_schema?.properties?.[field];
    const schemas = [
      ["hold_key", "duration", { minimum: 0, maximum: KEY_HOLD_MAX_S }, `at most ${KEY_HOLD_MAX_S} per call`],
      ["type_text", "text", { maxLength: TYPE_TEXT_MAX_CHARS }, `at most ${TYPE_TEXT_MAX_CHARS} characters per call`],
      ["gamepad_button", "hold", { minimum: GAMEPAD_BUTTON_MIN_S, maximum: GAMEPAD_HOLD_MAX_S }, `at most ${GAMEPAD_HOLD_MAX_S}`],
      ["gamepad_stick", "duration", { minimum: 0, maximum: GAMEPAD_HOLD_MAX_S }, `at most ${GAMEPAD_HOLD_MAX_S}`],
      ["gamepad_trigger", "duration", { minimum: 0, maximum: GAMEPAD_HOLD_MAX_S }, `at most ${GAMEPAD_HOLD_MAX_S}`],
    ].filter(([name, field, bounds, words]) =>
      !Object.entries(bounds).every(([k, v]) => prop(name, field)?.[k] === v) ||
      !`${tool(name)?.description} ${prop(name, field)?.description ?? ""}`.includes(words))
      .map(([name, field]) => `${name}.${field}: ${show(prop(name, field))}; ${show(tool(name)?.description)}`);
    check("the hold_key, type_text and gamepad schemas state the backend's limits, in the schema and in words", !schemas.length,
      schemas.join("; "));
    // The key goes up when each call ends, and the next call comes a model turn
    // later: "call again to keep holding" had the model plan on an unbroken hold.
    const holdWords = tool("hold_key")?.description ?? "";
    check("hold_key says the key is let go when each call ends, not that another call keeps holding",
      holdWords.includes("released when the call ends") && !/call again|keep holding|repeat/i.test(holdWords), show(holdWords));

    const reference = agent.__buildActionReference([...agent.__TOOLS, ...agent.__GAMEPAD_TOOLS]).split("\n");
    const listed = [
      ["hold_key", `"duration" (0 to ${KEY_HOLD_MAX_S})`],
      ["type_text", `"text" (max ${TYPE_TEXT_MAX_CHARS} chars)`],
      ["gamepad_button", `"hold"? (${GAMEPAD_BUTTON_MIN_S} to ${GAMEPAD_HOLD_MAX_S})`],
      ["gamepad_stick", `"duration"? (0 to ${GAMEPAD_HOLD_MAX_S})`],
    ].map(([name, want]) => [want, reference.find(l => l.startsWith(`- ${name} `)) ?? ""]).filter(([want, line]) => !line.includes(want));
    check("JSON-action mode lists the limits too", !listed.length, show(listed));
  }

  const hold = (requested, applied, extra = {}) => ({
    ok: true, method: "sendinput", held: applied, halted: false,
    limit: { requested, applied, min: 0, max: KEY_HOLD_MAX_S, unit: "s", clamped: requested !== applied }, ...extra,
  });
  const typed = (requested, applied) => ({
    ok: true, limit: { requested, applied, min: 0, max: TYPE_TEXT_MAX_CHARS, unit: "characters", clamped: requested !== applied },
  });
  const results = [
    ["a 600 s hold cut to 5 s", limits.holdKeyResult(hold(600, 5), { duration: 600 }),
      t => t.startsWith("Key held for 5s.") && t.includes("Asked for 600s") && t.includes("at most 5s per call")
        && t.includes("let go when the call ends") && !/repeat|call again|keep holding/i.test(t)],
    ["a hold within the limit", limits.holdKeyResult(hold(0.25, 0.25), { duration: 0.25 }), t => t === "Key held for 0.25s."],
    ["a hold below zero", limits.holdKeyResult(hold(-3, 0), { duration: -3 }),
      t => t.startsWith("Key held for 0s.") && t.includes("at least 0s")],
    ["an infinite hold (not from this page)", limits.holdKeyResult(hold("inf", 5), {}), t => t.includes("Asked for inf,") && t.includes("at most 5s")],
    ["a hold halted part-way", limits.holdKeyResult(hold(600, 5, { held: 0.3, halted: true }), { duration: 600 }),
      t => t.startsWith("Key held for 0.3s.") && t.includes("halted after 0.3s") && !t.includes("repeat")],
    ["a backend from before the limits", limits.holdKeyResult({ ok: true, method: "sendinput" }, { duration: 2 }), t => t === "Key held for 2s."],
    ["a failed hold", limits.holdKeyResult({ ok: false, error: "no key to hold in ''", limit: hold(1, 1).limit }, {}),
      t => t === "Error: no key to hold in ''"],
    ["a hold the backend refused", limits.holdKeyResult({ detail: [{ loc: ["body", "duration"], msg: "Field required" }] }, {}),
      t => t === "Error: duration: Field required"],
    ["1000 characters cut to 300", limits.typeTextResult(typed(1000, 300)),
      t => t.startsWith("Text typed.") && t.includes("first 300 of 1000 characters") && t.includes("send the rest")],
    ["300 characters", limits.typeTextResult(typed(300, 300)), t => t === "Text typed."],
    ["typed, by a backend from before the limits", limits.typeTextResult({ ok: true }), t => t === "Text typed."],
    ["a gamepad press too short to see", limits.withLimitNotes("Pressed a.", { ok: true, limit: { requested: 0, applied: 0.02, min: 0.02, max: 5, unit: "s", clamped: true } }),
      t => t.startsWith("Pressed a. ") && t.includes("at least 0.02s")],
    ["no reply at all", limits.limitNote(undefined) + limits.haltNote(null), t => t === ""],
    // The backend sends `limit` with its errors too. A call that failed typed or
    // held nothing, so no note may say it did so in part.
    ["a failed type that carries a cut limit", limits.limitNote({ ok: false, error: "no clipboard", limit: typed(1000, 300).limit }),
      t => t === ""],
    ["a failed hold that carries a cut limit and a halt",
      limits.replyNote({ ...hold(600, 5, { held: 0.3, halted: true }), ok: false, error: "SendInput failed" })
        + limits.withLimitNotes("", { ...hold(600, 5), ok: false }), t => t === ""],
    ["a sequence step both halted and cut", limits.replyNote(hold(600, 5, { held: 0.3, halted: true })),
      t => t.includes("halted after 0.3s") && !t.includes("per call")],
  ].filter(([, text, ok]) => !ok(text)).map(([label, text]) => `${label}: ${show(text)}`);
  check("tool results say what the backend held or typed, not what was asked", !results.length, results.join("; "));

  // Every hold or type in GameAgent.jsx, the steps of execute_sequence included,
  // has its result go through those, up to the next tool's handler.
  const calls = [...code.matchAll(/backend\("\/(keyboard\/hold|keyboard\/type|gamepad\/(?:button|stick|trigger))"/g)];
  const unreported = calls.map(m => {
    const rest = code.slice(m.index);
    const next = rest.search(/\btoolName === /);
    const handler = next < 0 ? rest : rest.slice(0, next);
    return /\b(?:limitNote|replyNote|withLimitNotes|holdKeyResult|typeTextResult)\(/.test(handler) ? null : `${m[1]} at: ${context(m.index)}`;
  }).filter(Boolean);
  check(`every hold and type the model asks for tells it what was cut (${calls.length} calls)`, calls.length >= 7 && !unreported.length,
    unreported.length ? unreported.join("  |  ") : `found ${calls.length}, expected at least 7 — has the tool code changed shape?`);
  // execute_sequence answers with one line per step, changed or not.
  // replyNote, not limitNote: a step that was halted must not be told to hold longer.
  const noted = code.match(/const (\w+) = replyNote\(r\);\s*const (\w+) = \1 \?/);
  const stepLines = [...code.matchAll(/summary\.push\(`\$\{executed\}: \$\{t\}[^`]*?(no change|changed)(\$\{\w+\})?`\)/g)];
  check("execute_sequence puts what was cut on each step's line",
    !!noted && stepLines.length === 2 && stepLines.every(m => m[2] === `\${${noted[2]}}`),
    show({ note: noted?.[0] ?? null, lines: stepLines.map(m => m[0]) }));
}

// ── The kill switch ───────────────────────────────────────────────────────────
// The mouse in a screen corner never stopped keys sent with SendInput, and Stop
// only stopped the page asking for more. The backend now halts input on a hotkey
// or on Stop and refuses input with 423 until Resume (tools/check_backend.py
// checks that side). Here: the page and the backend agree on the names, the page
// says the right things, and the page is wired so that a halt is waited out,
// never counted as a no-op, an error or a stuck game, and Stop halts too.
console.log("kill switch");
{
  const ks = await import(pathToFileURL(path.join(ROOT, "src", "agent", "killSwitch.js")).href);
  const pyStatus = py.match(/^HALT_STATUS\s*=\s*(\d+)/m);
  const pyReasons = py.match(/^HALT_REASONS\s*=\s*\(([^)]*)\)/m);
  const pyReasonNames = pyReasons ? [...pyReasons[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]) : null;
  const pageReasons = py.match(/class HaltBody\(BaseModel\):\s*reason: Literal\[([^\]]*)\]/);
  check("the page and the backend agree on the halt status and the reasons for a halt",
    Number(pyStatus?.[1]) === ks.HALT_STATUS && same(pyReasonNames, ks.HALT_REASONS) && ks.HALT_REASONS.includes(ks.STOP_HALT)
      && same(pageReasons ? [...pageReasons[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]) : null, ["page", "stop"]),
    show({ status: pyStatus?.[1], reasons: pyReasonNames, page: pageReasons?.[1] }));

  const state = (halted, reasons, extra = {}) => ({
    halted, reasons, by: reasons.length ? "Ctrl+Alt+Pause" : null, since: halted ? "2026-09-17T14:03:22" : null,
    hotkeys: ["Ctrl+Alt+Pause", "Ctrl+Alt+Shift+H"], hotkeyProblems: [], ...extra,
  });
  const idle = ks.readHaltState(state(false, []));
  const byHotkey = ks.readHaltState(state(true, ["hotkey"]));
  const byStop = ks.readHaltState(state(true, ["stop"], { by: "■ Stop on the agent page" }));
  const cases = [
    ["a reply that is not a state (an old backend's 404, no answer)",
      [ks.readHaltState({ detail: "Not Found" }), ks.readHaltState({ ok: false, error: "Failed to fetch" }), ks.readHaltState(null)],
      r => r.every(x => x === null)],
    ["a hotkey's halt gets the red banner, with who and when, and a log line; Stop's own gets neither",
      [ks.haltBanner(byHotkey), ks.haltBanner(byStop), ks.haltBanner(idle), ks.haltChange(idle, byHotkey), ks.haltChange(idle, byStop)],
      ([banner, stop, none, said, quiet]) => banner?.title === "Input halted: press Resume" && banner.detail.includes("Ctrl+Alt+Pause")
        && banner.detail.includes("14:03:22") && stop === null && none === null && said?.type === "error" && said.text.includes("Resume")
        && quiet === null],
    ["a hotkey pressed while Stop's halt is on is still said, and Resume is logged; Stop's own lifting is not",
      [ks.haltChange(byStop, ks.readHaltState(state(true, ["stop", "hotkey"]))), ks.haltChange(byHotkey, idle), ks.haltChange(byStop, idle),
        ks.haltChange(byHotkey, byHotkey)],
      ([said, resumed, quiet, same]) => said?.type === "error" && resumed?.text === "▶ Input resumed." && quiet === null && same === null],
    ["▶ Start refuses while someone halted input, and not for Stop's own halt or an old backend",
      [ks.haltStartProblem(byHotkey), ks.haltStartProblem(byStop), ks.haltStartProblem(idle), ks.haltStartProblem(null)],
      ([refused, ...rest]) => /^Not started: input is halted .*Resume/.test(refused ?? "") && rest.every(x => x === null)],
    ["an input route's halted reply is heard; the state's own routes are not",
      [ks.inputHalted("/mouse/click", 423, { ok: false, halted: true }), ks.inputHalted("/keyboard/hold", 200, { ok: true, halted: true }),
        ks.inputHalted("/session/state", 200, { halted: true, reasons: ["hotkey"] }), ks.inputHalted("/session/halt", 200, { ok: true, halted: true }),
        ks.inputHalted("/keyboard/hold", 200, { ok: true, halted: false })],
      r => same(r, [true, true, false, false, false])],
    ["the model is told a halt is not a move that failed, and what was done before it",
      [ks.haltedToolText({ ok: false, halted: true, error: "x" }), ks.haltedToolText({ ok: false, halted: true, typed: 4 }),
        ks.haltedToolText({ ok: true, halted: true, held: 0.3 }), ks.haltedToolText({ ok: false, halted: true, clicked: 1 })],
      ([refused, typed, held, clicked]) => refused.startsWith("Not done.") && /do not try another action/.test(refused) && /Resume/.test(refused)
        && typed.startsWith("Only the first 4 characters") && held.startsWith("Input was halted after 0.3s") && clicked.startsWith("Clicked 1 time,")],
    ["the controls name the registered hotkeys and ■ Stop for a game that blocks them, and warn when there are none",
      [ks.hotkeysNote(byHotkey), ks.hotkeysNote(ks.readHaltState(state(false, [], { hotkeys: [], hotkeyProblems: ["Ctrl+Alt+Pause is taken by another program"] }))),
        ks.hotkeysNote(null)],
      ([named, none, unknown]) => named?.type === "info" && named.text.includes("Ctrl+Alt+Pause or Ctrl+Alt+Shift+H")
        && named.text.includes("■ Stop") && !/any window/.test(named.text)
        && none?.type === "warn" && none.text.includes("taken by another program") && none.text.includes("■ Stop") && unknown === null],
    // A halted tool result is known by a list, not a field: the result goes to
    // the provider as it is, and Anthropic refuses a field it does not know.
    ["a tool result for an action that met a halt is known as one, and carries nothing more to the provider",
      (() => {
        const result = { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Not done." }] };
        const marked = ks.markHalted(result);
        return [marked === result, ks.metHalt(result), ks.metHalt({ ...result }), ks.metHalt(JSON.parse(JSON.stringify(result))),
          ks.metHalt(null), ks.metHalt({ type: "tool_result" }), JSON.stringify(result).includes("halted"), Object.keys(result)];
      })(),
      r => same(r, [true, true, false, false, false, false, false, ["type", "tool_use_id", "content"]])],
  ].filter(([, got, ok]) => !ok(got)).map(([label, got]) => `${label}: ${show(got)}`);
  check("what the page reads, shows and says about a halt", !cases.length, cases.join("; "));

  // The page's wiring, as esbuild prints it.
  const between = (from, to) => {
    const start = code.indexOf(from);
    const end = start < 0 ? -1 : code.indexOf(to, start + from.length);
    return start < 0 || end < 0 ? "" : code.slice(start, end);
  };
  const stop = between("const stopAgent = useCallback(", "const togglePause = useCallback(");
  check("■ Stop aborts the model request in flight and halts the input already sent",
    /stopCtrlRef\.current\.abort\(\);/.test(stop) && /backend\("\/session\/halt", \{ reason: STOP_HALT \}\)/.test(stop), show(stop.slice(0, 200)));
  const lifts = [...code.matchAll(/backend\("\/session\/resume", \{ reason: STOP_HALT \}\)/g)].length;
  const resume = between("const resumeInput = useCallback(", "const waitWhileHalted");
  check("the page lifts only Stop's own halt by itself (when its run ends, or one left behind, idle or at Start); Resume lifts any",
    lifts === 3 && /backend\("\/session\/resume", \{\}\)/.test(resume) && !/reason/.test(resume), show({ lifts, resume: resume.slice(0, 160) }));
  check("the games loop waits while input is halted, as while paused",
    /while \(\(pauseRef\.current \|\| haltedRef\.current\) && !stopRef\.current\) await/.test(code), "no wait on haltedRef at the top of the loop");
  check("a solver move that met a halt is neither a failure nor a blocked move, and the loop goes round",
    /if \(isHaltReply\(res\)\) return \{ halted: true, reason: "input halted" \};\s*if \(!res\.ok\) \{/.test(code) && /if \(sr\.halted\) continue;/.test(code),
    "solverTurn or the games loop does not handle { halted }");
  check("the loop's own clicks (a restart button, a decision's option) wait out a halt instead of failing",
    [...code.matchAll(/sendWhenLive\("\/mouse\/click"/g)].length === 3, `found ${[...code.matchAll(/sendWhenLive\("\/mouse\/click"/g)].length}, wanted 3`);
  check("▶ Start does not begin while someone halted input", /const haltProblem = haltStartProblem\(/.test(between("const startAgent = useCallback(", "stopRef.current = false;")),
    "no haltStartProblem before the run's reset");
  // startingRef is what keeps a second click on ▶ Start out. Let down while the
  // page waits for the state or for Stop's halt to be lifted, it let a double
  // click start two runs side by side, both sending input.
  const startHalt = between('const haltReply = await backend("/session/state")', 'backend("/session/resume", { reason: STOP_HALT })');
  check("▶ Start keeps a second click out while it asks for the halt state and lifts Stop's halt",
    !!startHalt && /if \(haltProblem\) \{\s*startingRef\.current = false;[^}]*return;\s*\}/.test(startHalt)
      && !/startingRef\.current = false/.test(startHalt.replace(/if \(haltProblem\) \{[^}]*\}/, "")),
    show(startHalt.slice(0, 300)));
  // A restart click the model picked that met a halt was never sent: counted as
  // a failed attempt, three of them ended the session, on exactly the games with
  // no plugin, which only have this way to restart.
  const restart = between("const attemptRestart = useCallback(", "const testSolver = useCallback(");
  const afterClick = restart.slice(restart.indexOf("await executeTool(clickAct.tool"));
  check("a restart click the model picked that met a halt is not counted as an attempt",
    /^await executeTool\(clickAct\.tool[^;]*;\s*if \(metHalt\((\w+)\)\) \{\s*attempt--;\s*continue;\s*\}/.test(afterClick)
      && afterClick.indexOf("metHalt(") < afterClick.indexOf("verify(")
      && /if \(!await waitWhileHalted\(\)\) return \{ ok: false \};/.test(restart.slice(0, restart.indexOf("await executeTool(clickAct.tool"))),
    show(afterClick.slice(0, 200)));
  const executeTool = between("const executeTool = useCallback(", "toolName === \"observe_screen\"");
  check("executeTool marks a halted action's tool result", /return markHalted\(toolResult\(haltedToolText\(res\)\)\);/.test(executeTool),
    show(executeTool.slice(executeTool.indexOf("const halted"), executeTool.indexOf("const halted") + 160)));

  // In executeTool, every input the model sends is checked for a halt before the
  // screen is watched for a change or a no-op is counted.
  const tools = between("const executeTool = useCallback(", 'toolName === "update_memory"');
  const unchecked = [...tools.matchAll(/backend\("\/(mouse|keyboard|gamepad)\/[a-z]+"/g)].map(m => {
    const rest = tools.slice(m.index + m[0].length);
    const next = rest.search(/waitChange\(|noOpStreakRef|toolName === /);
    return /isHaltReply\(/.test(next < 0 ? rest : rest.slice(0, next)) ? null : context(code.indexOf(tools) + m.index);
  }).filter(Boolean);
  const inputs = [...tools.matchAll(/backend\("\/(mouse|keyboard|gamepad)\/[a-z]+"/g)].length;
  check(`every input the model sends is checked for a halt before a no-op could be counted (${inputs} calls)`,
    inputs >= 15 && !unchecked.length, unchecked.length ? unchecked.join("  |  ") : `found ${inputs}, expected at least 15`);
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

// ── The standing rule about what is on screen ─────────────────────────────────
// The agent plays games nobody vetted, and anything on screen — an ad, a fake
// "Download" button, a line of chat, a page that knows a model is reading it —
// can be written as an order to the model, which holds the real mouse and
// keyboard. Every system prompt therefore carries the rule from
// src/agent/prompts.js. Here: that the rule still says what it is for, and that
// the page adds it where model requests are built; the wire checks below confirm
// it arrives, for every provider.
{
  console.log("the standing screen rule");
  const says = (what, re) => check(`the rule says ${what}`, re.test(SCREEN_RULE), show(SCREEN_RULE));
  says("what is on screen is not instructions to the model", /screen[\s\S]*(never instructions|not instructions)/i);
  says("not to obey what the screen tells it to do", /(do not|never) (obey|follow)/i);
  says("not to type credentials or personal data", /password/i);
  says("not to type URLs", /url/i);
  says("not to download or install", /(download|install)/i);
  says("not to sign in or make an account", /(sign in|account)/i);
  says("what to do instead: report the game as stuck", /stuck/i);
  // The prompt goes out with every request, and a 4k-context local model has to
  // hold it alongside a screenshot.
  const sentences = (SCREEN_RULE.match(/\.(\s|$)/g) ?? []).length;
  check("the rule is at most three sentences and 500 characters",
    sentences <= 3 && SCREEN_RULE.length <= 500, `${sentences} sentences, ${SCREEN_RULE.length} characters`);

  check("withScreenRule puts the rule after a prompt, keeping the prompt",
    withScreenRule("PLAY BRIEF") === `PLAY BRIEF\n\n${SCREEN_RULE}`, show(withScreenRule("PLAY BRIEF")));
  check("adding the rule twice adds it once",
    withScreenRule(withScreenRule("PLAY BRIEF")) === withScreenRule("PLAY BRIEF") &&
      (withScreenRule(`${SCREEN_RULE}\n\nPLAY BRIEF`).match(/SCREEN SAFETY/g) ?? []).length === 1,
    show(withScreenRule(withScreenRule("PLAY BRIEF"))));
  check("an empty prompt is still the rule",
    withScreenRule("") === SCREEN_RULE && withScreenRule(null) === SCREEN_RULE && withScreenRule(undefined) === SCREEN_RULE,
    show(withScreenRule(null)));

  // The rule also has to say that the game's own words to the player still
  // count. An unseen game has no plugin and no manual: the screen is where the
  // agent learns the objective and the controls, and set_goals is built out of
  // that. A rule read as "ignore what the screen says" would take the one
  // channel an unknown game has, and would contradict the brief it is appended
  // to, which tells the model to click a visible start button.
  says("the game's own instructions to the player still count",
    /(read|follow|use) it to learn|follow the game's own/i);
  says("what it refuses is aimed past the game", /(beyond|outside) playing|aimed at you/i);

  // Added where the provider request is built, which is the one place every
  // prompt passes through — a prompt written later cannot be left out.
  check("callAI adds the rule to the prompt it was given",
    /const request = \{ model, system: withScreenRule\(systemPrompt\)/.test(source),
    "expected `const request = { model, system: withScreenRule(systemPrompt), …` in callAI");

  // callAI appends, so a prompt whose last line is a format instruction has to
  // state the rule itself, ahead of that line. Three do: the JSON-action
  // protocol block, which ends the playing prompts on a small local model, and
  // the two replies the page parses as JSON. withScreenRule is idempotent, so
  // callAI still leaves them alone and the wire checks below still hold.
  check("the JSON-action protocol stays the last thing in a playing prompt",
    /withScreenRule\(\w+\)\s*\+\s*\(noToolsMode \? buildJsonProtocol\(/.test(source),
    "expected the briefs built as `withScreenRule(brief) + (noToolsMode ? buildJsonProtocol(…) : \"\")`");
  check("the prompts whose reply is parsed as JSON state the rule before their format line",
    /\$\{SCREEN_RULE\}\s*\n\s*\nYou are looking at a game that has stopped responding/.test(source) &&
      /`\$\{SCREEN_RULE\}\\n\\nYou are a game session analyst/.test(source),
    "expected the stuck-screen and post-session analysis prompts to open with ${SCREEN_RULE}");
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

    // What callAI puts on the wire for each cloud provider (src/llm/requests.js
    // builds it; tools/check-llm.mjs checks the builders on their own).
    const headerIn = (sent, name) => Object.entries(sent?.init?.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    const answers = {
      anthropic: { type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" },
      openai: { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] },
      gemini: { candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] },
    };
    const wire = {};
    for (const provider of ["anthropic", "openai", "gemini"]) {
      respond = () => json(200, answers[provider]);
      const r = await run(provider, { retry: false, maxTokens: 1 });
      const sent = r.sent[0];
      wire[provider] = { r, sent, body: sent?.init?.body ? JSON.parse(sent.init.body) : null };
    }
    check("callAI sends Anthropic the browser header, the key, and the caller's token cap",
      !wire.anthropic.r.e && headerIn(wire.anthropic.sent, "anthropic-dangerous-direct-browser-access") === "true" &&
        headerIn(wire.anthropic.sent, "x-api-key") === "test-key" && wire.anthropic.body?.max_tokens === 1,
      show({ error: wire.anthropic.r.e?.message, headers: wire.anthropic.sent?.init?.headers, max_tokens: wire.anthropic.body?.max_tokens }));
    check("callAI sends OpenAI max_completion_tokens, not max_tokens",
      !wire.openai.r.e && wire.openai.body?.max_completion_tokens === 1 && !("max_tokens" in (wire.openai.body ?? {})),
      show({ error: wire.openai.r.e?.message, body: wire.openai.body }));
    check("callAI sends Gemini the key in x-goog-api-key, with no key in the URL",
      !wire.gemini.r.e && headerIn(wire.gemini.sent, "x-goog-api-key") === "test-key" && !/key=|test-key/.test(wire.gemini.sent?.url ?? "key=") &&
        wire.gemini.sent.url.endsWith("/models/test-model:generateContent") && wire.gemini.body?.generationConfig?.maxOutputTokens === 1,
      show({ error: wire.gemini.r.e?.message, url: wire.gemini.sent?.url, headers: wire.gemini.sent?.init?.headers }));

    // Gemini's thought signature, through callAI both ways: the reply is kept
    // in the conversation as the loop keeps it, and the next request sends the
    // call's part back exactly as it came.
    {
      const signed = [
        { text: "Up.", thoughtSignature: "sig-text" },
        { functionCall: { id: "fc-1", name: "press_key", args: { key: "up" } }, thoughtSignature: "sig-call" },
      ];
      respond = () => json(200, { candidates: [{ content: { role: "model", parts: signed }, finishReason: "STOP" }] });
      const stop = new AbortController();
      const turn = [{ role: "user", content: "Turn 1." }];
      const first = await agent.__callAI("gemini", "test-model", "system", turn, [], "test-key", null, { signal: stop.signal, retry: false });
      const use = first.content.find(c => c.type === "tool_use");
      calls.length = 0;
      respond = () => json(200, answers.gemini);
      await agent.__callAI("gemini", "test-model", "system", [
        ...turn,
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "pressed up" }] },
      ], [], "test-key", null, { signal: stop.signal, retry: false });
      const contents = calls[0]?.init?.body ? JSON.parse(calls[0].init.body).contents : [];
      check("callAI sends a Gemini function call back with its thought signature, as received, and answers it by its id",
        same(contents[1]?.parts, signed) && contents[2]?.parts?.[0]?.functionResponse?.id === "fc-1",
        show(contents));
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

    // Which server: the relay's own, whatever the field says; the field only
    // for a call straight from the browser.
    const LAN = "http://192.168.1.50:11434";
    agent.__setOllamaBase(`${LAN}/`);
    try {
      respond = () => json(200, { ok: true, status: 200, elapsed: 0.1, body: { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] } });
      const relayed = await run("ollama", { retry: false }, { relay: true });
      const sentBody = relayed.sent[0]?.init?.body ? JSON.parse(relayed.sent[0].init.body) : null;
      check("ollama via the relay: the request names no Ollama server, only what to send",
        !relayed.e && relayed.calls === 1 && relayed.sent[0].url === "/api/llm/ollama" &&
          same(Object.keys(sentBody ?? {}).sort(), ["payload", "timeout"]) && !JSON.stringify(sentBody).includes("192.168.1.50"),
        show({ error: relayed.e?.message, url: relayed.sent[0]?.url, keys: sentBody && Object.keys(sentBody) }));
      respond = () => json(200, { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
      const direct = await run("ollama", { retry: false }, { relay: false });
      check("ollama direct: the browser calls the OLLAMA SERVER field's address",
        !direct.e && direct.calls === 1 && direct.sent[0].url === `${LAN}/v1/chat/completions`,
        show({ error: direct.e?.message, urls: direct.sent.map(c => c.url) }));
    } finally {
      agent.__setOllamaBase(null);
    }

    // The standing screen rule is on the wire, whichever provider answers, and
    // the caller's own prompt is still there in front of it. Checked from the
    // request body rather than from the source, because every route puts the
    // system prompt somewhere else (Anthropic `system`, OpenAI and Ollama a
    // first message, Gemini `systemInstruction`), and a route that stopped
    // sending it would still read fine.
    {
      const ruled = (v) => typeof v === "string" ? (v.includes(SCREEN_RULE) ? [v] : [])
        : Array.isArray(v) ? v.flatMap(ruled)
        : v && typeof v === "object" ? Object.values(v).flatMap(ruled)
        : [];
      const wanted = withScreenRule("system"); // `run` sends "system" as the prompt
      const wrong = [];
      for (const [provider, o] of routes) {
        respond = provider === "ollama" && o.relay !== false
          ? () => json(200, { ok: true, status: 200, elapsed: 0.1, body: answers.openai })
          : () => json(200, answers[provider] ?? answers.openai);
        const r = await run(provider, { retry: false, maxTokens: 1 }, o);
        const body = r.sent[0]?.init?.body ? JSON.parse(r.sent[0].init.body) : null;
        const carried = body ? ruled(body) : [];
        if (r.e || carried.length !== 1 || carried[0] !== wanted) {
          wrong.push(`${routeName(provider, o)}: ${show(r.e?.message ?? carried)}`);
        }
      }
      check(`every provider request carries the standing screen rule, after the caller's prompt (${routes.length} routes)`,
        !wrong.length, wrong.join("  |  "));
    }

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
    // The relay with no usable Ollama address (503), or a server that redirects
    // elsewhere (502): asking again meets the same refusal, so the session ends
    // with the backend's reason instead of waiting fifteen minutes.
    for (const [status, detail] of [
      [503, "ollamaBase in agent-config.json is not a usable Ollama address: 'x'. Fix it, then restart the backend (start.bat)."],
      [502, "the Ollama server at http://192.168.1.50:11434 answered with a redirect (HTTP 307), which the relay does not follow."],
    ]) {
      respond = () => json(status, { ok: false, detail });
      const r = await run("ollama", {}, { relay: true });
      check(`ollama via the relay: an HTTP ${status} refusal from the relay ends the session at once, in the backend's words`,
        !r.hung && r.e?.verdict?.kind === "fatal" && r.e.verdict.reason === "backend-refused" && r.calls === 1 &&
          r.e.verdict.userText.includes(detail.slice(0, 40)),
        show({ verdict: r.e?.verdict, calls: r.calls }));
    }

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

      // The kill switch: an input route that finds input halted is heard at
      // once, so the games loop waits from that moment; the halt state's own
      // routes are read as a state instead.
      const halts = [];
      agent.__onInputHalted(r => halts.push(r));
      respond = () => json(423, { ok: false, halted: true, error: "input is halted by Ctrl+Alt+Pause: ..." });
      const refusedClick = await agent.__backend("/mouse/click", { x: 1, y: 2 });
      respond = () => json(200, { ok: true, method: "sendinput", held: 0.3, halted: true });
      await agent.__backend("/keyboard/hold", { key: "a", duration: 5 });
      respond = () => json(200, { halted: true, reasons: ["hotkey"], by: "Ctrl+Alt+Pause" });
      await agent.__backend("/session/state");
      respond = () => json(200, { ok: true, halted: false });
      await agent.__backend("/keyboard/press", { key: "a" });
      check("backend() reports a halted input route at once (a 423, or a hold let go early), and not the state's own routes",
        halts.length === 2 && halts[0].halted === true && halts[1].held === 0.3 && refusedClick.ok === false && !refusedClick.refused
          && backendFailure(refusedClick).includes("halted"),
        show({ halts, refusedClick }));
    } finally {
      agent.__onBackendRefused(null);
      agent.__onInputHalted(null);
      delete globalThis.__AGENT_TOKEN__;
    }

    // ── The turn being measured: what callAI and backend() add to it ───────────
    // Only the model's reply used to be timed, so a slow turn could not be put
    // down to the model, the backend or the page's own waiting. callAI and
    // backend() now add their time, the tokens a reply reports and the inputs
    // the backend confirmed to the turn the games loop is measuring
    // (src/agent/turnClock.js, checked on its own in tools/check-episodes.mjs).
    console.log("turn records");
    const clock = await import(pathToFileURL(path.join(ROOT, "src", "agent", "turnClock.js")).href);
    const after = (ms, reply) => new Promise(r => realSetTimeout(r, ms)).then(reply);
    const measured = async (work) => {
      const turn = clock.startTurn({ kind: "model", turn: 1, game: 1 });
      agent.__beginTurn(turn);
      try { await work(); } finally { agent.__endTurn(turn); }
      return turn.finish({ kind: "action" });
    };
    const withUsage = {
      anthropic: { ...answers.anthropic, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } },
      openai: { ...answers.openai, usage: { prompt_tokens: 135, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
      gemini: { ...answers.gemini, usageMetadata: { promptTokenCount: 135, candidatesTokenCount: 12, thoughtsTokenCount: 8, cachedContentTokenCount: 30 } },
    };
    const tokenRecords = {};
    for (const provider of Object.keys(withUsage)) {
      respond = () => after(30, () => json(200, withUsage[provider]));
      tokenRecords[provider] = await measured(() => run(provider, { retry: false }));
    }
    const wrongTokens = Object.entries(tokenRecords)
      .filter(([, r]) => !(r.tokens_in === 135 && r.tokens_out === 20 && r.tokens_cached === 30 && r.llm_ms >= 25 && r.backend_ms === 0))
      .map(([p, r]) => `${p}: ${show(r)}`);
    check("during a turn, callAI's wait is the turn's llm time, and the tokens in, out and cached are the turn's, for every cloud provider",
      !wrongTokens.length, wrongTokens.join("  |  "));
    globalThis.__AGENT_TOKEN__ = token;
    try {
      respond = () => json(200, { ok: true, status: 200, elapsed: 0.1,
        body: { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5 } } });
      const relayed = await measured(() => run("ollama", { retry: false }, { relay: true }));
      check("the Ollama relay's round trip is llm time, not backend time, and no cache is claimed where Ollama reports none",
        relayed.tokens_in === 50 && relayed.tokens_out === 5 && relayed.tokens_cached === null && relayed.backend_ms === 0 && relayed.actions === 0,
        show(relayed));

      const inputs = await measured(async () => {
        respond = () => after(20, () => json(200, { ok: true }));
        await agent.__backend("/mouse/click", { x: 1, y: 2 });
        await agent.__backend("/keyboard/press", { key: "a" });
        respond = () => json(200, { ok: false, error: "(1, 2) is off the screen" });
        await agent.__backend("/mouse/click", { x: 1, y: 2 });
        respond = () => json(423, { ok: false, halted: true, error: "input is halted" });
        await agent.__backend("/keyboard/press", { key: "a" });
      });
      check("during a turn, an input request's round trip is backend time, and only an input the backend confirmed is an action",
        inputs.actions === 2 && inputs.backend_ms >= 35 && inputs.llm_ms === 0, show(inputs));
      const other = await measured(async () => {
        respond = () => after(30, () => json(200, { halted: false, reasons: [] }));
        await agent.__backend("/session/state");
        respond = () => after(10, () => json(200, { ok: true }));
        await agent.__backend("/log/append", { session: "s", lines: ["x"] });
      });
      check("requests that send no input to the game are neither backend time nor actions",
        other.backend_ms === 0 && other.actions === 0 && other.other_ms >= 35, show(other));
      respond = () => json(200, { ok: true });
      const outside = await agent.__backend("/mouse/click", { x: 1, y: 2 });
      check("outside a turn, backend() works as before and records nothing", outside.ok === true);
    } finally {
      delete globalThis.__AGENT_TOKEN__;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Where each turn's records come from ───────────────────────────────────────
// The records' shapes are checked in tools/check-episodes.mjs. What is read here
// is that the games loop feeds them: every turn of play is measured, the page
// times its own waiting, a run is stamped with both commits before it plays,
// each game with a result gets one line, and the flush neither drops a batch
// the backend did not take nor sends a model's reply cut short.
{
  console.log("run records");
  const once = (name, pattern, want = 1) => {
    const found = [...code.matchAll(pattern)].length;
    check(name, found === want, found ? `found ${found}, wanted ${want} — has the page changed shape?` : "not found — has the page changed shape?");
  };
  once("every solver turn is measured, as a plugin turn",
    /const solverTurn = useCallback\(\s*\(plugin\) => measureTurn\("plugin", \(\) => playSolverTurn\(plugin\)\)/g);
  once("every model turn of play is measured, as a model turn",
    /const agentTurn = useCallback\(\s*\(systemPrompt, apiKey\) => measureTurn\("model", \(\) => playModelTurn\(systemPrompt, apiKey\)\)/g);
  once("the solver's turn is played only through that measure", /\bplaySolverTurn\(/g);
  once("the model's turn is played only through that measure", /\bplayModelTurn\(/g);
  once("a measured turn is queued as a turn record however it ends",
    /beginTurn\((\w+)\);[\s\S]{0,200}?\} finally \{\s*endTurn\(\1\);\s*queueRecord\("turn", \1\.finish\(\w+\)\);\s*\}/g);
  once("every frame grab is the turn's capture time", /const grabFrame = useCallback\(\(\) => inTurnPhase\("capture", captureNow\), \[captureNow\]\);/g);
  once("the wait for the screen to change is the turn's confirm time, and says whether it did",
    /async function waitChange\([^)]*\) \{\s*return inTurnPhase\("confirm", async \(\) => \{\s*const (\w+) = await watchForChange\([^)]*\);\s*noteTurn\(\{ changed: !!\1\.changed \}\);/g);
  const rawPace = [...code.matchAll(/setTimeout\(\w+, timing\.actionPace\)/g)].map(m => context(m.index));
  check("the timing profile's pause after an action is always the turn's pace time (no bare setTimeout left)",
    !rawPace.length && /async function pace\(ms\) \{[\s\S]{0,120}?inTurnPhase\("pace",/.test(code), rawPace.join("  |  ") || "pace() not found");
  check("▶ Start logs the RUN line and writes run.json, with both commits, once the log is cleared and before memory is loaded",
    /setLog\(\[\]\);[\s\S]{0,300}?await stampRun\(\w+\);[\s\S]{0,1500}?await loadMemory\(/.test(code)
      && /const (\w+) = readVersion\(\w+\);\s*const (\w+) = \{ \.\.\.\w+, page: PAGE_VERSION, backend: \1 \};[\s\S]{0,200}?addLog\(runHeader\(\2\)[\s\S]{0,200}?versionProblem\(PAGE_VERSION, \1,[\s\S]{0,200}?queueRecord\("run", runRecord\(\2\)\);/.test(code),
    "stampRun is not where it should be — has startAgent changed shape?");
  // Logged before the run had its own session, these went to the last run's
  // log file, and setLog([]) cleared them off the screen.
  once("the control scheme and a pause-to-think left off are said after the RUN line, in the run's own log",
    /await stampRun\(\w+\);\s*if \(pauseDropped\) addLog\("Pause-to-think is on but no game is attached[^"]*", "warn"\);\s*addLog\(`Control scheme: /g);
  once("...and nowhere else", /Control scheme: /g);
  once("a game's line is queued once, only for a game that got a result, after the session's outcome is set",
    /finalOutcome = (\w+)\.outcome;[\s\S]{0,200}?queueRecord\("game", gameRecord\(\{\s*run: runRef\.current,\s*game: \w+ \+ 1,\s*outcome: \1\.outcome,/g);
  once("game lines are written in that one place only", /queueRecord\("game"/g);
  // What fills a game's line besides its outcome. Each is set somewhere else in
  // the loop, where an edit could quietly leave every score "model", every game
  // not stopped and no snapshots, with the records' own checks still passing.
  const scoreSets = [...code.matchAll(/currentScoreRef\.current = ([^;]+);(?:\s*scoreSourceRef\.current = ([^;]+);)?/g)]
    .map(m => ({ value: m[1].trim(), source: m[2]?.trim() ?? null, at: context(m.index) }));
  const unsourced = scoreSets.filter(s => s.value !== "null" && !s.source);
  const measured = scoreSets.filter(s => /solverScoreRef|screenScoreRef|\.scoreOf\(/.test(s.value));
  const said = scoreSets.filter(s => /toolInput\.score/.test(s.value));
  const misattributed = [...measured.filter(s => s.source !== "\"measured\""), ...said.filter(s => s.source !== "\"model\"")];
  check("every score the loop keeps says where it came from: the solver's and the plugin's measured, the model's its own word",
    scoreSets.length >= 5 && !unsourced.length && measured.length >= 2 && said.length >= 1 && !misattributed.length,
    [...unsourced.map(s => `no source: ${s.at}`), ...misattributed.map(s => `${s.source}: ${s.at}`)].join("  |  ")
      || `found ${scoreSets.length} scores, ${measured.length} measured, ${said.length} reported — has the page changed shape?`);
  once("a game's end the solver measured has its score marked measured",
    /end\.finalScore = measured;\s*\}\s*if \(measured != null\) end\.scoreSource = "measured";/g);
  once("a game's line lists its snapshots and says whether only ■ Stop ended it",
    /queueRecord\("game", gameRecord\(\{[\s\S]{0,1200}?snapshots: gameSnapshotsRef\.current,[\s\S]{0,200}?stopped: gameOutcome == null && stopRef\.current,?\s*\}\)\);/g);
  once("each saved snapshot goes into its game's list", /if \(res\?\.ok && res\.files\?\.length\) \{\s*gameSnapshotsRef\.current\.push\(\.\.\.res\.files\);/g);
  once("the list starts empty for each game", /const turnsBeforeGame = turnCountRef\.current;\s*gameSnapshotsRef\.current = \[\];/g);
  once("the flush sends log lines and records through the bounded queue, putting back what did not get through",
    /await drainQueue\(logQueueRef\.current, \{ plan: logLineBatches, send, max: LOG_QUEUE_MAX \}\);\s*const \w+ = await drainQueue\(\s*recordQueueRef\.current,\s*\{ plan: recordBatches, send, max: RECORD_QUEUE_MAX, keep: keepRecord \}\s*\);/g);
  const cut = [...code.matchAll(/addLog\(`[^`]*\$\{(?:lead\.see|lead\.plan|text|toolInput\.analysis)\.slice\(/g)].map(m => context(m.index));
  const whole = ["lead.see", "lead.plan", "toolInput.analysis"]
    .filter(v => !new RegExp(`addLog\\(\`[^\`]*\\$\\{${v.replace(".", "\\.")}\\}\`, "\\w+", \\{ screen: \\d+ \\}\\)`).test(code));
  check("the model's see, plan and reasoning reach the log file whole, cut short on screen only",
    !cut.length && !whole.length, [...cut, ...whole.map(v => `${v} is not logged whole`)].join("  |  "));
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

// The relay's Ollama server is the backend's to choose, so nothing in the page
// may name one to it, and a session whose field names another does not start.
{
  const named = [...code.matchAll(/\bbase_url\b/g)].map(m => context(m.index));
  const saves = [...code.matchAll(/backend\("\/config\/ollama-base", \{ base_url: ollamaHost \}\)/g)].length;
  check("the page sends base_url only to save the OLLAMA SERVER field, never with a model request",
    named.length === 1 && saves === 1, named.join("  |  "));
  check("the field starts as the relay's server, from /capabilities, on mount and when the backend comes back",
    /if \(caps\.ollama\.base && !ollamaKnownRef\.current\) \{\s*ollamaKnownRef\.current = true;\s*setOllamaHost\(caps\.ollama\.base\);/.test(code) &&
      [...code.matchAll(/await loadCapabilities\(\);/g)].length === 2,
    "not found — has the backend check changed shape?");
  // Asked again at Start: a backend restarted between two watchdog pings may
  // relay somewhere else than the page last heard.
  check("a session does not start while OLLAMA SERVER and the relay's server differ, as the backend says at Start",
    /if \(!apiKey && providerKey !== "ollama"\) \{[^}]*\}\s*let ollamaRelay = capabilities\.ollama;\s*if \(providerKey === "ollama"\) \{\s*if \(ollamaViaBackend\) \{[^}]*startingRef\.current = true;[^}]*const caps = await fetchCapabilities\(\{ signal: ctrl\.signal \}\)\.catch\(\(\) => null\);[^}]*if \(caps\) ollamaRelay = caps\.ollama;\s*\}\s*const problem = ollamaStartProblem\(\{ field: ollamaHost, relay: ollamaViaBackend, server: ollamaRelay \}\);\s*if \(problem\) \{\s*startingRef\.current = false;\s*addLog\(problem, "error"\);\s*return;\s*\}\s*\}\s*startingRef\.current = true;\s*setCheckingModel\(true\);/.test(code) &&
      /Ollama: \$\{model\} on \$\{ollamaRelay\?\.base \?\? /.test(code),
    "not found before the model check — has startAgent changed shape?");
  // That ask waits, so the running flag alone no longer stops a second click.
  check("a second click on Start while it asks the backend does not start a second run",
    /const startAgent = useCallback\(async \(\) => \{\s*if \(running \|\| startingRef\.current\) return;/.test(code) &&
      /useEffect\(\(\) => \{\s*if \(running\) startingRef\.current = false;\s*\}, \[running\]\);/.test(code),
    "the startingRef guard or its reset is missing");
}

// The chosen model is checked at Start (src/llm/models.js, checked on its own in
// tools/check-llm.mjs), before anything of the run is reset, and a failed check
// starts nothing: the log keeps the provider's reason, and Start works again.
{
  console.log("model picker and the check at Start");
  check("▶ Start checks the chosen model, with the page's backend() and callAI, and starts nothing when the check fails",
    /startingRef\.current = true;\s*setCheckingModel\(true\);\s*let (\w+);\s*try \{\s*\1 = await checkModel\(providerKey, model, \{\s*apiKey,\s*relay: ollamaViaBackend,\s*base: [^,]+,\s*backend,\s*callAI\s*\}\);\s*\} finally \{\s*setCheckingModel\(false\);\s*\}\s*if \(!\1\.ok\) \{\s*startingRef\.current = false;\s*addLog\(\1\.text, \1\.type\);\s*return;\s*\}\s*stopRef\.current = false;/.test(code),
    "not found right before the run's reset — has startAgent changed shape?");
  check("a check that passed is logged once the run's log is cleared",
    /setLog\(\[\]\);[\s\S]{0,1200}?addLog\(modelCheck\.text, modelCheck\.type\);/.test(code), "not found after setLog([])");
  check("Start cannot be clicked again while the model is being checked",
    /onClick: startAgent,\s*disabled: !readyToPlay \|\| checkingModel,/.test(code), "the Start button is not disabled by checkingModel");
  check("the picker has a free-text model id field, alongside the listed models",
    /"aria-label": "Model id",[\s\S]{0,200}?value: model,[\s\S]{0,120}?onChange: \(e\) => setModel\(e\.target\.value\.trim\(\)\)/.test(code) &&
      /modelChoices\(providerKey, /.test(code),
    "no text input bound to model — has the picker changed shape?");
  check("the picker lists models with the page's backend() (the Ollama relay needs its token)",
    /await listModels\(provider, \{[^}]*\bsignal,\s*backend\s*\}\)/.test(code), "listModels is not given backend");
  check("the key field shows the provider's note that the key lives in the page",
    /PROVIDERS\[providerKey\]\.keyNote &&/.test(code), "keyNote is not rendered");
  // The session is started with the values from the click, but frame size, image
  // count, history window and the relay setting follow the controls.
  const locked = [
    ["provider buttons", /onClick: \(\) => handleProviderChange\(key\),\s*disabled: settingsLocked,/],
    ["model list", /if \(e\.target\.value\) setModel\(e\.target\.value\);\s*\},\s*disabled: settingsLocked,/],
    ["model id field", /onChange: \(e\) => setModel\(e\.target\.value\.trim\(\)\),\s*disabled: settingsLocked,/],
    ["key field", /onChange: \(e\) => handleApiKeyChange\(e\.target\.value\),\s*disabled: settingsLocked,/],
    ["OLLAMA SERVER field", /onChange: \(e\) => setOllamaHost\(e\.target\.value\),\s*disabled: settingsLocked,/],
    ["relay checkbox", /onChange: \(e\) => setOllamaViaBackendState\(e\.target\.checked\),\s*disabled: settingsLocked/],
  ].filter(([, re]) => !re.test(code)).map(([name]) => name);
  check("provider, model, key, Ollama server and relay are locked while the model is checked and while a session runs",
    /const settingsLocked = checkingModel \|\| running;/.test(code) && !locked.length, locked.join(", ") || "settingsLocked is not checkingModel || running");
  check("a model list goes when the key or server it was asked with changes or is cleared",
    /useEffect\(\(\) => \{\s*setModelList\(null\);\s*if \(!canListModels\) return void 0;/.test(code) ||
      /useEffect\(\(\) => \{\s*setModelList\(null\);\s*if \(!canListModels\) return undefined;/.test(code),
    "the listing effect does not clear the old list first");
  check("a play turn and a study turn say so when the reply was cut off at the output cap before the model acted",
    [...code.matchAll(/const cutOff = cutOffNote\(providerKey, resp\);\s*if \(cutOff\) addLog\(cutOff, "warn"\);/g)].length === 2,
    "cutOffNote is not logged after both the play and the study request");
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
