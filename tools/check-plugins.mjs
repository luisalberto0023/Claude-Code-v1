#!/usr/bin/env node
// Every method the agent reaches for through a plugin must exist on EVERY
// registered plugin object, or be optional at the call site.
//
// Written because the same mistake has now happened three times: a function is
// exported from a plugin's module, tested directly, and left off the object the
// agent actually calls through — so it works in every test and is undefined in
// the app. The earlier version of this check only looked at one plugin, which is
// how the third one got through.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "..", "src", "GameAgent.jsx");
const src = fs.readFileSync(AGENT, "utf8");

// Which plugins are registered?
const registered = [...src.matchAll(/^import\s+(\w+)\s+from\s+"(\.\/plugins\/[^"]+)"/gm)]
  .map(m => ({ name: m[1], file: m[2] }))
  .filter(p => new RegExp(`GAME_PLUGINS\\s*=\\s*\\[[^\\]]*\\b${p.name}\\b`).test(src));

if (!registered.length) {
  console.error("No plugins appear in GAME_PLUGINS — is the registry still there?");
  process.exit(1);
}

// A member only has to exist if the agent CALLS it without checking first.
//
// Reading one as a flag — `if (plugin.tracksTiles)` — is fine when it is
// absent, and so is calling through `?.`. What breaks the app is calling a
// member outright that was never attached, which is the mistake this exists to
// catch.
const RECEIVER = "(?:plug|plugin|activePlugin|learnPlugin)";
const called = new Set(), guarded = new Set();
// `plugin.x?.(…)` is an optional CALL, not an optional member access, and it is
// the commonest guarded form in the agent. Match it before the plain-call
// pattern, which would otherwise miss it and leave those members unchecked
// altogether — neither required nor optional, which is the same blind spot this
// file exists to close.
for (const m of src.matchAll(new RegExp(`\\b${RECEIVER}\\.\\s*(\\w+)\\?\\.\\s*\\(`, "g"))) guarded.add(m[1]);
for (const m of src.matchAll(new RegExp(`\\b${RECEIVER}\\.\\s*(\\w+)\\s*\\(`, "g"))) called.add(m[1]);
for (const m of src.matchAll(new RegExp(`\\b${RECEIVER}\\?\\.\\s*(\\w+)`, "g"))) guarded.add(m[1]);
// Anything tested before use is guarded too: `plugin.x &&`, `if (plugin.x)`,
// `!plugin.x`, `plugin.x ??`.
for (const m of src.matchAll(new RegExp(`\\b${RECEIVER}\\.\\s*(\\w+)\\s*(?:&&|\\)|\\?\\?)`, "g"))) guarded.add(m[1]);
const required = new Set([...called].filter(n => !guarded.has(n)));
const optional = guarded;
for (const skip of ["current", "id", "label"]) required.delete(skip);

let failed = false;
for (const p of registered) {
  const mod = await import(path.join(HERE, "..", "src", p.file.replace("./", "")));
  const obj = mod.default ?? mod.plugin;
  const missing = [...required].filter(n => typeof obj?.[n] === "undefined");
  // Also flag anything exported from the module but absent from the object,
  // which is the exact shape of the recurring mistake.
  const stranded = Object.keys(mod).filter(
    n => typeof mod[n] === "function" && n !== "default" && typeof obj?.[n] === "undefined");
  console.log(`${p.name}: ${missing.length ? "MISSING " + missing.join(", ") : "all required members present"}` +
    (stranded.length ? `  |  exported but not on the plugin: ${stranded.join(", ")}` : ""));
  if (missing.length) failed = true;
}
console.log(`\nrequired by the agent: ${[...required].sort().join(", ")}`);
console.log(`optional (guarded with ?.): ${[...optional].sort().join(", ")}`);
process.exit(failed ? 1 : 0);
