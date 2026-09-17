// ── Which Ollama server the model requests go to ──────────────────────────────
//
// With "Relay through local backend" on (the default), the backend sends every
// Ollama request to ONE server, chosen when it starts: OLLAMA_BASE_URL in its
// environment, else "ollamaBase" in agent-config.json, else localhost
// (agent_server.py, "Ollama relay"). The page used to send the address with
// each request instead, and the backend went wherever it was told, which let
// anything that could reach the backend use it as a proxy into the LAN.
//
// So with the relay on, the OLLAMA SERVER field shows the backend's server
// (from /capabilities), and a different address takes effect only once it is
// saved (POST /config/ollama-base) and the backend restarted. With the relay
// off, the browser calls whatever the field says, as it always has.
//
// `server` below is /capabilities' "ollama": {base, source, error, saved}, or
// null when the backend has not said (offline, or older than this page).

import { backendFailure } from "./backend.js";

export const OLLAMA_DEFAULT_BASE = "http://localhost:11434";
// The environment variable that overrides agent-config.json; OLLAMA_BASE_ENV in
// agent_server.py.
export const OLLAMA_BASE_ENV = "OLLAMA_BASE_URL";

/** An address as typed, without surrounding space or trailing slashes. */
export function tidyOllamaBase(text) {
  return String(text ?? "").trim().replace(/\/+$/, "");
}

/**
 * An address as typed, for the log: everything before its last @ (after any
 * http://) hidden, as the backend does, since the log is kept on disk and a
 * typed address may carry a password.
 */
export function shownOllamaBase(text) {
  const tidy = tidyOllamaBase(text);
  const at = tidy.lastIndexOf("@");
  if (at < 0) return tidy;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(tidy.slice(0, at))?.[0] ?? "";
  return `${scheme}***${tidy.slice(at)}`;
}

const same = (a, b) => !!a && !!b && tidyOllamaBase(a) === tidyOllamaBase(b);

function sourceWords(source) {
  if (source === "default") return "the default";
  if (source === OLLAMA_BASE_ENV) return `set by ${OLLAMA_BASE_ENV} for the backend`;
  return `saved in ${source}`;
}

// A saved address the backend will use from its next start, when that is not
// the one it uses now. Not while OLLAMA_BASE_URL decides: a restart keeps it.
function pendingSave(server) {
  return server.saved && !same(server.saved, server.base) && server.source !== OLLAMA_BASE_ENV
    ? ` ${server.saved} is saved for the next start: restart start.bat to use it.`
    : "";
}

/**
 * The line under the field, and whether its Save button does anything:
 * {tone: "ok" | "info" | "warn" | "error", text, canSave}.
 */
export function ollamaServerNote({ field, relay, server }) {
  const typed = tidyOllamaBase(field);
  if (!relay) {
    return {
      tone: "info",
      text: "The browser calls this address directly. Start Ollama there with OLLAMA_ORIGINS=* " +
        "(and OLLAMA_HOST=0.0.0.0 on another PC) so the browser may reach it.",
      canSave: !!server && !!typed && !same(typed, server.saved ?? server.base),
    };
  }
  if (!server) {
    return {
      tone: "warn",
      text: "The backend has not said which Ollama server it relays to: it is offline, or older than this page " +
        "(restart start.bat).",
      canSave: false,
    };
  }
  if (!server.base) {
    return {
      tone: "error",
      text: `The relay refuses model requests: ${server.error ?? "no usable Ollama address"}. ` +
        (server.source === OLLAMA_BASE_ENV
          ? `Fix or clear ${OLLAMA_BASE_ENV} for the backend, then restart start.bat.`
          : "Save a working address, then restart start.bat."),
      canSave: !!typed && !same(typed, server.saved),
    };
  }
  // A save waiting for a restart is named even when the field shows the server
  // in use (as it does again after a reload), or the save looks lost. Saving
  // the server in use then takes the waiting one back.
  const pending = pendingSave(server);
  if (same(typed, server.base)) {
    return {
      tone: pending ? "warn" : "ok",
      text: `The backend relays to this server (${sourceWords(server.source)}).${pending}`,
      canSave: !!pending,
    };
  }
  if (!typed) {
    return { tone: "warn", text: `The backend relays to ${server.base} (${sourceWords(server.source)}).${pending}`, canSave: false };
  }
  if (same(typed, server.saved)) {
    return {
      tone: "warn",
      text: server.source === OLLAMA_BASE_ENV
        ? `Saved, but ${OLLAMA_BASE_ENV} is set for the backend and wins: it relays to ${server.base}.`
        : `Saved. Restart start.bat to relay to it; until then the backend relays to ${server.base}.`,
      canSave: false,
    };
  }
  return {
    tone: "warn",
    text: `Not in use: the backend relays to ${server.base}. Save this address, then restart start.bat.`,
    canSave: true,
  };
}

