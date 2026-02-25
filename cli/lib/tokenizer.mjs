// Node.js tokenizer module for CLI use
// Loads tokenizer models from local filesystem — no network access.

import fs from "node:fs";
import path from "node:path";
import { encode as gptEncode } from "gpt-tokenizer/encoding/o200k_base";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { ClaudeTokenizer } from "../../js/claude-tokenizer.js";

// Block all remote access — CLI is fully offline
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useFSCache = false;

export const MODEL_NAMES = [
  "claude", "openai", "gemini", "deepseek",
  "qwen", "llama", "mistral", "grok", "minimax",
];

// HF model directory names (must match build-cli.mjs output)
const HF_MODELS = {
  gemini:   "gemini",
  deepseek: "deepseek",
  qwen:     "qwen",
  minimax:  "minimax",
  llama:    "llama",
  mistral:  "mistral",
  grok:     "grok",
};

const loaded = {};

export async function loadModel(name, modelsDir) {
  if (loaded[name]) return;

  if (name === "openai") {
    // gpt-tokenizer has encoding data built in — nothing to load
    loaded[name] = { type: "gpt" };
    return;
  }

  if (name === "claude") {
    const vocabPath = path.join(modelsDir, "claude-vocab.json");
    const vocab = JSON.parse(fs.readFileSync(vocabPath, "utf8"));
    loaded[name] = { type: "claude", tokenizer: new ClaudeTokenizer(vocab) };
    return;
  }

  const dir = HF_MODELS[name];
  if (!dir) throw new Error(`Unknown model: ${name}`);
  const localPath = path.join(modelsDir, dir);
  const tokenizer = await AutoTokenizer.from_pretrained(localPath);
  loaded[name] = { type: "hf", tokenizer };
}

export function countTokens(name, text) {
  if (!text || text.length === 0) return 0;

  const entry = loaded[name];
  if (!entry) throw new Error(`Model not loaded: ${name}`);

  if (entry.type === "gpt") {
    return gptEncode(text).length;
  }
  if (entry.type === "claude") {
    return entry.tokenizer.countTokens(text);
  }
  // HF tokenizer
  return entry.tokenizer.encode(text).length;
}
