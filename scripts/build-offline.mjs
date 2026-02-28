#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const TMP = path.join(ROOT, ".bundle-tmp");
const DIST = path.join(ROOT, "dist");

const HF_REPOS = [
  "Xenova/gemma-2-tokenizer",
  "deepseek-ai/DeepSeek-V3",
  "Qwen/Qwen3-0.6B",
  "MiniMaxAI/MiniMax-Text-01",
  "Xenova/llama4-tokenizer",
  "mistralai/Mistral-Nemo-Instruct-2407",
  "Xenova/grok-1-tokenizer",
];
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

function patchSource() {
  console.log("[1/6] Patching source for offline bundling...");

  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(TMP, "js"), { recursive: true });

  for (const file of fs.readdirSync(path.join(ROOT, "js"))) {
    fs.copyFileSync(path.join(ROOT, "js", file), path.join(TMP, "js", file));
  }

  let src = fs.readFileSync(path.join(TMP, "js", "tokenizer.js"), "utf8");

  const existingImport = 'import { loadClaudeTokenizer, getClaudeTokenizer } from "./claude-tokenizer.js";';
  src = src.replace(
    existingImport,
    `${existingImport}
import { encode as __gptEncode, decode as __gptDecode } from "gpt-tokenizer/encoding/o200k_base";
import { AutoTokenizer as __HfAutoTokenizer, env as __hfEnv } from "@huggingface/transformers";`
  );

  src = src.replace(
    /function loadHfLibrary\(\) \{[\s\S]*?^}/m,
    `function loadHfLibrary() {
  if (hfAutoTokenizer) return Promise.resolve(hfAutoTokenizer);
  __hfEnv.remoteHost = "https://offline.invalid";
  __hfEnv.allowLocalModels = false;
  __hfEnv.useBrowserCache = false;
  hfAutoTokenizer = __HfAutoTokenizer;
  return Promise.resolve(hfAutoTokenizer);
}`
  );

  src = src.replace(
    /if \(profile\.type === "gpt"\) \{\s*promise = import\("https:\/\/esm\.sh\/gpt-tokenizer@[\d.]+\/encoding\/o200k_base"\)\s*\.then\(\(mod\) => \{\s*gptEncode = mod\.encode;\s*gptDecode = mod\.decode;\s*status\[name\] = "ready";\s*\}\)/,
    `if (profile.type === "gpt") {
    promise = Promise.resolve().then(() => {
      gptEncode = __gptEncode;
      gptDecode = __gptDecode;
      status[name] = "ready";
    })`
  );

  src = src.replace(
    'const vocabUrl = new URL("../data/claude-vocab.json", import.meta.url).href;',
    'const vocabUrl = "https://offline.invalid/data/claude-vocab.json";'
  );

  fs.writeFileSync(path.join(TMP, "js", "tokenizer.js"), src);
}

async function bundle() {
  console.log("[2/6] Bundling with esbuild...");
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(TMP, "js", "app.js")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    outfile: path.join(DIST, "bundle.js"),
    define: {
      "import.meta.url": JSON.stringify("https://offline.invalid/js/app.js"),
    },
    nodePaths: [path.join(ROOT, "node_modules")],
    plugins: [onnxShimPlugin],
  });
}

async function downloadModels() {
  console.log("[3/6] Downloading tokenizer model data...");

  const models = {};
  const modelsDir = process.env.MODELS_DIR;

  if (modelsDir) {
    console.log(`  Using local model data from ${modelsDir}`);
    for (const repo of HF_REPOS) {
      models[repo] = {};
      for (const file of HF_FILES) {
        const filePath = path.join(modelsDir, repo, file);
        console.log(`  Reading ${repo}/${file}...`);
        models[repo][file] = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
    }
  } else {
    for (const repo of HF_REPOS) {
      models[repo] = {};
      for (const file of HF_FILES) {
        const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
        console.log(`  Fetching ${repo}/${file}...`);
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        }
        models[repo][file] = await res.json();
      }
    }
  }

  const claudeVocab = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "claude-vocab.json"), "utf8")
  );

  return { models, claudeVocab };
}

function generateInterceptor(models, claudeVocab) {
  console.log("[4/6] Generating fetch interceptor...");

  const modelsJson = JSON.stringify(models);
  const vocabJson = JSON.stringify(claudeVocab);

  return `(function(){
var MODELS=${modelsJson};
var CLAUDE_VOCAB=${vocabJson};
var _origFetch=window.fetch;
window.fetch=function(input,init){
  var url=(typeof input==="string")?input:(input instanceof Request)?input.url:String(input);
  for(var repo in MODELS){
    for(var file in MODELS[repo]){
      if(url.indexOf(repo)!==-1&&url.indexOf(file)!==-1){
        var body=JSON.stringify(MODELS[repo][file]);
        return Promise.resolve(new Response(body,{status:200,headers:{"Content-Type":"application/json"}}));
      }
    }
  }
  if(url.indexOf("claude-vocab")!==-1){
    var body=JSON.stringify(CLAUDE_VOCAB);
    return Promise.resolve(new Response(body,{status:200,headers:{"Content-Type":"application/json"}}));
  }
  return _origFetch.apply(this,arguments);
};
})();`;
}

function assembleHtml(interceptorJs) {
  console.log("[5/6] Assembling single HTML file...");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const bundleJs = fs.readFileSync(path.join(DIST, "bundle.js"), "utf8");

  let out = html;

  out = out.replace(
    /<link rel="stylesheet" href="css\/style\.css">/,
    `<style>\n${css}\n</style>`
  );

  const safeInterceptor = interceptorJs.replaceAll("</script", "<\\/script");
  const safeBundle = bundleJs.replaceAll("</script", "<\\/script");

  out = out.replace(
    /<script type="module" src="js\/app\.js"><\/script>/,
    () => `<script>${safeInterceptor}</script>\n<script>${safeBundle}</script>`
  );

  const outPath = path.join(DIST, "tokencount.html");
  fs.writeFileSync(outPath, out);

  const sizeMB = (Buffer.byteLength(out) / 1024 / 1024).toFixed(1);
  console.log(`  Output: ${outPath} (${sizeMB} MB)`);
}

function createArchive() {
  console.log("[6/6] Creating tar.gz archive...");
  execSync(
    `tar -czf tokencount-offline.tar.gz -C dist tokencount.html`,
    { cwd: ROOT }
  );
  fs.renameSync(
    path.join(ROOT, "tokencount-offline.tar.gz"),
    path.join(DIST, "tokencount-offline.tar.gz")
  );
  console.log("  Archive: dist/tokencount-offline.tar.gz");
}

async function main() {
  console.log("Building offline bundle...\n");

  patchSource();
  await bundle();
  const { models, claudeVocab } = await downloadModels();
  const interceptorJs = generateInterceptor(models, claudeVocab);
  assembleHtml(interceptorJs);
  createArchive();

  fs.rmSync(TMP, { recursive: true });

  console.log("\nDone! Open dist/tokencount.html in a browser (file:/// works).");
}

main().catch((err) => {
  console.error("Build failed:", err);
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true });
  process.exit(1);
});
