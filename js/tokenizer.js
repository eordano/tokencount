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

// State
let gptEncode = null;
let gptDecode = null;
const hfTokenizers = {};
const status = {};
const loadPromises = {};
let hfAutoTokenizer = null;
let hfAutoTokenizerPromise = null;

for (const p of MODEL_PROFILES) {
  status[p.name] = "pending";
}

export function getStatus(name) {
  return status[name] || "pending";
}

export function isReady(name) {
  return status[name] === "ready";
}

// Count tokens using real tokenizer, or fallback to heuristic
export function countTokens(text, name) {
  if (!text || text.trim().length === 0) return 0;

  if (name === "openai" && gptEncode) {
    return gptEncode(text).length;
  }

  if (name === "claude") {
    const ct = getClaudeTokenizer();
    if (ct) return ct.countTokens(text);
    return fallbackEstimate(text, name);
  }

  const tokenizer = hfTokenizers[name];
  if (tokenizer) {
    try {
      const ids = tokenizer.encode(text);
      return ids.length;
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

// Encode text into an array of token strings for visualization
export function encodeTokens(text, name) {
  if (!text || text.length === 0) return null;

  if (name === "claude") {
    const ct = getClaudeTokenizer();
    return ct ? ct.encode(text) : null;
  }

  if (name === "openai" && gptEncode && gptDecode) {
    const ids = gptEncode(text);
    const tokens = [];
    let prev = 0;
    for (let i = 0; i < ids.length; i++) {
      const decoded = gptDecode(ids.slice(0, i + 1));
      tokens.push(decoded.slice(prev));
      prev = decoded.length;
    }
    return tokens;
  }

  const tokenizer = hfTokenizers[name];
  if (tokenizer) {
    try {
      const ids = tokenizer.encode(text);
      const tokens = [];
      let prev = 0;
      for (let i = 0; i < ids.length; i++) {
        const decoded = tokenizer.decode(ids.slice(0, i + 1), { skip_special_tokens: true });
        tokens.push(decoded.slice(prev));
        prev = decoded.length;
      }
      return tokens.filter(t => t.length > 0);
    } catch {
      return null;
    }
  }

  return null;
}

// Load HuggingFace transformers library (shared, loaded once)
function loadHfLibrary() {
  if (hfAutoTokenizer) return Promise.resolve(hfAutoTokenizer);
  if (hfAutoTokenizerPromise) return hfAutoTokenizerPromise;
  hfAutoTokenizerPromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1")
    .then((mod) => {
      hfAutoTokenizer = mod.AutoTokenizer;
      return hfAutoTokenizer;
    })
    .catch((err) => {
      console.error("Failed to load @huggingface/transformers:", err);
      hfAutoTokenizerPromise = null;
      throw err;
    });
  return hfAutoTokenizerPromise;
}

// Lazy-load a single model by name. Returns a promise that resolves when ready.
export function loadModel(name, onReady) {
  if (status[name] === "ready" || status[name] === "error") {
    return Promise.resolve();
  }
  if (loadPromises[name]) return loadPromises[name];

  const profile = MODEL_PROFILES.find((p) => p.name === name);
  if (!profile) return Promise.resolve();

  status[name] = "loading";

  let promise;
  if (profile.type === "gpt") {
    promise = import("https://esm.sh/gpt-tokenizer@2.8.1/encoding/o200k_base")
      .then((mod) => {
        gptEncode = mod.encode;
        gptDecode = mod.decode;
        status[name] = "ready";
      })
      .catch((err) => {
        console.error("Failed to load gpt-tokenizer:", err);
        status[name] = "error";
      });
  } else if (profile.type === "ctoc") {
    const vocabUrl = new URL("../data/claude-vocab.json", import.meta.url).href;
    promise = loadClaudeTokenizer(vocabUrl)
      .then(() => { status[name] = "ready"; })
      .catch((err) => {
        console.error("Failed to load Claude tokenizer:", err);
        status[name] = "error";
      });
  } else if (profile.type === "hf") {
    promise = loadHfLibrary()
      .then((AutoTokenizer) => AutoTokenizer.from_pretrained(profile.hfRepo))
      .then((tokenizer) => {
        hfTokenizers[name] = tokenizer;
        status[name] = "ready";
      })
      .catch((err) => {
        console.error(`Failed to load tokenizer for ${name}:`, err);
        status[name] = "error";
      });
  } else {
    return Promise.resolve();
  }

  loadPromises[name] = promise.then(() => {
    if (onReady) onReady(name);
  });
  return loadPromises[name];
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
