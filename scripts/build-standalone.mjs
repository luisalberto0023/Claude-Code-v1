// Builds nexus-grid.html: a single self-contained file with CSS + JS inlined.
// Run AFTER `npm run build` (expects dist/ to exist).
//
// IMPORTANT: replacement values are passed as FUNCTIONS, not strings.
// String.replace interprets `$&`, `$1`, etc. in a string replacement — and the
// React bundle contains the literal "$&/" — so a string replacement silently
// injects the matched <script> tag into the middle of the JS and corrupts it.
// A function replacement is taken verbatim.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const assetsDir = path.join(distDir, 'assets');

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const files = fs.readdirSync(assetsDir);
const cssFile = files.find(f => f.endsWith('.css'));
const jsFile = files.find(f => f.endsWith('.js'));

const css = fs.readFileSync(path.join(assetsDir, cssFile), 'utf8');
let js = fs.readFileSync(path.join(assetsDir, jsFile), 'utf8');

// Neutralize any literal </script> in the JS so it can't terminate the block early.
js = js.replace(/<\/script>/gi, '<\\/script>');

let out = html.replace(
  /<link rel="stylesheet" crossorigin href="[^"]+"[^>]*>/,
  () => `<style>${css}</style>`,
);
out = out.replace(
  /<script type="module" crossorigin src="[^"]+"><\/script>/,
  () => `<script type="module">${js}</script>`,
);

const outPath = path.join(root, 'nexus-grid.html');
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${Math.round(out.length / 1024)}KB)`);