/**
 * Why a session must not start with these settings, or null. With the relay
 * on, every model request goes to the backend's server, so a field naming
 * another would send the session somewhere the operator did not mean, and a
 * relay without a usable server refuses the first turn anyway.
 */
export function ollamaStartProblem({ field, relay, server }) {
  if (!relay) return null;
  // ▶ Start needs the backend online, so a backend that has not said is one
  // older than this page (its relay wants a base_url, and refuses the first
  // turn), or one that stopped answering just now.
  if (!server) {
    return "Not started: the backend has not said which Ollama server its relay uses: it is older than this page, " +
      "or not answering. Restart start.bat, then reload this page.";
  }
  const envDecides = server.source === OLLAMA_BASE_ENV;
  if (!server.base) {
    return `Not started: the backend's relay refuses model requests (${server.error ?? "no usable Ollama address"}). ` +
      (envDecides
        ? `Fix or clear ${OLLAMA_BASE_ENV} for the backend and restart start.bat.`
        : "Save a working address under OLLAMA SERVER and restart start.bat.");
  }
  if (!same(field, server.base)) {
    return `Not started: OLLAMA SERVER says ${shownOllamaBase(field) || "nothing"}, but the backend relays to ${server.base}. ` +
      (envDecides
        ? `${OLLAMA_BASE_ENV} is set for the backend and decides its server: set the field back to ${server.base}, ` +
          `or change ${OLLAMA_BASE_ENV} and restart start.bat.`
        : `Save the address and restart start.bat, or set the field back to ${server.base}.`);
  }
  return null;
}

/**
 * The log line for POST /config/ollama-base's reply, {type, text}, or null
 * when backend() has already said the page was refused.
 */
export function ollamaSavedMessage(reply) {
  if (reply?.refused) return null;
  if (reply?.ok !== true) {
    return { type: "warn", text: `Ollama server not saved — ${olderBackend(reply) ?? backendFailure(reply)}` };
  }
  if (reply.overriddenBy) {
    return {
      type: "warn",
      text: `💾 Saved ${reply.saved} in agent-config.json, but ${reply.overriddenBy} is set for the backend and wins ` +
        `(it relays to ${reply.active ?? "no usable server"}). Clear ${reply.overriddenBy} and restart start.bat to use the saved address.`,
    };
  }
  if (reply.restartRequired) {
    return {
      type: "success",
      text: `💾 Saved ${reply.saved} as the Ollama server (agent-config.json). Restart start.bat to use it; ` +
        `until then the backend relays to ${reply.active ?? "no usable server"}.`,
    };
  }
  return { type: "success", text: `💾 Saved ${reply.saved}; the backend already relays to it.` };
}

/**
 * The log line for GET /llm/ollama/tags' reply, {type, text}, or null when
 * backend() has already said the page was refused.
 */
export function ollamaModelsMessage(reply) {
  if (reply?.refused) return null;
  const older = olderBackend(reply);
  if (older) return { type: "warn", text: `Ollama not checked — ${older}` };
  if (reply?.ok !== true) {
    // A {detail} refusal: the relay has no usable server, and says why.
    if (reply?.detail != null) return { type: "error", text: `✗ ${backendFailure(reply)}` };
    return {
      type: "warn",
      text: `✗ Ollama at ${reply?.base ?? "the backend's server"} did not answer: ${backendFailure(reply)}`,
    };
  }
  const names = (reply.models ?? []).map(m => m.name);
  if (!names.length) {
    return { type: "warn", text: `Ollama at ${reply.base} answers, but has no models: run ollama pull <model> there.` };
  }
  const shown = names.slice(0, 8).join(", ");
  const more = names.length > 8 ? `, and ${names.length - 8} more` : "";
  return {
    type: "success",
    text: `✓ Ollama at ${reply.base} answers, with ${names.length} model${names.length === 1 ? "" : "s"}: ${shown}${more}`,
  };
}

// A backend started before these routes existed answers them "Not Found".
function olderBackend(reply) {
  return reply?.detail === "Not Found"
    ? "the backend is older than this page: restart start.bat"
    : null;
}
