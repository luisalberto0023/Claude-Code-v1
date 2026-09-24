import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import agentToken, { TOKEN_FILE_NAME } from "./tools/vite-agent-token.mjs";
import { gitVersion, agentVersion } from "./tools/git-version.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  // Puts the backend's launch token in the page (see the plugin for why there),
  // and the commit the page runs, read again for every page load in npm run dev.
  plugins: [react(), agentToken(), agentVersion({ root: ROOT })],
  // The commit a build runs, fixed into it when it is built, so every run says
  // which code it was (src/agent/episodes.js). Not in npm run dev: there a pull
  // changes the files Vite serves, and a commit read when Vite started would go
  // on naming the old one (tools/git-version.mjs says why that matters).
  define: command === "build" ? { __AGENT_VERSION__: JSON.stringify(gitVersion(ROOT)) } : {},
  server: {
    fs: {
      // The dev server hands out any file in the project folder by its path,
      // .agent-token too (and the backend's temporary copy while it writes one).
      // The page gets the token in its HTML; the file needs no URL of its own,
      // where a later CORS or proxy change would expose it. Setting deny replaces
      // Vite's own list, so that list comes first (with .git, which newer Vite
      // denies as well).
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", `${TOKEN_FILE_NAME}*`],
    },
    // The backend accepts requests only from a page at this port. Deliberately
    // not strictPort: a second start.bat would then see Vite exit at once and
    // run its cleanup, which closes every backend window, the working one too.
    // A second Vite on 5174 is harmless instead: the backend refuses its page.
    port: 5173,
    // No hot updates: an open tab runs the code it loaded, until it is
    // reloaded. With them on, a git pull swapped the new GameAgent.jsx (and all
    // it imports) into a tab already open, even mid-run, while the tab still
    // named the commit it was loaded with, so a backend left running from
    // before the pull matched it and no mismatch was said (and the run's
    // records credited the new code to the old commit). The page's commit is
    // read on each load (tools/git-version.mjs), so it is true only if the
    // code changes on a load and at no other time. Reload the tab after an
    // edit or a pull.
    hmr: false,
    // Off: the page and /api are one origin, so nothing needs CORS, and Vite's
    // default would let a page on any other localhost port read this page,
    // token included.
    cors: false,
    proxy: {
      "/api": {
        target: "http://localhost:8765",
        changeOrigin: true,
        rewrite: p => p.replace(/^\/api/, ""),
      },
    },
  },
}));
