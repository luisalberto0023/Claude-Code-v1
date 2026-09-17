#!/usr/bin/env node
// Check how the page talks to model providers: which models it starts with, what
// each request looks like, and the model picker's listing and the check at Start.
//
//   node tools/check-llm.mjs
//
// Two of the four providers failed out of the box: the page started on a Gemini
// model shut down in November 2025, and the Anthropic default was retired in June
// 2026. The cloud requests were stale too: OpenAI was sent max_tokens, which
// GPT-5-era models refuse; the Gemini key went in the URL (?key=), where newer
// AI Studio keys do not belong; Gemini's thought signatures were dropped from the
// conversation, which Gemini 3 models refuse on the turn's function call; and
// Anthropic was never told the request comes from a browser. None of it showed
// until a session was under way. So this checks, with no provider called (every
// fetch here is a stand-in) and no key used:
//   - PROVIDERS names no retired model id, each default is in its own list, and
//     no source file under src/ names a retired id either
//   - OpenAI is sent max_completion_tokens and never max_tokens, and every cloud
//     cap leaves a model that thinks by default room to answer (thinking counts
//     toward it); a reply cut off at the cap before it acted is logged
//   - the OpenAI list leaves out chat models that cannot take a turn
//   - Gemini gets the key in x-goog-api-key, never in the URL, listing included
//   - Anthropic requests carry anthropic-dangerous-direct-browser-access: true,
//     and the key field says the key lives in the page
//   - a Gemini reply's parts, thought signatures included, go back exactly as
//     received and in order, and a function response carries its call's id
//   - model lists are read per provider, and the picker keeps its defaults first
//     and says which of them the key or server lacks
//   - the check at Start: an Ollama model must be pulled (relay or direct), a
//     cloud model gets one request for one token with no retry, and a failure
//     refuses to start in the provider's own words
// tools/check-agent.mjs checks the same request shapes as callAI really sends
// them, and that ▶ Start runs the check before a session begins.

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

const { PROVIDERS } = await load("src/llm/providers.js");
const req = await load("src/llm/requests.js");
const models = await load("src/llm/models.js");
const llmErrors = await load("src/agent/llmErrors.js");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = v => JSON.stringify(v);
const header = (init, name) => Object.entries(init?.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// ── Which models the page starts with ─────────────────────────────────────────
// Retired or shut down, per the providers' deprecation pages (checked
// 2026-09-17). A model the list must not offer for another reason is named
// with that reason.
const RETIRED = {
  anthropic: [
    "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20240620", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307",
    "claude-3-opus-20240229",
  ],
  gemini: ["gemini-2.5-flash-preview-05-20", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
  openai: [],
  ollama: [],
};
const NOT_OFFERED = { "gemma4:e2b": "7.2 GB, too big for the test PC's 6 GB GPU (gemma4:e2b-it-qat is 4.3 GB)" };

console.log("providers");
check("the four providers are there", same(Object.keys(PROVIDERS).sort(), ["anthropic", "gemini", "ollama", "openai"]), show(Object.keys(PROVIDERS)));
for (const [key, prov] of Object.entries(PROVIDERS)) {
  const ids = (prov.models ?? []).map(m => m.id);
  check(`${key}: the default model is in its own list, and the list has no repeats`,
    ids.includes(prov.defaultModel) && new Set(ids).size === ids.length, show({ default: prov.defaultModel, ids }));
  const stale = ids.filter(id => Object.values(RETIRED).flat().includes(id) || NOT_OFFERED[id]);
  check(`${key}: no retired model id is offered`, !stale.length, stale.map(id => `${id}${NOT_OFFERED[id] ? ` (${NOT_OFFERED[id]})` : ""}`).join(", "));
}
check("the defaults are models documented today (Anthropic Claude Sonnet 5, Gemini 3.8 Flash, OpenAI GPT-5.6 Luna)",
  PROVIDERS.anthropic.defaultModel === "claude-sonnet-5" && PROVIDERS.gemini.defaultModel === "gemini-3.8-flash" &&
    PROVIDERS.openai.defaultModel === "gpt-5.6-luna",
  show(Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.defaultModel]))));
check("Ollama keeps the model already pulled on the test PC as its default", PROVIDERS.ollama.defaultModel === "qwen2.5vl:3b",
  PROVIDERS.ollama.defaultModel);
check("gpt-4o is offered only as legacy",
  (PROVIDERS.openai.models.find(m => m.id === "gpt-4o")?.label ?? "(legacy)").includes("legacy"), show(PROVIDERS.openai.models));
