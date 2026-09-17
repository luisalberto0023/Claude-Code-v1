import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import agentToken, { TOKEN_FILE_NAME } from "./tools/vite-agent-token.mjs";

export default defineConfig({
  // Puts the backend's launch token in the page (see the plugin for why there).
  plugins: [react(), agentToken()],
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
});
