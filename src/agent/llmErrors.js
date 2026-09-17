// ── What a failed model request means ─────────────────────────────────────────
//
// A model request that fails says nothing about the game. It used to: any error
// out of callAI ended the turn with stop:"api-error", the games loop read that
// as the game being over and recorded it as "ended", attemptRestart then clicked
// New Game on a board that was still live, and the false result was saved to
// memory. Every failure except a 429 was also retried the same way, six times
// over about 38 seconds, including a wrong API key or a model id that does not
// exist, which no amount of waiting fixes.
//
// So a failure is sorted into one of three kinds, and callers act on the kind:
//
//   retry    the model may well answer if asked again: rate limits (429),
//            server errors (5xx), requests that ran past their deadline, and
//            requests that never got an HTTP answer at all.
//   fatal    asking again cannot help: a key that is wrong or not allowed
//            (401, 403), a model or address that does not exist (404), or a
//            request the provider rejects as invalid (400). The provider's own
//            words are kept, because they say what to fix.
//   stopped  the user pressed Stop. That is not a failure of anything.
//
// Ollama's HTTP 400 is two unrelated faults, told apart by Ollama's words. A
// capability the model lacks, such as `tools` on a small vision model (commit
// 61cfe3b), comes back as "... does not support tools" every single time, so
// that is fatal at once. Any other 400 is most likely a request body cut off on
// a flaky LAN link, which reaches Ollama as a 400 once its body-read timeout
// expires (commit fe7ca78). Asking again usually works, so it is worth
// retrying: OLLAMA_400_RETRIES times within one request, and after that by the
// games loop's wait for the model, which gives up after MODEL_WAIT_CAP_MS
// (turnResult.js). A link that keeps cutting requests off therefore pauses the
// run and ends it within that cap, rather than ending it after three tries.
//
// Errors are recognised by fields callAI sets on them, not by their wording:
//   status          the HTTP status the provider (or Ollama, via the relay) gave
//   network         the request never got an HTTP answer
//   timedOut        the request ran past its deadline (see withDeadline)
//   stopped         Stop was pressed while it was in flight
//   backendRefused  our own backend refused to relay it (its request body, or
//                   later its token check), which is not the model's doing

// How many HTTP 400s in a row from Ollama one request retries. The next one
// ends the request (still as worth retrying) and the games loop takes over.
export const OLLAMA_400_RETRIES = 2;

const PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  ollama: "Ollama",
};

export function httpError(status, message) {
  const err = new Error(message || `HTTP ${status}`);
  err.status = status;
  return err;
}

export function networkError(message, cause) {
  const err = new Error(message || cause?.message || "no reply");
  err.network = true;
  if (cause) err.cause = cause;
  return err;
}

export function timeoutError(ms) {
  const err = new Error(`no reply within ${Math.round(ms / 1000)}s`);
  err.timedOut = true;
  return err;
}

export function stoppedError() {
  const err = new Error("stopped");
  err.stopped = true;
  return err;
}

export function backendRefusedError(message) {
  const err = new Error(message || "the backend refused the request");
  err.backendRefused = true;
  return err;
}

// The provider's message without the "HTTP 400 after 2.1s:" callAI puts in
// front of it, since the verdict names the status itself.
function providerText(err) {
  const raw = String(err?.message ?? err ?? "").trim();
  const text = raw.replace(/^HTTP \d{3}(?: after [\d.]+s)?:\s*/, "").trim() || raw;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

const verdict = (kind, reason, userText) => ({ kind, reason, userText });

/**
 * What a failed model request means: {kind, reason, userText}.
 *
 *   kind      "retry" | "fatal" | "stopped"
 *   reason    a short fixed name for the cause, for code and logs to match on:
 *             stopped, timeout, rate-limited, server-error, network, unexpected,
 *             bad-request, unsupported, auth, forbidden, not-found, rejected,
 *             backend-refused
 *   userText  one line for the log that says what happened and, when it is
 *             fatal, what to do about it
 *
 * `previous400s` is how many HTTP 400s this provider has already answered in a
 * row for the same request; it only matters for Ollama (see the top of this
 * file).
 */
export function classifyLlmError(err, provider, { previous400s = 0 } = {}) {
  const who = PROVIDER_NAMES[provider] ?? "The model provider";
  const said = providerText(err);

  if (err?.stopped) return verdict("stopped", "stopped", "stopped by the user");
  if (err?.timedOut) {
    return verdict("retry", "timeout", `${who} did not reply in time (${said})`);
  }
  if (err?.backendRefused) {
    return verdict("fatal", "backend-refused",
      `the backend refused to relay the request to ${who}: ${said}`);
  }

  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400) {
    const http = `HTTP ${status}`;
    if (status === 429) return verdict("retry", "rate-limited", `${who} is rate limiting requests (${http}): ${said}`);
    if (status >= 500) return verdict("retry", "server-error", `${who} had a server error (${http}): ${said}`);
    if (status === 408) return verdict("retry", "timeout", `${who} timed out the request (${http}): ${said}`);

    if (status === 400 && provider === "ollama") {
      if (/\bdoes not support\b/i.test(said)) {
        return verdict("fatal", "unsupported",
          `${who} cannot do what the request asks with this model (${http}): ${said}. ` +
          `If it names tools, turn on Small-model mode (JSON actions); if it names vision or images, pick a model that can see images.`);
      }
      if (previous400s < OLLAMA_400_RETRIES) {
        return verdict("retry", "bad-request",
          `${who} rejected the request (${http}), which a request cut off in transit also causes: ${said}`);
      }
      return verdict("retry", "bad-request",
        `${who} rejected the request ${previous400s + 1} times in a row (${http}): ${said}. ` +
        `A request cut off on a flaky network link does this; a smaller Local screenshot width makes each request shorter.`);
    }
    if (status === 401) {
      return verdict("fatal", "auth", `${who} did not accept the API key (${http}): ${said}. Check the key.`);
    }
    if (status === 403) {
      return verdict("fatal", "forbidden",
        `${who} refused access (${http}): ${said}. Check that the key may use this model and API.`);
    }
    if (status === 404) {
      return verdict("fatal", "not-found", provider === "ollama"
        ? `${who} does not have that model (${http}): ${said}. Pull it on the Ollama host (ollama pull <model>) or pick another.`
        : `${who} does not know that model or address (${http}): ${said}. The model id may be wrong or retired; pick another.`);
    }
    if (status === 400) {
      return verdict("fatal", "bad-request", `${who} rejected the request as invalid (${http}): ${said}`);
    }
    return verdict("fatal", "rejected", `${who} rejected the request (${http}): ${said}`);
  }

  if (err?.network) return verdict("retry", "network", `no answer from ${who} (${said})`);
  // Anything else went wrong on the way back: a reply that could not be read,
  // say, or tool arguments that were not JSON. The model's next reply is a new
  // sample, so asking again is worth it.
  return verdict("retry", "unexpected", `${who} request failed: ${said}`);
}