check("Gemini's note keeps the free tier and drops the old 1500 requests a day",
  /free tier/i.test(PROVIDERS.gemini.notes) && !/1500|1,500/.test(PROVIDERS.gemini.notes), PROVIDERS.gemini.notes);
check("the Anthropic key field says the key lives in the page, and to use a dedicated key with a spend limit",
  /lives in this page/i.test(PROVIDERS.anthropic.keyNote ?? "") && /made only for this agent/i.test(PROVIDERS.anthropic.keyNote) &&
    /spend limit/i.test(PROVIDERS.anthropic.keyNote),
  show(PROVIDERS.anthropic.keyNote));

// Anywhere in src/, a retired id in quotes is a request waiting to fail.
{
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, "src"));
  const quoted = Object.values(RETIRED).flat().concat(Object.keys(NOT_OFFERED));
  const found = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const id of quoted) {
      if (new RegExp(`["'\`]${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(text)) found.push(`${path.relative(ROOT, file)}: ${id}`);
    }
  }
  check("no file under src/ names a retired model id", !found.length, found.join("; "));

  // Every provider request is built in src/llm/requests.js, so none of the
  // fixes below can be undone by a second copy in the page.
  const agent = fs.readFileSync(path.join(ROOT, "src", "GameAgent.jsx"), "utf8");
  const inline = ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com", "max_tokens", "?key=", "x-goog-api-key", "anthropic-version"]
    .filter(s => agent.includes(s));
  check("GameAgent.jsx builds no provider request itself (src/llm/requests.js does)", !inline.length, inline.join(", "));
}

// ── What each request looks like ──────────────────────────────────────────────
console.log("requests");
const KEY = "test-key-Abc123";
const convo = [{ role: "user", content: "hi" }];
const TOOL = { name: "press_key", description: "Press a key", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
{
  const a = req.anthropicRequest({ model: "claude-sonnet-5", system: "sys", messages: convo, tools: [TOOL], apiKey: KEY });
  const body = JSON.parse(a.init.body);
  check("Anthropic: POST /v1/messages with the key, the API version and anthropic-dangerous-direct-browser-access: true",
    a.url === "https://api.anthropic.com/v1/messages" && a.init.method === "POST" && header(a.init, "x-api-key") === KEY &&
      header(a.init, "anthropic-version") === "2023-06-01" && header(a.init, "anthropic-dangerous-direct-browser-access") === "true",
    show({ url: a.url, headers: a.init.headers }));
  check("Anthropic: max_tokens is the page's cap, or what the caller asks for",
    body.max_tokens === req.MAX_OUTPUT_TOKENS.anthropic && body.model === "claude-sonnet-5" && body.tools?.length === 1 &&
      JSON.parse(req.anthropicRequest({ model: "m", system: "s", messages: convo, apiKey: KEY, maxTokens: 1 }).init.body).max_tokens === 1,
    show(body));
  check("Anthropic: no temperature (Claude 4.7 and later refuse a non-default one)", !("temperature" in body) && !("top_p" in body), show(body));
  const listing = models.modelListRequest("anthropic", KEY);
  check("Anthropic's model list is asked with the same browser header",
    listing.url === "https://api.anthropic.com/v1/models?limit=1000" && header(listing.init, "anthropic-dangerous-direct-browser-access") === "true" &&
      header(listing.init, "x-api-key") === KEY && !header(listing.init, "content-type"),
    show(listing));
}
{
  const o = req.openaiRequest({ model: "gpt-5.6-luna", system: "sys", messages: convo, tools: [TOOL], apiKey: KEY });
  const body = JSON.parse(o.init.body);
  check("OpenAI: max_completion_tokens, never max_tokens",
    body.max_completion_tokens === req.MAX_OUTPUT_TOKENS.openai && !("max_tokens" in body) &&
      JSON.parse(req.openaiRequest({ model: "m", system: "s", messages: convo, apiKey: KEY, maxTokens: 1 }).init.body).max_completion_tokens === 1,
    show(body));
  check("OpenAI: the key as a bearer token, the system prompt first, tools as functions",
    o.url === "https://api.openai.com/v1/chat/completions" && header(o.init, "authorization") === `Bearer ${KEY}` &&
      body.messages[0]?.role === "system" && body.tools?.[0]?.function?.name === "press_key",
    show({ url: o.url, body }));
  // Thinking counts toward the cap, and every provider's default thinks without
  // being asked (Claude Sonnet 5 and Opus 5 included), so a 4096 cap could end a
  // turn before it acts.
  check("every cloud cap leaves a thinking model room to think and still answer (Anthropic, OpenAI, Gemini)",
    req.MAX_OUTPUT_TOKENS.anthropic >= 16000 && req.MAX_OUTPUT_TOKENS.openai >= 16000 && req.MAX_OUTPUT_TOKENS.gemini >= 16000 &&
      // Claude Haiku 4.5, the smallest default, allows 64K output.
      Object.values(req.MAX_OUTPUT_TOKENS).every(n => n <= 64000),
    show(req.MAX_OUTPUT_TOKENS));
  const listing = models.modelListRequest("openai", KEY);
  check("OpenAI's model list is GET /v1/models with the bearer token",
    listing.url === "https://api.openai.com/v1/models" && header(listing.init, "authorization") === `Bearer ${KEY}`, show(listing));
}
{
  const g = req.geminiRequest({ model: "gemini-3.8-flash", system: "sys", messages: convo, tools: [TOOL], apiKey: KEY });
  const body = JSON.parse(g.init.body);
  check("Gemini: the key in x-goog-api-key, and nowhere in the URL",
    header(g.init, "x-goog-api-key") === KEY && !g.url.includes(KEY) && !/[?&]key=/i.test(g.url) && !g.url.includes("?"),
    show({ url: g.url, headers: g.init.headers }));
  check("Gemini: POST models/<id>:generateContent, with maxOutputTokens",
    g.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent" &&
      body.generationConfig?.maxOutputTokens === req.MAX_OUTPUT_TOKENS.gemini &&
      JSON.parse(req.geminiRequest({ model: "m", system: "s", messages: convo, apiKey: KEY, maxTokens: 1 }).init.body).generationConfig.maxOutputTokens === 1,
    show({ url: g.url, generationConfig: body.generationConfig }));
  check("Gemini: an id typed with models/ in front, or with URL characters in it, stays one path segment",
    req.geminiRequest({ model: "models/gemini-3.8-flash", system: "s", messages: convo, apiKey: KEY }).url === g.url &&
      req.geminiRequest({ model: "x?key=1#y", system: "s", messages: convo, apiKey: KEY }).url.endsWith("/models/x%3Fkey%3D1%23y:generateContent"),
    "");
  const listing = models.modelListRequest("gemini", KEY);
  check("Gemini's model list has the key in the header, not the URL",
    header(listing.init, "x-goog-api-key") === KEY && !listing.url.includes(KEY) && !/[?&]key=/i.test(listing.url), show(listing));
}
{
  const body = req.ollamaChatBody({ model: "qwen2.5vl:3b", system: "sys", messages: convo, tools: [] });
  check("Ollama's chat body is as before: no stream, temperature 0.25, no token cap",
    body.stream === false && body.temperature === 0.25 && body.top_p === 0.9 && !("max_tokens" in body) && body.tools === undefined,
    show(body));
}

// ── Gemini thought signatures ─────────────────────────────────────────────────
// Gemini 3 refuses (HTTP 400) a turn's function call sent back without its
// thoughtSignature, and asks for every part to go back exactly as it came. The
// page keeps its conversation in Anthropic's format, so each part rides along
// on the block made from it.
console.log("gemini thought signatures");
{
  const parts = [
    { text: "", thoughtSignature: "sig-empty" },
    { text: "Moving up, then left.", thoughtSignature: "sig-text" },
    { functionCall: { id: "call-1", name: "press_key", args: { key: "up" } }, thoughtSignature: "sig-call" },
    { functionCall: { name: "press_key", args: { key: "left" } } },
  ];
  const reply = req.fromGemini({
    candidates: [{ content: { role: "model", parts: structuredClone(parts) }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
  });
  const uses = reply.content.filter(c => c.type === "tool_use");
  check("fromGemini: text and both calls come through, as the page reads them",
    reply.stop_reason === "tool_use" && uses.length === 2 && uses.every(u => u.name === "press_key" && u.id.startsWith("press_key__")) &&
      same(uses.map(u => u.input), [{ key: "up" }, { key: "left" }]) &&
      reply.content.filter(c => c.type === "text").map(c => c.text).join("") === "Moving up, then left.",
    show(reply.content));
  check("fromGemini: thinking is counted as output, since it is billed as output",
    reply.usage.input_tokens === 100 && reply.usage.output_tokens === 50, show(reply.usage));

  // As the page stores it: pushed into the conversation and later copied, so
  // only data survives (the JSON round trip proves nothing rides on identity).
  const conversation = JSON.parse(JSON.stringify([
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }, { type: "text", text: "Turn 1." }] },
    { role: "assistant", content: reply.content },
    { role: "user", content: uses.map(u => ({ type: "tool_result", tool_use_id: u.id, content: [{ type: "text", text: `pressed ${u.input.key}` }] })) },
  ]));
  const contents = req.toGeminiMessages(conversation);
  check("toGeminiMessages: the model's parts go back exactly as received, signatures and order included",
    contents.length === 3 && contents[1].role === "model" && same(contents[1].parts, parts), show(contents[1]));
  check("toGeminiMessages: each function response names its call, and carries the call's id when Gemini gave one",
    same(contents[2].parts, [
      { functionResponse: { id: "call-1", name: "press_key", response: { result: "pressed up" } } },
      { functionResponse: { name: "press_key", response: { result: "pressed left" } } },
    ]), show(contents[2]));
  const sent = req.geminiRequest({ model: "gemini-3.8-flash", system: "s", messages: conversation, apiKey: KEY }).init.body;
  check("the request body sends every signature", ["sig-empty", "sig-text", "sig-call"].every(s => sent.includes(`"thoughtSignature":"${s}"`)), "");

  // The window trimmed the call away: the response still names the function.
  const trimmed = req.toGeminiMessages([conversation[2]]);
  check("a function response whose call was trimmed from the window still names the function",
    same(trimmed[0].parts.map(p => p.functionResponse?.name), ["press_key", "press_key"]) && !trimmed[0].parts.some(p => "id" in p.functionResponse),
    show(trimmed));

  // A conversation built by the page itself (no Gemini parts) converts as before.
  const plain = req.toGeminiMessages([
    { role: "assistant", content: [{ type: "text", text: "go" }, { type: "tool_use", id: "press_key__abc", name: "press_key", input: { key: "up" } }] },
  ]);
  check("blocks with no Gemini part convert as before",
    same(plain, [{ role: "model", parts: [{ text: "go" }, { functionCall: { name: "press_key", args: { key: "up" } } }] }]), show(plain));

  // A reply cut off before it said anything leaves no parts at all, which
  // Gemini refuses as an empty message.
  const cut = req.fromGemini({ candidates: [{ content: { role: "model" }, finishReason: "MAX_TOKENS" }] });
  const withCut = req.toGeminiMessages([{ role: "user", content: "hi" }, { role: "assistant", content: cut.content }, { role: "user", content: "again" }]);
  check("a reply cut off with no parts is left out of what is sent back",
    same(cut.content, []) && withCut.length === 2 && withCut.every(m => m.parts.length > 0), show(withCut));
}

// ── A reply cut off at the output cap ─────────────────────────────────────────
// A model that thinks by default can spend the whole cap thinking and stop
// before it calls a tool. The turn then does nothing, so the log says why.
console.log("replies cut off at the cap");
{
  const geminiCut = req.fromGemini({ candidates: [{ content: { role: "model", parts: [{ text: "", thoughtSignature: "s" }] }, finishReason: "MAX_TOKENS" }] });
  const geminiCalled = req.fromGemini({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "press_key", args: {} } }] }, finishReason: "MAX_TOKENS" }] });
  const geminiDone = req.fromGemini({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
  const openaiCut = req.fromOpenAI({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
  const openaiCalled = req.fromOpenAI({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "press_key", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
  const openaiDone = req.fromOpenAI({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  check("Gemini's MAX_TOKENS and OpenAI's length read as Anthropic's max_tokens; a call or a finished reply does not",
    geminiCut.stop_reason === "max_tokens" && geminiCalled.stop_reason === "tool_use" && geminiDone.stop_reason === "end_turn" &&
      openaiCut.stop_reason === "max_tokens" && openaiCalled.stop_reason === "tool_use" && openaiDone.stop_reason === "end_turn",
    show([geminiCut, geminiCalled, geminiDone, openaiCut, openaiCalled, openaiDone].map(r => r.stop_reason)));

  const anthropicCut = { content: [{ type: "thinking", thinking: "", signature: "x" }], stop_reason: "max_tokens" };
  const note = req.cutOffNote("anthropic", anthropicCut);
  check("a reply cut off before it acted is logged with the cap it hit, for every provider",
    typeof note === "string" && note.includes("16,384 tokens") && note.includes("may do nothing") &&
      req.cutOffNote("gemini", geminiCut)?.includes("output cap") && req.cutOffNote("openai", openaiCut)?.includes("output cap") &&
      req.cutOffNote("ollama", openaiCut)?.includes("length limit"),
    show(note));
  check("but not a reply that called a tool, or one that finished",
    req.cutOffNote("gemini", geminiCalled) === null && req.cutOffNote("openai", openaiDone) === null &&
      req.cutOffNote("anthropic", { content: [{ type: "tool_use", id: "t", name: "press_key", input: {} }], stop_reason: "max_tokens" }) === null &&
      req.cutOffNote("anthropic", { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }) === null && req.cutOffNote("anthropic", null) === null,
    "");
}

// ── Model lists ───────────────────────────────────────────────────────────────
console.log("model lists");
{
  const anthropic = models.readModelList("anthropic", { data: [
    { id: "claude-opus-5", display_name: "Claude Opus 5", capabilities: { image_input: { supported: true } } },
    { id: "claude-text-only", display_name: "Text only", capabilities: { image_input: { supported: false } } },
    { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", capabilities: null },
  ] });
  check("Anthropic: listed models that can see images, named",
    same(anthropic.map(m => m.id), ["claude-opus-5", "claude-haiku-4-5-20251001"]) && anthropic[0].label.includes("Claude Opus 5"), show(anthropic));
  const openai = models.readModelList("openai", { data: [
    "gpt-5.6-luna", "gpt-5.6-terra", "gpt-4o", "gpt-image-2.5-flare", "gpt-4o-mini-tts", "gpt-realtime-2.1", "text-embedding-3-large",
    "whisper-1", "dall-e-3", "o3", "gpt-live-1",
    // Still served, but text only or capped at 4,096 output tokens.
    "gpt-3.5-turbo", "gpt-3.5-turbo-0125", "gpt-4", "gpt-4-0613", "gpt-4-turbo", "gpt-4-turbo-2024-04-09", "chatgpt-4o-latest",
    "gpt-4.1", "gpt-4o-mini",
  ].map(id => ({ id, object: "model" })) });
  check("OpenAI: chat models only, no speech, image, embedding or realtime ones",
    same(openai.map(m => m.id), ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-4o", "o3", "gpt-4.1", "gpt-4o-mini"]), show(openai.map(m => m.id)));
  check("OpenAI: not the chat models that cannot take a turn (gpt-3.5, gpt-4, gpt-4-turbo, chatgpt-*), but gpt-4o and gpt-4.1 stay",
    !openai.some(m => /^(gpt-3\.5|gpt-4(-|$)|chatgpt-)/.test(m.id)) && openai.some(m => m.id === "gpt-4.1"), show(openai.map(m => m.id)));
  const gemini = models.readModelList("gemini", { models: [
    { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.1-flash-tts-preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.1-flash-image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-2.5-flash-native-audio-preview-12-2025", supportedGenerationMethods: ["generateContent"] },
  ] });
  check("Gemini: generateContent models, without models/ or speech and image makers",
    same(gemini.map(m => m.id), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]) && gemini[0].label.startsWith("Gemini 3.8 Flash"),
    show(gemini));
  const relayTags = models.readModelList("ollama", { ok: true, base: "http://h:11434", models: [{ name: "qwen2.5vl:3b", size: 3200000000, parameterSize: "3.8B" }, { name: "moondream:latest" }] });
  const directTags = models.readModelList("ollama", { models: [{ name: "gemma3:4b", size: 3300000000, details: { parameter_size: "4.3B" } }] });
  check("Ollama: the relay's list and Ollama's own /api/tags both read, marked as pulled",
    same(relayTags.map(m => m.id), ["qwen2.5vl:3b", "moondream:latest"]) && relayTags[0].label === "qwen2.5vl:3b (3.8B, 3.2GB, pulled)" &&
      directTags[0].label === "gemma3:4b (4.3B, 3.3GB, pulled)",
    show([relayTags, directTags]));

  check("the same model under Ollama's :latest, Gemini's models/ and letter case where Ollama ignores it",
    models.sameModel("ollama", "moondream", "moondream:latest") && models.sameModel("ollama", "Qwen2.5VL:3b", "qwen2.5vl:3b") &&
      !models.sameModel("ollama", "qwen2.5vl:3b", "qwen2.5vl:7b") && models.sameModel("gemini", "models/gemini-3.8-flash", "gemini-3.8-flash") &&
      !models.sameModel("anthropic", "claude-opus-5", "Claude-Opus-5") && !models.sameModel("openai", "", ""),
    "");

  const defaults = PROVIDERS.gemini.models.map(m => m.id);
  check("the picker offers the defaults until a list comes back", same(models.modelChoices("gemini", null).map(m => m.id), defaults), "");
  const choices = models.modelChoices("gemini", [{ id: "gemini-3.8-flash", label: "x" }, { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash · gemini-3.7-flash" }]);
  check("then the defaults first, marked when the key lacks one, and the rest of the list after them, once each",
    same(choices.map(m => m.id), [...defaults, "gemini-3.7-flash"]) && !choices[0].label.includes("not offered") &&
      choices[1].label.endsWith("— not offered to this key"),
    show(choices));
  const pulled = models.modelChoices("ollama", [{ id: "qwen2.5vl:3b", label: "qwen2.5vl:3b (pulled)" }, { id: "llava:13b", label: "llava:13b (pulled)" }]);
  check("for Ollama, a default not pulled says so, and a pulled model the defaults lack is added",
    pulled[0].id === "qwen2.5vl:3b" && !pulled[0].label.includes("not pulled") && pulled.find(m => m.id === "qwen3-vl:4b")?.label.endsWith("not pulled on that server") &&
      pulled.at(-1).id === "llava:13b",
    show(pulled.map(m => m.label)));

  check("the line under the picker says what came back",
    models.modelListMessage("gemini", { ok: true, models: gemini }).text.includes("offers this key 2 models") &&
      models.modelListMessage("ollama", { ok: true, models: [] }).text.includes("ollama pull") &&
      models.modelListMessage("openai", { ok: false, error: "OpenAI did not accept the API key (HTTP 401): bad key. Check the key." }).text
        .startsWith("Could not list OpenAI's models: OpenAI did not accept"),
    "");
}

// Listing through stand-ins: fetch for the providers, backend() for the relay.
{
  const recorder = (respond) => {
    const calls = [];
    const fn = async (url, init = {}) => { calls.push({ url, init }); return respond(url, init); };
    return { calls, fn };
  };
  const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const noBackend = async () => { throw new Error("backend() was asked, but should not have been"); };

  const gem = recorder(() => jsonResponse(200, { models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }));
  const listed = await models.listModels("gemini", { apiKey: KEY, fetch: gem.fn, backend: noBackend });
  check("listModels(gemini): one GET with the key in the header, and the models read from it",
    listed.ok && same(listed.models.map(m => m.id), ["gemini-3.8-flash"]) && gem.calls.length === 1 && !gem.calls[0].url.includes(KEY) &&
      header(gem.calls[0].init, "x-goog-api-key") === KEY && gem.calls[0].init.signal,
    show({ listed, calls: gem.calls.map(c => c.url) }));

  const refused = recorder(() => jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  const bad = await models.listModels("anthropic", { apiKey: "wrong", fetch: refused.fn, backend: noBackend });
  check("listModels: a refused key says so in the provider's words",
    !bad.ok && bad.error.includes("invalid x-api-key") && bad.error.includes("did not accept the API key"), show(bad));

  const offline = recorder(() => Promise.reject(new TypeError("Failed to fetch")));
  const down = await models.listModels("openai", { apiKey: KEY, fetch: offline.fn, backend: noBackend });
  check("listModels: no answer at all says so", !down.ok && down.error.includes("no answer from OpenAI") && down.error.includes("Failed to fetch"), show(down));

  const hang = recorder((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })));
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 20);
  const t0 = Date.now();
  const cancelled = await models.listModels("openai", { apiKey: KEY, fetch: hang.fn, backend: noBackend, signal: cancel.signal });
  check("listModels: a listing replaced by a newer one ends at once, marked stopped",
    !cancelled.ok && cancelled.stopped === true && Date.now() - t0 < 1000, show(cancelled));

  const asked = [];
  const relayBackend = async (p, body, opts) => {
    asked.push({ p, body, signal: !!opts?.signal });
    return { ok: true, base: "http://192.168.1.50:11434", elapsed: 0.1, models: [{ name: "qwen2.5vl:3b" }, { name: "gemma3:4b" }] };
  };
  const noFetch = async () => { throw new Error("fetch was used, but the relay should have been"); };
  const viaRelay = await models.listModels("ollama", { relay: true, base: "http://ignored:11434", backend: relayBackend, fetch: noFetch });
  check("listModels(ollama, relay): asks the backend's GET /llm/ollama/tags, names no server, and reads its list",
    viaRelay.ok && same(viaRelay.models.map(m => m.id), ["qwen2.5vl:3b", "gemma3:4b"]) && same(asked, [{ p: "/llm/ollama/tags", body: null, signal: true }]) &&
      viaRelay.base === "http://192.168.1.50:11434",
    show({ viaRelay, asked }));

  const direct = recorder(() => jsonResponse(200, { models: [{ name: "moondream:latest", size: 1700000000, details: { parameter_size: "1.9B" } }] }));
  const viaBrowser = await models.listModels("ollama", { relay: false, base: "http://192.168.1.50:11434/", fetch: direct.fn, backend: noBackend });
  check("listModels(ollama, relay off): the browser asks the OLLAMA SERVER field's /api/tags",
    viaBrowser.ok && viaBrowser.models[0]?.id === "moondream:latest" && direct.calls[0]?.url === "http://192.168.1.50:11434/api/tags",
    show({ viaBrowser, urls: direct.calls.map(c => c.url) }));

  const locked = await models.listModels("ollama", { relay: true, fetch: noFetch,
    backend: async () => ({ ok: false, error: "The backend refused this page's token", detail: "wrong token", refused: "token" }) });
  check("listModels(ollama): a backend that refuses the page is marked refused (backend() has said so already)",
    !locked.ok && locked.refused === "token", show(locked));
  const older = await models.listModels("ollama", { relay: true, fetch: noFetch, backend: async () => ({ detail: "Not Found" }) });
  check("listModels(ollama): a backend older than the tags route says to restart it",
    !older.ok && older.error.includes("restart start.bat"), show(older));
}

// ── The check at Start ────────────────────────────────────────────────────────
console.log("model check at Start");
{
  const verdictOf = (status, message, provider) => llmErrors.classifyLlmError(llmErrors.httpError(status, message), provider);

  check("an empty or spaced model id is refused before anything is asked",
    models.modelIdProblem("") && models.modelIdProblem("   ") && models.modelIdProblem("gpt 5") && models.modelIdProblem(null) &&
      models.modelIdProblem("gemini-3.8-flash") === null,
    "");

  const ok = models.cloudCheckMessage("gemini", "gemini-3.8-flash", null);
  const auth = models.cloudCheckMessage("anthropic", "claude-sonnet-5", verdictOf(401, "invalid x-api-key", "anthropic"));
  const gone = models.cloudCheckMessage("gemini", "gemini-2.0-flash", verdictOf(404, "models/gemini-2.0-flash is not found for API version v1beta", "gemini"));
  const busy = models.cloudCheckMessage("gemini", "gemini-3.8-flash", verdictOf(429, "Resource has been exhausted", "gemini"));
  check("a cloud check that answered starts; a refused key or retired model does not, in the provider's words",
    ok.ok && ok.type === "success" &&
      !auth.ok && auth.type === "error" && auth.text.startsWith("Not started:") && auth.text.includes("invalid x-api-key") && !auth.text.includes("may clear up") &&
      !gone.ok && gone.text.includes("is not found for API version") && gone.text.includes("retired"),
    show({ ok, auth, gone }));
  check("a check that may clear up (rate limit, server error) does not start either, and says to try again",
    !busy.ok && busy.text.includes("Resource has been exhausted") && busy.text.includes("press ▶ Start again"), show(busy));
  const tooShort = models.cloudCheckMessage("openai", "gpt-5.6-luna",
    verdictOf(400, "Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.", "openai"));
  const oldParam = models.cloudCheckMessage("openai", "gpt-5.6-luna",
    verdictOf(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "openai"));
  check("a provider that refuses only the one-token length accepted the key and model, so the session starts, saying so",
    tooShort.ok && tooShort.type === "warn" && tooShort.text.includes("would not give a one-token reply"), show(tooShort));
  check("but a refusal of max_tokens itself is a real fault, and does not start", !oldParam.ok && oldParam.text.includes("Unsupported parameter"), show(oldParam));

  const tags = { ok: true, base: "http://192.168.1.50:11434", models: [{ name: "qwen2.5vl:3b" }, { name: "moondream:latest" }] };
  const have = models.ollamaCheckMessage("moondream", tags);
  const lack = models.ollamaCheckMessage("qwen3-vl:4b", tags);
  const noServer = models.ollamaCheckMessage("qwen2.5vl:3b", { ok: false, base: "http://192.168.1.50:11434", status: 0, error: "URLError: refused" });
  const unusable = models.ollamaCheckMessage("qwen2.5vl:3b", { ok: false, detail: "ollamaBase in agent-config.json is not a usable Ollama address" });
  check("Ollama: a pulled model starts; one not pulled does not, and names what the server has",
    have.ok && !lack.ok && lack.text.includes("ollama pull qwen3-vl:4b") && lack.text.includes("qwen2.5vl:3b, moondream:latest") &&
      lack.text.includes("http://192.168.1.50:11434"),
    show({ have, lack }));
  check("Ollama: a server that does not answer, or a relay with no usable server, does not start, saying why",
    !noServer.ok && noServer.text.includes("URLError: refused") && !unusable.ok && unusable.text.includes("not a usable Ollama address"),
    show({ noServer, unusable }));

  // checkModel, with callAI and backend() as stand-ins.
  const aiCalls = [];
  const answering = async (...args) => { aiCalls.push(args); return { content: [], usage: {} }; };
  const passed = await models.checkModel("openai", "gpt-5.6-luna", { apiKey: KEY, callAI: answering, backend: async () => { throw new Error("no"); } });
  const [provider, model, system, messages, tools, key, onRetry, opts] = aiCalls[0] ?? [];
  check("checkModel(cloud): one callAI request, for one token, with no tools and no retry, under a deadline",
    passed.ok && aiCalls.length === 1 && provider === "openai" && model === "gpt-5.6-luna" && key === KEY && same(tools, []) &&
      messages.length === 1 && typeof system === "string" && onRetry === null &&
      opts.maxTokens === models.CHECK_MAX_TOKENS && models.CHECK_MAX_TOKENS === 1 && opts.retry === false &&
      opts.timeoutMs === models.CHECK_TIMEOUT_MS && "signal" in opts,
    show({ passed, args: aiCalls[0]?.map(a => (typeof a === "string" && a === KEY ? "(key)" : a)) }));

  const refusing = async () => {
    const err = llmErrors.httpError(404, "The model `gpt-9` does not exist");
    err.verdict = llmErrors.classifyLlmError(err, "openai");
    throw err;
  };
  const failed = await models.checkModel("openai", "gpt-9", { apiKey: KEY, callAI: refusing });
  const unclassified = await models.checkModel("anthropic", "claude-x", { apiKey: KEY, callAI: async () => { throw llmErrors.httpError(401, "invalid x-api-key"); } });
  check("checkModel(cloud): a refusal does not start, in the provider's words, whether or not callAI classified it",
    !failed.ok && failed.text.includes("does not exist") && !unclassified.ok && unclassified.text.includes("did not accept the API key"),
    show({ failed, unclassified }));

  let asked = 0;
  const nothing = await models.checkModel("gemini", "  ", { apiKey: KEY, callAI: async () => { asked++; } });
  check("checkModel: no model id asks nobody", !nothing.ok && asked === 0 && nothing.text.includes("no model is chosen"), show(nothing));

  const relayAsked = [];
  const ollamaOk = await models.checkModel("ollama", "qwen2.5vl:3b", {
    relay: true, callAI: async () => { throw new Error("callAI should not be used for Ollama's check"); },
    backend: async (p) => { relayAsked.push(p); return tags; },
  });
  check("checkModel(ollama, relay): asks the relay's tags, spends no model request, and starts when the model is pulled",
    ollamaOk.ok && same(relayAsked, ["/llm/ollama/tags"]), show({ ollamaOk, relayAsked }));

  const directAsked = [];
  const ollamaMissing = await models.checkModel("ollama", "qwen3-vl:4b", {
    relay: false, base: "http://localhost:11434",
    callAI: async () => { throw new Error("no"); }, backend: async () => { throw new Error("no"); },
    fetch: async (url) => { directAsked.push(url); return new Response(JSON.stringify({ models: [{ name: "qwen2.5vl:3b" }] }), { status: 200 }); },
  });
  check("checkModel(ollama, relay off): asks Ollama's own /api/tags, and does not start when the model is not pulled",
    !ollamaMissing.ok && ollamaMissing.text.includes("does not have qwen3-vl:4b") && same(directAsked, ["http://localhost:11434/api/tags"]),
    show({ ollamaMissing, directAsked }));
}

if (failures) {
  console.error(`\n${failures} model-provider check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("\nall model-provider checks passed");
