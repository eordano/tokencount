import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = path.join(ROOT, "dist");

// Hugging Face tokenizer repo -> its dist/models/ directory in the CLI build.
export const HF_REPO_MAP = {
  "Xenova/gemma-2-tokenizer":              "gemini",
  "deepseek-ai/DeepSeek-V3":               "deepseek",
  "Qwen/Qwen3-0.6B":                       "qwen",
  "MiniMaxAI/MiniMax-Text-01":             "minimax",
  "Xenova/llama4-tokenizer":               "llama",
  "mistralai/Mistral-Nemo-Instruct-2407":  "mistral",
  "Xenova/grok-1-tokenizer":               "grok",
};
export const HF_FILES = ["tokenizer.json", "tokenizer_config.json"];

// Stubs the onnxruntime/sharp backends transformers.js imports but tokenizing never runs.
// patchNodeOnnx also cuts the node build's startup require of onnxruntime-node.
export function shimPlugin({ patchNodeOnnx = false } = {}) {
  return {
    name: "shims",
    setup(build) {
      build.onResolve({ filter: /^(onnxruntime|sharp$)/ }, (args) => ({
        path: args.path,
        namespace: "shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        contents: "export default {}; export const env = { wasm: {} }; export class Tensor {}",
        loader: "js",
      }));
      if (!patchNodeOnnx) return;
      build.onLoad({ filter: /transformers\.node\.mjs$/ }, (args) => {
        const src = fs.readFileSync(args.path, "utf8");
        const load = 'requireFromHere("onnxruntime-node")';
        if (!src.includes(load)) throw new Error(`${args.path}: onnxruntime-node load not found`);
        return { contents: src.replace(load, "{}"), loader: "js" };
      });
    },
  };
}

export async function fetchHfText(repo, file) {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  console.log(`  Fetching ${repo}/${file}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
