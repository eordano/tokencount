#!/usr/bin/env node
/**
 * Fetches the 8 vendor tokenizer tables that build.rs compiles into the CLI,
 * and verifies every one of them against a pinned sha256 before it is kept.
 *
 * The repository does not carry these files: they belong to the model vendors
 * and total ~90 MB. `build.rs` reads them from $TOKEN_COUNT_MODELS, laid out as
 *
 *   <dir>/o200k_base.tiktoken
 *   <dir>/<model>/tokenizer.json     for each of HF_MODELS in build.rs
 *
 * which is exactly what this script writes. Nix (flake.nix) fetches the same
 * files at the same digests; --verify-pins proves the two agree, so a bump in
 * one that is not mirrored in the other fails CI instead of a release.
 *
 * A digest mismatch is fatal and the file is deleted: an upstream that moves
 * must fail loudly rather than quietly change what ships.
 *
 * Usage:
 *   node scripts/fetch-models.mjs <output-dir> [options]
 *
 *   --only <a,b,...>   fetch only these entries (by model name, or "openai")
 *   --force            re-download even when a file already verifies
 *   --verify-pins      compare the pins below against flake.nix and exit
 *   --print-pins       print "<relative path> <sha256>" for every entry
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The pinned table. `name` is the build.rs model key ("openai" for the
 * tiktoken file); `rel` is the path under the output directory; `sha256` is
 * the digest the download must have.
 */
const MODELS = [
  {
    name: "openai",
    rel: "o200k_base.tiktoken",
    url: "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken",
    sha256: "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d",
  },
  {
    name: "gemini",
    repo: "Xenova/gemma-2-tokenizer",
    sha256: "7da53ca29fb16f6b2489482fc0bc6a394162cdab14d12764a1755ebc583fea79",
  },
  {
    name: "deepseek",
    repo: "deepseek-ai/DeepSeek-V3",
    sha256: "621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41",
  },
  {
    name: "qwen",
    repo: "Qwen/Qwen3-0.6B",
    sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
  },
  {
    name: "llama",
    repo: "Xenova/llama4-tokenizer",
    sha256: "83f98afcee90487efa47b12ba910f877285cd0e0b8f93dd6c88440b3fa8e67b3",
  },
  {
    name: "mistral",
    repo: "mistralai/Mistral-Nemo-Instruct-2407",
    sha256: "e11c71726323d33da7b8d6f6f269f1988931c0a52b7122bcdd8c05042974e0db",
  },
  {
    name: "grok",
    repo: "Xenova/grok-1-tokenizer",
    sha256: "f9ea0625debc3e7ee0f0b3c00e933e230ad9c88afe16369f865e8fde3d836faa",
  },
  {
    name: "minimax",
    repo: "MiniMaxAI/MiniMax-Text-01",
    sha256: "ece04384257543dd1c1312991b6042efdc5be09103729a62cc84d718bcc3b1a6",
  },
].map((m) =>
  m.repo
    ? {
        ...m,
        rel: `${m.name}/tokenizer.json`,
        url: `https://huggingface.co/${m.repo}/resolve/main/tokenizer.json`,
      }
    : m
);

const USAGE = `Usage: node scripts/fetch-models.mjs <output-dir> [options]

Downloads the vendor tokenizer tables build.rs compiles in, checking each one
against a pinned sha256.

  --only <a,b,...>   fetch only these entries (openai, gemini, deepseek, qwen,
                     llama, mistral, grok, minimax)
  --force            re-download even when a file already verifies
  --verify-pins      compare the pins here against flake.nix and exit
  --print-pins       print "<relative path> <sha256>" for every entry
  -h, --help         show this help
`;

