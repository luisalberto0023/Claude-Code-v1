import { useState, useEffect, useRef, useCallback } from "react";
import game2048 from "./plugins/game2048.js";

// Game plugins provide deterministic perception and policy for a specific game.
// When one matches, the agent reads the true game state from pixels and picks
// moves by search instead of asking the model — far more reliable than a small
// vision model, and effectively free.
const GAME_PLUGINS = [game2048];
function findPlugin(gameDesc) {
  return GAME_PLUGINS.find(p => p.match(gameDesc)) ?? null;
}

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
    notes: "100% free & unlimited, runs on your own GPU. Needs Ollama + a vision model pulled.",
    envKey: null,
    baseURL: "http://localhost:11434/v1/chat/completions",
    supportsSearch: false,
    defaultModel: "qwen2.5vl:3b",
    models: [
      { id: "qwen2.5vl:3b", label: "Qwen2.5-VL 3B · qwen2.5vl:3b (light, grounding)" },
      { id: "gemma3:4b", label: "Gemma 3 4B · gemma3:4b (screen/OCR)" },
      { id: "moondream", label: "Moondream 2 · moondream (tiny, ~2GB)" },
      { id: "llava:7b", label: "LLaVA 7B · llava:7b (tight on 6GB)" },
      { id: "minicpm-v", label: "MiniCPM-V · minicpm-v (OCR, tight)" },
      { id: "qwen2.5vl:7b", label: "Qwen2.5-VL 7B · qwen2.5vl:7b (needs ~8GB+)" },
    ],
  },
};

