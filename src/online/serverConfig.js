/* Point this at your deployed game server (Phase 1 → Render).

   After deploying the server, set the URL here, e.g.:
     const FALLBACK = 'https://nexus-grid-server.onrender.com';
   For local development against `server/`, use:
     const FALLBACK = 'http://localhost:2567';

   You can also override at build time with the VITE_SERVER_URL env var.
   Until a real URL is set, the "Play Online" screen shows a setup notice and
   never tries to connect, so the rest of the game is unaffected. */

const FALLBACK = 'REPLACE_ME_SERVER_URL';

export function serverUrl() {
  const u = (import.meta.env?.VITE_SERVER_URL || FALLBACK || '').trim();
  return u.replace(/\/+$/, '');
}

export function isOnlineConfigured() {
  const u = serverUrl();
  return !!u && !u.startsWith('REPLACE_ME');
}