// ── Deadlines ─────────────────────────────────────────────────────────────────
//
// Every model request runs under a deadline, and Stop cuts it short. Without
// one a request can wait for as long as the connection stays open: the cloud
// fetches never had a timeout, and the 180 s one Ollama requests once had was
// lost in 16c6155.

// Cloud providers answer a turn in seconds; 90 s is well past a slow one.
export const CLOUD_TIMEOUT_MS = 90_000;
// The backend's Ollama relay gives the model this long, and the page waits a
// little longer than that for the relay's reply, so it is the relay that times
// out first and says so, rather than the page cutting it off with less detail.
export const OLLAMA_RELAY_TIMEOUT_S = 600;
export const OLLAMA_RELAY_MARGIN_S = 30;
export const OLLAMA_RELAY_PAGE_TIMEOUT_MS = (OLLAMA_RELAY_TIMEOUT_S + OLLAMA_RELAY_MARGIN_S) * 1000;
// Straight from the browser to Ollama, with no relay in between: the same
// allowance the relay gives the model.
export const OLLAMA_DIRECT_TIMEOUT_MS = OLLAMA_RELAY_TIMEOUT_S * 1000;
// agent_server.py never gives Ollama less than this, whatever it is sent.
const RELAY_MIN_TIMEOUT_S = 30;

export function requestTimeoutMs(provider, { viaBackend = false } = {}) {
  if (provider === "ollama") return viaBackend ? OLLAMA_RELAY_PAGE_TIMEOUT_MS : OLLAMA_DIRECT_TIMEOUT_MS;
  return CLOUD_TIMEOUT_MS;
}

/**
 * How long to ask the relay to wait for Ollama when the page waits `pageMs`
 * for the relay: the same margin as a normal request, so a request given a
 * shorter deadline (the check made while waiting for the model) does not leave
 * the backend waiting on Ollama for the full ten minutes after the page gave up.
 */
export function relayTimeoutS(pageMs) {
  if (!(pageMs > 0)) return OLLAMA_RELAY_TIMEOUT_S;
  return Math.max(RELAY_MIN_TIMEOUT_S, Math.floor(pageMs / 1000) - OLLAMA_RELAY_MARGIN_S);
}

/**
 * Whether a failed relay reply ({ok: false, status: 0, ...}) is the relay's own
 * timeout running out. The backend says so with `timedOut`. A backend started
 * before it did has no such field, and would otherwise make a ten-minute
 * timeout look like a dropped connection, which is retried at once, three
 * times over; its error text still names the timeout, so that is read instead.
 */
export function relayTimedOut(reply) {
  if (reply?.status !== 0) return false;
  if (typeof reply.timedOut === "boolean") return reply.timedOut;
  return /\bTimeoutError\b|\btimed out\b/i.test(String(reply.error ?? ""));
}

/**
 * A signal for one request that aborts when `ms` pass or `stopSignal` aborts.
 *
 * explain(err) turns whatever the aborted request threw into an error that says
 * why: stoppedError when Stop was pressed (which wins, since the user asked),
 * timeoutError when the deadline passed, and `err` itself otherwise. done()
 * must be called when the request is finished, body included, or the timer
 * keeps running.
 */
export function withDeadline(stopSignal, ms) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onStop = () => ctrl.abort(stoppedError());
  if (stopSignal?.aborted) onStop();
  else stopSignal?.addEventListener?.("abort", onStop, { once: true });
  const timer = ms > 0
    ? setTimeout(() => { timedOut = true; ctrl.abort(timeoutError(ms)); }, ms)
    : null;
  return {
    signal: ctrl.signal,
    explain(err) {
      if (stopSignal?.aborted) return stoppedError();
      if (timedOut) return timeoutError(ms);
      return err;
    },
    done() {
      if (timer) clearTimeout(timer);
      stopSignal?.removeEventListener?.("abort", onStop);
    },
  };
}

/** Wait `ms`, or reject with stoppedError as soon as `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(stoppedError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(stoppedError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
