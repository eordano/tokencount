// Real tokenization using CDN-loaded tokenizer libraries
// openai: gpt-tokenizer (pure JS, o200k_base encoding)
// claude: ctoc trie-based tokenizer (rohangpta/ctoc, ~96% accurate)
// Others (Gemini, DeepSeek, Qwen, Llama, Mistral, Grok, MiniMax): @huggingface/transformers AutoTokenizer

import { loadClaudeTokenizer, getClaudeTokenizer } from "./claude-tokenizer.js";

export const MODEL_PROFILES = [
  { name: "claude",   displayName: "Claude",   label: "Claude 4.6 Opus (and all Claude 3+ models)",   color: "#d4a574", type: "ctoc" },
  { name: "openai",   displayName: "GPT-5",    label: "OpenAI tiktoken (GPT 5.2, Phi-4, and others)", color: "#10a37f", type: "gpt" },
  { name: "gemini",   displayName: "Gemini",   label: "Gemini 3.1 Pro (and all Gemini models)",       color: "#4285f4", type: "hf", hfRepo: "Xenova/gemma-2-tokenizer" },
  { name: "deepseek", displayName: "DeepSeek", label: "DeepSeek V3 (and others)",                     color: "#4D6BFE", type: "hf", hfRepo: "deepseek-ai/DeepSeek-V3" },
  { name: "qwen",     displayName: "Qwen",     label: "Qwen 3 (and Qwen 2.5+ models)",                color: "#ff6a3d", type: "hf", hfRepo: "Qwen/Qwen3-0.6B" },
  { name: "minimax",  displayName: "MiniMax",  label: "MiniMax-Text-01",                              color: "#a78bfa", type: "hf", hfRepo: "MiniMaxAI/MiniMax-Text-01" },
  { name: "llama",    displayName: "Llama",    label: "Llama 3 (all Llama 3 and 4 models)",           color: "#0668E1", type: "hf", hfRepo: "Xenova/llama4-tokenizer" },
  { name: "mistral",  displayName: "Mistral",  label: "Mistral (Nemo, Small 24B, Pixtral)",           color: "#F4A100", type: "hf", hfRepo: "mistralai/Mistral-Nemo-Instruct-2407" },
  { name: "grok",     displayName: "Grok",     label: "Grok (1 and 2, 3 and 4 unknown)",              color: "#E63946", type: "hf", hfRepo: "Xenova/grok-1-tokenizer" },
];

// State — all mutable tokenizer state lives here
const state = {
  status: Object.fromEntries(MODEL_PROFILES.map((p) => [p.name, "pending"])),
  promises: {},       // name → load promise
  gpt: null,          // { encode, decode } once loaded
  hf: {},             // name → HF tokenizer instance
  hfLib: null,        // AutoTokenizer class (shared)
  hfLibPromise: null, // loading promise for the HF library
};

export function getStatus(name) {
  return state.status[name] || "pending";
}

export function isReady(name) {
  return state.status[name] === "ready";
}

// Count tokens using real tokenizer, or fallback to heuristic
export function countTokens(text, name) {
  if (!text || text.trim().length === 0) return 0;

  if (name === "openai" && state.gpt) {
    return state.gpt.encode(text).length;
  }

  if (name === "claude") {
    const ct = getClaudeTokenizer();
    if (ct) return ct.countTokens(text);
    return fallbackEstimate(text, name);
  }

  const tokenizer = state.hf[name];
  if (tokenizer) {
    try {
      return tokenizer.encode(text).length;
    } catch {
      return fallbackEstimate(text, name);
    }
  }

  return fallbackEstimate(text, name);
}

// Count tokens for all models
export function countAllTokenizers(text) {
  return MODEL_PROFILES.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    label: p.label,
    color: p.color,
    tokens: countTokens(text, p.name),
    ready: isReady(p.name),
    status: getStatus(p.name),
  }));
}

// Progressively decode token IDs into an array of token strings
function decodeProgressive(ids, decodeFn) {
  const tokens = [];
  let prev = 0;
  for (let i = 0; i < ids.length; i++) {
    const decoded = decodeFn(ids.slice(0, i + 1));
    tokens.push(decoded.slice(prev));
    prev = decoded.length;
  }
  return tokens;
}

