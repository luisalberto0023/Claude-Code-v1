// ── What a model request looks like, for each provider ────────────────────────
//
// The page keeps its conversation in the Anthropic message format, whatever the
// provider, and turns it into each provider's request here. These are plain
// functions, with no fetch in them, so tools/check-agent.mjs can check what is
// sent without calling anyone.
//
// Four things were wrong with the requests before, each one enough to make a
// current model refuse or misbehave:
//   - OpenAI got `max_tokens`, which OpenAI has deprecated in favour of
//     max_completion_tokens and which its reasoning models (GPT-5.6 among them)
//     refuse. They get max_completion_tokens now, which also bounds the tokens a
//     reasoning model spends thinking.
//   - Gemini got the API key as ?key= in the URL. Keys created in AI Studio since
//     May 28, 2026 are authorization keys, and the key belongs in the
//     x-goog-api-key header (Google's REST examples); a URL also ends up in logs
//     and browser history, which a header does not.
//   - The Gemini converters rebuilt the model's reply from scratch and dropped its
//     thought signatures. Gemini 3 models validate them: a function call in the
//     current turn sent back without its signature is refused with HTTP 400. So
//     each part of a Gemini reply is kept as it came (on the block made from it,
//     as `gemini`), and sent back exactly as received, in its place.
//   - Anthropic refuses a browser's request unless it says
//     `anthropic-dangerous-direct-browser-access: true`. The name is a warning:
//     the key sits in the page (SETUP.md says what to do about that).

export const ANTHROPIC_API = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const OPENAI_API = "https://api.openai.com/v1";
export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

// The most a reply may use, thinking included. The default models of all three
// think without being asked: Claude Sonnet 5 and Opus 5 (thinking on by default,
// at effort high, and it counts toward max_tokens), GPT-5.6 models and Gemini
// 3.x Flash. A cap of 4096 could be spent on thinking alone and stop the reply
// before it calls a tool, so the turn does nothing. 16384 is within every
// default's output limit (Claude Haiku 4.5's is 64K, the others' larger). The cap
// is a ceiling, not a charge; the token budget in ADVANCED still bounds a session.
export const MAX_OUTPUT_TOKENS = { anthropic: 16384, openai: 16384, gemini: 16384 };

// A block that carries a Gemini part the agent has no use for (an empty text
// part holding a thought signature, say), kept so it goes back in its place.
export const GEMINI_PART = "gemini_part";

// ── Headers ───────────────────────────────────────────────────────────────────

