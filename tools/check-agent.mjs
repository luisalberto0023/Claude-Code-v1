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
// Values that live inside GameAgent.jsx (TOOLS, GAMEPAD_TOOLS, GAME_PLUGINS,
// pluginName, buildActionReference) are
// read by bundling it with a line that exports them added at the end, the same
// way check-render.mjs bundles it, so the check sees what the page really
// builds. Agent logic that can live in its own module under src/agent/ is
// imported directly instead, which needs no bundling.

import { build, transform } from "esbuild";
import fs from "fs";
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
const { backendFailure, readReply } =
  await import(pathToFileURL(path.join(ROOT, "src", "agent", "backend.js")).href);

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
      contents: `${source}\nexport { TOOLS as __TOOLS, GAMEPAD_TOOLS as __GAMEPAD_TOOLS, GAME_PLUGINS as __GAME_PLUGINS, pluginName as __pluginName, buildActionReference as __buildActionReference };\n`,
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
  check("GameAgent.jsx bundles and exposes TOOLS, GAMEPAD_TOOLS, GAME_PLUGINS, pluginName and buildActionReference", false, detail);
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

process.exit(failures ? 1 : 0);
