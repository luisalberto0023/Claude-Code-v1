#!/usr/bin/env node
// Check that the build cannot ship an API key.
//
//   node tools/check-secrets.mjs
//
// Two things have to hold for a cloud key to stay in the one tab it was typed
// into:
//
//   - No source file may write `import.meta.env`, and index.html may not ask for
//     `%VITE_NAME%`. Those are the two places Vite pastes an environment value
//     in: a build replaces `import.meta.env.VITE_NAME` and the HTML placeholder
//     with the value, and the dev server prepends the whole env object to any
//     module whose source says `import.meta.env` at all. The page looks the name
//     up through an optional chain instead (`import.meta?.env?.[key]`,
//     src/GameAgent.jsx getEnv), which Vite leaves alone. Checked here against
//     src/ and index.html, because a dev-only leak never reaches dist/ for the
//     scanner below to find.
//   - tools/check-no-secrets.mjs, which `npm run build` runs after vite build,
//     must actually bite. A scanner that quietly matches nothing is worse than
//     none, because the build then says "ok" for ever. So it is run here
//     against scratch directories with planted fake keys, and it must fail on
//     each of them, pass on a clean one, and never print the value it found.
//
// Nothing real is used: the planted keys are built by joining pieces, so no
// string in this file looks like a key to anything scanning the repo.

import { spawnSync } from "child_process";
import { transform } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCANNER = path.join(HERE, "check-no-secrets.mjs");

const { findSecrets, scanTree, masked, TEXT_EXTENSIONS } =
  await import(pathToFileURL(SCANNER).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("secrets");

// Fake keys, in the shapes the providers issue. Joined from pieces so this file
// holds no key-shaped literal of its own.
const FAKE = {
  google: ["AIza", "SyB9_ExampleNotARealKey_00000000000000"].join(""),
  googleAuth: ["AQ.", "Ab8RN6J_ExampleNotARealKey_00000000000000"].join(""),
  anthropic: ["sk-ant-", "api03-ExampleNotARealKey_0000000000000000000000"].join(""),
  openai: ["sk-", "proj-ExampleNotARealKey00000000000000000000"].join(""),
  named: ["apiKey: \"", "Zx9QwErTyUiOpAsDfGhJkL1234567890", "\""].join(""),
  bearer: ["Authorization: Bearer ", "Zx9QwErTyUiOpAsDfGhJkL1234567890"].join(""),
};

// ── The rules on their own ────────────────────────────────────────────────────
for (const [name, planted] of Object.entries(FAKE)) {
  const text = `const a=1;\n// nothing here\nconst b="${planted}";\nexport default a;\n`;
  const found = findSecrets(text);
  check(`a ${name} key in a file is found`, found.length > 0,
    `findSecrets returned nothing for ${name}`);
  check(`a ${name} key is reported with its line, and masked`,
    found.length > 0 && found[0].line === 3 && !found.some(f => f.sample.includes(planted.slice(-8))),
    found.length ? JSON.stringify(found[0]) : "nothing found");
}

// Things a build really does contain, which must not be reported. Minified
// output is full of long identifiers, asset hashes and base64.
const INNOCENT = {
  "minified property access": `const t={model:e,system:n,apiKey:r,maxTokens:i};export{t};`,
  "a header built from a variable": `headers:{"x-api-key":e,"anthropic-version":"2023-06-01"}`,
  "an asset hash in a file name": `import"./index-DhQ69xxV.js";const u="/assets/index-a1b2c3d4e5f60718293a4b5c6d7e8f90.css";`,
  "a long decimal": `const n=100000000000000000000000000000;`,
  "a hex digest": `const sha="3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b";`,
  "a data URI": `const img="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";`,
  "the page's own words about keys": `"This key lives in this page: the browser sends it to Anthropic directly"`,
  "a token header name": `const TOKEN_HEADER="X-Agent-Token";const h={[TOKEN_HEADER]:t};`,
};
for (const [name, text] of Object.entries(INNOCENT)) {
  const found = findSecrets(text);
  check(`${name} is not reported`, found.length === 0,
    found.length ? found.map(f => `${f.rule} ${f.sample}`).join("; ") : "");
}

check("a masked sample shows no more than the first few characters",
  !masked(FAKE.google).includes(FAKE.google.slice(6)) && masked(FAKE.google).includes("chars"),
  masked(FAKE.google));
check("the scanner reads the files a build writes",
  [".js", ".html", ".css", ".map", ".json"].every(e => TEXT_EXTENSIONS.has(e)),
  JSON.stringify([...TEXT_EXTENSIONS]));

// ── A whole directory, the way `npm run build` scans dist/ ────────────────────
const scratch = path.join(os.tmpdir(), `game-agent-secrets-${process.pid}-${randomUUID()}`);
const write = (rel, text) => {
  const at = path.join(scratch, rel);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
};
const runScanner = (dir) => {
  const r = spawnSync(process.execPath, [SCANNER, dir], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

try {
  // A clean build: nothing to find, and the scanner says so.
  write("clean/index.html", `<!doctype html><script type="module" src="/assets/index-DhQ69xxV.js"></script>`);
  write("clean/assets/index-DhQ69xxV.js", Object.values(INNOCENT).join("\n"));
  write("clean/assets/index-htIsYh1p.css", `:root{--bg:#0a0a0a}`);
  const clean = scanTree(path.join(scratch, "clean"));
  check("a clean build passes", clean.findings.length === 0 && clean.files.length === 3,
    JSON.stringify({ files: clean.files.length, findings: clean.findings }));
  const cleanRun = runScanner(path.join(scratch, "clean"));
  check("the command exits 0 on a clean build", cleanRun.status === 0 && /ok\s+no API keys/.test(cleanRun.out),
    JSON.stringify(cleanRun));

  // The same build with a key pasted in, as a static import.meta.env read would
  // paste it: deep in one minified line of one asset.
  write("planted/index.html", `<!doctype html><script type="module" src="/assets/index-DhQ69xxV.js"></script>`);
  write("planted/assets/index-DhQ69xxV.js",
    `${Object.values(INNOCENT).join("\n")}\nconst k="${FAKE.google}";export{k};\n`);
  const planted = scanTree(path.join(scratch, "planted"));
  check("a build with a key in an asset is caught",
    planted.findings.length === 1 && planted.findings[0].file.endsWith("index-DhQ69xxV.js"),
    JSON.stringify(planted.findings));

  const plantedRun = runScanner(path.join(scratch, "planted"));
  check("the command exits 1 on a build with a key", plantedRun.status === 1 && /FAIL/.test(plantedRun.out),
    JSON.stringify(plantedRun));
  check("the command never prints the key it found",
    !plantedRun.out.includes(FAKE.google) && !plantedRun.out.includes(FAKE.google.slice(8)),
    plantedRun.out);
  check("the command says what to do about it",
    /rotate the key/.test(plantedRun.out) && /assets[\\/]index-DhQ69xxV\.js/.test(plantedRun.out),
    plantedRun.out);

  // A key in a nested folder, and in index.html rather than an asset, is found
  // too: the scan walks the whole tree, not just dist/assets.
  write("nested/index.html", `<!doctype html><script>window.__k="${FAKE.anthropic}"</script>`);
  write("nested/deep/one/two/chunk.js", `export const q="${FAKE.openai}";`);
  const nested = scanTree(path.join(scratch, "nested"));
  check("a key anywhere in the tree is found", nested.findings.length === 2,
    JSON.stringify(nested.findings));

  // A missing directory is a failure, not a pass: `npm run build` must not go
  // green because the scan had nothing to look at.
  const missing = runScanner(path.join(scratch, "not-built"));
  check("a missing directory fails rather than passing", missing.status === 1 && /does not exist/.test(missing.out),
    JSON.stringify(missing));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ── The build runs it, and the page still reads no key from the environment ───
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
check("npm run build scans its output for keys",
  /vite build/.test(pkg.scripts?.build ?? "") && /check-no-secrets\.mjs/.test(pkg.scripts?.build ?? ""),
  JSON.stringify(pkg.scripts?.build));
check("npm run check tests the scanner", /check-secrets\.mjs/.test(pkg.scripts?.check ?? ""),
  JSON.stringify(pkg.scripts?.check));

const sourceFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(entry.name)) sourceFiles.push(full);
  }
})(path.join(ROOT, "src"));

