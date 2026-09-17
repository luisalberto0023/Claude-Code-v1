// ── Reading the backend's replies ─────────────────────────────────────────────
//
// A write the backend did not make has to be said out loud. The page used to
// save a session's memory and move on without looking at the reply, so a
// rejected save looked exactly like a successful one, and the only sign was a
// memory file that never changed.
//
// Failures arrive in two shapes. The backend's own routes, and the page's
// backend() helper when the request never got an answer or the answer was not
// JSON (see readReply), reply {"ok": false, "error": "..."}. A body the backend refuses to accept at all
// (a field with a value it does not allow) is answered by FastAPI itself, with
// HTTP 422 and {"detail": [{"loc": [...], "msg": "..."}]}, and no "ok" in it.

/**
 * The reply to a backend request, from its HTTP status and the body as text.
 *
 * The backend answers every route in JSON, its refusals included, and that is
 * returned as it is. A body that is not JSON did not come from the backend's
 * routes. The likeliest by far is the backend being down while Vite is still up:
 * Vite's proxy then answers the page itself with HTTP 500 and an empty body, and
 * parsing that used to surface as "Unexpected end of JSON input", which names
 * neither the backend nor what to do about it.
 */
export function readReply(status, text) {
  const body = typeof text === "string" ? text.trim() : "";
  if (body) {
    try { return JSON.parse(body); } catch { /* not JSON: said below */ }
  }
  return {
    ok: false,
    error: body
      ? `the backend replied HTTP ${status}: ${body.length > 120 ? `${body.slice(0, 120)}…` : body}`
      : `no reply from the backend (HTTP ${status}, empty); check that the backend window is running`,
  };
}

/**
 * Why the backend did not do what was asked, or null when it confirmed it did.
 *
 * Only an explicit {"ok": true} counts as success: a reply that says nothing
 * either way is treated as a failure, because assuming otherwise is how a
 * failed save went unnoticed.
 */
export function backendFailure(reply) {
  if (reply?.ok === true) return null;
  if (typeof reply?.error === "string" && reply.error.trim()) return reply.error.trim();
  const detail = reply?.detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(d => {
      // loc starts with where the value was ("body", "query", "path"), which
      // says nothing the field name does not.
      const field = (Array.isArray(d?.loc) ? d.loc : [])
        .filter((part, i) => !(i === 0 && ["body", "query", "path"].includes(part)))
        .join(".");
      const msg = typeof d?.msg === "string" ? d.msg : JSON.stringify(d);
      return field ? `${field}: ${msg}` : msg;
    }).join("; ");
  }
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  return "the backend did not confirm it";
}

// ── Who the backend lets in ───────────────────────────────────────────────────
//
// The backend moves the real mouse for whoever asks, and any web page in the
// browser can ask localhost. So it takes requests only with the token it made
// when it started, and only from this page's own address (agent_server.py, "Who
// may use this server"). The dev server puts the token in the page as
// window.__AGENT_TOKEN__ (tools/vite-agent-token.mjs), and backend() in
// GameAgent.jsx sends it with every request.

export const TOKEN_HEADER = "X-Agent-Token";
// Where the backend accepts the page from; PAGE_ORIGINS in agent_server.py.
export const PAGE_ADDRESS = "http://localhost:5173";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/** This page's backend token, or null when the page was served without one. */
export function pageToken(scope = globalThis) {
  const token = scope?.__AGENT_TOKEN__;
  return typeof token === "string" && TOKEN_PATTERN.test(token) ? token : null;
}

/** Headers for a backend request: the token when there is one, and a JSON body's type. */
export function backendHeaders(token, { json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (token) headers[TOKEN_HEADER] = token;
  return headers;
}

/**
 * Whether the backend turned this page away, and what the operator can do
 * about it, or null when it did not.
 *
 * Only the backend's access check answers 401 or 403 (no route does), and it
 * does so before anything runs. Every later request is refused the same way,
 * so this is said once, loudly, rather than as one failed click after another.
 */
export function accessRefusal(status, token) {
  if (status === 401) {
    return token
      ? { kind: "token", message: "The backend refused this page's token. It makes a new one each time it starts, so it has been restarted since this page loaded: reload this page (F5)." }
      : { kind: "no-token", message: `This page has no backend token, so the backend refuses it. Start the agent with start.bat (or the backend, then npm run dev) and reload ${PAGE_ADDRESS}.` };
  }
  if (status === 403) {
    return { kind: "origin", message: `The backend accepts only the agent page at ${PAGE_ADDRESS} (or http://127.0.0.1:5173). Open it there.` };
  }
  return null;
}

// ── What one request may carry ────────────────────────────────────────────────
//
// The backend caps what a single request may write (LOG_APPEND_MAX_LINES,
// LOG_APPEND_MAX_BYTES and SNAPSHOT_MAX_BYTES in agent_server.py, the same
// numbers; tools/check-agent.mjs fails if they differ), so a runaway or hostile
// request cannot fill the disk in one go. The page keeps inside those caps
// instead of having its writes refused.

export const LOG_APPEND_MAX_LINES = 1000;
export const LOG_APPEND_MAX_BYTES = 1024 * 1024;
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

const utf8 = new TextEncoder();

/** Bytes a log line takes in the file, counted as the backend counts them. */
function lineBytes(line) {
  return utf8.encode(line.replace(/\n+$/, "")).length + 1;
}

/**
 * Log lines split into batches the backend accepts, in order.
 *
 * A line that could not fit even alone (a whole reply dumped into the log, say)
 * is cut, and says how much was left out, rather than having its whole batch
 * refused.
 */
export function logBatches(lines, { maxLines = LOG_APPEND_MAX_LINES, maxBytes = LOG_APPEND_MAX_BYTES } = {}) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const raw of lines) {
    let line = String(raw);
    let size = lineBytes(line);
    if (size > maxBytes) {
      const note = ` … [cut: the line was ${size} bytes]`;
      const room = maxBytes - lineBytes(note);
      // Characters in proportion to the bytes that fit, then fewer until they
      // do (a character can take up to 4 bytes).
      let keep = Math.floor(line.length * room / size);
      while (keep > 0 && lineBytes(line.slice(0, keep)) - 1 > room) keep = Math.floor(keep * 0.9);
      line = line.slice(0, keep) + note;
      size = lineBytes(line);
    }
    if (batch.length && (batch.length >= maxLines || bytes + size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(line);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** A snapshot's size as the backend measures it: the PNG as decoded, plus the text. */
export function snapshotBytes(pngBase64, text) {
  return Math.floor((pngBase64?.length ?? 0) * 3 / 4) + (text ? utf8.encode(text).length : 0);
}
