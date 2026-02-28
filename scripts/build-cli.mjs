#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DIST = path.join(ROOT, "dist");
const MODELS_OUT = path.join(DIST, "models");

const HF_REPO_MAP = {
  "Xenova/gemma-2-tokenizer":              "gemini",
  "deepseek-ai/DeepSeek-V3":               "deepseek",
  "Qwen/Qwen3-0.6B":                       "qwen",
  "MiniMaxAI/MiniMax-Text-01":             "minimax",
  "Xenova/llama4-tokenizer":               "llama",
  "mistralai/Mistral-Nemo-Instruct-2407":  "mistral",
  "Xenova/grok-1-tokenizer":               "grok",
};
const HF_FILES = ["tokenizer.json", "tokenizer_config.json"];

const onnxShimPlugin = {
  name: "shims",
  setup(build) {
    build.onResolve({ filter: /^onnxruntime/ }, (args) => ({
      path: args.path,
      namespace: "shim",
    }));
    build.onResolve({ filter: /^sharp$/ }, (args) => ({
      path: args.path,
      namespace: "shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
      contents: "export default {}; export const env = { wasm: {} };",
      loader: "js",
    }));
  },
};

async function bundle() {
  console.log("[1/3] Bundling CLI with esbuild...");
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, "cli", "tokencount.mjs")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    minify: true,
    outfile: path.join(DIST, "tokencount.mjs"),
    banner: { js: "#!/usr/bin/env node" },
    plugins: [onnxShimPlugin],
  });

  const size = (fs.statSync(path.join(DIST, "tokencount.mjs")).size / 1024 / 1024).toFixed(1);
  console.log(`  Output: dist/tokencount.mjs (${size} MB)`);
}

async function copyModels() {
  console.log("[2/3] Preparing model data...");

  if (fs.existsSync(MODELS_OUT)) fs.rmSync(MODELS_OUT, { recursive: true });

  const modelsDir = process.env.MODELS_DIR;

  if (modelsDir) {
    console.log(`  Using local model data from ${modelsDir}`);
    for (const [repo, dir] of Object.entries(HF_REPO_MAP)) {
      const outDir = path.join(MODELS_OUT, dir);
      fs.mkdirSync(outDir, { recursive: true });
      for (const file of HF_FILES) {
        const src = path.join(modelsDir, repo, file);
        console.log(`  Copying ${repo}/${file} → models/${dir}/${file}`);
        fs.copyFileSync(src, path.join(outDir, file));
      }
    }
  } else {
    for (const [repo, dir] of Object.entries(HF_REPO_MAP)) {
      const outDir = path.join(MODELS_OUT, dir);
      fs.mkdirSync(outDir, { recursive: true });
      for (const file of HF_FILES) {
        const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
        console.log(`  Fetching ${repo}/${file}...`);
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        fs.writeFileSync(path.join(outDir, file), text);
      }
    }
  }

  const claudeSrc = path.join(ROOT, "data", "claude-vocab.json");
  console.log("  Copying claude-vocab.json");
  fs.copyFileSync(claudeSrc, path.join(MODELS_OUT, "claude-vocab.json"));
}

function finalize() {
  console.log("[3/3] Finalizing...");

  const cli = path.join(DIST, "tokencount.mjs");
  fs.chmodSync(cli, 0o755);

  try {
    const result = execSync(`echo "hello" | node "${cli}"`, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30000,
    });
    console.log(`  Smoke test: ${result.trim()}`);
  } catch (err) {
    console.error("  Smoke test failed:", err.message);
    process.exit(1);
  }
}

async function main() {
  console.log("Building tokencount CLI...\n");

  await bundle();
  await copyModels();
  finalize();

  console.log("\nDone! Run: ./dist/tokencount.mjs [options] [files...]");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