export function anthropicHeaders(apiKey, { json = true } = {}) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    // Without it Anthropic refuses a request from a browser (CORS).
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export function openaiHeaders(apiKey, { json = true } = {}) {
  return { ...(json ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${apiKey}` };
}

export function geminiHeaders(apiKey, { json = true } = {}) {
  return { ...(json ? { "Content-Type": "application/json" } : {}), "x-goog-api-key": apiKey };
}

/**
 * A Gemini model id as a URL path segment. models.list names models
 * "models/gemini-...", and either form may be typed into the model field.
 */
export function geminiModelPath(model) {
  const id = String(model ?? "").trim().replace(/^models\//, "");
  return `models/${encodeURIComponent(id)}`;
}

// ── Requests ──────────────────────────────────────────────────────────────────
// Each returns {url, init} for fetch, without a signal (callAI adds its own).

const cap = (provider, maxTokens) => (maxTokens > 0 ? Math.floor(maxTokens) : MAX_OUTPUT_TOKENS[provider]);

export function anthropicRequest({ model, system, messages, tools = [], apiKey, maxTokens = null }) {
  const body = {
    model,
    max_tokens: cap("anthropic", maxTokens),
    system,
    messages,
    tools: tools.length ? tools : undefined,
  };
  return {
    url: `${ANTHROPIC_API}/messages`,
    init: { method: "POST", headers: anthropicHeaders(apiKey), body: JSON.stringify(body) },
  };
}

export function openaiRequest({ model, system, messages, tools = [], apiKey, maxTokens = null }) {
  const body = {
    model,
    messages: [{ role: "system", content: system }, ...toOpenAIMessages(messages)],
    tools: tools.length ? toOpenAITools(tools) : undefined,
    max_completion_tokens: cap("openai", maxTokens),
  };
  return {
    url: `${OPENAI_API}/chat/completions`,
    init: { method: "POST", headers: openaiHeaders(apiKey), body: JSON.stringify(body) },
  };
}

export function geminiRequest({ model, system, messages, tools = [], apiKey, maxTokens = null }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiMessages(messages),
    tools: tools.length ? toGeminiTools(tools) : undefined,
    generationConfig: { maxOutputTokens: cap("gemini", maxTokens) },
  };
  return {
    url: `${GEMINI_API}/${geminiModelPath(model)}:generateContent`,
    init: { method: "POST", headers: geminiHeaders(apiKey), body: JSON.stringify(body) },
  };
}

/** The body of an Ollama chat request, sent through the relay or straight to Ollama. */
export function ollamaChatBody({ model, system, messages, tools = [] }) {
  return {
    model,
    messages: [{ role: "system", content: system }, ...toOpenAIMessages(messages)],
    tools: tools.length ? toOpenAITools(tools) : undefined,
    stream: false,
    // Ollama defaults to temperature 1.0. Choosing a game move is a decision,
    // not creative writing — sample the model's best judgment instead of a
    // random one from the distribution.
    temperature: 0.25,
    top_p: 0.9,
  };
}

// ── Format converters ─────────────────────────────────────────────────────────

export function toOpenAITools(tools) {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  }];
}

export function toOpenAIMessages(messages) {
  return messages.flatMap(m => {
    if (typeof m.content === "string") {
      return [{ role: m.role === "assistant" ? "assistant" : "user", content: m.content }];
    }
    const toolUses = m.content.filter(c => c.type === "tool_use");
    const toolResults = m.content.filter(c => c.type === "tool_result");

    if (toolResults.length > 0) {
      return toolResults.map(tr => ({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: Array.isArray(tr.content)
          ? tr.content.map(c => c.text ?? "").join("")
          : (tr.content ?? ""),
      }));
    }

    if (toolUses.length > 0) {
      const textParts = m.content.filter(c => c.type === "text").map(c => c.text).join("");
      return [{
        role: "assistant",
        content: textParts || null,
        tool_calls: toolUses.map(tu => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      }];
    }

    const parts = m.content.map(c => {
      if (c.type === "text") return { type: "text", text: c.text };
      if (c.type === "image") return { type: "image_url", image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } };
      return null;
    }).filter(Boolean);

    const role = m.role === "assistant" ? "assistant" : "user";
    if (parts.length === 1 && parts[0].type === "text") return [{ role, content: parts[0].text }];
    return [{ role, content: parts }];
  });
}

// The tool_use id for a Gemini function call: Gemini's own id when it gave one,
// or a made-up one. Either starts with the function's name, which is what a
// functionResponse needs when the call itself has been trimmed out of the
// conversation window.
function geminiCallId(call) {
  return `${call.name}__${call.id || Math.random().toString(36).slice(2, 8)}`;
}

export function toGeminiMessages(messages) {
  // Which call each tool result answers, for the functionResponse's name, and
  // its id when Gemini gave the call one.
  const calls = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) if (c.type === "tool_use") calls.set(c.id, c);
  }

  return messages.map(m => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      return { role, parts: [{ text: m.content }] };
    }
    const parts = [];
    for (const c of m.content) {
      // A part of Gemini's own reply goes back exactly as it came, signature
      // and all, and in the same order.
      if (role === "model" && c.gemini) {
        parts.push(c.gemini);
      } else if (c.type === "text") {
        parts.push({ text: c.text });
      } else if (c.type === "image") {
        parts.push({ inlineData: { mimeType: c.source.media_type, data: c.source.data } });
      } else if (c.type === "tool_use") {
        parts.push({ functionCall: { name: c.name, args: c.input } });
      } else if (c.type === "tool_result") {
        const content = Array.isArray(c.content)
          ? c.content.map(x => x.text ?? "").join("")
          : (c.content ?? "");
        const call = calls.get(c.tool_use_id);
        const name = call?.name ?? (c.tool_use_id.includes("__") ? c.tool_use_id.split("__")[0] : c.tool_use_id);
        const id = call?.gemini?.functionCall?.id;
        parts.push({ functionResponse: { ...(id ? { id } : {}), name, response: { result: content } } });
      }
    }
    return { role, parts };
  })
    // A reply that was cut off before it said anything (a model that spent its
    // whole output cap thinking) leaves a message with no parts, which Gemini
    // refuses as invalid; leaving it out loses nothing.
    .filter(m => m.parts.length > 0);
}

export function fromOpenAI(resp) {
  const msg = resp.choices?.[0]?.message;
  if (!msg) return { type: "message", content: [], stop_reason: "end_turn" };
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }
  return {
    type: "message",
    content,
    // "length": the output cap ran out, in Anthropic's words "max_tokens".
    stop_reason: { tool_calls: "tool_use", length: "max_tokens" }[resp.choices?.[0]?.finish_reason] ?? "end_turn",
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      // Of the prompt tokens, those OpenAI served from its cache; Ollama says nothing.
      ...cachedInput(resp.usage?.prompt_tokens_details?.cached_tokens),
    },
  };
}

export function fromGemini(resp) {
  const candidate = resp.candidates?.[0];
  if (!candidate) return { type: "message", content: [], stop_reason: "end_turn" };
  const content = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: geminiCallId(part.functionCall),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        gemini: part,
      });
    } else if (typeof part.text === "string" && part.text && !part.thought) {
      content.push({ type: "text", text: part.text, gemini: part });
    } else {
      content.push({ type: GEMINI_PART, gemini: part });
    }
  }
  return {
    type: "message",
    content,
    stop_reason: content.some(c => c.type === "tool_use") ? "tool_use"
      : candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
      // Thinking is billed as output, so the token budget counts it too.
      output_tokens: (resp.usageMetadata?.candidatesTokenCount ?? 0) + (resp.usageMetadata?.thoughtsTokenCount ?? 0),
      // Of the prompt tokens, those Gemini served from its cache, when it says.
      ...cachedInput(resp.usageMetadata?.cachedContentTokenCount),
    },
  };
}

// cached_input_tokens only when the provider reported it: a reply that says
// nothing about its cache is not a reply that used none.
function cachedInput(value) {
  return Number.isFinite(value) ? { cached_input_tokens: value } : {};
}

/**
 * A reply's tokens as the turn records keep them (src/agent/turnClock.js), or
 * null when the reply carried no usage: {in, out, cached}.
 *   in      every prompt token. Anthropic counts those it read from or wrote to
 *           its prompt cache apart from input_tokens; the others include them.
 *   out     the reply's, thinking included (fromGemini adds it; OpenAI's
 *           completion_tokens already has it).
 *   cached  the prompt tokens served from the provider's cache, where it says
 *           (null where it does not, as with Ollama).
 */
export function usageTokens(provider, usage) {
  if (!usage || typeof usage !== "object") return null;
  const n = v => (Number.isFinite(v) ? v : null);
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  if (provider === "anthropic") {
    const read = n(usage.cache_read_input_tokens);
    const written = n(usage.cache_creation_input_tokens);
    return { in: input == null ? null : input + (read ?? 0) + (written ?? 0), out: output, cached: read };
  }
  return { in: input, out: output, cached: n(usage.cached_input_tokens) };
}

/**
 * The log line for a reply that ran out of output tokens before the model
 * acted (Anthropic's stop_reason "max_tokens", OpenAI's finish_reason "length",
 * Gemini's MAX_TOKENS), or null. Such a turn does nothing, and without this the
 * log would not say why: a model that thinks by default can spend the whole cap
 * thinking. A reply that did call a tool is not reported.
 */
export function cutOffNote(provider, resp) {
  if (resp?.stop_reason !== "max_tokens") return null;
  if ((resp.content ?? []).some(c => c.type === "tool_use")) return null;
  const limit = MAX_OUTPUT_TOKENS[provider];
  return limit
    ? `⚠ The reply was cut off at the output cap (${limit.toLocaleString("en-US")} tokens) before the model acted, most likely spent thinking: this turn may do nothing.`
    : "⚠ The reply was cut off at the model's length limit before it acted: this turn may do nothing.";
}
