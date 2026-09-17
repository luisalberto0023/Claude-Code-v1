// ── The providers, and the models each one starts with ────────────────────────
//
// The model ids here are only where the picker starts. The picker also asks the
// provider which models the key may use (src/llm/models.js), takes any id typed
// into it, and ▶ Start checks the chosen model before a session begins. A fixed
// list is bound to go stale: the one this replaced started the page on Gemini
// 2.5 Flash preview 05-20, shut down November 18, 2025, and every other Gemini id
// in it and the Anthropic default (Claude Sonnet 4, retired June 15, 2026) were
// gone too, so two of the four providers failed out of the box with nothing in
// the page to say why.
//
// Every id below was checked against the provider's own documentation on
// 2026-09-17: platform.claude.com (models overview and deprecations),
// ai.google.dev (models, deprecations and pricing), developers.openai.com
// (models, each model's page and deprecations) and ollama.com/library (tags).
//
// `keyNote` is said next to the key field. Every cloud key typed here lives in
// the page: the browser sends it to the provider itself, so anything that can
// read this tab (an extension, a script that gets into the page) can read the
// key. Until model requests go through the backend, a key made only for this
// agent, with a spend limit, bounds what a leaked one costs.

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic", icon: "🟠", free: false,
    notes: "Best reasoning & vision. Requires API key.",
    // Anthropic sets spend limits per workspace (Console: Settings → Workspaces
    // → Spend limits), and not on the Default Workspace, so the key needs a
    // workspace of its own.
    keyNote: "This key lives in this page: the browser sends it to Anthropic directly, and anything that can read this tab can read it. " +
      "Use a key made only for this agent, in a Console workspace of its own with a monthly spend limit (Settings → Workspaces → Spend limits).",
    envKey: "VITE_ANTHROPIC_API_KEY",
    supportsSearch: true,
    defaultModel: "claude-sonnet-5",
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
      { id: "claude-opus-5", label: "Claude Opus 5 (strongest, slower)" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
    ],
  },
  openai: {
    label: "OpenAI", icon: "🟢", free: false,
    notes: "Requires API key. GPT-5.6 models reason before they answer, and see images.",
    keyNote: "This key lives in this page: the browser sends it to OpenAI directly, and anything that can read this tab can read it. Use a key made only for this agent.",
    envKey: "VITE_OPENAI_API_KEY",
    supportsSearch: false,
    defaultModel: "gpt-5.6-luna",
    models: [
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (lower cost)" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (stronger)" },
      { id: "gpt-4o", label: "GPT-4o (legacy)" },
    ],
  },
  gemini: {
    label: "Google Gemini", icon: "🔵", free: true,
    // Google's pricing page: on the free tier, content is used to improve
    // Google's products.
    notes: "Free tier available (Google may use free-tier prompts and screenshots to improve its products). Best free option.",
    keyNote: "This key lives in this page: the browser sends it to Google directly, and anything that can read this tab can read it. Use a key made only for this agent.",
    envKey: "VITE_GEMINI_API_KEY",
    supportsSearch: true,
    defaultModel: "gemini-3.8-flash",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (free tier ✓)" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (free tier ✓, lighter)" },
    ],
  },
  ollama: {
    label: "Ollama (local)", icon: "🖥️", free: true,
    notes: "100% free & unlimited, runs on your own GPU. Needs Ollama + a vision model pulled.",
    envKey: null,
    supportsSearch: false,
    // Kept as the default: it is the model already pulled on the test PC.
    defaultModel: "qwen2.5vl:3b",
    // Sizes are the download sizes on ollama.com; the GTX 980 Ti has 6 GB.
    models: [
      { id: "qwen2.5vl:3b", label: "Qwen2.5-VL 3B · qwen2.5vl:3b (light, grounding)" },
      { id: "qwen3-vl:4b", label: "Qwen3-VL 4B · qwen3-vl:4b (3.3GB)" },
      { id: "qwen3.5:4b", label: "Qwen3.5 4B · qwen3.5:4b (3.4GB, sees images)" },
      { id: "gemma4:e2b-it-qat", label: "Gemma 4 E2B QAT · gemma4:e2b-it-qat (4.3GB)" },
      { id: "gemma3:4b", label: "Gemma 3 4B · gemma3:4b (screen/OCR)" },
      { id: "moondream", label: "Moondream 2 · moondream (tiny, ~2GB)" },
      { id: "llava:7b", label: "LLaVA 7B · llava:7b (tight on 6GB)" },
      { id: "minicpm-v", label: "MiniCPM-V · minicpm-v (OCR, tight)" },
      { id: "qwen2.5vl:7b", label: "Qwen2.5-VL 7B · qwen2.5vl:7b (needs ~8GB+)" },
    ],
  },
};
