// ── Which models there are, and whether the chosen one answers ────────────────
//
// The model picker used to be a fixed list, and a model id that had been retired
// failed only once a session was under way: a turn of play was refused, and the
// session ended. Nothing checked the id before, and nothing let the operator use
// an id the list did not have. So:
//   - the picker lists what the provider offers the key (Anthropic and OpenAI
//     GET /v1/models, Gemini models.list, Ollama's pulled models through the
//     backend's GET /llm/ollama/tags, or Ollama's own /api/tags with the relay
//     off), after the defaults in providers.js, and a text field takes any id;
//   - ▶ Start checks the chosen model first, and does not start when the check
//     fails, saying why in the provider's own words (classifyLlmError). For
//     Ollama that is the model being among the server's pulled models, which
//     costs nothing; for a cloud provider it is one request for a one-token
//     reply, which costs a fraction of one turn.
//
// listModels and checkModel do the asking. They are given what they ask with
// (fetch, the page's backend() and callAI), so tools/check-llm.mjs can run them
// against stand-ins; everything else here is plain functions of their replies.

import { PROVIDERS } from "./providers.js";
import { ANTHROPIC_API, OPENAI_API, GEMINI_API, anthropicHeaders, openaiHeaders, geminiHeaders } from "./requests.js";
import { backendFailure } from "../agent/backend.js";
import { classifyLlmError, httpError, networkError, withDeadline } from "../agent/llmErrors.js";

// The check at Start asks for a reply this long, so it costs next to nothing.
export const CHECK_MAX_TOKENS = 1;
// A check waits this long. A cloud model answers one token in seconds; the relay
// gives Ollama's model list 15 s of its own (OLLAMA_TAGS_TIMEOUT_S).
export const CHECK_TIMEOUT_MS = 30_000;
export const MODEL_LIST_TIMEOUT_MS = 20_000;
// The picker lists models once typing in the key (or the Ollama address) has
// paused this long, so a half-typed key is not sent to the provider.
export const MODEL_LIST_PAUSE_MS = 800;

// What the check at Start sends a cloud model: no tools, no image.
export const CHECK_SYSTEM = "You are checking that a connection works.";
export const CHECK_MESSAGES = Object.freeze([Object.freeze({ role: "user", content: "Reply with the single word OK." })]);

const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", ollama: "Ollama" };

// ── Listing ───────────────────────────────────────────────────────────────────

/** The request that lists a cloud provider's models for a key, {url, init}. */
export function modelListRequest(provider, apiKey) {
  if (provider === "anthropic") {
    return { url: `${ANTHROPIC_API}/models?limit=1000`, init: { method: "GET", headers: anthropicHeaders(apiKey, { json: false }) } };
  }
  if (provider === "openai") {
    return { url: `${OPENAI_API}/models`, init: { method: "GET", headers: openaiHeaders(apiKey, { json: false }) } };
  }
  if (provider === "gemini") {
    return { url: `${GEMINI_API}/models?pageSize=1000`, init: { method: "GET", headers: geminiHeaders(apiKey, { json: false }) } };
  }
  return null;
}

// Models a provider lists that cannot play: speech, embeddings, image or video
// makers, live audio. Only a list's clutter; a typed id is still used as typed.
const OPENAI_NOT_CHAT = /(^|-)(tts|transcribe|realtime|audio|image|embedding|moderation|search|instruct|live|translate|codex)(-|$)|^(dall-e|whisper|davinci|babbage|text-|omni-moderation|sora)/i;
const GEMINI_NOT_CHAT = /(^|-)(tts|embedding|image|live|audio|transcribe|robotics|computer-use|aqa)(-|$)|^(imagen|veo|lyria|embedding|text-embedding|gemini-omni)/i;
// OpenAI chat models still served that cannot take a turn as this page sends it,
// per OpenAI's model pages (checked 2026-09-17): gpt-3.5-turbo and gpt-4 read
// text only (no screenshot), and gpt-3.5-turbo and gpt-4-turbo stop at 4,096
// output tokens, below MAX_OUTPUT_TOKENS, so every turn would be refused. They
// shut down on 2026-10-23 anyway. gpt-4o and gpt-4.1 are not matched. (chatgpt-*
// ids are not offered at all: chatgpt-4o-latest shut down on 2026-02-17.)
const OPENAI_CANNOT_PLAY = /^(gpt-3\.5|gpt-4(-|$))/i;

