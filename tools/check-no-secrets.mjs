#!/usr/bin/env node
// Fail a build whose output holds anything shaped like an API key.
//
//   node tools/check-no-secrets.mjs              scans dist/
//   node tools/check-no-secrets.mjs <directory>  scans that directory
//
// `npm run build` runs it after `vite build`, so a build that baked a key into
// dist/assets/*.js cannot be published or committed without this saying so.
//
// Why it is needed. Cloud keys are typed into the page and kept in memory
// (src/GameAgent.jsx getEnv). They are never read from .env: Vite replaces only
// `import.meta.env.VITE_NAME` written out in full, and the page looks the name
// up dynamically instead, which Vite leaves alone. That is easy to "fix" — one
// obvious-looking edit to a static `import.meta.env.VITE_ANTHROPIC_API_KEY`
// makes Vite paste the developer's own key into dist/assets/*.js, and dist/ is
// the one thing here that gets handed to other people. Nothing in the code says
// so at the point of the edit, so the build says it instead.
//
// What it looks for: the prefixes the providers use (Google's AIza… and the new
// AQ.… auth keys, Anthropic's sk-ant-…, OpenAI's sk-…) and long random-looking
// values next to a key-ish name (apiKey: "…", x-api-key: "…", Bearer …). The
// last rule is the one that catches a provider this page has never heard of.
//
// It never prints a value it finds: a real key must not end up in a terminal
// scrollback, a CI log or a bug report. Findings say the file, the line and the
// first few characters only.
//
// tools/check-secrets.mjs, which `npm run check` runs, tests these rules against
// a scratch directory with a planted fake key, so the scanner failing to bite is
// itself caught before a push.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Only files a key could be readable in. Images and fonts are skipped: a key
// cannot get into one through a build, and scanning them as text is noise.
export const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".css", ".html", ".htm",
  ".json", ".map", ".txt", ".svg", ".md", ".webmanifest", "",
]);

// A value random-looking enough to be a key rather than a minified identifier,
// a hash in a file name or a base64 image: long, mixed, and not all one class.
const RANDOM = /^(?=[\s\S]*[a-z])(?=[\s\S]*[0-9])[A-Za-z0-9_\-]{24,}$/;
const looksRandom = (value) =>
  RANDOM.test(value) &&
  // Hex and decimal strings (asset hashes, ids, long numbers) are not keys.
  !/^[0-9a-f]+$/i.test(value) &&
  // A key mixes cases or carries a separator; lowercase-and-digits alone is
  // usually a minified string or a slug.
  (/[A-Z]/.test(value) || /[_-]/.test(value));

export const SECRET_RULES = [
  {
    name: "Google API key (AIza…)",
    // Google's own keys are 39 characters; anything past the prefix and the
    // length is a key by shape.
    find: /AIza[0-9A-Za-z_\-]{30,}/g,
  },
  {
    name: "Google auth key (AQ.…)",
    // The keys Google now issues; they are rejected as a ?key= query value and
    // go in the x-goog-api-key header (src/llm/requests.js).
    find: /\bAQ\.[0-9A-Za-z_\-]{20,}/g,
  },
  {
    name: "Anthropic API key (sk-ant-…)",
    find: /\bsk-ant-[0-9A-Za-z_\-]{20,}/g,
  },
  {
    name: "OpenAI API key (sk-…)",
    // sk-proj-… and the older sk-… both match. sk-ant- is caught above and is
    // skipped here so one key is not reported twice.
    find: /\bsk-(?!ant-)[0-9A-Za-z_\-]{20,}/g,
  },
  {
    name: "a long random value next to a key name",
    // `apiKey: "…"`, `"x-api-key":"…"`, `token=…`. The value has to look random
    // (looksRandom), or every minified `apiKey:someIdentifier` would be
    // reported.
    find: /(?:api[_-]?key|apikey|x-api-key|x-goog-api-key|secret|password|authorization|access[_-]?token|\btoken)["'`]?\s*[:=]\s*["'`]?\s*([A-Za-z0-9_\-]{24,})/gi,
    value: m => m[1],
  },
  {
    name: "a long random value after Bearer",
    find: /\bBearer\s+([A-Za-z0-9_\-]{24,})/g,
    value: m => m[1],
  },
];

/** Where in `text` offset `index` is, as a 1-based line number. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** The first few characters of `value`, with the rest hidden. */
export function masked(value) {
  const head = value.slice(0, 6);
  return `${head}… (${value.length} chars)`;
}

/**
 * Everything key-shaped in `text`, as {rule, line, index, sample} with the
 * value masked. Never returns the value itself.
 */
export function findSecrets(text) {
  const found = [];
  for (const rule of SECRET_RULES) {
    rule.find.lastIndex = 0;
    for (const m of text.matchAll(rule.find)) {
      const value = rule.value ? rule.value(m) : m[0];
      if (!value) continue;
      if (rule.value && !looksRandom(value)) continue;
      found.push({ rule: rule.name, index: m.index, line: lineAt(text, m.index), sample: masked(value) });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Every file under `dir` worth scanning, deepest paths included. */
export function textFilesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Scan `dir`. Returns {files, findings}, where each finding also carries the
 * file it was found in, relative to `dir`.
 */
export function scanTree(dir) {
  const files = textFilesUnder(dir);
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      findings.push({ file: path.relative(dir, file), rule: "unreadable", line: 0, index: 0, sample: e.message });
      continue;
    }
    for (const f of findSecrets(text)) findings.push({ ...f, file: path.relative(dir, file) });
  }
  return { files, findings };
}

// ── Run from the command line ─────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const target = path.resolve(process.argv[2] ?? path.join(ROOT, "dist"));
  // Named as the project sees it ("dist") when it is in the project, and by its
  // full path when a check points this at a scratch directory elsewhere.
  const inside = path.relative(ROOT, target);
  const shown = inside && !inside.startsWith("..") ? inside : target;

  if (!fs.existsSync(target)) {
    console.error(`  FAIL  no secrets check: ${shown} does not exist. Run it after a build, or give it a directory.`);
    process.exit(1);
  }

  const { files, findings } = scanTree(target);
  if (findings.length) {
    console.error(`  FAIL  ${shown} holds ${findings.length} value${findings.length > 1 ? "s" : ""} shaped like an API key:`);
    for (const f of findings) console.error(`        ${f.file}:${f.line}  ${f.rule}  ${f.sample}`);
    console.error("        A key in the build output is shipped to whoever gets the page. Do not commit or publish it:");
    console.error("        take the key out of the source (the page reads keys from its own field, never from .env),");
    console.error("        delete dist/, and rotate the key if it was a real one.");
    process.exit(1);
  }
  console.log(`  ok    no API keys in ${shown} (${files.length} file${files.length === 1 ? "" : "s"} scanned)`);
}
