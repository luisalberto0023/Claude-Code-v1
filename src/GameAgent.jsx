import { useState, useEffect, useRef, useCallback } from "react";

// ── Safe env access (works in Vite AND artifact sandbox) ──────────────────────
const _runtimeKeys = {};
function getEnv(key) {
  try { const v = import.meta?.env?.[key]; if (v && !v.includes("your-key")) return v; } catch {}
  return _runtimeKeys[key] ?? "";
}
function setRuntimeKey(k, v) { _runtimeKeys[k] = v; }

// ── Backend proxy ─────────────────────────────────────────────────────────────
async function backend(path, body = null) {
  try {
    const res = await fetch(`/api${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Providers ─────────────────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: {
    label: "Anthropic", icon: "🟠", free: false,
    notes: "Best reasoning & vision. Requires API key.",
    envKey: "VITE_ANTHROPIC_API_KEY",
    baseURL: "https://api.anthropic.com/v1/messages",
    supportsSearch: true,
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4 (recommended)" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
    ],
  },
  openai: {
    label: "OpenAI", icon: "🟢", free: false,
    notes: "$5 free credit on signup. Good vision.",
    envKey: "VITE_OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1/chat/completions",
    supportsSearch: false,
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o", label: "GPT-4o (best vision)" },
      { id: "gpt-4o-mini", label: "GPT-4o mini (cheaper)" },
    ],
  },
  gemini: {
    label: "Google Gemini", icon: "🔵", free: true,
    notes: "Free tier: 1500 req/day. Best free option.",
    envKey: "VITE_GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/models",
    supportsSearch: true,
    defaultModel: "gemini-2.5-flash-preview-05-20",
    models: [
      { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash (free ✓)" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (free ✓)" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash (free ✓)" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    ],
  },
  ollama: {
    label: "Ollama (local)", icon: "🖥️", free: true,
    notes: "100% free, runs locally. Needs Ollama + vision model.",
    envKey: null,
    baseURL: "http://localhost:11434/v1/chat/completions",
    supportsSearch: false,
    defaultModel: "llava",
    models: [
      { id: "llava", label: "LLaVA (recommended)" },
      { id: "qwen2-vl", label: "Qwen2-VL (better quality)" },
      { id: "minicpm-v", label: "MiniCPM-V (lightweight)" },
    ],
  },
};

// ── Format converters ─────────────────────────────────────────────────────────

function toOpenAITools(tools) {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  }];
}

function toOpenAIMessages(messages) {
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

function toGeminiMessages(messages) {
  return messages.map(m => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      return { role, parts: [{ text: m.content }] };
    }
    const parts = [];
    for (const c of m.content) {
      if (c.type === "text") {
        parts.push({ text: c.text });
      } else if (c.type === "image") {
        parts.push({ inlineData: { mimeType: c.source.media_type, data: c.source.data } });
      } else if (c.type === "tool_use") {
        parts.push({ functionCall: { name: c.name, args: c.input } });
      } else if (c.type === "tool_result") {
        const content = Array.isArray(c.content)
          ? c.content.map(x => x.text ?? "").join("")
          : (c.content ?? "");
        // id encodes the function name as "name__rand"
        const fcName = c.tool_use_id.includes("__") ? c.tool_use_id.split("__")[0] : c.tool_use_id;
        parts.push({ functionResponse: { name: fcName, response: { result: content } } });
      }
    }
    return { role, parts };
  });
}

function fromOpenAI(resp) {
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
    stop_reason: resp.choices?.[0]?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

function fromGemini(resp) {
  const candidate = resp.candidates?.[0];
  if (!candidate) return { type: "message", content: [], stop_reason: "end_turn" };
  const content = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.text) content.push({ type: "text", text: part.text });
    if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: `${part.functionCall.name}__${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  return {
    type: "message",
    content,
    stop_reason: content.some(c => c.type === "tool_use") ? "tool_use" : "end_turn",
    usage: {
      input_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// ── callAI — unified caller with 429-aware retry ──────────────────────────────
const RETRY_429 = [15000, 30000, 62000];
const RETRY_ERR = [2000, 4000, 8000];

async function callAI(providerKey, model, systemPrompt, messages, tools, apiKey, onRetry) {
  const prov = PROVIDERS[providerKey];

  const doCall = async () => {
    if (providerKey === "anthropic") {
      const body = {
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: tools.length ? tools : undefined,
      };
      const res = await fetch(prov.baseURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const error = new Error(err.error?.message ?? `HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    }

    if (providerKey === "openai") {
      const body = {
        model,
        messages: [{ role: "system", content: systemPrompt }, ...toOpenAIMessages(messages)],
        tools: tools.length ? toOpenAITools(tools) : undefined,
        max_tokens: 4096,
      };
      const res = await fetch(prov.baseURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const error = new Error(err.error?.message ?? `HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return fromOpenAI(await res.json());
    }

    if (providerKey === "gemini") {
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiMessages(messages),
        tools: tools.length ? toGeminiTools(tools) : undefined,
        generationConfig: { maxOutputTokens: 4096 },
      };
      const url = `${prov.baseURL}/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const error = new Error(err.error?.message ?? `HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return fromGemini(await res.json());
    }

    if (providerKey === "ollama") {
      const body = {
        model,
        messages: [{ role: "system", content: systemPrompt }, ...toOpenAIMessages(messages)],
        tools: tools.length ? toOpenAITools(tools) : undefined,
        stream: false,
      };
      const res = await fetch(prov.baseURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return fromOpenAI(await res.json());
    }

    throw new Error(`Unknown provider: ${providerKey}`);
  };

  let errAttempts = 0;
  const rateLimits = [...RETRY_429];

  for (;;) {
    try {
      return await doCall();
    } catch (err) {
      if (err.status === 429 && rateLimits.length > 0) {
        const delay = rateLimits.shift();
        onRetry?.(`Rate limited — waiting ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else if (err.status !== 429 && errAttempts < RETRY_ERR.length) {
        const delay = RETRY_ERR[errAttempts++];
        onRetry?.(`Error: ${err.message} — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ── Screen capture ─────────────────────────────────────────────────────────────
const MAX_FRAME_W = 1280;

function captureFrame(videoEl, canvasEl, scaleRef) {
  if (!videoEl || !canvasEl || videoEl.readyState < 2) return null;
  const realW = videoEl.videoWidth;
  const realH = videoEl.videoHeight;
  if (!realW || !realH) return null;

  let imgW = realW, imgH = realH;
  if (imgW > MAX_FRAME_W) {
    imgH = Math.round(imgH * MAX_FRAME_W / imgW);
    imgW = MAX_FRAME_W;
  }

  canvasEl.width = imgW;
  canvasEl.height = imgH;
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, imgW, imgH);
  scaleRef.current = { imgW, imgH, realW, realH, scale: realW / imgW };

  return {
    data: canvasEl.toDataURL("image/jpeg", 0.85).split(",")[1],
    imgW, imgH, realW, realH,
  };
}

// ── Perceptual hash (8×8 grid) ────────────────────────────────────────────────
function frameHash(canvasEl) {
  if (!canvasEl || !canvasEl.width) return new Float32Array(64);
  const ctx = canvasEl.getContext("2d");
  const w = canvasEl.width, h = canvasEl.height;
  const cellW = Math.max(1, Math.floor(w / 8));
  const cellH = Math.max(1, Math.floor(h / 8));
  const hash = new Float32Array(64);
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const data = ctx.getImageData(gx * cellW, gy * cellH, cellW, cellH).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      hash[gy * 8 + gx] = data.length > 0 ? sum / (data.length / 4) : 0;
    }
  }
  return hash;
}

function hashDist(a, b) {
  if (!a || !b) return 0;
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / 64);
}

// ── Wait for screen change ────────────────────────────────────────────────────
async function waitChange(videoEl, canvasEl, scaleRef, maxMs = 2000, threshold = 4.0) {
  const t0 = Date.now();
  captureFrame(videoEl, canvasEl, scaleRef);
  const baseline = frameHash(canvasEl);
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 150));
    captureFrame(videoEl, canvasEl, scaleRef);
    const dist = hashDist(baseline, frameHash(canvasEl));
    if (dist > threshold) return { changed: true, dist, elapsed: Date.now() - t0 };
  }
  return { changed: false, dist: 0, elapsed: maxMs };
}

// ── Conversation window management ────────────────────────────────────────────
const WINDOW_TURNS = 20;
const CHECKPOINT_EVERY = 15;
const MAX_IMAGES = 3;

function pruneImages(messages) {
  const imageIndices = [];
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some(c => c.type === "image")) {
      imageIndices.push(i);
    }
  });
  const keepFrom = imageIndices.length > MAX_IMAGES
    ? imageIndices[imageIndices.length - MAX_IMAGES]
    : 0;

  return messages.map((m, i) => {
    if (!Array.isArray(m.content)) return m;
    if (!m.content.some(c => c.type === "image")) return m;
    if (i >= keepFrom) return m;
    return { ...m, content: m.content.filter(c => c.type !== "image") };
  });
}

function pruneConv(messages, checkpoint) {
  let pruned = pruneImages(messages);
  if (pruned.length > WINDOW_TURNS * 2) {
    pruned = pruned.slice(-(WINDOW_TURNS * 2));
  }
  if (checkpoint) {
    const already = pruned[0]?.content === checkpoint.content;
    if (!already) pruned = [checkpoint, ...pruned];
  }
  return pruned;
}

async function buildChkRequest(providerKey, model, systemPrompt, messages, apiKey, onRetry) {
  try {
    const resp = await callAI(
      providerKey, model, systemPrompt,
      [
        ...pruneImages(messages).slice(-10),
        { role: "user", content: "Summarize this game session in 3-5 bullet points: current state, score, strategies in use, key learnings. Label it [CHECKPOINT]." },
      ],
      [], apiKey, onRetry
    );
    const text = resp.content?.find(c => c.type === "text")?.text ?? "";
    return text ? { role: "user", content: `[CHECKPOINT] ${text}` } : null;
  } catch {
    return null;
  }
}

// ── Timing profiles ───────────────────────────────────────────────────────────
const TIMING_PROFILES = {
  instant: { label: "Instant", confirmDelay: 500,  actionPace: 0,    mouseSpeed: 0.05, typingInterval: 0.01 },
  arcade:  { label: "Arcade",  confirmDelay: 1000, actionPace: 200,  mouseSpeed: 0.1,  typingInterval: 0.02 },
  puzzle:  { label: "Puzzle",  confirmDelay: 2000, actionPace: 500,  mouseSpeed: 0.2,  typingInterval: 0.03 },
  rpg:     { label: "RPG",     confirmDelay: 3000, actionPace: 1000, mouseSpeed: 0.3,  typingInterval: 0.05 },
  slow:    { label: "Slow",    confirmDelay: 5000, actionPace: 2000, mouseSpeed: 0.5,  typingInterval: 0.08 },
  custom:  { label: "Custom",  confirmDelay: 2000, actionPace: 500,  mouseSpeed: 0.2,  typingInterval: 0.03 },
};

// ── Memory helpers ────────────────────────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

async function loadMemory(gameKey) {
  return backend(`/memory/${encodeURIComponent(gameKey)}`);
}

async function saveMemory(gameKey, patch) {
  return backend(`/memory/${encodeURIComponent(gameKey)}`, patch);
}

async function clearMemory(gameKey) {
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(gameKey)}`, { method: "DELETE" });
    return res.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Tool definitions (13 tools) ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "observe_screen",
    description: "Capture the current screen state as an image. Use to see what is on screen without taking any action.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_screen_text",
    description: "Capture the screen to read text: scores, instructions, menus. Returns a screenshot.",
    input_schema: {
      type: "object",
      properties: { region: { type: "string", description: "Optional region description to focus on" } },
      required: [],
    },
  },
  {
    name: "move_mouse",
    description: "Move the mouse cursor to coordinates without clicking.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X coordinate in image pixels" },
        y: { type: "integer", description: "Y coordinate in image pixels" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "click",
    description: "Click the mouse at specific coordinates.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X coordinate in image pixels" },
        y: { type: "integer", description: "Y coordinate in image pixels" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        clicks: { type: "integer", description: "1 = single click, 2 = double click" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "drag",
    description: "Click and drag from one position to another.",
    input_schema: {
      type: "object",
      properties: {
        x1: { type: "integer" }, y1: { type: "integer" },
        x2: { type: "integer" }, y2: { type: "integer" },
        button: { type: "string", enum: ["left", "right"] },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the mouse wheel at a position.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        amount: { type: "integer", description: "Positive = up, negative = down" },
      },
      required: ["x", "y", "amount"],
    },
  },
  {
    name: "press_key",
    description: "Press a key or combo: 'enter', 'space', 'up', 'ctrl+z', 'ctrl+shift+t', etc.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "hold_key",
    description: "Hold a key down for a duration in seconds.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        duration: { type: "number", description: "Seconds to hold" },
      },
      required: ["key", "duration"],
    },
  },
  {
    name: "type_text",
    description: "Type text as keyboard input.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "analyse_game_state",
    description: "Think through the game state and strategy. No action taken — use for reasoning.",
    input_schema: {
      type: "object",
      properties: {
        analysis: { type: "string", description: "Your analysis of the current game state" },
        strategy: { type: "string", description: "Strategy being applied" },
      },
      required: ["analysis"],
    },
  },
  {
    name: "update_memory",
    description: "Save discoveries, strategies, or lessons to persistent memory for future sessions.",
    input_schema: {
      type: "object",
      properties: {
        strategy: { type: "string" },
        strategyReason: { type: "string" },
        discoveries: { type: "array", items: { type: "string" } },
        avoidPatterns: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },
  {
    name: "report_progress",
    description: "Report current score or a notable milestone.",
    input_schema: {
      type: "object",
      properties: {
        score: { type: "number" },
        milestone: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "signal_game_end",
    description: "Signal that the game has ended (win, loss, stuck, or natural end). Call this when game over is detected.",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["won", "lost", "stuck", "ended"] },
        finalScore: { type: "number" },
        reason: { type: "string" },
      },
      required: ["outcome"],
    },
  },
];

// ── UI theme & helpers ────────────────────────────────────────────────────────
const C = {
  bg:      "#07070f",
  panel:   "#0d0d1a",
  border:  "#1e1e3a",
  accent:  "#6366f1",
  accentL: "#818cf8",
  green:   "#22c55e",
  red:     "#ef4444",
  yellow:  "#eab308",
  dim:     "#4b5563",
  text:    "#e2e8f0",
  textDim: "#94a3b8",
};

let _seq = 0;
const uid = () => `${Date.now()}-${++_seq}`;
const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });

function btnStyle(bg, disabled = false) {
  return {
    background: bg, color: "#fff", border: "none", borderRadius: 4,
    padding: "4px 10px", cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12, opacity: disabled ? 0.5 : 1,
  };
}

function inputStyle(extra = {}) {
  return {
    width: "100%", background: C.bg, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 4,
    padding: "4px 6px", fontSize: 12, boxSizing: "border-box", ...extra,
  };
}

function HudRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 11 }}>
      <span style={{ color: C.dim }}>{label}</span>
      <span style={{ color: color ?? C.text }}>{String(value ?? "—")}</span>
    </div>
  );
}

// ── GameAgent component ───────────────────────────────────────────────────────
export default function GameAgent() {
  // Provider / model state
  const [providerKey, setProviderKey] = useState("gemini");
  const [model, setModel] = useState(PROVIDERS.gemini.defaultModel);
  const [apiKeyInput, setApiKeyInput] = useState("");

  // Game config
  const [gameDesc, setGameDesc] = useState("2048");
  const [gameUrl, setGameUrl] = useState("");

  // Timing
  const [timingProfile, setTimingProfile] = useState("arcade");
  const [customTiming, setCustomTiming] = useState({ confirmDelay: 2000, actionPace: 500, mouseSpeed: 0.2, typingInterval: 0.03 });

  // Advanced
  const [skipResearch, setSkipResearch] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Runtime state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [log, setLog] = useState([]);
  const [actions, setActions] = useState([]);
  const [turnCount, setTurnCount] = useState(0);
  const [tokenCount, setTokenCount] = useState({ input: 0, output: 0 });
  const [currentScore, setCurrentScore] = useState(null);
  const [gameResult, setGameResult] = useState(null);
  const [memoryData, setMemoryData] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [lastConfirm, setLastConfirm] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [screenInfo, setScreenInfo] = useState(null);
  const [backendOk, setBackendOk] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // Collapse
  const [showMemory, setShowMemory] = useState(false);
  const [showMilestones, setShowMilestones] = useState(false);
  const [showChecklist, setShowChecklist] = useState(true);

  // Refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const scaleRef = useRef({ imgW: 0, imgH: 0, realW: 0, realH: 0, scale: 1 });
  const convRef = useRef([]);
  const checkpointRef = useRef(null);
  const stopRef = useRef(false);
  const pauseRef = useRef(false);
  const stuckRingRef = useRef([]);
  const stuckTriggerRef = useRef(0);
  const turnCountRef = useRef(0);
  const tokenRef = useRef({ input: 0, output: 0 });
  const currentScoreRef = useRef(null);
  const streamRef = useRef(null);
  const logEndRef = useRef(null);
  const gameEndRef = useRef(null); // set by signal_game_end tool

  const getTiming = useCallback(() => {
    return timingProfile === "custom" ? customTiming : (TIMING_PROFILES[timingProfile] ?? TIMING_PROFILES.arcade);
  }, [timingProfile, customTiming]);

  const addLog = useCallback((text, type = "info") => {
    setLog(l => [...l.slice(-300), { id: uid(), ts: ts(), text, type }]);
  }, []);

  const addAction = useCallback((name, args, result) => {
    setActions(a => [...a.slice(-60), { id: uid(), ts: ts(), name, args, result }]);
  }, []);

  // Backend health check on mount
  useEffect(() => {
    backend("/health").then(r => {
      if (r.status === "ok") {
        setBackendOk(true);
        setScreenInfo({ width: r.screen_width, height: r.screen_height });
        addLog(`Backend online — ${r.platform} ${r.screen_width}×${r.screen_height}`, "success");
      } else {
        addLog("Backend offline — start agent_server.py first", "error");
      }
    });
  }, [addLog]);

  // Auto-scroll log
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [log]);

  const handleVideoMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const s = scaleRef.current;
    if (!s.imgW) return;
    setMousePos({
      x: Math.round((e.clientX - rect.left) * (s.imgW / rect.width)),
      y: Math.round((e.clientY - rect.top) * (s.imgH / rect.height)),
    });
  }, []);

  const startCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCapturing(true);
      addLog("Screen capture started", "success");
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        setCapturing(false);
        addLog("Screen capture ended", "warn");
      });
    } catch (e) {
      addLog(`Screen capture failed: ${e.message}`, "error");
    }
  }, [addLog]);

  const stopCapture = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCapturing(false);
  }, []);

  // ── executeTool ──────────────────────────────────────────────────────────────
  const executeTool = useCallback(async (toolName, toolInput, toolId) => {
    const timing = getTiming();

    const scaled = (x, y) => {
      const s = scaleRef.current;
      if (!s.scale || s.scale <= 1) return { x, y };
      return { x: Math.round(x * s.scale), y: Math.round(y * s.scale) };
    };

    const toolResult = (text) => ({
      type: "tool_result",
      tool_use_id: toolId,
      content: [{ type: "text", text }],
    });

    // ── Screen observation ───────────────────────────────────────────────────
    if (toolName === "observe_screen" || toolName === "read_screen_text") {
      const frame = captureFrame(videoRef.current, canvasRef.current, scaleRef);
      if (!frame) return toolResult("Screen not available — ensure screen capture is active.");
      return {
        type: "tool_result",
        tool_use_id: toolId,
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } },
          { type: "text", text: `Screen: ${frame.imgW}×${frame.imgH}px (real ${frame.realW}×${frame.realH}px, scale ${(frame.realW / frame.imgW).toFixed(2)}x)` },
        ],
      };
    }

    // ── Mouse actions ────────────────────────────────────────────────────────
    if (toolName === "move_mouse") {
      const { x, y } = scaled(toolInput.x, toolInput.y);
      const res = await backend("/mouse/move", { x, y, duration: timing.mouseSpeed });
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? "Mouse moved." : `Error: ${res.error}`);
    }

    if (toolName === "click") {
      const { x, y } = scaled(toolInput.x, toolInput.y);
      const res = await backend("/mouse/click", {
        x, y,
        button: toolInput.button ?? "left",
        clicks: toolInput.clicks ?? 1,
        move_duration: timing.mouseSpeed,
      });
      const confirm = await waitChange(videoRef.current, canvasRef.current, scaleRef, timing.confirmDelay);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Clicked. Screen ${confirm.changed ? `changed (dist ${confirm.dist.toFixed(1)})` : "unchanged"}.`
        : `Error: ${res.error}`);
    }

    if (toolName === "drag") {
      const s1 = scaled(toolInput.x1, toolInput.y1);
      const s2 = scaled(toolInput.x2, toolInput.y2);
      const res = await backend("/mouse/drag", { x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, duration: timing.mouseSpeed * 2, button: toolInput.button ?? "left" });
      const confirm = await waitChange(videoRef.current, canvasRef.current, scaleRef, timing.confirmDelay);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? `Dragged. Screen ${confirm.changed ? "changed" : "unchanged"}.` : `Error: ${res.error}`);
    }

    if (toolName === "scroll") {
      const { x, y } = scaled(toolInput.x, toolInput.y);
      const res = await backend("/mouse/scroll", { x, y, amount: toolInput.amount });
      await waitChange(videoRef.current, canvasRef.current, scaleRef, Math.min(timing.confirmDelay, 1000));
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? "Scrolled." : `Error: ${res.error}`);
    }

    // ── Keyboard actions ─────────────────────────────────────────────────────
    if (toolName === "press_key") {
      const res = await backend("/keyboard/press", { key: toolInput.key });
      const confirm = await waitChange(videoRef.current, canvasRef.current, scaleRef, timing.confirmDelay);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Key pressed. Screen ${confirm.changed ? `changed (dist ${confirm.dist.toFixed(1)})` : "unchanged"}.`
        : `Error: ${res.error}`);
    }

    if (toolName === "hold_key") {
      const res = await backend("/keyboard/hold", { key: toolInput.key, duration: toolInput.duration });
      await waitChange(videoRef.current, canvasRef.current, scaleRef, Math.min(timing.confirmDelay, 1500));
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? `Key held for ${toolInput.duration}s.` : `Error: ${res.error}`);
    }

    if (toolName === "type_text") {
      const res = await backend("/keyboard/type", { text: toolInput.text, interval: timing.typingInterval });
      await waitChange(videoRef.current, canvasRef.current, scaleRef, Math.min(timing.confirmDelay, 1500));
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? "Text typed." : `Error: ${res.error}`);
    }

    // ── Meta tools ───────────────────────────────────────────────────────────
    if (toolName === "analyse_game_state") {
      if (toolInput.strategy) addLog(`Strategy: ${toolInput.strategy}`, "info");
      addLog(`Analysis: ${toolInput.analysis?.slice(0, 200)}`, "info");
      return toolResult("Analysis noted.");
    }

    if (toolName === "update_memory") {
      const gameKey = slugify(gameDesc);
      await saveMemory(gameKey, { gameDesc, ...toolInput });
      const mem = await loadMemory(gameKey);
      setMemoryData(mem);
      addLog("Memory updated.", "success");
      return toolResult("Memory saved.");
    }

    if (toolName === "report_progress") {
      if (toolInput.score != null) {
        setCurrentScore(toolInput.score);
        currentScoreRef.current = toolInput.score;
      }
      if (toolInput.milestone) {
        setMilestones(m => [...m, { id: uid(), ts: ts(), text: toolInput.milestone, score: toolInput.score }]);
      }
      addLog(`Progress: score=${toolInput.score ?? "?"} ${toolInput.milestone ?? ""}`, "success");
      return toolResult("Progress noted.");
    }

    if (toolName === "signal_game_end") {
      gameEndRef.current = toolInput;
      setGameResult({ outcome: toolInput.outcome, finalScore: toolInput.finalScore, reason: toolInput.reason });
      addLog(`Game ended: ${toolInput.outcome} — ${toolInput.reason ?? ""}`, toolInput.outcome === "won" ? "success" : "warn");
      return toolResult(`Game end recorded: ${toolInput.outcome}`);
    }

    return toolResult(`Unknown tool: ${toolName}`);
  }, [gameDesc, getTiming, addLog, addAction]);

  // ── agentTurn ────────────────────────────────────────────────────────────────
  const agentTurn = useCallback(async (systemPrompt, apiKey) => {
    turnCountRef.current++;

    // Generate checkpoint every N turns
    if (turnCountRef.current > 1 && turnCountRef.current % CHECKPOINT_EVERY === 0 && convRef.current.length > 4) {
      addLog("Generating checkpoint summary...", "info");
      const chk = await buildChkRequest(providerKey, model, systemPrompt, convRef.current, apiKey, msg => addLog(msg, "warn"));
      if (chk) checkpointRef.current = chk;
    }

    // Prune conversation window
    convRef.current = pruneConv(convRef.current, checkpointRef.current);

    // Capture current frame and add turn message
    const frame = captureFrame(videoRef.current, canvasRef.current, scaleRef);
    if (frame) {
      convRef.current.push({
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } },
          { type: "text", text: `Turn ${turnCountRef.current}. Observe the screen and take your next action.` },
        ],
      });
    } else {
      convRef.current.push({
        role: "user",
        content: `Turn ${turnCountRef.current}. Screen unavailable. What is your next action?`,
      });
    }

    let resp;
    try {
      resp = await callAI(providerKey, model, systemPrompt, convRef.current, TOOLS, apiKey, msg => addLog(msg, "warn"));
    } catch (e) {
      addLog(`API error: ${e.message}`, "error");
      return { stop: true, reason: "api-error" };
    }

    // Accumulate tokens
    if (resp.usage) {
      tokenRef.current.input += resp.usage.input_tokens ?? 0;
      tokenRef.current.output += resp.usage.output_tokens ?? 0;
      setTokenCount({ ...tokenRef.current });
    }
    setTurnCount(t => t + 1);

    // Update stuck ring
    const hash = frameHash(canvasRef.current);
    stuckRingRef.current = [...stuckRingRef.current.slice(-6), hash];

    // Add assistant message to history
    convRef.current.push({ role: "assistant", content: resp.content ?? [] });

    // Log text content
    for (const c of resp.content ?? []) {
      if (c.type === "text") addLog(c.text, "assistant");
    }

    // Execute tool calls
    const toolUses = (resp.content ?? []).filter(c => c.type === "tool_use");
    const toolResults = [];
    for (const tu of toolUses) {
      if (stopRef.current) break;
      addLog(`→ ${tu.name}(${JSON.stringify(tu.input).slice(0, 100)})`, "tool");
      const result = await executeTool(tu.name, tu.input, tu.id);
      toolResults.push(result);
      if (gameEndRef.current) break;
    }

    if (toolResults.length > 0) {
      convRef.current.push({ role: "user", content: toolResults });
    }

    if (gameEndRef.current) {
      return { stop: true, reason: "game-end", ...gameEndRef.current };
    }

    return { stop: false };
  }, [providerKey, model, addLog, executeTool]);

  // ── runResearch ──────────────────────────────────────────────────────────────
  const runResearch = useCallback(async (apiKey) => {
    addLog(`Researching "${gameDesc}" strategies...`, "info");
    try {
      const resp = await callAI(
        providerKey, model,
        "You are a game strategy researcher with deep knowledge of browser and desktop games.",
        [{
          role: "user",
          content: `What are the best strategies for playing "${gameDesc}"? Provide 3-5 concise bullet points covering: core mechanics, optimal strategy, common mistakes to avoid, and any tips for high scores. Use your training knowledge.`,
        }],
        [], apiKey, msg => addLog(msg, "warn")
      );
      const text = resp.content?.find(c => c.type === "text")?.text ?? "";
      if (text) addLog(`Research: ${text.slice(0, 300)}`, "success");
      return text;
    } catch (e) {
      addLog(`Research failed: ${e.message} — continuing without research`, "warn");
      return null;
    }
  }, [providerKey, model, gameDesc, addLog]);

  // ── startAgent ───────────────────────────────────────────────────────────────
  const startAgent = useCallback(async () => {
    if (running) return;
    if (!capturing) { addLog("Start screen capture first.", "error"); return; }

    const prov = PROVIDERS[providerKey];
    const apiKey = apiKeyInput || getEnv(prov.envKey ?? "");
    if (!apiKey && providerKey !== "ollama") { addLog("No API key configured.", "error"); return; }

    // Reset everything
    stopRef.current = false;
    pauseRef.current = false;
    gameEndRef.current = null;
    convRef.current = [];
    checkpointRef.current = null;
    stuckRingRef.current = [];
    stuckTriggerRef.current = 0;
    turnCountRef.current = 0;
    tokenRef.current = { input: 0, output: 0 };
    currentScoreRef.current = null;

    setRunning(true);
    setGameResult(null);
    setCurrentScore(null);
    setMilestones([]);
    setLog([]);
    setTurnCount(0);
    setTokenCount({ input: 0, output: 0 });
    setPhase("research");

    const gameKey = slugify(gameDesc);
    const startTime = Date.now();

    // Load prior memory
    const mem = await loadMemory(gameKey);
    setMemoryData(Object.keys(mem).length ? mem : null);
    if (mem?.strategies?.length) {
      addLog(`Loaded memory: ${mem.sessions} sessions, best score: ${mem.bestScore ?? "?"}`, "info");
    }

    // Research phase
    let research = null;
    if (!skipResearch) {
      research = await runResearch(apiKey);
      if (stopRef.current) { setRunning(false); setPhase("idle"); return; }
    }

    // Build system prompt
    const memCtx = mem?.strategies?.length
      ? `\n\nPRIOR KNOWLEDGE FROM MEMORY:\n- Best score: ${mem.bestScore ?? "unknown"}\n- Strategies: ${mem.strategies.slice(0, 3).join("; ")}\n- Discoveries: ${(mem.discoveries ?? []).slice(0, 5).join("; ")}\n- Avoid: ${(mem.avoidPatterns ?? []).slice(0, 3).join("; ")}`
      : "";

    const researchCtx = research ? `\n\nRESEARCH FINDINGS:\n${research}` : "";

    const systemPrompt = `You are an autonomous AI game-playing agent playing "${gameDesc}" on the user's screen.

Your goal: Play as well as possible — maximize score and try to win.

TOOLS AVAILABLE:
- observe_screen / read_screen_text: See the current screen
- click, drag, scroll, move_mouse: Mouse control (use image-space pixel coordinates)
- press_key, hold_key, type_text: Keyboard control
- analyse_game_state: Think through strategy (no action taken)
- update_memory: Save discoveries for future sessions
- report_progress: Report scores and milestones
- signal_game_end: Call when the game is over

WORKFLOW PER TURN:
1. Use observe_screen to see current state
2. Use analyse_game_state to reason about best move
3. Take action (click, press_key, etc.)
4. Observe result if needed
5. Report scores with report_progress
6. Call signal_game_end when game over is detected

COORDINATE SYSTEM:
- All x,y coordinates are in the DOWNSCALED image space (max 1280px wide)
- The backend auto-scales to real screen pixels
- Be precise — click exactly on game elements

IMPORTANT:
- After each action, the response tells you whether the screen changed
- If screen unchanged after a click, try a different position or action
- Save strategies and discoveries with update_memory periodically${memCtx}${researchCtx}`;

    // Study phase — 3 observe-only turns to understand the game state
    setPhase("study");
    addLog("Study phase — observing for 3 turns before playing...", "info");
    const studyToolNames = new Set(["observe_screen", "read_screen_text", "analyse_game_state"]);

    for (let i = 0; i < 3 && !stopRef.current; i++) {
      while (pauseRef.current && !stopRef.current) await new Promise(r => setTimeout(r, 500));
      const frame = captureFrame(videoRef.current, canvasRef.current, scaleRef);
      const turnMsg = i === 0
        ? "Study the game board carefully. Identify the game type, current state, score if visible, and controls. Do NOT take any action yet."
        : `Study turn ${i + 1}/3 — continue observing. Note any additional details.`;

      convRef.current.push({
        role: "user",
        content: frame
          ? [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } },
              { type: "text", text: turnMsg },
            ]
          : turnMsg,
      });

      try {
        const studyTools = TOOLS.filter(t => studyToolNames.has(t.name));
        const resp = await callAI(providerKey, model, systemPrompt, convRef.current, studyTools, apiKey, msg => addLog(msg, "warn"));
        const content = resp.content ?? [];
        convRef.current.push({ role: "assistant", content });
        const toolResults = [];
        for (const tu of content.filter(c => c.type === "tool_use")) {
          toolResults.push(await executeTool(tu.name, tu.input, tu.id));
        }
        if (toolResults.length) convRef.current.push({ role: "user", content: toolResults });
        const text = content.find(c => c.type === "text")?.text ?? "";
        if (text) addLog(`Study ${i + 1}/3: ${text.slice(0, 200)}`, "info");
      } catch (e) {
        addLog(`Study turn error: ${e.message}`, "warn");
      }
    }

    if (stopRef.current) { setRunning(false); setPhase("idle"); return; }

    // Main play loop
    setPhase("playing");
    addLog("Autonomous play starting...", "success");

    let finalOutcome = "ended";
    let finalScore = null;

    while (!stopRef.current) {
      while (pauseRef.current && !stopRef.current) await new Promise(r => setTimeout(r, 500));
      if (stopRef.current) break;

      const result = await agentTurn(systemPrompt, apiKey);

      if (result.stop) {
        finalOutcome = result.outcome ?? "ended";
        finalScore = result.finalScore ?? currentScoreRef.current;
        break;
      }

      // Stuck detection — ring buffer of last 7 hashes, 5 similar = stuck
      if (stuckRingRef.current.length >= 5) {
        const ring = stuckRingRef.current.slice(-5);
        const allSimilar = ring.every((h, i) => i === 0 || hashDist(ring[i - 1], h) < 4.0);
        if (allSimilar) {
          stuckTriggerRef.current++;
          addLog(`Stuck detected (${stuckTriggerRef.current}/2)`, "warn");
          if (stuckTriggerRef.current >= 2) {
            finalOutcome = "stuck";
            addLog("Agent declared stuck after 2 consecutive triggers.", "warn");
            break;
          }
          convRef.current.push({
            role: "user",
            content: "The screen has not changed in several turns. Try a completely different approach, check if the game ended, or use observe_screen to reassess.",
          });
        }
      }
    }

    // Save session memory
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    try {
      await saveMemory(gameKey, {
        gameDesc,
        outcome: finalOutcome,
        score: finalScore,
        durationSeconds,
        turnCount: turnCountRef.current,
      });
      const updatedMem = await loadMemory(gameKey);
      setMemoryData(updatedMem);
    } catch (e) {
      addLog(`Memory save failed: ${e.message}`, "warn");
    }

    setRunning(false);
    setPhase("ended");
    addLog(`Session complete — outcome: ${finalOutcome}, turns: ${turnCountRef.current}, duration: ${durationSeconds}s`, "success");
  }, [running, capturing, providerKey, apiKeyInput, gameDesc, skipResearch, agentTurn, runResearch, executeTool, addLog]);

  const stopAgent = useCallback(() => {
    stopRef.current = true;
    pauseRef.current = false;
    setPaused(false);
    addLog("Stopping agent...", "warn");
  }, [addLog]);

  const togglePause = useCallback(() => {
    pauseRef.current = !pauseRef.current;
    setPaused(p => !p);
    addLog(pauseRef.current ? "Paused." : "Resumed.", "info");
  }, [addLog]);

  const restartAgent = useCallback(() => {
    stopRef.current = true;
    setTimeout(() => startAgent(), 300);
  }, [startAgent]);

  const handleProviderChange = useCallback((key) => {
    setProviderKey(key);
    setModel(PROVIDERS[key].defaultModel);
    setApiKeyInput("");
  }, []);

  const handleApiKeyChange = useCallback((val) => {
    setApiKeyInput(val);
    const prov = PROVIDERS[providerKey];
    if (prov.envKey) setRuntimeKey(prov.envKey, val);
  }, [providerKey]);

  // ── Checklist ────────────────────────────────────────────────────────────────
  const checklist = [
    { label: "Backend online",   done: backendOk },
    { label: "Screen captured",  done: capturing },
    { label: "API key set",      done: !!(apiKeyInput || getEnv(PROVIDERS[providerKey].envKey ?? "")) || providerKey === "ollama" },
    { label: "Game name set",    done: gameDesc.trim().length > 0 },
  ];
  const readyToPlay = checklist.every(c => c.done);

  const phaseColor = { idle: C.dim, research: C.yellow, study: C.accentL, playing: C.green, ended: C.textDim }[phase] ?? C.dim;
  const logColors  = { info: C.text, assistant: C.accentL, tool: C.yellow, error: C.red, warn: C.yellow, success: C.green };
  const outcomeColors = { won: C.green, lost: C.red, stuck: C.yellow, ended: C.textDim };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw", background: C.bg, color: C.text, fontFamily: "monospace", fontSize: 13, overflow: "hidden" }}>

      {/* ── Left panel ─────────────────────────────────────────────────────── */}
      <div style={{ width: 300, minWidth: 260, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflowY: "auto", background: C.panel }}>

        {/* Header */}
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.accentL }}>Game Agent</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: phaseColor }}>● {phase}</span>
        </div>

        {/* Status pills */}
        <div style={{ display: "flex", gap: 4, padding: "6px 10px", flexWrap: "wrap" }}>
          {checklist.map(item => (
            <span key={item.label} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 999, background: item.done ? "#14532d" : "#3b1515", color: item.done ? C.green : C.red }}>
              {item.done ? "✓" : "✗"} {item.label}
            </span>
          ))}
        </div>

        {/* Screen capture */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>SCREEN CAPTURE</div>
          <div style={{ position: "relative", background: "#000", borderRadius: 4, overflow: "hidden", aspectRatio: "16/9" }}>
            <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "contain", display: capturing ? "block" : "none" }} muted onMouseMove={handleVideoMouseMove} />
            {!capturing && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: C.dim, fontSize: 11 }}>
                No capture
              </div>
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
            {!capturing
              ? <button onClick={startCapture} style={btnStyle(C.accent)}>Share Screen</button>
              : <button onClick={stopCapture} style={btnStyle(C.red)}>Stop Capture</button>
            }
            {screenInfo && <span style={{ fontSize: 10, color: C.dim }}>{screenInfo.width}×{screenInfo.height}</span>}
          </div>
          {capturing && <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>Cursor: {mousePos.x},{mousePos.y}</div>}
        </div>

        {/* Provider selector */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>PROVIDER</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Object.entries(PROVIDERS).map(([key, prov]) => (
              <button key={key} onClick={() => handleProviderChange(key)}
                style={{ ...btnStyle(providerKey === key ? C.accent : C.border), fontSize: 11, padding: "3px 8px" }}>
                {prov.icon} {prov.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: C.textDim, marginTop: 4 }}>{PROVIDERS[providerKey].notes}</div>
          <select value={model} onChange={e => setModel(e.target.value)}
            style={{ ...inputStyle(), marginTop: 6 }}>
            {PROVIDERS[providerKey].models.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          {PROVIDERS[providerKey].envKey && (
            <input
              type="password"
              placeholder={`${PROVIDERS[providerKey].label} API key`}
              value={apiKeyInput}
              onChange={e => handleApiKeyChange(e.target.value)}
              style={{ ...inputStyle(), marginTop: 6 }}
            />
          )}
        </div>

        {/* Game config */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>GAME</div>
          <input placeholder="Game name (e.g. 2048)" value={gameDesc} onChange={e => setGameDesc(e.target.value)} style={inputStyle()} />
          <input placeholder="URL (optional)" value={gameUrl} onChange={e => setGameUrl(e.target.value)} style={inputStyle({ marginTop: 4 })} />
        </div>

        {/* Timing profiles */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>TIMING</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Object.entries(TIMING_PROFILES).map(([key, t]) => (
              <button key={key} onClick={() => setTimingProfile(key)}
                style={{ ...btnStyle(timingProfile === key ? C.accent : C.border), fontSize: 10, padding: "2px 7px" }}>
                {t.label}
              </button>
            ))}
          </div>
          {timingProfile === "custom" && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: C.textDim }}>
                Confirm delay (ms)
                <input type="number" value={customTiming.confirmDelay}
                  onChange={e => setCustomTiming(t => ({ ...t, confirmDelay: +e.target.value }))}
                  style={inputStyle({ width: 70 })} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: C.textDim }}>
                Action pace (ms)
                <input type="number" value={customTiming.actionPace}
                  onChange={e => setCustomTiming(t => ({ ...t, actionPace: +e.target.value }))}
                  style={inputStyle({ width: 70 })} />
              </div>
            </div>
          )}
        </div>

        {/* Advanced */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <button onClick={() => setShowAdvanced(a => !a)}
            style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 11, padding: 0 }}>
            {showAdvanced ? "▾" : "▸"} ADVANCED
          </button>
          {showAdvanced && (
            <div style={{ marginTop: 6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={skipResearch} onChange={e => setSkipResearch(e.target.checked)} />
                Skip research phase
              </label>
            </div>
          )}
        </div>

        {/* Controls */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {!running
              ? <button onClick={startAgent} disabled={!readyToPlay} style={btnStyle(readyToPlay ? C.green : C.dim, !readyToPlay)}>▶ Start</button>
              : <>
                  <button onClick={togglePause} style={btnStyle(C.yellow)}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
                  <button onClick={stopAgent} style={btnStyle(C.red)}>■ Stop</button>
                  <button onClick={restartAgent} style={btnStyle(C.border)}>↺ Restart</button>
                </>
            }
            {!running && gameDesc.trim() && (
              <button onClick={async () => { await clearMemory(slugify(gameDesc)); setMemoryData(null); addLog("Memory cleared.", "warn"); }}
                style={{ ...btnStyle(C.border), fontSize: 11 }}>Clear Memory</button>
            )}
          </div>
        </div>

        {/* Checklist */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <button onClick={() => setShowChecklist(a => !a)}
            style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 11, padding: 0 }}>
            {showChecklist ? "▾" : "▸"} CHECKLIST
          </button>
          {showChecklist && (
            <div style={{ marginTop: 6 }}>
              {checklist.map(item => (
                <div key={item.label} style={{ fontSize: 11, color: item.done ? C.green : C.dim, marginBottom: 2 }}>
                  {item.done ? "✓" : "○"} {item.label}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Game result card */}
        {gameResult && (
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, background: "#0a120a" }}>
            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 2 }}>RESULT</div>
            <div style={{ fontSize: 14, color: outcomeColors[gameResult.outcome] ?? C.text, fontWeight: 700 }}>
              {gameResult.outcome.toUpperCase()}
            </div>
            {gameResult.finalScore != null && <div style={{ fontSize: 12, color: C.text }}>Score: {gameResult.finalScore}</div>}
            {gameResult.reason && <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{gameResult.reason}</div>}
          </div>
        )}

        {/* Memory panel */}
        {memoryData && Object.keys(memoryData).length > 0 && (
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
            <button onClick={() => setShowMemory(a => !a)}
              style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 11, padding: 0 }}>
              {showMemory ? "▾" : "▸"} MEMORY ({memoryData.sessions ?? 0} sessions)
            </button>
            {showMemory && (
              <div style={{ marginTop: 6 }}>
                {memoryData.bestScore != null && (
                  <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>Best score: {memoryData.bestScore}</div>
                )}
                {(memoryData.strategies ?? []).slice(0, 3).map((s, i) => (
                  <div key={i} style={{ fontSize: 10, color: C.accentL, marginBottom: 2 }}>• {s}</div>
                ))}
                {(memoryData.discoveries ?? []).slice(0, 3).map((d, i) => (
                  <div key={i} style={{ fontSize: 10, color: C.textDim, marginBottom: 2 }}>◦ {d}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Milestones panel */}
        {milestones.length > 0 && (
          <div style={{ padding: "8px 10px" }}>
            <button onClick={() => setShowMilestones(a => !a)}
              style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 11, padding: 0 }}>
              {showMilestones ? "▾" : "▸"} MILESTONES ({milestones.length})
            </button>
            {showMilestones && (
              <div style={{ marginTop: 6, maxHeight: 120, overflowY: "auto" }}>
                {milestones.slice().reverse().map(m => (
                  <div key={m.id} style={{ fontSize: 10, color: C.green, marginBottom: 2 }}>
                    {m.ts} {m.score != null ? `[${m.score}] ` : ""}{m.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Centre: Agent log ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <span style={{ fontWeight: 700, color: C.accentL }}>Agent Log</span>
          <span style={{ fontSize: 11, color: C.dim }}>Turn {turnCount}</span>
          <span style={{ fontSize: 11, color: C.dim }}>In: {tokenCount.input.toLocaleString()} / Out: {tokenCount.output.toLocaleString()}</span>
          {currentScore != null && <span style={{ fontSize: 11, color: C.green }}>Score: {currentScore}</span>}
          {running && <span style={{ fontSize: 11, color: paused ? C.yellow : C.green }}>● {paused ? "PAUSED" : "RUNNING"}</span>}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
          {log.map(entry => (
            <div key={entry.id} style={{ marginBottom: 3, lineHeight: 1.5 }}>
              <span style={{ color: C.dim, fontSize: 10, marginRight: 6 }}>{entry.ts}</span>
              <span style={{ color: logColors[entry.type] ?? C.text, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{entry.text}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* ── Right: HUD + Action feed ────────────────────────────────────────── */}
      <div style={{ width: 230, borderLeft: `1px solid ${C.border}`, display: "flex", flexDirection: "column", background: C.panel, flexShrink: 0 }}>
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, color: C.accentL, fontSize: 12 }}>HUD</div>
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <HudRow label="Status"  value={running ? (paused ? "paused" : "running") : phase} color={running ? (paused ? C.yellow : C.green) : phaseColor} />
          <HudRow label="Mouse"   value={`${mousePos.x}, ${mousePos.y}`} />
          <HudRow label="Scale"   value={scaleRef.current.scale > 0 ? `${scaleRef.current.scale.toFixed(2)}x` : "—"} />
          <HudRow label="Turns"   value={turnCount} />
          <HudRow label="In tok"  value={tokenCount.input.toLocaleString()} />
          <HudRow label="Out tok" value={tokenCount.output.toLocaleString()} />
          {screenInfo && <HudRow label="Screen" value={`${screenInfo.width}×${screenInfo.height}`} />}
          {lastConfirm && (
            <HudRow label="Confirm"
              value={lastConfirm.changed ? `changed (${lastConfirm.dist?.toFixed?.(1)})` : "no change"}
              color={lastConfirm.changed ? C.green : C.yellow} />
          )}
        </div>

        <div style={{ padding: "6px 10px", fontSize: 11, color: C.textDim }}>RECENT ACTIONS</div>
        <div style={{ flex: 1, overflowY: "auto", padding: "2px 10px 8px" }}>
          {actions.slice().reverse().map(a => (
            <div key={a.id} style={{ marginBottom: 6, fontSize: 10 }}>
              <span style={{ color: C.dim }}>{a.ts}</span>
              <span style={{ color: C.yellow, marginLeft: 4 }}>{a.name}</span>
              <div style={{ color: C.dim, marginLeft: 4, wordBreak: "break-all" }}>
                {JSON.stringify(a.args).slice(0, 60)}
              </div>
              {a.result && (
                <div style={{ color: a.result.ok ? C.green : C.red, marginLeft: 4 }}>
                  → {a.result.ok ? "ok" : a.result.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