// Read as esbuild prints it, with the comments gone: this very rule is
// described in a comment in src/GameAgent.jsx, and a check that a comment can
// fail is a check nobody can explain themselves in.
const compiled = new Map();
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, "utf8");
  const { code } = await transform(text, { loader: file.endsWith("x") ? "jsx" : "js", format: "esm" });
  compiled.set(file, code);
}

// Written as `import.meta.env`, with nothing between the two, the whole .env is
// in the module: in a build Vite replaces `import.meta.env.VITE_NAME` with the
// value, and in `npm run dev` — which is how the agent actually runs — Vite's
// import analysis sees the four characters `.env` after `import.meta` and
// prepends `import.meta.env = { …every VITE_ value… };` to the module, whatever
// follows. So `import.meta.env?.[key]` and `import.meta.env[key]` leak just as
// `import.meta.env.VITE_ANTHROPIC_API_KEY` does, and the dist scan cannot see
// the dev-only ones. The page's lookup keeps the `?.` before `env`
// (`import.meta?.env?.[key]`, src/GameAgent.jsx getEnv), which Vite leaves
// alone — that one character is what stops the injection, so match what Vite
// matches rather than the shapes that spell a name out.
const staticEnv = [...compiled]
  .filter(([, code]) => /import\.meta\s*\.\s*env/.test(code))
  .map(([file]) => path.relative(ROOT, file));
check("no source file writes import.meta.env — Vite injects the whole .env wherever it appears",
  !staticEnv.length,
  `${staticEnv.join(", ")} writes import.meta.env; keep the ?. before env (import.meta?.env?.[key])`);

// The other place Vite pastes a key: `%VITE_NAME%` in index.html, which it
// replaces in the built HTML. No transform needed — it is not JavaScript.
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const placeholders = html.match(/%VITE_[A-Z0-9_]+%/g) ?? [];
  check("index.html asks for no environment value", !placeholders.length,
    `${placeholders.join(", ")} — Vite replaces these in the built HTML`);
}

const keyFiles = sourceFiles.filter(f => /VITE_[A-Z_]*API_KEY/.test(compiled.get(f)));
check("the names of the key slots live in src/llm/providers.js alone",
  keyFiles.every(f => path.relative(ROOT, f).replace(/\\/g, "/") === "src/llm/providers.js"),
  keyFiles.map(f => path.relative(ROOT, f)).join(", "));

process.exit(failures ? 1 : 0);