/** What a provider's model list says, as [{id, label}], newest first as sent. */
export function readModelList(provider, body) {
  if (provider === "anthropic") {
    return (Array.isArray(body?.data) ? body.data : [])
      .filter(m => typeof m?.id === "string" && m.capabilities?.image_input?.supported !== false)
      .map(m => ({ id: m.id, label: m.display_name ? `${m.display_name} · ${m.id}` : m.id }));
  }
  if (provider === "openai") {
    return (Array.isArray(body?.data) ? body.data : [])
      .filter(m => typeof m?.id === "string" && /^(gpt-|o\d)/i.test(m.id) && !OPENAI_NOT_CHAT.test(m.id) && !OPENAI_CANNOT_PLAY.test(m.id))
      .map(m => ({ id: m.id, label: m.id }));
  }
  if (provider === "gemini") {
    return (Array.isArray(body?.models) ? body.models : [])
      .filter(m => typeof m?.name === "string" && (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map(m => ({ id: m.name.replace(/^models\//, ""), label: m.displayName }))
      .filter(m => !GEMINI_NOT_CHAT.test(m.id))
      .map(m => ({ id: m.id, label: m.label ? `${m.label} · ${m.id}` : m.id }));
  }
  if (provider === "ollama") {
    // The relay's GET /llm/ollama/tags ({models: [{name, size, parameterSize}]})
    // or Ollama's own /api/tags ({models: [{name, size, details}]}).
    return (Array.isArray(body?.models) ? body.models : [])
      .filter(m => typeof m?.name === "string")
      .map(m => {
        const params = m.parameterSize ?? m.details?.parameter_size;
        const gb = Number(m.size) > 0 ? `${(Number(m.size) / 1e9).toFixed(1)}GB` : null;
        const about = [params, gb].filter(Boolean).join(", ");
        return { id: m.name, label: about ? `${m.name} (${about}, pulled)` : `${m.name} (pulled)` };
      });
  }
  return [];
}

/**
 * Whether two ids name the same model. Ollama reads a name without a tag as
 * ":latest" ("moondream" is "moondream:latest"), and Gemini ids may carry the
 * "models/" models.list puts in front.
 */
export function sameModel(provider, a, b) {
  const tidy = (id) => {
    let s = String(id ?? "").trim();
    if (provider === "gemini") s = s.replace(/^models\//, "");
    if (provider === "ollama") {
      s = s.toLowerCase();
      if (!/:[^/]*$/.test(s)) s = `${s}:latest`;
    }
    return s;
  };
  const x = tidy(a);
  return !!x && x === tidy(b);
}

/**
 * The picker's choices: the provider's defaults first, then whatever else the
 * provider listed. `listed` is null until a list came back. A default the list
 * does not have says so, since that is the one the operator is likeliest to pick.
 */
export function modelChoices(provider, listed) {
  const defaults = PROVIDERS[provider]?.models ?? [];
  if (!Array.isArray(listed)) return defaults;
  const missing = provider === "ollama" ? "not pulled on that server" : "not offered to this key";
  return [
    ...defaults.map(d => (listed.some(m => sameModel(provider, m.id, d.id)) ? d : { ...d, label: `${d.label} — ${missing}` })),
    ...listed.filter(m => !defaults.some(d => sameModel(provider, m.id, d.id))),
  ];
}

/**
 * The line under the picker for a listing: {type, text}. `result` is
 * {ok: true, models} or {ok: false, error}.
 */
export function modelListMessage(provider, result) {
  const who = PROVIDER_NAMES[provider] ?? provider;
  if (!result?.ok) return { type: "warn", text: `Could not list ${who}'s models: ${result?.error ?? "no reply"}` };
  const n = result.models.length;
  if (!n) {
    return {
      type: "warn",
      text: provider === "ollama"
        ? "The Ollama server answers, but has no models pulled: run ollama pull <model> there."
        : `${who} listed no models this page can use; type an id instead.`,
    };
  }
  return {
    type: "success",
    text: provider === "ollama"
      ? `${n} model${n === 1 ? "" : "s"} pulled on the Ollama server, listed below the defaults.`
      : `${who} offers this key ${n} model${n === 1 ? "" : "s"}, listed below the defaults.`,
  };
}

/** Why a model id cannot be used at all, or null. */
export function modelIdProblem(model) {
  const id = typeof model === "string" ? model.trim() : "";
  if (!id) return "no model is chosen: pick one, or type its id";
  if (/\s/.test(id)) return `"${id}" is not a model id (it has a space in it)`;
  return null;
}

// A failure while listing or checking, in the words classifyLlmError gives a
// failed model request: a key the provider refuses reads the same either way.
function failureText(err, provider) {
  return (err?.verdict ?? classifyLlmError(err, provider)).userText;
}

/**
 * Ollama's pulled models, in the shape of the relay's GET /llm/ollama/tags
 * reply: {ok: true, base, models} or {ok: false, base?, error} (a refusal by
 * the backend keeps its `refused` and `detail`). With the relay off the browser
 * asks Ollama's own /api/tags at `base`, the OLLAMA SERVER field. `signal` is
 * expected to come from withDeadline, whose abort reason says whether it was a
 * Stop or the deadline.
 */
export async function ollamaTags({ relay, base, signal = null, backend, fetch = globalThis.fetch }) {
  if (relay) {
    try {
      return await backend("/llm/ollama/tags", null, { signal });
    } catch (err) {
      // backend() throws only when the signal aborted, with the abort's reason.
      return { ok: false, error: failureText(err, "ollama") };
    }
  }
  const where = String(base ?? "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${where}/api/tags`, { method: "GET", signal })
      .catch(e => { throw signal?.aborted ? e : networkError(e?.message, e); });
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    return { ok: true, base: where, models: Array.isArray(body?.models) ? body.models : [] };
  } catch (err) {
    return { ok: false, base: where, error: failureText(err, "ollama") };
  }
}

/**
 * What the provider offers: {ok: true, models: [{id, label}], base?} or
 * {ok: false, error, refused?, stopped?}. `signal` cancels it (a newer listing
 * replaces this one), and it gives up after MODEL_LIST_TIMEOUT_MS.
 */
export async function listModels(provider, { apiKey = "", relay = true, base = "", signal = null, backend, fetch = globalThis.fetch } = {}) {
  const deadline = withDeadline(signal, MODEL_LIST_TIMEOUT_MS);
  try {
    if (provider === "ollama") {
      const reply = await ollamaTags({ relay, base, signal: deadline.signal, backend, fetch });
      if (reply?.ok !== true) {
        const error = reply?.detail === "Not Found"
          ? "the backend is older than this page: restart start.bat"
          : backendFailure(reply);
        return { ok: false, base: reply?.base, error, refused: reply?.refused, stopped: !!signal?.aborted };
      }
      return { ok: true, base: reply.base, models: readModelList("ollama", reply) };
    }
    const request = modelListRequest(provider, apiKey);
    if (!request) return { ok: false, error: `unknown provider ${provider}` };
    try {
      const res = await fetch(request.url, { ...request.init, signal: deadline.signal })
        .catch(e => { throw networkError(e?.message, e); });
      // Read as text first: a body cut off by the deadline is a failure, not an
      // empty list.
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* said below */ }
      if (!res.ok) throw httpError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
      if (!body) throw new Error(`the model list was not JSON: ${text.slice(0, 120)}`);
      return { ok: true, models: readModelList(provider, body) };
    } catch (err) {
      return { ok: false, error: failureText(deadline.explain(err), provider), stopped: !!signal?.aborted };
    }
  } finally {
    deadline.done();
  }
}

// ── The check at Start ────────────────────────────────────────────────────────

// A refusal of the one-token reply itself, rather than of the key or the model:
// a provider that will not reply that briefly still accepted both. The request
// is sent with max_completion_tokens, never max_tokens, so an OpenAI refusal
// naming "Unsupported parameter" is a real fault and is not read this way.
function refusedOnlyTheLength(verdict) {
  if (verdict?.kind !== "fatal" || verdict.reason !== "bad-request") return false;
  const said = String(verdict.userText ?? "");
  return /\b(max_completion_tokens|max_tokens|max_output_tokens|maxOutputTokens|output limit)\b/i.test(said) &&
    /\b(minimum|at least|too (small|low)|limit was reached|below)\b/i.test(said) &&
    !/unsupported parameter|unrecognized/i.test(said);
}

/**
 * What a cloud model's one-token check means: {ok, type, text}. `verdict` is
 * classifyLlmError's, or null when the model replied.
 */
export function cloudCheckMessage(provider, model, verdict) {
  const who = PROVIDER_NAMES[provider] ?? provider;
  if (!verdict) return { ok: true, type: "success", text: `✓ ${who} accepted the key and answered with ${model}.` };
  if (refusedOnlyTheLength(verdict)) {
    return {
      ok: true, type: "warn",
      text: `${who} accepted the key and ${model} but would not give a one-token reply (${verdict.userText}); starting.`,
    };
  }
  if (verdict.kind === "stopped") return { ok: false, type: "warn", text: "Not started: the model check was stopped." };
  return {
    ok: false, type: "error",
    text: `Not started: the check of ${model} failed — ${verdict.userText}` +
      (verdict.kind === "retry" ? " This may clear up: press ▶ Start again in a moment." : ""),
  };
}

/**
 * What an Ollama model check means: {ok, type, text}. `reply` is the relay's GET
 * /llm/ollama/tags reply, or the same shape built from Ollama's /api/tags when
 * the relay is off ({ok, base, models} or {ok: false, base, error}).
 */
export function ollamaCheckMessage(model, reply) {
  if (reply?.refused) {
    return { ok: false, type: "error", text: `Not started: the backend refused this page (${backendFailure(reply)}).` };
  }
  if (reply?.detail === "Not Found") {
    return { ok: false, type: "error", text: "Not started: the backend is older than this page and cannot list Ollama's models: restart start.bat, then reload this page." };
  }
  const where = reply?.base ? `Ollama at ${reply.base}` : "Ollama";
  if (reply?.ok !== true) {
    return {
      ok: false, type: "error",
      text: `Not started: ${where} did not list its models — ${backendFailure(reply)}. Check that Ollama is running there.`,
    };
  }
  const names = readModelList("ollama", reply).map(m => m.id);
  if (names.some(name => sameModel("ollama", name, model))) {
    return { ok: true, type: "success", text: `✓ ${where} has ${model} pulled.` };
  }
  return {
    ok: false, type: "error",
    text: `Not started: ${where} does not have ${model}. Run ollama pull ${model} there, or pick one it has` +
      (names.length ? `: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", ..." : ""}.` : " (it has none)."),
  };
}

/**
 * The check ▶ Start makes before a session: {ok, type, text}, where `text` is
 * the log line either way. Ollama: the model is among the server's pulled
 * models. A cloud provider: one request for a CHECK_MAX_TOKENS reply, with no
 * retry, through `callAI` (the page's). That proves the key and the model id,
 * and that the provider takes the request as callAI builds it. It does not
 * prove the model takes tools, a screenshot or the full output cap: the check
 * sends none of them, so a model that lacks one passes and is refused on its
 * first turn.
 */
export async function checkModel(provider, model, { apiKey = "", relay = true, base = "", signal = null, backend, callAI, fetch = globalThis.fetch } = {}) {
  const problem = modelIdProblem(model);
  if (problem) return { ok: false, type: "error", text: `Not started: ${problem}.` };
  const id = model.trim();

  if (provider === "ollama") {
    const deadline = withDeadline(signal, CHECK_TIMEOUT_MS);
    try {
      return ollamaCheckMessage(id, await ollamaTags({ relay, base, signal: deadline.signal, backend, fetch }));
    } finally {
      deadline.done();
    }
  }

  try {
    await callAI(provider, id, CHECK_SYSTEM, CHECK_MESSAGES, [], apiKey, null,
      { signal, retry: false, timeoutMs: CHECK_TIMEOUT_MS, maxTokens: CHECK_MAX_TOKENS });
    return cloudCheckMessage(provider, id, null);
  } catch (err) {
    return cloudCheckMessage(provider, id, err?.verdict ?? classifyLlmError(err, provider));
  }
}