function fail(message) {
  process.stderr.write(`fetch-models: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: null, only: null, force: false, verifyPins: false, printPins: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      i++;
      if (i >= argv.length) fail(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--only") args.only = new Set(value().split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--force") args.force = true;
    else if (arg === "--verify-pins") args.verifyPins = true;
    else if (arg === "--print-pins") args.printPins = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    else if (args.out === null) args.out = path.resolve(arg);
    else fail(`unexpected argument: ${arg}`);
  }
  return args;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * The digests flake.nix pins for the same eight files, as
 * "<relative path>" -> "<hex>". Nix records them as SRI base64.
 */
function flakePins() {
  const nix = fs.readFileSync(path.join(ROOT, "flake.nix"), "utf8");
  const toHex = (sri) => Buffer.from(sri.replace(/^sha256-/, ""), "base64").toString("hex");
  const pins = new Map();

  const o200k = nix.match(
    /url\s*=\s*"https:\/\/openaipublic\.blob\.core\.windows\.net\/encodings\/o200k_base\.tiktoken";\s*hash\s*=\s*"(sha256-[^"]+)"/
  );
  if (o200k) pins.set("o200k_base.tiktoken", toHex(o200k[1]));

  for (const model of MODELS) {
    if (!model.repo) continue;
    const escaped = model.repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const hit = nix.match(
      new RegExp(`fetchHf\\s+"${escaped}"\\s+"tokenizer\\.json"\\s*\\n?\\s*"(sha256-[^"]+)"`)
    );
    if (hit) pins.set(model.rel, toHex(hit[1]));
  }
  return pins;
}

function verifyPins() {
  const pins = flakePins();
  const problems = [];
  for (const model of MODELS) {
    const nixHex = pins.get(model.rel);
    if (!nixHex) {
      problems.push(`${model.rel}: no matching pin found in flake.nix`);
    } else if (nixHex !== model.sha256) {
      problems.push(`${model.rel}: flake.nix pins ${nixHex}, this script pins ${model.sha256}`);
    }
  }
  if (problems.length) {
    fail(
      `flake.nix and scripts/fetch-models.mjs disagree:\n  ${problems.join("\n  ")}\n` +
        "Both fetch the same vendor files; bump them together."
    );
  }
  process.stdout.write(`pins agree with flake.nix for all ${MODELS.length} files\n`);
}

async function download(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "tokencount-fetch-models" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Fetch with a couple of retries: HuggingFace 429s under CI load. */
async function downloadWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await download(url);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const wait = attempt * 5000;
        process.stderr.write(`  ${err.message}; retrying in ${wait / 1000}s\n`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.printPins) {
    for (const model of MODELS) process.stdout.write(`${model.rel} ${model.sha256}\n`);
    return;
  }
  if (args.verifyPins) {
    verifyPins();
    return;
  }
  if (!args.out) fail(`no output directory given\n\n${USAGE}`);
  if (args.only) {
    const known = new Set(MODELS.map((m) => m.name));
    for (const name of args.only) if (!known.has(name)) fail(`unknown model: ${name}`);
  }

  // The pins are the whole point of this script; a silent divergence from the
  // Nix build would mean two "reproducible" paths shipping different bytes.
  verifyPins();

  const wanted = MODELS.filter((m) => !args.only || args.only.has(m.name));
  for (const model of wanted) {
    const dest = path.join(args.out, model.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (!args.force && fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === model.sha256) {
      process.stdout.write(`ok       ${model.rel} (cached)\n`);
      continue;
    }

    process.stdout.write(`fetching ${model.rel}\n`);
    const body = await downloadWithRetry(model.url);
    const got = sha256(body);
    if (got !== model.sha256) {
      fail(
        `${model.rel}: sha256 mismatch\n` +
          `  url      ${model.url}\n` +
          `  expected ${model.sha256}\n` +
          `  got      ${got}\n` +
          "The upstream file changed. Nothing was written. Verify the new file by\n" +
          "hand, then update BOTH scripts/fetch-models.mjs and flake.nix."
      );
    }
    fs.writeFileSync(dest, body);
    process.stdout.write(`ok       ${model.rel} (${(body.length / 1024 / 1024).toFixed(1)} MB)\n`);
  }
}

main().catch((err) => fail(err.stack || String(err)));
