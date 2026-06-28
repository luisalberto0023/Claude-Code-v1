/* Lightweight device account: a persistent token in localStorage + a display
   name. Created/refreshed on the server. Real sign-in (Google/email) is a
   later phase before rewards go live. */

import { serverUrl } from './serverConfig.js';

const TOKEN_KEY = 'nexus.token';
const NAME_KEY = 'nexus.name';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function getSavedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function save(token, name) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch { /* ignore */ }
}

// Create or refresh the account; returns the full profile.
export async function ensureAccount(name) {
  const res = await fetch(`${serverUrl()}/api/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: getToken(), name }),
  });
  if (!res.ok) throw new Error('Could not reach the server.');
  const acc = await res.json();
  save(acc.token, acc.name);
  return acc;
}

// Read current profile without changing the name (returns null if no account yet).
export async function fetchProfile() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${serverUrl()}/api/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function fetchLeaderboard() {
  const res = await fetch(`${serverUrl()}/api/leaderboard?token=${encodeURIComponent(getToken())}`);
  if (!res.ok) throw new Error('Could not load the leaderboard.');
  return res.json(); // { top: [...], me: {rank,...}|null }
}
