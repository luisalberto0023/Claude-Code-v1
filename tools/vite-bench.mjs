// Serve the local test games under bench/ at their own addresses.
//
// The dev server already serves bench/minesweeper/index.html at
// http://localhost:5173/bench/minesweeper/ — with the slash. Without it, Vite
// finds no file and falls back to the agent page, so an address typed the
// obvious way showed the agent instead of the game, and the page's relative
// script path would not have worked either. This sends the address without the
// slash to the one with it, query and all.
//
// Dev server only, like the games themselves: `npm run build` builds the agent
// page and nothing under bench/.

import fs from "fs";
import path from "path";

export const BENCH_DIR = "bench";

/**
 * Where to send `url` (a request's path and query), or null to leave it be:
 * /bench/<name> and /bench/<name>?… go to /bench/<name>/… when
 * bench/<name>/index.html exists under `root`.
 */
export function benchRedirect(url, root) {
  const m = /^\/bench\/([a-z0-9][a-z0-9-]*)(\?.*)?$/i.exec(String(url ?? ""));
  if (!m) return null;
  if (!fs.existsSync(path.join(root, BENCH_DIR, m[1], "index.html"))) return null;
  return `/${BENCH_DIR}/${m[1]}/${m[2] ?? ""}`;
}

export default function benchPages() {
  let root = process.cwd();
  return {
    name: "bench-pages",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      // Added here, not in a returned hook, so it runs before Vite's own
      // fallback to the agent page.
      server.middlewares.use((req, res, next) => {
        const to = benchRedirect(req.url, root);
        if (!to) return next();
        res.statusCode = 302;
        res.setHeader("Location", to);
        res.end();
      });
    },
  };
}