// Encode text into an array of token strings for visualization
export function encodeTokens(text, name) {
  if (!text || text.length === 0) return null;

  if (name === "claude") {
    const ct = getClaudeTokenizer();
    return ct ? ct.encode(text) : null;
  }

  if (name === "openai" && state.gpt) {
    return decodeProgressive(state.gpt.encode(text), state.gpt.decode);
  }

  const tokenizer = state.hf[name];
  if (tokenizer) {
    try {
      const ids = tokenizer.encode(text);
      return decodeProgressive(ids, (slice) =>
        tokenizer.decode(slice, { skip_special_tokens: true })
      ).filter(t => t.length > 0);
    } catch {
      return null;
    }
  }

  return null;
}

// Load HuggingFace transformers library (shared, loaded once)
function loadHfLibrary() {
  if (state.hfLib) return Promise.resolve(state.hfLib);
  if (state.hfLibPromise) return state.hfLibPromise;
  state.hfLibPromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1")
    .then((mod) => {
      state.hfLib = mod.AutoTokenizer;
      return state.hfLib;
    })
    .catch((err) => {
      console.error("Failed to load @huggingface/transformers:", err);
      state.hfLibPromise = null;
      throw err;
    });
  return state.hfLibPromise;
}

// Lazy-load a single model by name. Returns a promise that resolves when ready.
export function loadModel(name, onReady) {
  if (state.status[name] === "ready" || state.status[name] === "error") {
    return Promise.resolve();
  }
  if (state.promises[name]) return state.promises[name];

  const profile = MODEL_PROFILES.find((p) => p.name === name);
  if (!profile) return Promise.resolve();

  state.status[name] = "loading";

  let promise;
  if (profile.type === "gpt") {
    promise = import("https://esm.sh/gpt-tokenizer@3.4.0/encoding/o200k_base")
      .then((mod) => {
        state.gpt = { encode: mod.encode, decode: mod.decode };
        state.status[name] = "ready";
      })
      .catch((err) => {
        console.error("Failed to load gpt-tokenizer:", err);
        state.status[name] = "error";
      });
  } else if (profile.type === "ctoc") {
    const vocabUrl = new URL("../data/claude-vocab.json", import.meta.url).href;
    promise = loadClaudeTokenizer(vocabUrl)
      .then(() => { state.status[name] = "ready"; })
      .catch((err) => {
        console.error("Failed to load Claude tokenizer:", err);
        state.status[name] = "error";
      });
  } else if (profile.type === "hf") {
    promise = loadHfLibrary()
      .then((AutoTokenizer) => AutoTokenizer.from_pretrained(profile.hfRepo))
      .then((tokenizer) => {
        state.hf[name] = tokenizer;
        state.status[name] = "ready";
      })
      .catch((err) => {
        console.error(`Failed to load tokenizer for ${name}:`, err);
        state.status[name] = "error";
      });
  } else {
    return Promise.resolve();
  }

  state.promises[name] = promise.then(() => {
    if (onReady) onReady(name);
  });
  return state.promises[name];
}

// Heuristic fallback (used while tokenizers are loading or on error)
const FALLBACK = {
  openai:   { eng: 4.0, cjk: 1.5 },
  claude:   { eng: 3.7, cjk: 1.4 },
  gemini:   { eng: 4.0, cjk: 1.6 },
  deepseek: { eng: 3.8, cjk: 1.4 },
  qwen:     { eng: 3.5, cjk: 1.2 },
  llama:    { eng: 3.5, cjk: 1.3 },
  mistral:  { eng: 3.8, cjk: 1.4 },
  grok:     { eng: 3.8, cjk: 1.4 },
  minimax:  { eng: 3.8, cjk: 1.3 },
};

function detectCjkRatio(text) {
  if (!text) return 0;
  const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\uff00-\uffef]/g;
  const matches = text.match(cjk);
  return matches ? matches.length / text.length : 0;
}

function fallbackEstimate(text, name) {
  const r = FALLBACK[name] || { eng: 3.7, cjk: 1.4 };
  const cjk = detectCjkRatio(text);
  const cpt = r.eng * (1 - cjk) + r.cjk * cjk;
  const charEst = Math.ceil(text.length / cpt);
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const wordEst = Math.ceil(words * 1.3);
  return Math.max(1, Math.ceil(charEst * 0.6 + wordEst * 0.4));
}
