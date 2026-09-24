// Give the agent page the backend's token, and nobody else.
//
// The backend (agent_server.py) refuses every request without the token it
// made at launch, because any web page open in the browser can send requests to
// localhost, and those requests move the real mouse. The backend writes the
// token to .agent-token in the project root; this dev-server plugin reads that
// file each time the page itself is served and puts the token in the page as
// window.__AGENT_TOKEN__, where backend() in src/GameAgent.jsx sends it as
// X-Agent-Token.
//
// Why this way:
//   - Read on every page load, not once when Vite starts, so the start order does
//     not matter, and a backend restarted with a new token needs only a reload.
//   - In the HTML, which no other site can read: vite.config.js turns Vite's CORS
//     off (its default lets any localhost origin read responses) and Vite checks
//     the Host header against DNS rebinding. A token in its own script file would
//     be readable by any site through <script src>, so there is none, and
//     vite.config.js tells Vite not to serve .agent-token itself either.
//   - Dev server only (apply: "serve"). Never a VITE_ environment value and never
//     in `npm run build` output: dist/ would carry a token to wherever it is
//     copied, long after that launch.
//   - Vite refuses to start when it is too old to check the Host header (see
//     MIN_VITE_VERSION). package-lock.json is not in git and start.bat installs
//     Node packages only once, so the test PC runs whatever Vite it got then.

import fs from "fs";
import path from "path";
import { version as installedVite } from "vite";

export const TOKEN_FILE_NAME = ".agent-token";
// The same rule as TOKEN_PATTERN in agent_server.py (tools/check-agent.mjs
// compares them): characters safe inside a header and inside a script, and long
// enough not to guess.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
// Vite checks the Host header from 5.4.12 on. An older one answers a site that
// points its own name at 127.0.0.1 (DNS rebinding) as if it were this page, so
// that site could read the token out of the HTML. package.json asks for at least
// this version too, so `npm install` brings a Vite that has the check.
export const MIN_VITE_VERSION = "5.4.12";

/** Whether Vite `version` ("5.4.21", "6.0.0-beta.1") is at least MIN_VITE_VERSION. */
export function viteChecksHost(version) {
  const parts = v => String(v).split(/[-+]/)[0].split(".").map(Number);
  const have = parts(version);
  const need = parts(MIN_VITE_VERSION);
  if (have.length !== 3 || have.some(n => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** The token in `file`, or null when there is none or it is not a token. */
export function readAgentToken(file) {
  let text;
  try {
    text = fs.readFileSync(file, "ascii");
  } catch {
    return null;  // the backend has not started yet on this checkout
  }
  const token = text.trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

/** The script that hands the page its token. null tells the page it has none. */
export function tokenScript(token) {
  const safe = typeof token === "string" && TOKEN_PATTERN.test(token) ? token : null;
  return `window.__AGENT_TOKEN__ = ${JSON.stringify(safe)};`;
}

/**
 * Whether `pagePath` (the path Vite serves an HTML page as) is the agent page:
 * "/", "/index.html", or "/index.html" standing in for an address with no file
 * of its own. The local test games under bench/ are HTML pages the dev server
 * serves too, and a game has no business holding the token, so it gets none.
 */
export function isAgentPage(pagePath) {
  const p = String(pagePath ?? "").split(/[?#]/)[0];
  return p === "/" || p === "/index.html";
}

/** `viteVersion` is for tools/check-agent.mjs, to try a Vite that is too old. */
export default function agentToken({ viteVersion = installedVite } = {}) {
  let file = path.resolve(TOKEN_FILE_NAME);
  return {
    name: "agent-token",
    apply: "serve",
    configResolved(config) {
      if (!viteChecksHost(viteVersion)) {
        // Stop here rather than serve the token to a page other sites can read.
        throw new Error(`Vite ${viteVersion} is older than ${MIN_VITE_VERSION} and does not check the Host header, ` +
          "so other web sites could read the backend's token from the agent page. " +
          "Run `npm install` in the project folder, then run start.bat again.");
      }
      file = path.join(config.root, TOKEN_FILE_NAME);
    },
    transformIndexHtml(html, ctx) {
      if (!isAgentPage(ctx?.path)) return [];
      return [{ tag: "script", children: tokenScript(readAgentToken(file)), injectTo: "head-prepend" }];
    },
  };
}