// Ollama server address — configurable so the model can live on a separate PC.
let _ollamaBase = "http://localhost:11434";
// Route Ollama calls through the local backend rather than straight from the
// browser (see /llm/ollama in agent_server.py).
let _ollamaViaBackend = true;
function setOllamaViaBackend(v) { _ollamaViaBackend = !!v; }
function setOllamaBase(url) {
  const u = (url || "").trim().replace(/\/+$/, "");
  _ollamaBase = u || "http://localhost:11434";
}

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
// Local models on slow GPUs drop long-running connections while the server is
// still computing; the retry then hits Ollama's prompt cache and returns
// quickly. Retrying persistently is what keeps a session alive, so allow more
// attempts than the old 3.
const RETRY_ERR = [2000, 4000, 8000, 8000, 8000, 8000];

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
        // Ollama defaults to temperature 1.0. Choosing a game move is a
        // decision, not creative writing — sample the model's best judgment
        // instead of a random one from the distribution.
        temperature: 0.25,
        top_p: 0.9,
      };
      const t0 = Date.now();

      // Preferred path: relay through the local backend. The browser then only
      // holds a localhost connection, so security software / network gear on the
      // LAN path can't kill the long request while the model is thinking.
      if (_ollamaViaBackend) {
        let relay;
        try {
          relay = await backend("/llm/ollama", { base_url: _ollamaBase, payload: body, timeout: 600 });
        } catch (e) {
          throw new Error(`Relay unreachable: ${e.message} — is agent_server.py running?`);
        }
        if (relay?.ok && relay.body) return fromOpenAI(relay.body);
        const secs = relay?.elapsed ?? ((Date.now() - t0) / 1000).toFixed(1);
        const err = new Error(
          relay?.status
            ? `HTTP ${relay.status} after ${secs}s: ${String(relay.error ?? "").slice(0, 300)}`
            : `Ollama relay failed after ${secs}s: ${String(relay?.error ?? "unknown")}`
        );
        if (relay?.status) err.status = relay.status;
        throw err;
      }

      let res;
      try {
        res = await fetch(`${_ollamaBase}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (netErr) {
        // Connection died rather than returning an HTTP status. Report how long
        // it survived — a consistent cutoff points at a timeout in the path,
        // while a fast failure means Ollama is unreachable.
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        throw new Error(`${netErr.message} after ${secs}s — the request was still being processed when the connection dropped. Shrink the screenshot (Advanced -> Local screenshot width) so each turn finishes sooner.`);
      }
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text() || "").slice(0, 300); } catch {}
        const error = new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
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
// Mutable so we can send smaller frames to local models (fewer image tokens →
// fits their small context window). Cloud models keep the full 1280px.
let MAX_FRAME_W = 1280;
function setMaxFrameW(w) { MAX_FRAME_W = Math.max(320, Math.min(1280, w | 0)) || 1280; }
// JPEG quality for the frame we transmit. Smaller payloads spend less time on
// the wire, which matters when the request crosses a flaky network link: a
// body that is cut off mid-upload leaves the server waiting and then rejecting
// the request as malformed.
let FRAME_QUALITY = 0.85;
function setFrameQuality(q) { FRAME_QUALITY = Math.max(0.3, Math.min(0.95, q)) || 0.85; }

// `maxW` overrides the global cap. Pass the real width to capture full-size,
// which matters when a crop follows: cropping an already-downscaled frame
// compounds the shrink and can leave the game unreadably small.
// The solver reads tile numbers, not just tile colours, so its capture must not
// be downscaled: at 1280 the digits lose the detail that tells 256 from 128.
const SOLVER_CAPTURE_W = 4000;

function captureFrame(videoEl, canvasEl, scaleRef, maxW = null) {
  if (!videoEl || !canvasEl || videoEl.readyState < 2) return null;
  const realW = videoEl.videoWidth;
  const realH = videoEl.videoHeight;
  if (!realW || !realH) return null;

  const cap = maxW || MAX_FRAME_W;
  let imgW = realW, imgH = realH;
  if (imgW > cap) {
    imgH = Math.round(imgH * cap / imgW);
    imgW = cap;
  }

  canvasEl.width = imgW;
  canvasEl.height = imgH;
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, imgW, imgH);
  scaleRef.current = { imgW, imgH, realW, realH, scale: realW / imgW, offsetX: 0, offsetY: 0 };

  return {
    data: canvasEl.toDataURL("image/jpeg", FRAME_QUALITY).split(",")[1],
    imgW, imgH, realW, realH,
  };
}

// Draw a base64 JPEG (from the backend's native capture) onto the canvas so the
// perceptual-hash / change-detection code can run on it just like a browser frame.
async function drawDataURLToCanvas(dataURL, canvasEl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataURL;
  });
  let imgW = img.width, imgH = img.height;
  if (imgW > MAX_FRAME_W) {
    imgH = Math.round(imgH * MAX_FRAME_W / imgW);
    imgW = MAX_FRAME_W;
  }
  canvasEl.width = imgW;
  canvasEl.height = imgH;
  canvasEl.getContext("2d").drawImage(img, 0, 0, imgW, imgH);
  return { imgW, imgH };
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

// ── Click grid overlay ────────────────────────────────────────────────────────
// NitroGen finding: predicting a discrete grid cell beats regressing raw
// coordinates. We draw a faint labeled grid (columns A.., rows 1..) on the frame
// the model sees, and offer a click_grid tool so it can target a cell instead of
// guessing exact pixels — improving click reliability (esp. under DPI scaling).
const GRID_COLS = 12;
const GRID_ROWS = 8;
const GRID_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function drawGrid(canvasEl, cols = GRID_COLS, rows = GRID_ROWS) {
  if (!canvasEl || !canvasEl.width) return;
  const ctx = canvasEl.getContext("2d");
  const w = canvasEl.width, h = canvasEl.height;
  const cw = w / cols, ch = h / rows;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,70,70,0.30)";
  for (let c = 1; c < cols; c++) {
    const x = Math.round(c * cw);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let r = 1; r < rows; r++) {
    const y = Math.round(r * ch);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // Edge labels only (keeps the playfield readable): letters along the top,
  // numbers down the left.
  const fontPx = Math.max(9, Math.round(Math.min(cw, ch) * 0.22));
  ctx.font = `bold ${fontPx}px monospace`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255,235,0,0.9)";
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 2;
  for (let c = 0; c < cols; c++) {
    const label = GRID_LETTERS[c] ?? "?";
    const x = c * cw + cw / 2 - fontPx * 0.3, y = 1;
    ctx.strokeText(label, x, y); ctx.fillText(label, x, y);
  }
  for (let r = 0; r < rows; r++) {
    const label = String(r + 1);
    const x = 1, y = r * ch + ch / 2 - fontPx * 0.5;
    ctx.strokeText(label, x, y); ctx.fillText(label, x, y);
  }
  ctx.restore();
}

// ── HUD crop ──────────────────────────────────────────────────────────────────
// NitroGen masks distractor UI (streamer chrome, HUDs) so the model focuses on
// the game. We crop the captured frame to the game area by margin percentages.
// A crop is a pure cut (no rescale), so we fold the crop offset into
// scaleRef.offsetX/offsetY and leave scale unchanged — click + click_grid keep
// mapping to the correct real-screen pixels with no other changes.
let _cropTmp = null;
function _tmpCanvas() {
  if (!_cropTmp) _cropTmp = document.createElement("canvas");
  return _cropTmp;
}

// Crops canvasEl in place by {top,right,bottom,left} percentages and updates
// scaleRef so downstream coordinate scaling stays correct. Returns true if applied.
// Shrink the canvas to at most maxW wide, updating scaleRef so coordinates
// still map correctly. Run this AFTER cropping.
function downscaleCanvas(canvasEl, scaleRef, maxW) {
  if (!canvasEl || !canvasEl.width || canvasEl.width <= maxW) return;
  const newW = maxW;
  const newH = Math.round(canvasEl.height * maxW / canvasEl.width);
  const tmp = _tmpCanvas();
  tmp.width = newW; tmp.height = newH;
  tmp.getContext("2d").drawImage(canvasEl, 0, 0, newW, newH);
  canvasEl.width = newW; canvasEl.height = newH;
  canvasEl.getContext("2d").drawImage(tmp, 0, 0);
  const s = scaleRef.current;
  scaleRef.current = {
    ...s,
    imgW: newW, imgH: newH,
    scale: newW ? s.realW / newW : 1,
  };
}

function applyCrop(canvasEl, scaleRef, m) {
  if (!canvasEl || !canvasEl.width) return false;
  const w = canvasEl.width, h = canvasEl.height;
  const left = Math.round((Math.max(0, m.left ?? 0) / 100) * w);
  const top = Math.round((Math.max(0, m.top ?? 0) / 100) * h);
  const right = Math.round((Math.max(0, m.right ?? 0) / 100) * w);
  const bottom = Math.round((Math.max(0, m.bottom ?? 0) / 100) * h);
  const cw = w - left - right, ch = h - top - bottom;
  if (cw < 16 || ch < 16) return false; // too aggressive — skip rather than break
  if (left === 0 && top === 0 && right === 0 && bottom === 0) return false;

  const tmp = _tmpCanvas();
  tmp.width = cw; tmp.height = ch;
  tmp.getContext("2d").drawImage(canvasEl, left, top, cw, ch, 0, 0, cw, ch);
  canvasEl.width = cw; canvasEl.height = ch;
  canvasEl.getContext("2d").drawImage(tmp, 0, 0);

  const s = scaleRef.current;
  const scale = (!s.scale || s.scale <= 0) ? 1 : s.scale;
  scaleRef.current = {
    imgW: cw, imgH: ch,
    realW: Math.round(cw * scale), realH: Math.round(ch * scale),
    scale,
    offsetX: (s.offsetX ?? 0) + left * scale,
    offsetY: (s.offsetY ?? 0) + top * scale,
  };
  return true;
}

// Parse a cell reference like "C4" → { col: 2, row: 3 } (0-based), or null.
function parseGridCell(cell, cols = GRID_COLS, rows = GRID_ROWS) {
  if (typeof cell !== "string") return null;
  const m = cell.trim().toUpperCase().match(/^([A-Z]+)\s*([0-9]+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  const row = parseInt(m[2], 10) - 1;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, row };
}

// ── Wait for screen change ────────────────────────────────────────────────────
// `grab` is an async function that refreshes the canvas with the current frame
// (works for both browser screen-share and backend native capture).
// Snapshot the screen hash. Call this BEFORE performing an action so the
// comparison has a true "before" state.
async function snapshotHash(grab, canvasEl) {
  await grab();
  return frameHash(canvasEl);
}

// `baseline` MUST be captured before the action. Fast games finish animating
// during the action's own round trip, so grabbing the baseline afterwards
// measures post-move vs post-move and always reports "unchanged".
async function waitChange(grab, canvasEl, maxMs = 2000, threshold = 2.0, baseline = null) {
  const t0 = Date.now();
  if (!baseline) {
    await grab();
    baseline = frameHash(canvasEl);
  }
  let maxDist = 0; // largest movement seen, even if under threshold
  // Check immediately: the change may already have happened.
  await grab();
  let dist = hashDist(baseline, frameHash(canvasEl));
  if (dist > maxDist) maxDist = dist;
  if (dist > threshold) return { changed: true, dist, elapsed: Date.now() - t0 };

  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 150));
    await grab();
    dist = hashDist(baseline, frameHash(canvasEl));
    if (dist > maxDist) maxDist = dist;
    if (dist > threshold) return { changed: true, dist, elapsed: Date.now() - t0 };
  }
  return { changed: false, dist: maxDist, elapsed: maxMs };
}

// ── Conversation window management ────────────────────────────────────────────
// How many turns of history to keep. Local models run with a small context
// (Ollama defaults to 4096) — letting history grow to ~3.5k tokens leaves no
// headroom, and llama.cpp starts shifting/rebuilding its context cache, which
// is slow enough to stall a turn until the connection drops. Keep local runs
// well under that so every request is a cheap cache hit.
let WINDOW_TURNS = 20;
function setWindowTurns(n) { WINDOW_TURNS = Math.max(3, Math.min(40, n | 0)) || 20; }
const CHECKPOINT_EVERY = 15;
// NitroGen finding: a single recent frame carries enough context — keep fewer
// images in the window to cut vision tokens (was 3). Mutable because local
// models on small GPUs must be held to exactly ONE image: a single image is
// processed fine, but two or more reliably kill the Ollama runner.
let MAX_IMAGES = 2;
function setMaxImages(n) { MAX_IMAGES = Math.max(1, Math.min(4, n | 0)) || 1; }

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

// Strip ALL images (including nested in tool_results) for cheap text-only analysis calls
function stripAllImages(messages) {
  return messages
    .map(m => {
      if (typeof m.content === "string") return m;
      if (!Array.isArray(m.content)) return m;
      const filtered = m.content
        .filter(c => c.type !== "image")
        .map(c => {
          if (c.type === "tool_result" && Array.isArray(c.content)) {
            return { ...c, content: c.content.filter(x => x.type !== "image") };
          }
          return c;
        });
      return filtered.length > 0 ? { ...m, content: filtered } : null;
    })
    .filter(Boolean);
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
    name: "click_grid",
    description: "Click using the on-screen grid (more reliable than raw pixels). 'cell' is a column letter + row number like 'C4' (columns A-L left→right, rows 1-8 top→bottom). Optional dx,dy (0..1) pick a point inside the cell; default 0.5,0.5 = centre. Prefer this over click when a labeled grid is visible.",
    input_schema: {
      type: "object",
      properties: {
        cell: { type: "string", description: "Grid cell, e.g. 'C4' (col letter + row number)" },
        dx: { type: "number", description: "Horizontal position inside the cell, 0=left .. 1=right (default 0.5)" },
        dy: { type: "number", description: "Vertical position inside the cell, 0=top .. 1=bottom (default 0.5)" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        clicks: { type: "integer", description: "1 = single click, 2 = double click" },
      },
      required: ["cell"],
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
    description: "Think through the game state and strategy. No action taken — use for reasoning. REQUIRED before every physical action.",
    input_schema: {
      type: "object",
      properties: {
        analysis: { type: "string", description: "Your analysis of the current game state and what you intend to do next" },
        strategy: { type: "string", description: "Strategy being applied" },
      },
      required: ["analysis"],
    },
  },
  {
    name: "set_goals",
    description: "Define or update the ordered list of sub-goals working toward the main objective. Call once at the start of play to plan, then update currentIndex as you complete each goal.",
    input_schema: {
      type: "object",
      properties: {
        goals: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of sub-goals. Each should be a concrete, verifiable step.",
        },
        currentIndex: {
          type: "integer",
          description: "Index (0-based) of the goal you are currently working on. Increment as goals are completed.",
        },
      },
      required: ["goals"],
    },
  },
  {
    name: "execute_sequence",
    description: "Execute a batch of up to 15 simple actions in one tool call (saves tokens). Aborts early if 2 consecutive actions produce no screen change. Supported action tools: press_key, type_text, click, gamepad_button. Use this for repetitive moves like multiple arrow keys in 2048 or repeated gamepad presses.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          maxItems: 15,
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: ["press_key", "type_text", "click", "gamepad_button"] },
              input: { type: "object", description: "Arguments for that tool" },
            },
            required: ["tool", "input"],
          },
          description: "Ordered list of actions to execute sequentially.",
        },
      },
      required: ["actions"],
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

// ── Gamepad tools (used when the control scheme includes a gamepad) ───────────
const GAMEPAD_BUTTONS = [
  "a", "b", "x", "y", "lb", "rb", "ls", "rs", "start", "back", "guide", "up", "down", "left", "right",
  "south", "east", "west", "north", // SDL/cross-platform aliases (south=a, east=b, west=x, north=y)
];
const GAMEPAD_TOOLS = [
  {
    name: "gamepad_button",
    description: "Press a virtual Xbox controller button. Face: a,b,x,y (aka south,east,west,north). Shoulders: lb,rb. Stick clicks: ls,rs. System: start,back,guide. D-pad: up,down,left,right.",
    input_schema: {
      type: "object",
      properties: {
        button: { type: "string", enum: GAMEPAD_BUTTONS },
        hold: { type: "number", description: "Seconds to hold the button (default 0.08; use larger for charged actions)" },
      },
      required: ["button"],
    },
  },
  {
    name: "gamepad_stick",
    description: "Move an analog stick. x,y range -1..1. y: +1 = up/forward, -1 = down/back. x: +1 = right, -1 = left. duration = seconds to hold before recentering (0 = leave it held until changed).",
    input_schema: {
      type: "object",
      properties: {
        stick: { type: "string", enum: ["left", "right"] },
        x: { type: "number", description: "-1..1 (left/right)" },
        y: { type: "number", description: "-1..1 (down/up)" },
        duration: { type: "number", description: "Seconds to hold before recentering (0 = stay)" },
      },
      required: ["stick", "x", "y"],
    },
  },
  {
    name: "gamepad_trigger",
    description: "Squeeze an analog trigger (e.g. accelerate / shoot). value 0..1. duration = seconds to hold before releasing (0 = stay held).",
    input_schema: {
      type: "object",
      properties: {
        trigger: { type: "string", enum: ["left", "right"] },
        value: { type: "number", description: "0..1 squeeze amount" },
        duration: { type: "number", description: "Seconds to hold before releasing (0 = stay)" },
      },
      required: ["trigger", "value"],
    },
  },
];

// ── Control schemes (user picks one in the UI) ────────────────────────────────
// Defines which input tools the agent gets, and whether native-only features
// (DirectX capture, pause-to-think) are applicable.
const CONTROL_SCHEMES = {
  "browser-kbm":    { label: "🌐 Browser · KB/Mouse", inputs: ["kbm"], native: false },
  "native-kbm":     { label: "🖥️ Native · KB/Mouse",  inputs: ["kbm"], native: true },
  "native-gamepad": { label: "🎮 Native · Gamepad",    inputs: ["gamepad"], native: true },
  "native-all":     { label: "🎮 Native · Pad+KB/Mouse", inputs: ["kbm", "gamepad"], native: true },
};

const SHARED_TOOL_NAMES = new Set([
  "observe_screen", "read_screen_text", "analyse_game_state", "set_goals",
  "update_memory", "report_progress", "signal_game_end", "execute_sequence",
]);
const KBM_TOOL_NAMES = new Set(["move_mouse", "click", "click_grid", "drag", "scroll", "press_key", "hold_key", "type_text"]);

// Assemble the tool list the LLM sees for a given scheme (token-efficient: the
// model only gets the inputs that actually apply to this game).
function buildActiveTools(scheme, gridEnabled = true) {
  const cfg = CONTROL_SCHEMES[scheme] ?? CONTROL_SCHEMES["browser-kbm"];
  const shared = TOOLS.filter(t => SHARED_TOOL_NAMES.has(t.name));
  let kbm = cfg.inputs.includes("kbm") ? TOOLS.filter(t => KBM_TOOL_NAMES.has(t.name)) : [];
  if (!gridEnabled) kbm = kbm.filter(t => t.name !== "click_grid");
  const pad = cfg.inputs.includes("gamepad") ? GAMEPAD_TOOLS : [];
  return [...shared, ...kbm, ...pad];
}

// Human-readable control description injected into the system prompt.
function controlSchemeDescription(scheme, pauseToThink, gridEnabled = false) {
  const cfg = CONTROL_SCHEMES[scheme] ?? CONTROL_SCHEMES["browser-kbm"];
  const lines = [];
  if (cfg.inputs.includes("kbm")) {
    lines.push("- Keyboard/mouse: click, drag, scroll, move_mouse, press_key, hold_key, type_text (coordinates are image-space pixels; the backend scales to the real screen)");
    if (gridEnabled) {
      lines.push(`- A labeled grid (columns A-${GRID_LETTERS[GRID_COLS - 1]}, rows 1-${GRID_ROWS}) is drawn on every screenshot. To click, PREFER click_grid with a cell like "C4" (optionally dx,dy 0..1 inside the cell) — it is more reliable than guessing raw pixels.`);
    }
  }
  if (cfg.inputs.includes("gamepad")) {
    lines.push("- Gamepad (virtual Xbox controller): gamepad_button (a/b/x/y/lb/rb/ls/rs/start/back/guide/d-pad), gamepad_stick (analog movement), gamepad_trigger (analog squeeze). Prefer the gamepad for movement/combat in this game.");
  }
  if (pauseToThink && cfg.native) {
    lines.push("- NOTE: the game is automatically FROZEN while you reason and RESUMED right before your action runs, so take your time thinking — but expect your action to execute in real time once issued.");
  }
  return lines.join("\n");
}

// ── No-tools / JSON-action mode (for small local models that can't tool-call) ──
// Many local vision models (e.g. qwen2.5vl in Ollama) reject the `tools` param
// with HTTP 400. In that case we send NO tools and instead ask the model to
// reply with a JSON array of actions, which we parse and execute ourselves.

function buildActionReference(tools) {
  return tools.map(t => {
    const props = t.input_schema?.properties ?? {};
    const req = t.input_schema?.required ?? [];
    const keys = Object.keys(props);
    const args = keys.length
      ? `{ ${keys.map(k => `"${k}"${req.includes(k) ? "" : "?"}`).join(", ")} }`
      : "{ }";
    return `- ${t.name} ${args}`;
  }).join("\n");
}

function buildJsonProtocol(tools) {
  return `

=== HOW YOU CONTROL THE GAME (CRITICAL — this overrides any earlier tool instructions) ===
You cannot call functions. Each turn, reply with ONLY ONE JSON object — no prose, no markdown, no code fences.
Look at the screenshot FIRST, then decide. Fill every field:

{"see":"<what is actually on screen right now>",
 "plan":"<why this move is best given what you see>",
 "score":<current score as a number, or null if not visible>,
 "tool":"<name>","input":{ ...args }}

Example:
{"see":"top row 4,8,2,2; bottom-right holds the largest tile 64; one empty cell bottom-left",
 "plan":"merge the two 2s on the right while keeping 64 pinned in the bottom-right corner",
 "score":1240,
 "tool":"press_key","input":{"key":"right"}}

Available tools (?=optional arg):
${buildActionReference(tools)}

RULES:
- Output ONE JSON object only. No arrays, no extra text, no code fences.
- "see" must describe THIS screenshot — actual tile values and positions, not a generic sentence. Do not repeat a previous turn's description.
- "plan" must justify THIS move specifically. Never reuse the same sentence every turn.
- Every turn must end in a real screen-changing action (press_key / click / gamepad_button …), never analysis alone.
- Read the score off the screen into "score" when you can see it.`;
}

// Extract a list of {tool, input} from a model's free-text reply.
function parseJsonActions(text) {
  if (!text) return [];
  let s = String(text).replace(/```(?:json)?/gi, "").trim();
  const tryParse = (str) => { try { return JSON.parse(str); } catch { return null; } };
  let data = tryParse(s);
  if (!data) {
    const arr = s.match(/\[[\s\S]*\]/);
    const obj = s.match(/\{[\s\S]*\}/);
    data = (arr && tryParse(arr[0])) || (obj && tryParse(obj[0])) || null;
  }
  if (!data) return [];
  let items = Array.isArray(data) ? data : (Array.isArray(data.actions) ? data.actions : [data]);
  return items.map(it => {
    if (!it || typeof it !== "object") return null;
    const tool = it.tool || it.action || it.name;
    if (!tool) return null;
    let input = it.input || it.args || it.arguments;
    if (!input || typeof input !== "object") {
      // flattened form e.g. {"tool":"press_key","key":"up"} — drop the
      // reasoning fields so they never get passed as tool arguments
      const { tool: _t, action: _a, name: _n, see: _s, plan: _p, why: _w,
              reasoning: _r, score: _sc, ...rest } = it;
      input = rest;
    }
    return {
      tool,
      input: input || {},
      see: typeof it.see === "string" ? it.see : null,
      plan: typeof it.plan === "string" ? (it.plan) : (typeof it.why === "string" ? it.why : null),
      score: typeof it.score === "number" ? it.score : null,
    };
  }).filter(Boolean);
}

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
  const [ollamaHost, setOllamaHost] = useState("http://localhost:11434");

  // Game config
  const [gameDesc, setGameDesc] = useState("2048");
  const [gameUrl, setGameUrl] = useState("");

  // Timing
  const [timingProfile, setTimingProfile] = useState("arcade");
  const [customTiming, setCustomTiming] = useState({ confirmDelay: 2000, actionPace: 500, mouseSpeed: 0.2, typingInterval: 0.03 });

  // Advanced
  const [skipResearch, setSkipResearch] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxTokens, setMaxTokens] = useState(150000);
  const [gamesPerSession, setGamesPerSession] = useState(1);
  const [gameScores, setGameScores] = useState([]);
  const [gameNumber, setGameNumber] = useState(0);
  const [displaySurface, setDisplaySurface] = useState(null); // monitor | window | browser
  const [useSolver, setUseSolver] = useState(true);

  // Control scheme / input method (play any game: browser, native, KB/mouse, gamepad)
  const [controlScheme, setControlScheme] = useState("browser-kbm");
  const [gridEnabled, setGridEnabled] = useState(true); // labeled click-grid overlay
  const [cropEnabled, setCropEnabled] = useState(false); // HUD crop to game area
  const [cropMargins, setCropMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [previewSrc, setPreviewSrc] = useState(null);
  const [strategyInterval, setStrategyInterval] = useState(1); // B2: vision every N turns (1 = every turn)
  const [noToolsMode, setNoToolsMode] = useState(false); // JSON-action mode for small local models
  // Screenshot width sent to LOCAL models. Vision/prompt-processing time scales
  // with pixel count, so this is the main lever for getting each request to
  // finish before the connection times out.
  const [localImageWidth, setLocalImageWidth] = useState(512);
  const [ollamaViaBackend, setOllamaViaBackendState] = useState(true);
  const [capabilities, setCapabilities] = useState({ gamepad: false, capture: false, windows_api: false, speedhack: false });
  // Native-only options
  const [useNativeCapture, setUseNativeCapture] = useState(false);
  const [nativeWindows, setNativeWindows] = useState([]);
  const [selectedWindowTitle, setSelectedWindowTitle] = useState("");
  const [nativeRegionSet, setNativeRegionSet] = useState(false);
  const [pauseToThink, setPauseToThink] = useState(false);
  const [gameProcess, setGameProcess] = useState("");
  const [attached, setAttached] = useState(false);

  // Runtime state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [log, setLog] = useState([]);
  const [actions, setActions] = useState([]);
  const [turnCount, setTurnCount] = useState(0);
  const [tokenCount, setTokenCount] = useState({ input: 0, output: 0 });
  const [currentScore, setCurrentScore] = useState(null);
  const [bestTile, setBestTile] = useState(0);
  const [bestScore, setBestScore] = useState(null);
  const [gameResult, setGameResult] = useState(null);
  const [memoryData, setMemoryData] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [goals, setGoals] = useState([]);
  const [currentGoalIndex, setCurrentGoalIndex] = useState(0);
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
  // Separate canvas for the solver: it reads at full resolution (the frame is
  // never sent to a model, so pixels are free) and must not have the crop or
  // click-grid overlay applied.
  const solverCanvasRef = useRef(null);
  const solverScaleRef = useRef({ imgW: 0, imgH: 0, realW: 0, realH: 0, scale: 1, offsetX: 0, offsetY: 0 });
  // The board is read from colours and survives downscaling, but the score
  // digits do not: at 1280 the strokes merge and the holes that identify a
  // digit close up. The score boxes are therefore read from their own
  // full-resolution capture.
  const scoreCanvasRef = useRef(null);
  const scoreScaleRef = useRef({ imgW: 0, imgH: 0, realW: 0, realH: 0, scale: 1, offsetX: 0, offsetY: 0 });
  const screenScoreRef = useRef(null);        // SCORE as shown by the game
  const screenBestRef = useRef(null);         // BEST as shown by the game
  const solverScoreRef = useRef(0);
  const solverFailRef = useRef(0);
  const solverBlockedRef = useRef(new Set()); // directions that produced no change
  const solverActiveRef = useRef(false);
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
  const goalsRef = useRef([]);
  const currentGoalIndexRef = useRef(0);
  const lastTurnHashRef = useRef(null);
  const backendHealthRef = useRef(0);
  const streamRef = useRef(null);
  const logEndRef = useRef(null);
  const gameEndRef = useRef(null); // set by signal_game_end tool
  const activeToolsRef = useRef(buildActiveTools("browser-kbm")); // tools for the chosen scheme
  const captureSourceRef = useRef("browser"); // "browser" | "native"
  const pauseToThinkRef = useRef(false);
  const attachedRef = useRef(false);
  const gridEnabledRef = useRef(true);
  const cropRef = useRef({ enabled: false, top: 0, right: 0, bottom: 0, left: 0 });
  const strategyIntervalRef = useRef(1);
  const forceStrategyRef = useRef(false); // force a vision turn (e.g. after stuck)
  const noToolsRef = useRef(false);
  const lastActionNoOpRef = useRef(null);      // description of the last no-op move
  const lastFailedMovesRef = useRef(new Set()); // moves that did nothing on this board
  const noOpStreakRef = useRef(0);             // consecutive actions that changed nothing
  const restartPointRef = useRef(null);        // learned New Game button position
  const gameScoresRef = useRef([]);            // score of each completed game
  const gameBestTileRef = useRef(0);           // highest tile merged this game
  const fullLogRef = useRef([]);               // every log line, uncapped
  const logQueueRef = useRef([]);              // lines not yet written to disk
  const logSessionRef = useRef(
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  );

  const getTiming = useCallback(() => {
    return timingProfile === "custom" ? customTiming : (TIMING_PROFILES[timingProfile] ?? TIMING_PROFILES.arcade);
  }, [timingProfile, customTiming]);

  // The on-screen log keeps only the most recent entries so the page stays
  // responsive, but every line is also kept in full here and mirrored to a file
  // on disk — a long run must not lose its early history, and a crashed tab must
  // still leave a complete record to troubleshoot from.
  const addLog = useCallback((text, type = "info") => {
    const stamp = ts();
    setLog(l => [...l.slice(-300), { id: uid(), ts: stamp, text, type }]);
    const line = `[${stamp}] ${type === "info" ? "" : type.toUpperCase() + ": "}${text}`;
    fullLogRef.current.push(line);
    logQueueRef.current.push(line);
  }, []);

  // Flush queued lines to the backend on a timer: batching keeps a fast solver
  // run from issuing a request per move.
  useEffect(() => {
    const flush = async () => {
      if (!logQueueRef.current.length) return;
      const batch = logQueueRef.current.splice(0, logQueueRef.current.length);
      try {
        await backend("/log/append", { session: logSessionRef.current, lines: batch });
      } catch {
        // Backend down or restarting — keep the lines in the full in-memory copy
        // so "Save log" still produces everything; just do not retry forever.
      }
    };
    const id = setInterval(flush, 2000);
    return () => { flush(); clearInterval(id); };
  }, []);

  const saveLogFile = useCallback(() => {
    const body = fullLogRef.current.join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-${logSessionRef.current}.log`;
    a.click();
    URL.revokeObjectURL(url);
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
        if (r.capabilities) setCapabilities(r.capabilities);
        addLog(`Backend online — ${r.platform} ${r.screen_width}×${r.screen_height}`, "success");
      } else {
        addLog("Backend offline — start agent_server.py first", "error");
      }
    });
  }, [addLog]);

  // Keep refs in sync with control-scheme / native-capture / pause-to-think state
  useEffect(() => { activeToolsRef.current = buildActiveTools(controlScheme, gridEnabled); }, [controlScheme, gridEnabled]);
  useEffect(() => { gridEnabledRef.current = gridEnabled; }, [gridEnabled]);
  useEffect(() => { cropRef.current = { enabled: cropEnabled, ...cropMargins }; }, [cropEnabled, cropMargins]);
  useEffect(() => { strategyIntervalRef.current = Math.max(1, strategyInterval || 1); }, [strategyInterval]);
  useEffect(() => { setOllamaBase(ollamaHost); }, [ollamaHost]);
  useEffect(() => { setOllamaViaBackend(ollamaViaBackend); }, [ollamaViaBackend]);
  useEffect(() => { noToolsRef.current = noToolsMode; }, [noToolsMode]);
  // Local models have tiny context windows — send smaller screenshots to fit.
  useEffect(() => { setMaxFrameW(providerKey === "ollama" ? localImageWidth : 1280); }, [providerKey, localImageWidth]);
  // Local models: exactly ONE screenshot in context (2+ crashes the runner)
  useEffect(() => { setMaxImages(providerKey === "ollama" ? 1 : 2); }, [providerKey]);
  // Smaller payload for local runs — the request often crosses a LAN link
  useEffect(() => { setFrameQuality(providerKey === "ollama" ? 0.6 : 0.85); }, [providerKey]);
  // ...and a short history, so the prompt stays far below a 4096-token context
  useEffect(() => { setWindowTurns(providerKey === "ollama" ? 6 : 20); }, [providerKey]);
  // Reset native-only options when a non-native (browser) scheme is selected
  useEffect(() => {
    if (!CONTROL_SCHEMES[controlScheme]?.native) {
      setUseNativeCapture(false);
      setPauseToThink(false);
      setNativeRegionSet(false);
    }
  }, [controlScheme]);
  useEffect(() => { captureSourceRef.current = useNativeCapture ? "native" : "browser"; }, [useNativeCapture]);
  useEffect(() => { pauseToThinkRef.current = pauseToThink; }, [pauseToThink]);
  useEffect(() => { attachedRef.current = attached; }, [attached]);

  // B4: Continuous backend watchdog — pings every 10s, auto-pauses on 2 consecutive failures
  useEffect(() => {
    const interval = setInterval(async () => {
      let ok = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch("/api/health", { signal: ctrl.signal });
        clearTimeout(timer);
        const j = await res.json();
        ok = j?.status === "ok";
      } catch { ok = false; }

      if (ok) {
        if (backendHealthRef.current > 0 || !backendOk) {
          backendHealthRef.current = 0;
          setBackendOk(true);
          addLog("Backend healthy again.", "success");
        }
      } else {
        backendHealthRef.current++;
        if (backendHealthRef.current >= 2 && backendOk) {
          setBackendOk(false);
          addLog("⚠ Backend health check failed (2 consecutive) — auto-paused.", "error");
          if (running && !pauseRef.current) {
            pauseRef.current = true;
            setPaused(true);
          }
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [backendOk, running, addLog]);

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

      // What was shared decides whether clicks land correctly. Clicks are sent
      // in absolute screen coordinates, but a window/tab capture's origin is
      // that window's corner, not the screen's — so those coordinates would be
      // offset. Only a full-monitor share lines the two up.
      const track = stream.getVideoTracks()[0];
      const surface = track.getSettings?.().displaySurface ?? "unknown";
      setDisplaySurface(surface);
      const SURFACE_LABEL = { monitor: "entire screen", window: "a window", browser: "a browser tab" };
      addLog(`Screen capture started — sharing ${SURFACE_LABEL[surface] ?? surface}`, "success");
      if (surface === "window" || surface === "browser") {
        addLog(
          `⚠ You shared ${SURFACE_LABEL[surface]}. Keyboard works fine, but CLICKS (restart / click_grid) will land at the wrong place, because click coordinates are screen-absolute. Re-share and pick "Entire Screen", then use Crop to game area.`,
          "warn"
        );
      }

      track.addEventListener("ended", () => {
        setCapturing(false);
        setDisplaySurface(null);
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

  // ── Unified frame grab (browser screen-share OR backend native capture) ──────
  const grabFrame = useCallback(async () => {
    let base;
    if (captureSourceRef.current === "native") {
      const r = await backend("/capture/frame");
      if (!r || !r.ok || !r.image || !canvasRef.current) return null;
      await drawDataURLToCanvas(`data:image/jpeg;base64,${r.image}`, canvasRef.current);
      const imgW = canvasRef.current.width, imgH = canvasRef.current.height;
      const realW = r.real_width ?? imgW, realH = r.real_height ?? imgH;
      scaleRef.current = {
        imgW, imgH, realW, realH,
        scale: imgW ? realW / imgW : 1,
        offsetX: r.real_left ?? 0,
        offsetY: r.real_top ?? 0,
      };
      base = { data: r.image, imgW, imgH, realW, realH };
    } else {
      // When cropping, capture at FULL resolution and downscale after the crop.
      // Cropping an already-shrunk frame compounds the reduction (a 384px frame
      // cropped to the board became ~142px — too small to read).
      const cropping = !!cropRef.current?.enabled;
      base = captureFrame(videoRef.current, canvasRef.current, scaleRef, cropping ? 4096 : null);
      if (!base) return null;
    }

    let mutated = false;
    // HUD crop first (changes dimensions + scaleRef offsets) ...
    if (cropRef.current?.enabled && canvasRef.current?.width) {
      if (applyCrop(canvasRef.current, scaleRef, cropRef.current)) {
        mutated = true;
      }
      // ... then bring it down to the target width, so the cropped game area
      // fills the frame at full budget instead of a fraction of it.
      if (canvasRef.current.width > MAX_FRAME_W) {
        downscaleCanvas(canvasRef.current, scaleRef, MAX_FRAME_W);
        mutated = true;
      }
      base = {
        ...base,
        imgW: canvasRef.current.width, imgH: canvasRef.current.height,
        realW: scaleRef.current.realW, realH: scaleRef.current.realH,
      };
    }
    // ... then the labeled click-grid on top of the (possibly cropped) frame.
    if (gridEnabledRef.current && canvasRef.current?.width) {
      drawGrid(canvasRef.current);
      mutated = true;
    }
    if (mutated && canvasRef.current?.width) {
      base = { ...base, data: canvasRef.current.toDataURL("image/jpeg", FRAME_QUALITY).split(",")[1] };
    }
    return base;
  }, []);


  // Grab one frame and show it (with crop + grid applied) so margins can be tuned.
  const previewCrop = useCallback(async () => {
    const f = await grabFrame();
    if (f?.data) setPreviewSrc(`data:image/jpeg;base64,${f.data}`);
    else addLog("Preview unavailable — start capture / select a window first.", "warn");
  }, [grabFrame, addLog]);

  // ── Game speed control (pause-to-think). No-op unless enabled AND attached. ──
  const setGameSpeed = useCallback(async (speed) => {
    if (!pauseToThinkRef.current || !attachedRef.current) return;
    await backend("/game/speed", { speed });
  }, []);

  // ── Native window listing / region selection ─────────────────────────────────
  const listNativeWindows = useCallback(async () => {
    const r = await backend("/capture/windows");
    if (r.ok) {
      setNativeWindows(r.windows ?? []);
      addLog(`Found ${r.windows?.length ?? 0} windows.`, "info");
    } else {
      addLog(`Window list failed: ${r.error}`, "error");
    }
  }, [addLog]);

  const selectNativeWindow = useCallback(async (title) => {
    setSelectedWindowTitle(title);
    if (!title) { setNativeRegionSet(false); return; }
    const r = await backend("/capture/select", { title });
    if (r.ok) {
      setNativeRegionSet(true);
      addLog(`Capture region set to "${title}" (${r.region.width}×${r.region.height}).`, "success");
    } else {
      setNativeRegionSet(false);
      addLog(`Region select failed: ${r.error}`, "error");
    }
  }, [addLog]);

  // ── Attach / detach the speed hack to a running game process ─────────────────
  const attachGame = useCallback(async () => {
    if (!gameProcess.trim()) { addLog("Enter the game's process name (e.g. game.exe).", "warn"); return; }
    const r = await backend("/game/attach", { process: gameProcess.trim() });
    if (r.ok) {
      setAttached(true);
      addLog(`Attached to ${gameProcess} (pid ${r.pid}). Pause-to-think ready.`, "success");
    } else {
      setAttached(false);
      addLog(`Attach failed: ${r.error}`, "error");
    }
  }, [gameProcess, addLog]);

  const detachGame = useCallback(async () => {
    await backend("/game/detach");
    setAttached(false);
    addLog("Detached from game.", "info");
  }, [addLog]);

  // ── executeTool ──────────────────────────────────────────────────────────────
  const executeTool = useCallback(async (toolName, toolInput, toolId) => {
    const timing = getTiming();

    const scaled = (x, y) => {
      const s = scaleRef.current;
      const ox = s.offsetX ?? 0, oy = s.offsetY ?? 0;
      const sc = (!s.scale || s.scale <= 0) ? 1 : s.scale;
      return { x: Math.round(ox + x * sc), y: Math.round(oy + y * sc) };
    };

    const toolResult = (text) => ({
      type: "tool_result",
      tool_use_id: toolId,
      content: [{ type: "text", text }],
    });

    // ── Screen observation ───────────────────────────────────────────────────
    if (toolName === "observe_screen" || toolName === "read_screen_text") {
      const frame = await grabFrame();
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
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/mouse/click", {
        x, y,
        button: toolInput.button ?? "left",
        clicks: toolInput.clicks ?? 1,
        move_duration: timing.mouseSpeed,
      });
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Clicked. Screen ${confirm.changed ? `changed (dist ${confirm.dist.toFixed(1)})` : `unchanged (dist ${confirm.dist.toFixed(2)})`}.`
        : `Error: ${res.error}`);
    }

    if (toolName === "click_grid") {
      const parsed = parseGridCell(toolInput.cell);
      if (!parsed) return toolResult(`Invalid cell "${toolInput.cell}". Use a column letter + row number like "C4" (columns A-${GRID_LETTERS[GRID_COLS - 1]}, rows 1-${GRID_ROWS}).`);
      const s = scaleRef.current;
      const imgW = s.imgW || canvasRef.current?.width || 0;
      const imgH = s.imgH || canvasRef.current?.height || 0;
      if (!imgW || !imgH) return toolResult("Screen not available — capture a frame first.");
      const clamp01 = (v, d) => { const n = typeof v === "number" ? v : d; return Math.max(0, Math.min(1, n)); };
      const cw = imgW / GRID_COLS, ch = imgH / GRID_ROWS;
      const imgX = Math.round((parsed.col + clamp01(toolInput.dx, 0.5)) * cw);
      const imgY = Math.round((parsed.row + clamp01(toolInput.dy, 0.5)) * ch);
      const { x, y } = scaled(imgX, imgY);
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/mouse/click", {
        x, y,
        button: toolInput.button ?? "left",
        clicks: toolInput.clicks ?? 1,
        move_duration: timing.mouseSpeed,
      });
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm, imgX, imgY });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Clicked cell ${toolInput.cell.toUpperCase()} (image ${imgX},${imgY}). Screen ${confirm.changed ? `changed (dist ${confirm.dist.toFixed(1)})` : `unchanged (dist ${confirm.dist.toFixed(2)})`}.`
        : `Error: ${res.error}`);
    }

    if (toolName === "drag") {
      const s1 = scaled(toolInput.x1, toolInput.y1);
      const s2 = scaled(toolInput.x2, toolInput.y2);
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/mouse/drag", { x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y, duration: timing.mouseSpeed * 2, button: toolInput.button ?? "left" });
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? `Dragged. Screen ${confirm.changed ? "changed" : "unchanged"}.` : `Error: ${res.error}`);
    }

    if (toolName === "scroll") {
      const { x, y } = scaled(toolInput.x, toolInput.y);
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/mouse/scroll", { x, y, amount: toolInput.amount });
      await waitChange(grabFrame, canvasRef.current, Math.min(timing.confirmDelay, 1000), undefined, __base);
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? "Scrolled." : `Error: ${res.error}`);
    }

    // ── Keyboard actions ─────────────────────────────────────────────────────
    if (toolName === "press_key") {
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/keyboard/press", { key: toolInput.key });
      if (!res.ok) {
        addLog(`⚠ Backend key error: ${res.error}`, "error");
      } else if (res.focus) {
        // Synthetic keys land on whatever window has OS focus — surface it.
        addLog(`   key "${toolInput.key}" [${res.method ?? "?"}] → focused: "${res.focus}"`, "info");
      }
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      // Track no-op moves so the next turn can tell the model not to repeat them
      if (confirm.changed) {
        lastActionNoOpRef.current = null;
        lastFailedMovesRef.current.clear();
        noOpStreakRef.current = 0;
      } else {
        lastActionNoOpRef.current = `press_key ${toolInput.key}`;
        lastFailedMovesRef.current.add(String(toolInput.key));
        noOpStreakRef.current++;
      }
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Key pressed. Screen ${confirm.changed ? `changed (dist ${confirm.dist.toFixed(1)})` : `unchanged (dist ${confirm.dist.toFixed(2)}) — this direction is BLOCKED, try a different one`}.`
        : `Error: ${res.error}`);
    }

    if (toolName === "hold_key") {
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/keyboard/hold", { key: toolInput.key, duration: toolInput.duration });
      await waitChange(grabFrame, canvasRef.current, Math.min(timing.confirmDelay, 1500), undefined, __base);
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? `Key held for ${toolInput.duration}s.` : `Error: ${res.error}`);
    }

    if (toolName === "type_text") {
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/keyboard/type", { text: toolInput.text, interval: timing.typingInterval });
      await waitChange(grabFrame, canvasRef.current, Math.min(timing.confirmDelay, 1500), undefined, __base);
      addAction(toolName, toolInput, res);
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok ? "Text typed." : `Error: ${res.error}`);
    }

    // ── Gamepad actions ──────────────────────────────────────────────────────
    if (toolName === "gamepad_button") {
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/gamepad/button", { button: toolInput.button, hold: toolInput.hold ?? 0.08 });
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Pressed ${toolInput.button}. Screen ${confirm.changed ? `changed (dist ${confirm.dist.toFixed(1)})` : `unchanged (dist ${confirm.dist.toFixed(2)})`}.`
        : `Error: ${res.error}${res.available === false ? " (install vgamepad + ViGEmBus on Windows)" : ""}`);
    }

    if (toolName === "gamepad_stick") {
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/gamepad/stick", {
        stick: toolInput.stick ?? "left",
        x: toolInput.x ?? 0, y: toolInput.y ?? 0,
        duration: toolInput.duration ?? 0,
      });
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Stick ${toolInput.stick} → (${toolInput.x}, ${toolInput.y}). Screen ${confirm.changed ? "changed" : "unchanged"}.`
        : `Error: ${res.error}`);
    }

    if (toolName === "gamepad_trigger") {
      const __base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/gamepad/trigger", {
        trigger: toolInput.trigger ?? "right",
        value: toolInput.value ?? 1,
        duration: toolInput.duration ?? 0.1,
      });
      const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
      setLastConfirm(confirm);
      addAction(toolName, toolInput, { ...res, ...confirm });
      if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      return toolResult(res.ok
        ? `Trigger ${toolInput.trigger} → ${toolInput.value}. Screen ${confirm.changed ? "changed" : "unchanged"}.`
        : `Error: ${res.error}`);
    }

    // ── Meta tools ───────────────────────────────────────────────────────────
    if (toolName === "analyse_game_state") {
      if (toolInput.strategy) addLog(`Strategy: ${toolInput.strategy}`, "info");
      addLog(`Analysis: ${toolInput.analysis?.slice(0, 200)}`, "info");
      return toolResult("Analysis noted. Now take the action you described.");
    }

    if (toolName === "set_goals") {
      const newGoals = Array.isArray(toolInput.goals) ? toolInput.goals : [];
      const newIdx = typeof toolInput.currentIndex === "number" ? toolInput.currentIndex : 0;
      setGoals(newGoals);
      setCurrentGoalIndex(newIdx);
      goalsRef.current = newGoals;
      currentGoalIndexRef.current = newIdx;
      const active = newGoals[newIdx] ?? "n/a";
      addLog(`Goals (${newIdx + 1}/${newGoals.length}): now working on "${active}"`, "info");
      return toolResult(`Goals set: ${newGoals.length} total. Currently on goal ${newIdx + 1}: "${active}".`);
    }

    if (toolName === "execute_sequence") {
      const actions = Array.isArray(toolInput.actions) ? toolInput.actions.slice(0, 15) : [];
      let executed = 0;
      let noChangeStreak = 0;
      const summary = [];
      let lastConfirmInfo = null;

      for (const a of actions) {
        if (stopRef.current) break;
        while (pauseRef.current && !stopRef.current) await new Promise(r => setTimeout(r, 200));
        if (stopRef.current) break;

        const t = a.tool;
        const inp = a.input ?? {};
        let r;
        // Baseline before this step's action, not after it
        const __base = await snapshotHash(grabFrame, canvasRef.current);

        if (t === "press_key") {
          r = await backend("/keyboard/press", { key: inp.key });
        } else if (t === "type_text") {
          r = await backend("/keyboard/type", { text: inp.text, interval: timing.typingInterval });
        } else if (t === "click") {
          const s = scaled(inp.x, inp.y);
          r = await backend("/mouse/click", {
            x: s.x, y: s.y,
            button: inp.button ?? "left",
            clicks: inp.clicks ?? 1,
            move_duration: timing.mouseSpeed,
          });
        } else if (t === "gamepad_button") {
          r = await backend("/gamepad/button", { button: inp.button, hold: inp.hold ?? 0.08 });
        } else {
          summary.push(`${executed + 1}: unsupported tool "${t}" — skipped`);
          continue;
        }

        const confirm = await waitChange(grabFrame, canvasRef.current, timing.confirmDelay, undefined, __base);
        executed++;
        lastConfirmInfo = confirm;
        addAction(`seq.${t}`, inp, { ok: r?.ok ?? false, ...confirm });

        if (!confirm.changed) {
          noChangeStreak++;
          summary.push(`${executed}: ${t}(${JSON.stringify(inp).slice(0, 30)}) — no change`);
          if (noChangeStreak >= 2) {
            summary.push("ABORT: 2 consecutive no-change actions");
            break;
          }
        } else {
          noChangeStreak = 0;
          summary.push(`${executed}: ${t}(${JSON.stringify(inp).slice(0, 30)}) — changed`);
        }

        if (timing.actionPace > 0) await new Promise(r => setTimeout(r, timing.actionPace));
      }

      if (lastConfirmInfo) setLastConfirm(lastConfirmInfo);
      return toolResult(`Executed ${executed}/${actions.length} actions.\n${summary.join("\n")}`);
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
      // The model may report that the game ended, but not what happened in it.
      // Asked to end a 2048 game it had never played, it reported a win with a
      // final score of 2048 — the number in the site's name — and that
      // overwrote the real result, identically, in every game of a session.
      // Facts the agent measured itself win over anything reported here.
      const end = { ...toolInput };
      if (solverActiveRef.current) {
        const measured = screenScoreRef.current ?? solverScoreRef.current;
        if (measured != null && end.finalScore !== measured) {
          if (end.finalScore != null) {
            addLog(`Ignoring reported score ${end.finalScore} — the game showed ${measured}.`, "warn");
          }
          end.finalScore = measured;
        }
        // A win in 2048 means a 2048 tile was actually built.
        if (end.outcome === "win" && gameBestTileRef.current < 2048) {
          addLog(`Reported a win, but the highest tile built was ${gameBestTileRef.current || "none"} — recording as ended.`, "warn");
          end.outcome = "ended";
        }
      }
      gameEndRef.current = end;
      setGameResult({ outcome: end.outcome, finalScore: end.finalScore, reason: end.reason });
      addLog(`Game ended: ${end.outcome} — ${end.reason ?? ""}`, end.outcome === "win" ? "success" : "warn");
      return toolResult(`Game end recorded: ${end.outcome}`);
    }

    return toolResult(`Unknown tool: ${toolName}`);
  }, [gameDesc, getTiming, addLog, addAction, grabFrame]);

  // ── Solver turn ─────────────────────────────────────────────────────────────
  // Read the real board from pixels, pick a move by search, press the key, then
  // confirm by re-reading the board. No model call at all: reliable and ~instant.
  // Returns { ok } | { gameOver } | { fallback, reason } so the caller can hand
  // the turn back to the LLM if perception fails.
  // Record the biggest tile seen, from every board that reads successfully.
  //
  // Score and highest tile are different achievements — a game can score well
  // past 2048 without ever merging a 2048 tile — and the tile is what says how
  // far the game got. Taking it only from the read that follows a move loses it
  // whenever that particular read fails or the game-over overlay covers the
  // board, even though the tile was plainly there: a 512 could be on screen
  // while the display still read 256.
  const noteBestTile = useCallback((board) => {
    if (!board) return;
    let max = gameBestTileRef.current;
    for (const row of board) for (const v of row) if (v > max) max = v;
    if (max !== gameBestTileRef.current) {
      gameBestTileRef.current = max;
      setBestTile(max);
    }
  }, []);

  // Read SCORE and BEST from the boxes above the board, from a capture that is
  // not downscaled. Passing the board rectangle avoids locating the board a
  // second time at full resolution.
  const readScoresFromScreen = useCallback((plugin, state) => {
    if (!plugin?.readScores || !scoreCanvasRef.current) return null;
    try {
      if (!captureFrame(videoRef.current, scoreCanvasRef.current, scoreScaleRef, 4000)) return null;
      const solverW = solverCanvasRef.current?.width || 0;
      const k = solverW ? scoreCanvasRef.current.width / solverW : 1;
      const r = state?.rect;
      const hint = r ? {
        x: Math.round(r.x * k), y: Math.round(r.y * k),
        w: Math.round(r.w * k), h: Math.round(r.h * k),
      } : null;
      return plugin.readScores(scoreCanvasRef.current, hint);
    } catch {
      return null;
    }
  }, []);

  const solverTurn = useCallback(async (plugin) => {
    const canvas = solverCanvasRef.current;
    if (!canvas) return { fallback: true, reason: "no canvas" };

    // Full-resolution grab, no crop and no grid overlay
    const frame = captureFrame(videoRef.current, canvas, solverScaleRef, SOLVER_CAPTURE_W);
    if (!frame) return { fallback: true, reason: "no frame" };

    // Trust the board read first. It is exact when it succeeds, whereas the
    // game-over overlay check is a heuristic over button-coloured pixels and can
    // misfire (tile digits are nearly the same colour as the buttons). Only fall
    // back to that heuristic when the board genuinely cannot be read, which is
    // what the washed-out overlay actually causes.
    // A cell caught mid-animation is now reported as unreadable rather than
    // silently treated as empty, so give the tiles a moment and look again
    // before giving up on the board.
    let state = plugin.readState(canvas);
    for (let retry = 0; !state && retry < 5; retry++) {
      await new Promise(r => setTimeout(r, 100 + retry * 120));
      captureFrame(videoRef.current, canvas, solverScaleRef, SOLVER_CAPTURE_W);
      state = plugin.readState(canvas);
    }
    if (!state && plugin.lastReadFailure) {
      // Say which cells could not be read and what colour they were, so a
      // failure is diagnosable from the log rather than only visible as a
      // fallback to the model.
      const why = plugin.lastReadFailure();
      if (why) addLog(`Board read failed on: ${why}`, "warn");
    }

    if (state) {
      // Count this board before anything else can go wrong with the turn.
      noteBestTile(state.board);
      if (plugin.isTerminal(state)) {
        return { gameOver: true, board: state.board };
      }
      // A readable board with legal moves means the game is live, whatever the
      // overlay heuristic thinks.
    } else {
      if (plugin.isGameOverScreen?.(canvas)) {
        return { gameOver: true, reason: "game-over overlay (board unreadable)" };
      }
      return { fallback: true, reason: "board not readable" };
    }

    // Don't re-issue a move that just failed to change anything.
    const move = plugin.chooseMove(state, [...solverBlockedRef.current]);
    if (!move) return { gameOver: true, board: state.board };

    const timing = getTiming();
    const res = await backend("/keyboard/press", { key: move.key });
    if (!res.ok) {
      addLog(`⚠ Backend key error: ${res.error}`, "error");
      return { fallback: true, reason: "key failed" };
    }

    // Let the tiles animate, then re-read and compare — a real state check
    // rather than a pixel-difference guess.
    await new Promise(r => setTimeout(r, Math.max(180, timing.actionPace || 0) + 220));
    captureFrame(videoRef.current, canvas, solverScaleRef, SOLVER_CAPTURE_W);
    const after = plugin.readState(canvas);
    const changed = after && JSON.stringify(after.board) !== JSON.stringify(state.board);

    if (changed) {
      solverScoreRef.current += move.gained || 0;

      // Prefer the score the game itself shows. The running total is only as
      // good as the board reads behind it, and when those were wrong it produced
      // scores the board could never have reached. BEST cannot be derived at all
      // — it is the game's own record — so it has to be read too.
      const seen = readScoresFromScreen(plugin, after);
      if (seen) {
        const prev = screenScoreRef.current;
        // Within a game the score never falls, and one move cannot add a huge
        // amount; either failure means a misread, so keep the previous value.
        if (typeof seen.score === "number" && seen.score >= (prev ?? 0) &&
            seen.score - (prev ?? 0) <= 200000) {
          screenScoreRef.current = seen.score;
        }
        // BEST is never below the current score and never decreases.
        if (typeof seen.best === "number" &&
            seen.best >= (screenScoreRef.current ?? 0) &&
            seen.best >= (screenBestRef.current ?? 0)) {
          screenBestRef.current = seen.best;
          setBestScore(seen.best);
        }
      }

      currentScoreRef.current = screenScoreRef.current ?? solverScoreRef.current;
      setCurrentScore(currentScoreRef.current);
      noteBestTile(after.board);
      noOpStreakRef.current = 0;
      lastFailedMovesRef.current.clear();
      solverBlockedRef.current.clear();
    } else {
      noOpStreakRef.current++;
      lastFailedMovesRef.current.add(move.key);
      // Remember that this direction did nothing so the next search picks
      // something else instead of repeating it.
      solverBlockedRef.current.add(move.key);
      if (solverBlockedRef.current.size >= 4) {
        return { gameOver: true, reason: "every direction blocked", board: state.board };
      }
    }

    addAction(`solver.${move.key}`, { key: move.key }, { ok: true, changed });
    return { ok: true, key: move.key, changed, reason: move.reason, board: state.board };
  }, [getTiming, addLog, addAction, readScoresFromScreen, noteBestTile]);

  // ── Restart the game after it ends ──────────────────────────────────────────
  // General pattern: detect terminal state -> click the restart control -> verify.
  // The button's location is remembered after the first success and reused, so
  // later restarts cost no LLM call at all (a small learned "skill").
  const attemptRestart = useCallback(async (systemPrompt, apiKey) => {
    const timing = getTiming();
    const verify = async (base) => {
      const c = await waitChange(grabFrame, canvasRef.current, Math.max(timing.confirmDelay, 2500), 3.0, base);
      return c.changed;
    };

    // 0) If a plugin can find the restart control by colour, use that — no model
    //    call, no click-grid, and it works even when the board is unreadable.
    const plug = useSolver ? findPlugin(gameDesc) : null;

    // A plugin can confirm a restart properly: a fresh 2048 game has exactly one
    // or two tiles on the board. Checking that beats watching for any pixel
    // change, which an animation or a stray repaint can satisfy while the game
    // is in fact still over.
    const verifyFresh = async () => {
      if (!plug?.looksLikeNewGame || !solverCanvasRef.current) return null;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 250));
        captureFrame(videoRef.current, solverCanvasRef.current, solverScaleRef, SOLVER_CAPTURE_W);
        if (plug.isGameOverScreen?.(solverCanvasRef.current)) continue; // overlay still up
        const st = plug.readState(solverCanvasRef.current);
        if (st && plug.looksLikeNewGame(st)) return true;
      }
      return false;
    };

    if (plug?.findRestartButton && solverCanvasRef.current) {
      // Try each distinct button on screen, verifying a real restart each time.
      // At game over both "Try again" (over the board) and "New Game" (above it)
      // will restart, so anything already tried is excluded from the next search
      // instead of being clicked again.
      const tried = [];
      for (let attempt = 0; attempt < 3 && !stopRef.current; attempt++) {
        captureFrame(videoRef.current, solverCanvasRef.current, solverScaleRef, SOLVER_CAPTURE_W);
        const pt = plug.findRestartButton(solverCanvasRef.current, null, tried);
        if (!pt) { if (attempt) addLog("No further restart buttons to try.", "warn"); break; }
        tried.push({ x: pt.x, y: pt.y });
        const s = solverScaleRef.current;
        const sc = (!s.scale || s.scale <= 0) ? 1 : s.scale;
        const x = Math.round((s.offsetX ?? 0) + pt.x * sc);
        const y = Math.round((s.offsetY ?? 0) + pt.y * sc);
        addLog(`Restarting — clicking the ${pt.kind ?? "restart"} button at image ${pt.x},${pt.y} (screen ${x},${y}).`, "info");
        const base = await snapshotHash(grabFrame, canvasRef.current);
        const res = await backend("/mouse/click", { x, y, button: "left", clicks: 1, move_duration: timing.mouseSpeed });
        if (!res.ok) { addLog(`Click failed: ${res.error}`, "warn"); break; }

        const fresh = await verifyFresh();
        if (fresh === true) {
          restartPointRef.current = { x, y };
          addLog("✓ New game started (fresh board confirmed).", "success");
          return true;
        }
        if (fresh === null && await verify(base)) {
          // No plugin verification available — fall back to a screen change
          restartPointRef.current = { x, y };
          addLog("✓ New game started.", "success");
          return true;
        }
        addLog(`That button did not start a new game (attempt ${attempt + 1}/3).`, "warn");
      }
    }

    // 1) Reuse the remembered button position, if we have one.
    if (restartPointRef.current) {
      const { x, y } = restartPointRef.current;
      addLog("Restarting — clicking remembered New Game button…", "info");
      const base = await snapshotHash(grabFrame, canvasRef.current);
      const res = await backend("/mouse/click", { x, y, button: "left", clicks: 1, move_duration: timing.mouseSpeed });
      if (res.ok && await verify(base)) {
        addLog("✓ New game started.", "success");
        return true;
      }
      addLog("Remembered button did not work — asking the model to find it.", "warn");
      restartPointRef.current = null;
    }

    // 2) Ask the model to locate and click it (grid makes small models accurate).
    const savedGrid = gridEnabledRef.current;
    gridEnabledRef.current = true; // click_grid needs the overlay drawn
    try {
      for (let attempt = 1; attempt <= 3 && !stopRef.current; attempt++) {
        const frame = await grabFrame();
        if (!frame) return false;
        const ask = [
          "The game has ENDED (no moves left, or a game-over screen is showing).",
          "Find the button that starts a new game — labelled something like",
          '"New Game", "Try again", "Play again", or "Restart" — and click it.',
          'Reply with ONE JSON object using click_grid, e.g. {"see":"Game over overlay with a Try again button","plan":"click Try again","tool":"click_grid","input":{"cell":"F4"}}',
          "Use the labelled grid drawn on the screenshot to pick the cell containing that button.",
        ].join("\n");

        convRef.current.push({
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } },
            { type: "text", text: ask },
          ],
        });
        convRef.current = pruneConv(convRef.current, checkpointRef.current);

        let resp;
        try {
          resp = await callAI(providerKey, model, systemPrompt, convRef.current, noToolsRef.current ? [] : activeToolsRef.current, apiKey, m => addLog(m, "warn"));
        } catch (e) {
          addLog(`Restart attempt failed: ${e.message}`, "warn");
          continue;
        }

        const txt = (resp.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
        convRef.current.push({ role: "assistant", content: txt || "(restart)" });
        const acts = noToolsRef.current
          ? parseJsonActions(txt)
          : (resp.content ?? []).filter(c => c.type === "tool_use").map(c => ({ tool: c.name, input: c.input }));

        const clickAct = acts.find(a => a.tool === "click_grid" || a.tool === "click");
        if (!clickAct) {
          addLog(`Restart attempt ${attempt}: model did not return a click.`, "warn");
          continue;
        }

        const base = await snapshotHash(grabFrame, canvasRef.current);
        addLog(`→ ${clickAct.tool}(${JSON.stringify(clickAct.input).slice(0, 60)})`, "tool");
        const result = await executeTool(clickAct.tool, clickAct.input, `${clickAct.tool}__restart`);
        const txtOut = (result?.content ?? []).find(c => c.type === "text")?.text ?? "";

        if (await verify(base)) {
          // Remember where that click landed so later restarts skip the LLM.
          const m = txtOut.match(/image (\d+),(\d+)/);
          if (m) {
            const s = scaleRef.current;
            const sc = (!s.scale || s.scale <= 0) ? 1 : s.scale;
            restartPointRef.current = {
              x: Math.round((s.offsetX ?? 0) + Number(m[1]) * sc),
              y: Math.round((s.offsetY ?? 0) + Number(m[2]) * sc),
            };
          }
          addLog("✓ New game started.", "success");
          return true;
        }
        addLog(`Restart attempt ${attempt}: screen did not change.`, "warn");
      }
    } finally {
      gridEnabledRef.current = savedGrid;
    }
    return false;
  }, [getTiming, grabFrame, executeTool, providerKey, model, addLog, useSolver, gameDesc]);

  // ── Solver diagnostics ──────────────────────────────────────────────────────
  // Tile palettes differ between 2048 clones, so rather than guessing colours,
  // measure what is actually on screen and report it.
  const testSolver = useCallback(async () => {
    const plug = findPlugin(gameDesc);
    if (!plug) { addLog(`No solver plugin matches "${gameDesc}".`, "warn"); return; }
    const canvas = solverCanvasRef.current;
    if (!canvas || !videoRef.current) { addLog("Start screen capture first.", "warn"); return; }
    const frame = captureFrame(videoRef.current, canvas, solverScaleRef, SOLVER_CAPTURE_W);
    if (!frame) { addLog("No frame — is screen capture running?", "warn"); return; }

    // Show the frame the solver actually looked at. The most common failure is
    // simply that the game was not visible on screen at capture time, which is
    // obvious from the image but invisible in the numbers.
    try { setPreviewSrc(canvas.toDataURL("image/jpeg", 0.8)); } catch {}

    const d = plug.diagnose(canvas);
    addLog(`── Solver diagnostic ──`, "info");
    addLog(`capture: ${d.canvas} (see the image below — is the game board in it?)`, "info");
    if (d.topColors) addLog(`dominant colours: ${d.topColors.join("  ")}`, "info");
    if (d.rect) addLog(`board found at x${d.rect.x} y${d.rect.y} ${d.rect.w}×${d.rect.h} (tolerance ${d.boardTolerance})`, "info");
    (d.cells ?? []).forEach(c => addLog(`   ${c}`, "info"));
    (d.notes ?? []).forEach(n => addLog(`   note: ${n}`, "warn"));
    if (d.ok) {
      addLog("✓ Board read successfully:", "success");
      addLog(plug.describeState({ board: d.board }), "success");
      const mv = plug.chooseMove({ board: d.board });
      addLog(mv ? `solver would play: ${mv.reason}` : "no legal move (game over)", "success");
    } else {
      addLog("✗ Board NOT readable — copy the lines above so the palette can be corrected.", "error");
    }
    const btn = plug.findRestartButton?.(canvas);
    addLog(btn ? `restart button found at image ${btn.x},${btn.y}` : "restart button not found by colour", btn ? "success" : "warn");
  }, [gameDesc, addLog]);

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

    // Build turn message with current-goal context
    const goalLine = goalsRef.current.length > 0
      ? `\nCurrent goal (${currentGoalIndexRef.current + 1}/${goalsRef.current.length}): ${goalsRef.current[currentGoalIndexRef.current] ?? "n/a"}`
      : "";
    const baseLine = `Turn ${turnCountRef.current}.${goalLine}`;

    // B2: strategy-interval slow loop. Vision (image) turns run every N turns for
    // high-level planning; the turns in between are cheaper text-only "tactical"
    // turns where the model acts on its plan + the textual action feedback. The
    // first play turn and any stuck-triggered turn are forced to be strategy turns.
    const strategyInterval = Math.max(1, strategyIntervalRef.current || 1);
    const forced = forceStrategyRef.current;
    forceStrategyRef.current = false;
    const isStrategyTurn = forced || strategyInterval <= 1 || ((turnCountRef.current - 1) % strategyInterval === 0);

    // Pause-to-think: freeze the game while we capture + reason (no-op unless enabled)
    await setGameSpeed(0);

    // Always grab a frame for hashing / stuck-detection (local, no token cost)
    const frame = await grabFrame();
    const currentHash = frame ? frameHash(canvasRef.current) : null;
    const distFromLast = (currentHash && lastTurnHashRef.current) ? hashDist(lastTurnHashRef.current, currentHash) : 999;
    // A1: even on a strategy turn, skip the image if the screen is unchanged.
    // But never skip right after a no-op action: the model needs to SEE the
    // board again to pick a different move, otherwise it repeats the failed one.
    const lastNoOp = lastActionNoOpRef.current;
    const a1Skip = turnCountRef.current > 1 && distFromLast < 2.0 && !lastNoOp;
    const sendImage = !!frame && isStrategyTurn && !a1Skip;

    // Mode-appropriate nudge: small models must be pushed to ACT, not just analyse.
    let actNudge = noToolsRef.current
      ? 'Reply with ONE JSON action that MOVES the game now, e.g. {"tool":"press_key","input":{"key":"up"}}.'
      : "First call analyse_game_state, then take your next action. Prefer execute_sequence for repetitive moves.";
    // Break repetition loops: a small model will otherwise re-issue the exact
    // move that just did nothing, forever.
    if (lastNoOp) {
      const tried = [...lastFailedMovesRef.current].join(", ");
      actNudge = `Your last move (${lastNoOp}) changed NOTHING — that direction is blocked. Do NOT repeat it.${tried ? ` Already failed here: ${tried}.` : ""} Pick a DIFFERENT direction now. ${actNudge}`;
    }

    if (sendImage) {
      convRef.current.push({
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } },
          { type: "text", text: `${baseLine}\nLook at the screen and make your move. ${actNudge}` },
        ],
      });
    } else if (isStrategyTurn) {
      // Strategy turn but no fresh image (unchanged screen or capture unavailable)
      convRef.current.push({
        role: "user",
        content: frame
          ? `${baseLine}\n[Screen unchanged since last action — image omitted to save tokens.] ${actNudge}`
          : `${baseLine} (screen unavailable) ${actNudge}`,
      });
    } else {
      // Tactical turn — deliberately text-only to save tokens
      convRef.current.push({
        role: "user",
        content: `${baseLine}\nTACTICAL turn (no screenshot, saving tokens). ${actNudge}`,
      });
      addLog(`Tactical turn ${turnCountRef.current} (text-only)`, "info");
    }
    lastTurnHashRef.current = currentHash;

    let resp;
    const __t0 = Date.now();
    try {
      const toolsArg = noToolsRef.current ? [] : activeToolsRef.current;
      resp = await callAI(providerKey, model, systemPrompt, convRef.current, toolsArg, apiKey, msg => addLog(msg, "warn"));
      const secs = ((Date.now() - __t0) / 1000).toFixed(1);
      const kb = sendImage && frame?.data ? Math.round(frame.data.length * 0.75 / 1024) : 0;
      const imgNote = sendImage && frame ? ` (sent ${frame.imgW}×${frame.imgH} image, ~${kb}KB)` : " (no image)";
      addLog(`   LLM replied in ${secs}s${imgNote}`, "info");
    } catch (e) {
      await setGameSpeed(1); // always resume the game on the way out
      addLog(`API error after ${((Date.now() - __t0) / 1000).toFixed(1)}s: ${e.message}`, "error");
      return { stop: true, reason: "api-error" };
    }

    // Reasoning done — resume the game so the action below executes in real time
    await setGameSpeed(1);

    // Accumulate tokens
    if (resp.usage) {
      tokenRef.current.input += resp.usage.input_tokens ?? 0;
      tokenRef.current.output += resp.usage.output_tokens ?? 0;
      setTokenCount({ ...tokenRef.current });
    }
    setTurnCount(t => t + 1);

    // A2: enforce token budget cap — auto-pause when exceeded
    const totalTokens = tokenRef.current.input + tokenRef.current.output;
    if (maxTokens > 0 && totalTokens >= maxTokens && !pauseRef.current) {
      pauseRef.current = true;
      setPaused(true);
      addLog(`⚠️ Token cap reached: ${totalTokens.toLocaleString()} / ${maxTokens.toLocaleString()}. Auto-paused. Resume to continue.`, "warn");
    }

    // Update stuck ring
    const hash = frameHash(canvasRef.current);
    stuckRingRef.current = [...stuckRingRef.current.slice(-6), hash];

    if (noToolsRef.current) {
      // ── JSON-action mode (small local models): plain-text history, parse actions ──
      const text = (resp.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      convRef.current.push({ role: "assistant", content: text || "(no output)" });

      const actions = parseJsonActions(text);

      // Surface the model's reasoning readably instead of dumping raw JSON,
      // and pick up the score it read off the screen (no extra LLM call).
      const lead = actions[0];
      if (lead?.see) addLog(`  👁 ${lead.see.slice(0, 220)}`, "info");
      if (lead?.plan) addLog(`  🧠 ${lead.plan.slice(0, 220)}`, "assistant");
      if (!lead?.see && !lead?.plan && text) addLog(text.slice(0, 300), "assistant");
      // Only trust a model-reported score when nothing better is available.
      // The solver computes the score from actual merges; a small model asked
      // to read it off the screen produced a value that simply doubled every
      // turn (52428800 -> 104857600 -> ... -> 13421772800), which then polluted
      // saved memory. Ignore it while the solver is running, and sanity-check it
      // otherwise: scores only go up, and not by absurd leaps.
      if (typeof lead?.score === "number" && Number.isFinite(lead.score) && !solverActiveRef.current) {
        const prev = currentScoreRef.current;
        const s = Math.round(lead.score);
        const plausible = s >= 0 && s < 10_000_000 &&
          (prev == null || (s >= prev && s <= Math.max(prev * 4, prev + 5000)));
        if (plausible && s !== prev) {
          currentScoreRef.current = s;
          setCurrentScore(s);
        } else if (!plausible) {
          addLog(`Ignoring implausible reported score ${lead.score}.`, "warn");
        }
      }
      const PASSIVE = new Set(["analyse_game_state", "observe_screen", "read_screen_text"]);
      const hasRealAction = actions.some(a => !PASSIVE.has(a.tool));

      if (!actions.length) {
        addLog("No parseable JSON action — nudging model.", "warn");
        convRef.current.push({
          role: "user",
          content: 'Reply with ONLY one JSON object, e.g. {"tool":"press_key","input":{"key":"up"}}. No other text.',
        });
      } else if (!hasRealAction) {
        // Model only analysed/observed — force it to actually move next turn
        addLog("Model only analysed (no move) — pushing it to act.", "warn");
        convRef.current.push({
          role: "user",
          content: 'You only analysed — that does NOTHING. You MUST move now. Reply with ONE JSON object like {"tool":"press_key","input":{"key":"up"}} (up/down/left/right).',
        });
      }

      const feedback = [];
      for (const a of actions) {
        if (stopRef.current) break;
        addLog(`→ ${a.tool}(${JSON.stringify(a.input).slice(0, 100)})`, "tool");
        const result = await executeTool(a.tool, a.input, `${a.tool}__json`);
        for (const c of (result?.content ?? [])) {
          if (c.type === "image") feedback.push(c);
          else if (c.type === "text") {
            feedback.push({ type: "text", text: `${a.tool}: ${c.text}` });
            // Surface the outcome so failures aren't invisible in JSON mode
            addLog(`   ↳ ${c.text.slice(0, 160)}`, c.text.startsWith("Error") ? "error" : "info");
          }
        }
        if (gameEndRef.current) break;
      }
      if (feedback.length) convRef.current.push({ role: "user", content: feedback });
    } else {
      // ── Native tool-calling path ──
      convRef.current.push({ role: "assistant", content: resp.content ?? [] });
      for (const c of resp.content ?? []) {
        if (c.type === "text") addLog(c.text, "assistant");
      }
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
    }

    if (gameEndRef.current) {
      return { stop: true, reason: "game-end", ...gameEndRef.current };
    }

    return { stop: false };
  }, [providerKey, model, addLog, executeTool, maxTokens, grabFrame, setGameSpeed]);

  // ── runResearch ──────────────────────────────────────────────────────────────
  const runResearch = useCallback(async (apiKey) => {
    addLog(`Researching "${gameDesc}" strategies...`, "info");
    try {
      const resp = await callAI(
        providerKey, model,
        "You are a game strategy researcher with deep knowledge of browser and desktop games.",
        [{
          role: "user",
          // This text ends up in the system prompt of every later request, so on
          // a small local context it must be short and directly actionable.
          content: providerKey === "ollama"
            ? `In at most 4 SHORT imperative rules (max 15 words each, no preamble, no headings), how should a player win at "${gameDesc}"? Give only concrete per-move rules, e.g. "keep the largest tile in one corner".`
            : `What are the best strategies for playing "${gameDesc}"? Provide 3-5 concise bullet points covering: core mechanics, optimal strategy, common mistakes to avoid, and any tips for high scores. Use your training knowledge.`,
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

    const nativeMode = useNativeCapture;
    const captureReady = nativeMode ? nativeRegionSet : capturing;
    if (!captureReady) {
      addLog(nativeMode ? "Select a game window to capture first." : "Start screen capture first.", "error");
      return;
    }

    // Lock in the chosen control scheme for this run
    activeToolsRef.current = buildActiveTools(controlScheme, gridEnabled);
    captureSourceRef.current = nativeMode ? "native" : "browser";
    const schemeCfg = CONTROL_SCHEMES[controlScheme] ?? CONTROL_SCHEMES["browser-kbm"];
    const pauseActive = pauseToThink && schemeCfg.native && attachedRef.current;
    pauseToThinkRef.current = pauseActive;
    if (pauseToThink && schemeCfg.native && !attachedRef.current) {
      addLog("Pause-to-think is on but no game is attached — running without it.", "warn");
    }
    addLog(`Control scheme: ${schemeCfg.label}${pauseActive ? " · pause-to-think ON" : ""}`, "info");

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
    goalsRef.current = [];
    currentGoalIndexRef.current = 0;
    lastTurnHashRef.current = null;
    lastActionNoOpRef.current = null;
    lastFailedMovesRef.current = new Set();
    noOpStreakRef.current = 0;
    restartPointRef.current = null;
    gameScoresRef.current = [];
    setGameScores([]);
    setGameNumber(0);
    strategyIntervalRef.current = Math.max(1, strategyInterval || 1);
    forceStrategyRef.current = true; // first play turn is always a vision turn
    noToolsRef.current = noToolsMode;

    setRunning(true);
    setGameResult(null);
    setCurrentScore(null);
    setMilestones([]);
    setGoals([]);
    setCurrentGoalIndex(0);
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

    // Decided before the prompt is built: when a solver plays the game, the
    // model's remaining job is small and its instructions can be far shorter.
    const activePlugin = useSolver ? findPlugin(gameDesc) : null;

    // Research phase. Strategy notes only matter when the model is choosing the
    // moves; with a solver playing they are never consulted, so asking for them
    // costs a request and then sits in every later prompt for nothing.
    let research = null;
    if (!skipResearch && !activePlugin) {
      research = await runResearch(apiKey);
      if (stopRef.current) { setRunning(false); setPhase("idle"); return; }
    } else if (activePlugin && !skipResearch) {
      addLog("Skipping research — the solver picks the moves, so strategy notes are not used.", "info");
    }

    // Build system prompt
    // The system prompt is resent on EVERY request, so unbounded research or
    // memory text permanently eats the context window. On a 4096-token local
    // model that alone can leave no room for the screenshot. Cap both.
    const isLocal = providerKey === "ollama";
    const RESEARCH_CAP = isLocal ? 700 : 2500;
    const MEM_CAP = isLocal ? 350 : 1200;
    const cap = (t, n) => {
      const s = String(t ?? "").trim().replace(/\s+/g, " ");
      return s.length > n ? `${s.slice(0, n)}…` : s;
    };

    const memRaw = mem?.strategies?.length
      ? `Best score: ${mem.bestScore ?? "unknown"}. Strategies: ${mem.strategies.slice(0, isLocal ? 2 : 3).join("; ")}. Discoveries: ${(mem.discoveries ?? []).slice(0, isLocal ? 2 : 5).join("; ")}. Avoid: ${(mem.avoidPatterns ?? []).slice(0, isLocal ? 2 : 3).join("; ")}`
      : "";
    const memCtx = memRaw ? `\n\nPRIOR KNOWLEDGE:\n${cap(memRaw, MEM_CAP)}` : "";

    const researchCtx = research ? `\n\nSTRATEGY NOTES:\n${cap(research, RESEARCH_CAP)}` : "";

    const controlDesc = controlSchemeDescription(controlScheme, pauseActive, gridEnabled);

    // With a solver playing, the model is only called to start a new game or to
    // cover a board that is briefly unreadable. The full playing brief — goals,
    // memory, progress reporting, token-efficiency advice — is dead weight in
    // that mode, and it is resent on every request, so it is cut down to the job
    // that is actually left.
    const solverSystemPrompt = `You are helping run the game "${gameDesc}" on the user's screen.
A deterministic solver reads the board and chooses the moves. You are called only
when it cannot act — usually to start a new game, or when the board is briefly
unreadable.

INPUT CONTROLS (${schemeCfg.label}) — use ONLY these:
${controlDesc}

Each turn, do ONE of these:
- If a "Try again" or "New Game" button is visible, click it to start a game.
- Otherwise press a single arrow key to keep the game moving.
- Call signal_game_end if the game is clearly over and no button is visible.

Say in one short sentence what you see before you act.${noToolsMode ? buildJsonProtocol(activeToolsRef.current) : ""}`;

    const fullSystemPrompt = `You are an autonomous AI game-playing agent playing "${gameDesc}" on the user's screen.

Your goal: Play as well as possible — maximize score and try to win.

INPUT CONTROLS FOR THIS GAME (${schemeCfg.label}) — use ONLY these input tools:
${controlDesc}

OTHER TOOLS AVAILABLE:
- observe_screen / read_screen_text: See the current screen
- execute_sequence: Batch up to 15 actions in ONE tool call — strongly preferred for repetitive moves (e.g. multiple arrow keys in 2048, or repeated gamepad presses). Saves significant tokens.
- analyse_game_state: REQUIRED reasoning step before every physical action
- set_goals: Define and track your ordered sub-goals toward the main objective
- update_memory: Save discoveries and strategies for future sessions
- report_progress: Report scores and milestones
- signal_game_end: Call when the game is over

CRITICAL WORKFLOW RULES (follow every turn):
1. ALWAYS call analyse_game_state FIRST before any physical action (click, press_key, drag, scroll, type_text, move_mouse, hold_key, execute_sequence). State what you see, what you intend to do, and why. This is non-negotiable.
2. Exception: observe_screen, read_screen_text, set_goals, update_memory, report_progress, signal_game_end do NOT need analyse_game_state first.
3. On the FIRST play turn, call set_goals to plan an ordered list of 3-6 concrete sub-goals working toward the main objective.
4. As you complete sub-goals, call set_goals again to update currentIndex. You may also rewrite the goal list if the situation changes.
5. After taking an action, the response tells you whether the screen changed. If unchanged, try a different position/key/approach.
6. TOKEN EFFICIENCY: prefer execute_sequence for repetitive moves (e.g. 3-5 arrow presses in 2048) — one tool call instead of many. If a turn message says "Screen unchanged — image omitted", trust prior observations and continue without requesting a new screen.
7. Call report_progress whenever you achieve a milestone or read a new score.
8. Call signal_game_end immediately when you detect win/loss/game-over.
9. Call update_memory when you discover something repeatable worth remembering across sessions.

COORDINATE SYSTEM:
- All x,y coordinates are in the DOWNSCALED image space (max 1280px wide)
- The backend auto-scales to real screen pixels
- Be precise — click exactly on game elements

REASONING STYLE (for analyse_game_state):
- Be concise: 1-3 sentences max
- State: what you see → which goal you're advancing → what action you'll take next${memCtx}${researchCtx}${noToolsMode ? buildJsonProtocol(activeToolsRef.current) : ""}`;

    const systemPrompt = activePlugin ? solverSystemPrompt : fullSystemPrompt;

    // The system prompt is resent every request. On a small local context a
    // bloated one leaves little room for the screenshot, and llama.cpp cannot
    // shift the KV cache — it reprocesses everything and the turn stalls. This
    // only bites when the model is doing the playing; with a solver it is called
    // rarely and the prompt is already short.
    const promptTokEst = Math.round(systemPrompt.length / 4);
    addLog(`System prompt ≈ ${promptTokEst} tokens${activePlugin ? " (short form — solver is playing)" : ""}`, "info");
    if (isLocal && !activePlugin && promptTokEst > 1200) {
      addLog(`⚠ System prompt is large (≈${promptTokEst} tok) for a local model — turns may stall. Enable "Skip research phase" and/or Clear Memory to shrink it.`, "warn");
    }

    // Study phase — 3 observe-only turns to understand the game state
    setPhase("study");
    addLog("Study phase — observing for 3 turns before playing...", "info");
    const studyToolNames = new Set(["observe_screen", "read_screen_text", "analyse_game_state"]);

    for (let i = 0; i < 3 && !stopRef.current; i++) {
      while (pauseRef.current && !stopRef.current) await new Promise(r => setTimeout(r, 500));
      const frame = await grabFrame();
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
      // The play loop prunes, but the study loop did not — so study sent 1, then
      // 2, then 3 screenshots on successive turns. Prune here too.
      convRef.current = pruneConv(convRef.current, checkpointRef.current);

      try {
        const studyTools = noToolsMode ? [] : TOOLS.filter(t => studyToolNames.has(t.name));
        const resp = await callAI(providerKey, model, systemPrompt, convRef.current, studyTools, apiKey, msg => addLog(msg, "warn"));
        const content = resp.content ?? [];
        if (noToolsMode) {
          // No-tools study: just observe in plain text (no action parsing/execution)
          const text = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
          convRef.current.push({ role: "assistant", content: text || "(observing)" });
          if (text) addLog(`Study ${i + 1}/3: ${text.slice(0, 200)}`, "info");
        } else {
          convRef.current.push({ role: "assistant", content });
          const toolResults = [];
          for (const tu of content.filter(c => c.type === "tool_use")) {
            toolResults.push(await executeTool(tu.name, tu.input, tu.id));
          }
          if (toolResults.length) convRef.current.push({ role: "user", content: toolResults });
          const text = content.find(c => c.type === "text")?.text ?? "";
          if (text) addLog(`Study ${i + 1}/3: ${text.slice(0, 200)}`, "info");
        }
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
    const totalGames = Math.max(1, gamesPerSession || 1);

    solverActiveRef.current = !!activePlugin;
    if (activePlugin) {
      addLog(`⚙ Solver active: ${activePlugin.label} — reading the board from pixels and choosing moves by search.`, "success");
    } else if (useSolver) {
      addLog(`No solver plugin matches "${gameDesc}" — the model will play.`, "info");
    }

    // A session usually starts on the board left behind by the last one, which
    // is finished. Playing it as game 1 burns a game on a board with no legal
    // moves, so clear it first and let game 1 start fresh.
    if (activePlugin?.isTerminal && activePlugin.readState) {
      try {
        captureFrame(videoRef.current, solverCanvasRef.current, solverScaleRef, SOLVER_CAPTURE_W);
        const startState = activePlugin.readState(solverCanvasRef.current);
        const finished = startState
          ? activePlugin.isTerminal(startState)
          : !!activePlugin.isGameOverScreen?.(solverCanvasRef.current);
        if (finished) {
          addLog("Board still shows a finished game — starting a fresh one first.", "info");
          await attemptRestart(systemPrompt, apiKey);
        }
      } catch {
        // Not readable yet (capture still warming up) — the games loop handles it.
      }
    }

    // ── Games loop ───────────────────────────────────────────────────────────
    // Each pass plays one game to completion. When a game ends and more are
    // requested, click the restart control and keep going. This also recovers a
    // game that never started: every move is a no-op, which reads as "no moves
    // left", and the same restart path clicks New Game.
    for (let gameIdx = 0; gameIdx < totalGames && !stopRef.current; gameIdx++) {
      setGameNumber(gameIdx + 1);
      if (totalGames > 1) addLog(`── Game ${gameIdx + 1} of ${totalGames} ──`, "info");

      // Reset per-game tracking
      noOpStreakRef.current = 0;
      lastFailedMovesRef.current = new Set();
      lastActionNoOpRef.current = null;
      stuckTriggerRef.current = 0;
      gameEndRef.current = null;
      solverScoreRef.current = 0;
      solverFailRef.current = 0;
      solverBlockedRef.current = new Set();
      gameBestTileRef.current = 0;
      setBestTile(0);
      screenScoreRef.current = null;   // the game resets SCORE, but not BEST
      let gameOutcome = "ended";

    while (!stopRef.current) {
      while (pauseRef.current && !stopRef.current) await new Promise(r => setTimeout(r, 500));
      if (stopRef.current) break;

      // ── Solver path ──────────────────────────────────────────────────────
      // When a plugin recognises the game, perception and policy are handled
      // deterministically; the model is only consulted if that fails.
      if (activePlugin) {
        const sr = await solverTurn(activePlugin);

        if (sr.gameOver) {
          gameOutcome = "ended";
          addLog(`Board full — no legal moves. Final score ${solverScoreRef.current}.`, "warn");
          if (sr.board) addLog(activePlugin.describeState({ board: sr.board }), "info");
          break;
        }
        if (sr.ok) {
          solverFailRef.current = 0;
          turnCountRef.current++;
          setTurnCount(t => t + 1);
          addLog(`⚙ ${sr.reason}${sr.changed ? "" : " — no change"}`, sr.changed ? "info" : "warn");
          // A solver move that changes nothing means the board read is stale or
          // wrong; a few in a row and we hand back to the model.
          if (!sr.changed && noOpStreakRef.current >= 4) {
            addLog("Solver moves are not changing the board — falling back to the model.", "warn");
            solverFailRef.current = 99;
          }
          if (solverFailRef.current < 3) continue;
        } else {
          solverFailRef.current++;
          addLog(`Solver could not act (${sr.reason}) — attempt ${solverFailRef.current}/3.`, "warn");
          if (solverFailRef.current < 3) { await new Promise(r => setTimeout(r, 400)); continue; }
          addLog("Falling back to the model for this turn.", "warn");
          solverFailRef.current = 0;
        }
      }

      const result = await agentTurn(systemPrompt, apiKey);

      if (result.stop) {
        gameOutcome = result.outcome ?? "ended";
        if (result.finalScore != null) {
          currentScoreRef.current = result.finalScore;
          setCurrentScore(result.finalScore);
        }
        break;
      }

      // ── Stuck detection ──────────────────────────────────────────────────
      // Based on whether ACTIONS actually changed the screen, not on comparing
      // turn-boundary frame hashes. Hash comparison was unreliable: a real 2048
      // move on a cropped board scores ~2-4, below the old 4.0 "similar"
      // threshold, so successful moves counted as no-progress and ended healthy
      // sessions. A genuinely finished game is one where every direction we try
      // does nothing — so require repeated no-ops across SEVERAL DIFFERENT
      // actions before giving up, and reset as soon as anything works.
      const noOps = noOpStreakRef.current;
      const distinctFailed = lastFailedMovesRef.current.size;

      if (noOps === 0) {
        stuckTriggerRef.current = 0; // progress — clear any earlier suspicion
      } else if (noOps >= 3) {
        // Nudge the model to reassess, and make sure it gets a fresh screenshot
        forceStrategyRef.current = true;
        if (noOps === 3 || noOps === 6) {
          convRef.current.push({
            role: "user",
            content: `${noOps} actions in a row changed nothing (tried: ${[...lastFailedMovesRef.current].join(", ") || "n/a"}). Try a DIFFERENT direction you have not just tried. If every direction is blocked, the game is over — call signal_game_end.`,
          });
          addLog(`No progress for ${noOps} actions — asking model to change approach.`, "warn");
        }
      }

      // Give up only when the evidence is strong: either many different actions
      // all failed, or a long run of failures regardless of variety.
      const exhausted = noOps >= 4 && distinctFailed >= 3;
      const hardStop = noOps >= 10;
      if (exhausted || hardStop) {
        gameOutcome = "stuck";
        addLog(
          exhausted
            ? `No moves available — ${distinctFailed} different directions all blocked over ${noOps} actions.`
            : `No progress after ${noOps} consecutive actions.`,
          "warn"
        );
        break;
      }
    }

      // ── Game finished ──────────────────────────────────────────────────────
      const thisScore = gameEndRef.current?.finalScore ?? currentScoreRef.current;
      const thisBestTile = gameBestTileRef.current;
      gameScoresRef.current = [...gameScoresRef.current,
        { game: gameIdx + 1, score: thisScore, bestTile: thisBestTile,
          fromScreen: screenScoreRef.current != null, outcome: gameOutcome }];
      setGameScores([...gameScoresRef.current]);
      addLog(
        `Game ${gameIdx + 1} finished — ${gameOutcome}` +
        `${thisScore != null ? `, score ${thisScore}` : ""}` +
        `${thisBestTile ? `, highest tile ${thisBestTile}` : ""}.`,
        "success");

      finalOutcome = gameOutcome;
      finalScore = thisScore ?? finalScore;

      const moreToPlay = gameIdx + 1 < totalGames;
      if (!moreToPlay || stopRef.current) break;

      // Restart for the next game
      setPhase("restarting");
      const ok = await attemptRestart(systemPrompt, apiKey);
      setPhase("playing");
      if (!ok) {
        addLog("Could not start a new game — ending session.", "warn");
        break;
      }
      // Fresh board: clear per-game state so nothing leaks across games
      currentScoreRef.current = null;
      setCurrentScore(null);
      lastTurnHashRef.current = null;
      forceStrategyRef.current = true;
    }

    // Per-game results, then the session roll-up. Each game is listed on its own
    // line: an average hides which game did what, and the highest tile is the
    // real measure of how far a game got — a game can score well past 2048
    // without ever merging a 2048 tile.
    if (gameScoresRef.current.length > 1) {
      addLog("── Results by game ──", "info");
      for (const g of gameScoresRef.current) {
        addLog(
          `  Game ${g.game}: score ${g.score ?? "unknown"}` +
          `${g.bestTile ? `, highest tile ${g.bestTile}` : ""} (${g.outcome})`,
          "info");
      }
      const scored = gameScoresRef.current.map(g => g.score).filter(s => typeof s === "number");
      const tiles = gameScoresRef.current.map(g => g.bestTile).filter(Boolean);
      if (scored.length) {
        const best = Math.max(...scored);
        const avg = Math.round(scored.reduce((a, b) => a + b, 0) / scored.length);
        addLog(
          `Session totals — games: ${gameScoresRef.current.length}, best score: ${best}, average score: ${avg}` +
          `${tiles.length ? `, highest tile reached: ${Math.max(...tiles)}` : ""}`,
          "success");
        finalScore = best;
      }
    }

    // Post-session analysis — use the LLM to extract structured lessons
    let analysis = null;
    if (turnCountRef.current >= 3) {
      addLog("Running post-session analysis...", "info");
      try {
        const perGame = gameScoresRef.current.length > 1
          ? `\nResults per game:\n${gameScoresRef.current.map(g =>
              `  Game ${g.game}: score ${g.score ?? "unknown"}` +
              `${g.bestTile ? `, highest tile ${g.bestTile}` : ""} (${g.outcome})`).join("\n")}`
          : "";
        const analysisPrompt = `You just completed a session of "${gameDesc}".
Outcome: ${finalOutcome}
Best score of the session: ${finalScore ?? "unknown"}${perGame}
Note: score and highest tile are different achievements. A game can score well
above 2048 without ever merging a 2048 tile; the highest tile says how far it got.
Turns played: ${turnCountRef.current}
Goals at end: ${goalsRef.current.length > 0 ? goalsRef.current.map((g, i) => `${i === currentGoalIndexRef.current ? "▶" : i < currentGoalIndexRef.current ? "✓" : "○"} ${g}`).join("; ") : "none set"}

Review the conversation above and respond with ONLY a valid JSON object in this exact format (no markdown, no commentary):
{
  "bestStrategy": "the single most effective strategy used (under 100 chars)",
  "strategyReason": "why this strategy worked (under 100 chars)",
  "discoveries": ["new game fact 1", "new game fact 2"],
  "mistakes": ["specific mistake or stuck pattern to avoid 1", "..."],
  "nextSessionRule": "one concrete rule to follow next session (under 100 chars)"
}

Be specific and game-actionable. Each discovery and mistake should be under 100 chars. Empty arrays are fine if nothing applies.`;

        const analysisResp = await callAI(
          providerKey, model,
          "You are a game session analyst. Respond with ONLY valid JSON — no markdown fences, no commentary.",
          [...stripAllImages(convRef.current).slice(-40), { role: "user", content: analysisPrompt }],
          [], apiKey, msg => addLog(msg, "warn")
        );
        const text = analysisResp.content?.find(c => c.type === "text")?.text ?? "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
          if (analysis.nextSessionRule) addLog(`Rule for next session: ${analysis.nextSessionRule}`, "success");
          if (analysis.bestStrategy) addLog(`Best strategy: ${analysis.bestStrategy}`, "success");
        } else {
          addLog("Analysis returned no JSON — saving raw text as discovery", "warn");
          analysis = { discoveries: [text.slice(0, 200)] };
        }
      } catch (e) {
        addLog(`Analysis failed: ${e.message}`, "warn");
      }
    }

    // Save session memory (one consolidated call including analysis output)
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    try {
      await saveMemory(gameKey, {
        gameDesc,
        outcome: finalOutcome,
        score: finalScore,
        durationSeconds,
        turnCount: turnCountRef.current,
        strategy: analysis?.bestStrategy,
        strategyReason: analysis?.strategyReason ?? analysis?.nextSessionRule,
        discoveries: analysis?.discoveries,
        avoidPatterns: analysis?.mistakes,
      });
      const updatedMem = await loadMemory(gameKey);
      setMemoryData(updatedMem);
    } catch (e) {
      addLog(`Memory save failed: ${e.message}`, "warn");
    }

    // Ensure the game is never left frozen
    if (pauseToThinkRef.current) { await backend("/game/speed", { speed: 1 }); }

    setRunning(false);
    setPhase("ended");
    addLog(`Session complete — outcome: ${finalOutcome}, turns: ${turnCountRef.current}, duration: ${durationSeconds}s`, "success");
  }, [running, capturing, useNativeCapture, nativeRegionSet, controlScheme, gridEnabled, pauseToThink, strategyInterval, noToolsMode,
      gamesPerSession, attemptRestart, useSolver, solverTurn,
      providerKey, apiKeyInput, gameDesc, skipResearch, agentTurn, runResearch, executeTool, grabFrame, addLog]);

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
    // Local models usually can't tool-call — default them to JSON-action mode.
    setNoToolsMode(key === "ollama");
  }, []);

  const handleApiKeyChange = useCallback((val) => {
    setApiKeyInput(val);
    const prov = PROVIDERS[providerKey];
    if (prov.envKey) setRuntimeKey(prov.envKey, val);
  }, [providerKey]);

  // ── Checklist ────────────────────────────────────────────────────────────────
  const checklist = [
    { label: "Backend online",   done: backendOk },
    { label: "Screen captured",  done: useNativeCapture ? nativeRegionSet : capturing },
    { label: "API key set",      done: !!(apiKeyInput || getEnv(PROVIDERS[providerKey].envKey ?? "")) || providerKey === "ollama" },
    { label: "Game name set",    done: gameDesc.trim().length > 0 },
  ];
  const readyToPlay = checklist.every(c => c.done);

  const phaseColor = { idle: C.dim, research: C.yellow, study: C.accentL, playing: C.green, restarting: C.yellow, ended: C.textDim }[phase] ?? C.dim;
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
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: C.dim, fontSize: 11, textAlign: "center", padding: 8 }}>
                {useNativeCapture
                  ? (nativeRegionSet ? "DirectX capture · region set" : "DirectX capture · pick a window below")
                  : "No capture"}
              </div>
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <canvas ref={solverCanvasRef} style={{ display: "none" }} />
          <canvas ref={scoreCanvasRef} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
            {useNativeCapture
              ? <span style={{ fontSize: 10, color: C.textDim }}>Using backend capture (configured under Control Scheme)</span>
              : (!capturing
                  ? <button onClick={startCapture} style={btnStyle(C.accent)}>Share Screen</button>
                  : <button onClick={stopCapture} style={btnStyle(C.red)}>Stop Capture</button>)
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
          {providerKey === "ollama" && (
            <>
              <div style={{ fontSize: 11, color: C.accentL, marginTop: 8, marginBottom: 2, fontWeight: 700 }}>
                OLLAMA SERVER
              </div>
              <input
                type="text"
                placeholder="Ollama server (e.g. http://192.168.1.50:11434)"
                value={ollamaHost}
                onChange={e => setOllamaHost(e.target.value)}
                style={{ ...inputStyle(), border: `1px solid ${C.accent}` }}
              />
              <div style={{ fontSize: 9, color: C.dim, marginTop: 3 }}>
                localhost = model on this PC. For a separate GPU box, use its IP — and start Ollama there with OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS=* so the browser can reach it.
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", color: C.text, marginTop: 5 }}>
                <input type="checkbox" checked={ollamaViaBackend} onChange={e => setOllamaViaBackendState(e.target.checked)} />
                Relay through local backend
              </label>
              <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>
                Recommended. The browser then only holds a localhost connection, so antivirus/firewall on the LAN path can't cut off long requests mid-think.
              </div>
            </>
          )}
        </div>

        {/* Game config */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>GAME</div>
          <input placeholder="Game name (e.g. 2048)" value={gameDesc} onChange={e => setGameDesc(e.target.value)} style={inputStyle()} />
          <input placeholder="URL (optional)" value={gameUrl} onChange={e => setGameUrl(e.target.value)} style={inputStyle({ marginTop: 4 })} />
        </div>

        {/* Control scheme */}
        <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>CONTROL SCHEME</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Object.entries(CONTROL_SCHEMES).map(([key, s]) => (
              <button key={key} onClick={() => setControlScheme(key)}
                disabled={running}
                style={{ ...btnStyle(controlScheme === key ? C.accent : C.border, running), fontSize: 10, padding: "3px 7px" }}>
                {s.label}
              </button>
            ))}
          </div>

          {/* Gamepad capability hint */}
          {CONTROL_SCHEMES[controlScheme]?.inputs.includes("gamepad") && !capabilities.gamepad && (
            <div style={{ fontSize: 10, color: C.yellow, marginTop: 5 }}>
              ⚠ Gamepad needs <b>vgamepad</b> + the free <b>ViGEmBus</b> driver on Windows.
            </div>
          )}

          {/* Native-only options */}
          {CONTROL_SCHEMES[controlScheme]?.native && (
            <div style={{ marginTop: 8, padding: "7px 8px", background: "#0a0a18", borderRadius: 4, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.textDim, marginBottom: 5 }}>NATIVE GAME OPTIONS</div>

              {/* DirectX capture */}
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={useNativeCapture} disabled={running}
                  onChange={e => { setUseNativeCapture(e.target.checked); if (!e.target.checked) setNativeRegionSet(false); }} />
                Capture via DirectX (dxcam){!capabilities.capture && <span style={{ color: C.yellow }}> — needs dxcam</span>}
              </label>
              <div style={{ fontSize: 9, color: C.dim, margin: "2px 0 0 22px" }}>
                Off = share the game window with the browser instead.
              </div>

              {useNativeCapture && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: "flex", gap: 5 }}>
                    <button onClick={listNativeWindows} disabled={running} style={{ ...btnStyle(C.border, running), fontSize: 10 }}>↻ List windows</button>
                    {nativeRegionSet && <span style={{ fontSize: 10, color: C.green, alignSelf: "center" }}>● region set</span>}
                  </div>
                  {nativeWindows.length > 0 && (
                    <select value={selectedWindowTitle} disabled={running}
                      onChange={e => selectNativeWindow(e.target.value)}
                      style={{ ...inputStyle(), marginTop: 5 }}>
                      <option value="">— pick game window —</option>
                      {nativeWindows.map((w, i) => (
                        <option key={i} value={w.title}>{w.title.slice(0, 40)} ({w.width}×{w.height})</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Pause-to-think */}
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", color: C.text, marginTop: 8 }}>
                <input type="checkbox" checked={pauseToThink} disabled={running}
                  onChange={e => setPauseToThink(e.target.checked)} />
                Pause game while thinking{!capabilities.speedhack && <span style={{ color: C.yellow }}> — needs xspeedhack</span>}
              </label>
              <div style={{ fontSize: 9, color: C.dim, margin: "2px 0 0 22px" }}>
                Freezes a single-player game while the AI reasons. Never use online/anti-cheat games.
              </div>

              {pauseToThink && (
                <div style={{ marginTop: 6, display: "flex", gap: 5 }}>
                  <input placeholder="process e.g. game.exe" value={gameProcess} disabled={running}
                    onChange={e => setGameProcess(e.target.value)} style={inputStyle({ flex: 1 })} />
                  {!attached
                    ? <button onClick={attachGame} disabled={running} style={{ ...btnStyle(C.accent, running), fontSize: 10 }}>Attach</button>
                    : <button onClick={detachGame} style={{ ...btnStyle(C.green), fontSize: 10 }}>● attached</button>
                  }
                </div>
              )}
            </div>
          )}
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
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={useSolver} onChange={e => setUseSolver(e.target.checked)} />
                Use built-in solver when available
                {findPlugin(gameDesc)
                  ? <span style={{ color: C.green, fontSize: 10 }}>● 2048 ready</span>
                  : <span style={{ color: C.dim, fontSize: 10 }}>○ none for this game</span>}
              </label>
              <div style={{ fontSize: 9, color: C.dim, margin: "-2px 0 0 22px" }}>
                Reads the board from pixels and picks moves by search — far more accurate than a small vision model, and uses no tokens. The model still handles game-over and restarts.
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={skipResearch} onChange={e => setSkipResearch(e.target.checked)} />
                Skip research phase
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={noToolsMode} onChange={e => setNoToolsMode(e.target.checked)} />
                Small-model mode (JSON actions)
              </label>
              <div style={{ fontSize: 9, color: C.dim, margin: "-2px 0 0 22px" }}>
                For local models that can't do tool-calling (fixes Ollama HTTP 400). The model replies with JSON actions we parse. Auto-on for Ollama.
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={gridEnabled} onChange={e => setGridEnabled(e.target.checked)} />
                Click-grid overlay
              </label>
              <div style={{ fontSize: 9, color: C.dim, margin: "-2px 0 0 22px" }}>
                Draws a labeled A1-style grid on screenshots and enables the click_grid tool for reliable mouse targeting. Turn off for pure-keyboard games.
              </div>

              {/* HUD crop */}
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: C.text }}>
                <input type="checkbox" checked={cropEnabled} onChange={e => setCropEnabled(e.target.checked)} />
                Crop to game area (HUD mask)
              </label>
              <div style={{ fontSize: 9, color: C.dim, margin: "-2px 0 0 22px" }}>
                Trims browser chrome / HUD so the model focuses on the game. Margins are % of the captured frame.
              </div>
              {cropEnabled && (
                <div style={{ marginLeft: 22, marginTop: 2 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                    {["top", "right", "bottom", "left"].map(side => (
                      <div key={side} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: C.textDim }}>
                        <span style={{ width: 44 }}>{side}</span>
                        <input type="number" min="0" max="45" value={cropMargins[side]}
                          onChange={e => setCropMargins(m => ({ ...m, [side]: Math.max(0, Math.min(45, Number(e.target.value) || 0)) }))}
                          style={inputStyle({ width: 52 })} />
                        <span>%</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={previewCrop} style={{ ...btnStyle(C.border), fontSize: 10, marginTop: 5 }}>Preview</button>
                  {previewSrc && (
                    <img src={previewSrc} alt="crop preview"
                      style={{ display: "block", width: "100%", marginTop: 5, border: `1px solid ${C.border}`, borderRadius: 3 }} />
                  )}
                </div>
              )}
              <div>
                <label style={{ fontSize: 11, color: C.textDim, display: "block", marginBottom: 2 }}>
                  Games per session
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={gamesPerSession}
                  onChange={e => setGamesPerSession(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  style={inputStyle()}
                />
                <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>
                  After each game ends the agent clicks New Game and plays again, then reports best/average score. Also recovers a game that never started.
                </div>
              </div>
              <div>
                <label style={{ fontSize: 11, color: C.textDim, display: "block", marginBottom: 2 }}>
                  Token budget cap (0 = no cap)
                </label>
                <input
                  type="number"
                  min="0"
                  step="10000"
                  value={maxTokens}
                  onChange={e => setMaxTokens(Math.max(0, Number(e.target.value) || 0))}
                  style={inputStyle()}
                />
              </div>
              {providerKey === "ollama" && (
                <div>
                  <label style={{ fontSize: 11, color: C.textDim, display: "block", marginBottom: 2 }}>
                    Local screenshot width (px)
                  </label>
                  <input
                    type="number"
                    min="320"
                    max="1280"
                    step="64"
                    value={localImageWidth}
                    onChange={e => setLocalImageWidth(Math.max(320, Math.min(1280, Number(e.target.value) || 512)))}
                    style={inputStyle()}
                  />
                  <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>
                    Smaller = much faster inference. Lower this if requests time out ("Failed to fetch"). 512 is a good start on 6GB; try 384 if turns still take &gt;30s.
                  </div>
                </div>
              )}
              <div>
                <label style={{ fontSize: 11, color: C.textDim, display: "block", marginBottom: 2 }}>
                  Vision every N turns (1 = every turn)
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="1"
                  value={strategyInterval}
                  onChange={e => setStrategyInterval(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  style={inputStyle()}
                />
                <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>
                  &gt;1 = slow loop: send a screenshot only every N turns; the turns between are cheaper text-only tactical turns. Big token saver for fast/repetitive games.
                </div>
              </div>
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
            {!running && (
              <button
                onClick={async () => {
                  addLog("Test key in 3s — click your GAME window NOW…", "warn");
                  await new Promise(r => setTimeout(r, 3000));
                  const res = await backend("/keyboard/press", { key: "left" });
                  if (res.ok) {
                    addLog(`Test: sent "left" via ${res.method ?? "?"} to focused window: "${res.focus || "unknown"}" (held ${res.held ?? "?"}s). Did the game move?`, "success");
                  } else {
                    addLog(`Test FAILED: ${res.error}`, "error");
                  }
                }}
                style={{ ...btnStyle(C.yellow), fontSize: 11 }}>⌨ Test Key</button>
            )}
            {!running && findPlugin(gameDesc) && (
              <button onClick={testSolver} style={{ ...btnStyle(C.green), fontSize: 11 }}>
                🔍 Test Solver
              </button>
            )}
            {!running && (
              <button onClick={previewCrop} style={{ ...btnStyle(C.accent), fontSize: 11 }}>
                👁 See What Agent Sees
              </button>
            )}
            {!running && gameDesc.trim() && (
              <button onClick={async () => { await clearMemory(slugify(gameDesc)); setMemoryData(null); addLog("Memory cleared.", "warn"); }}
                style={{ ...btnStyle(C.border), fontSize: 11 }}>Clear Memory</button>
            )}
          </div>
          {previewSrc && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: C.textDim, marginBottom: 3 }}>
                EXACTLY what the model receives — is the game board visible and clear?
              </div>
              <img src={previewSrc} alt="agent view"
                style={{ display: "block", width: "100%", border: `1px solid ${C.accent}`, borderRadius: 3 }} />
              <button onClick={() => setPreviewSrc(null)}
                style={{ ...btnStyle(C.border), fontSize: 10, marginTop: 4 }}>Hide</button>
            </div>
          )}
        </div>

        {/* Goals */}
        {goals.length > 0 && (
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, background: "#0a0a18" }}>
            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>
              GOALS ({Math.min(currentGoalIndex, goals.length)}/{goals.length})
            </div>
            {goals.map((g, i) => {
              const done = i < currentGoalIndex;
              const active = i === currentGoalIndex;
              return (
                <div key={i} style={{
                  fontSize: 11, marginBottom: 3, lineHeight: 1.4,
                  color: done ? C.green : active ? C.accentL : C.dim,
                  fontWeight: active ? 700 : 400,
                }}>
                  <span style={{ marginRight: 5 }}>{done ? "✓" : active ? "▶" : "○"}</span>
                  {g}
                </div>
              );
            })}
          </div>
        )}

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
          {bestTile > 0 && <span style={{ fontSize: 11, color: C.yellow }}>Highest tile: {bestTile}</span>}
          {bestScore != null && <span style={{ fontSize: 11, color: C.dim }}>Best: {bestScore}</span>}
          {running && <span style={{ fontSize: 11, color: paused ? C.yellow : C.green }}>● {paused ? "PAUSED" : "RUNNING"}</span>}
          <button
            onClick={saveLogFile}
            title="Download every line of this run, including entries scrolled out of the view above"
            style={{
              marginLeft: "auto", background: "transparent", color: C.dim,
              border: `1px solid ${C.border}`, borderRadius: 4,
              padding: "2px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            ⬇ Save full log
          </button>
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
          {displaySurface && (
            <HudRow
              label="Sharing"
              value={displaySurface === "monitor" ? "screen ✓" : `${displaySurface} ⚠`}
              color={displaySurface === "monitor" ? C.green : C.yellow}
            />
          )}
          {gamesPerSession > 1 && <HudRow label="Game" value={`${gameNumber}/${gamesPerSession}`} color={C.accentL} />}
          {gameScores.length > 0 && (
            <HudRow label="Best" value={Math.max(...gameScores.map(g => g.score ?? 0))} color={C.green} />
          )}
          <HudRow label="In tok"  value={tokenCount.input.toLocaleString()} />
          <HudRow label="Out tok" value={tokenCount.output.toLocaleString()} />
          {maxTokens > 0 && (
            <HudRow
              label="Budget"
              value={`${Math.round(100 * (tokenCount.input + tokenCount.output) / maxTokens)}%`}
              color={(tokenCount.input + tokenCount.output) >= maxTokens ? C.red : (tokenCount.input + tokenCount.output) >= maxTokens * 0.8 ? C.yellow : C.green}
            />
          )}
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
