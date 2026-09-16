#!/usr/bin/env node
// Render the whole UI once, in node, and fail if the first render throws.
//
//   node tools/check-render.mjs
//   node tools/check-render.mjs --entry <path to a copy of GameAgent.jsx>
//
// Written because a blank page has already shipped once (commit 8b6277d): a
// useCallback listed a callback in its dependency array that was declared
// further down the component. Dependency arrays are evaluated during render, so
// the first render hit the temporal dead zone ("Cannot access 'executeTool'
// before initialization") and React left the page empty. `npm run build` passed,
// because the ordering is a runtime fault, not a syntax error, and the test PC
// was the first place anyone saw it.
//
// What this does: bundle src/GameAgent.jsx with esbuild into a throwaway file
// under the OS temp directory, import it, and render the default export with
// react-dom/server. That runs every hook initialiser, every dependency array and
// the whole JSX tree exactly as the browser's first render does.
//
// What it cannot see:
//   - Effects, timers and event handlers. The server renderer never runs them,
//     so a fault that only shows up after mount is out of its reach.
//   - Use-before-definition at MODULE level (outside the component). Bundling
//     makes esbuild rewrite top-level const/let as var, so reading a top-level
//     constant above its definition yields undefined here instead of throwing as
//     it would in the browser. Keep top-level constants in order, or move them
//     into their own module under src/ where node imports them unbundled.
//
// --entry exists to prove the check still bites: point it at a scratch copy of
// the component (with its src/ siblings) that has the 8b6277d mistake put back,
// and it must fail.

import { build } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const entryAt = args.indexOf("--entry");
if (entryAt >= 0 && !args[entryAt + 1]) {
  console.error("--entry needs a path");
  process.exit(2);
}
const ENTRY = path.resolve(entryAt >= 0 ? args[entryAt + 1] : path.join(ROOT, "src", "GameAgent.jsx"));

// Strings the first render must produce. One from the top of the tree and one
// from near the bottom, so a render that returns but has lost most of the page
// still fails.
const EXPECTED = ["Game Agent", "RECENT ACTIONS"];

// ── Browser globals ────────────────────────────────────────────────────────────
// None are stubbed, because the first render reads none today. Everything
// browser-only the component uses (screen capture, canvas, the backend fetches,
// downloads) sits in effects and event handlers, which a server render never
// calls, and stubbing them anyway would only hide the day one of them moves into
// the render path. If this check starts failing with "window is not defined" (or
// similar), first ask whether render SHOULD be reading it; only if so, define the
// smallest stand-in here, before the bundle is imported.

// ── Bundle ─────────────────────────────────────────────────────────────────────
// React stays outside the bundle so the component and react-dom/server share one
// copy (two copies of React is its own "invalid hook call" failure). The bundle
// lives in the temp directory, where a bare "react" would not resolve, so each
// React import is rewritten to the file URL of the repo's own node_modules copy.
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

const bundlePath = path.join(os.tmpdir(), `game-agent-render-${process.pid}-${randomUUID()}.mjs`);
let failed = false;
const fail = (what, detail) => {
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  failed = true;
};

const shown = path.relative(ROOT, ENTRY);
console.log(`render ${shown.startsWith("..") ? ENTRY : shown}`);
try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    outfile: bundlePath,
    // Inline so a failure's stack names src/GameAgent.jsx and a line in it,
    // rather than a line in a temp file that is deleted before anyone looks.
    sourcemap: "inline",
    logLevel: "silent",
    plugins: [reactFromRepo],
  });
  process.setSourceMapsEnabled(true);

  const { renderToString } = requireFromRoot("react-dom/server");
  const { createElement } = requireFromRoot("react");
  const mod = await import(pathToFileURL(bundlePath).href);
  if (typeof mod.default !== "function") {
    fail("default export is a component", `got ${typeof mod.default}`);
  } else {
    let html = null;
    try {
      html = renderToString(createElement(mod.default));
    } catch (e) {
      fail("first render", e?.stack?.split("\n").slice(0, 4).join("\n        ") ?? String(e));
    }
    if (html !== null) {
      if (html.length) console.log(`  ok    first render (${html.length} characters of HTML)`);
      else fail("first render", "rendered nothing");
      for (const s of EXPECTED) {
        if (html.includes(s)) console.log(`  ok    page contains "${s}"`);
        else fail(`page contains "${s}"`);
      }
    }
  }
} catch (e) {
  // A bundling error (a missing import, a syntax error) is a failure too, and
  // esbuild reports those as a list rather than a message.
  const detail = e?.errors?.length
    ? e.errors.map(x => `${x.location?.file ?? ""}:${x.location?.line ?? ""} ${x.text}`).join("; ")
    : (e?.stack ?? String(e));
  fail("bundle and import", detail);
} finally {
  fs.rmSync(bundlePath, { force: true });
}

process.exit(failed ? 1 : 0);
