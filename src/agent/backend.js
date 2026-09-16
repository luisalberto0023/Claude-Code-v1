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
