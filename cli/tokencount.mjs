// tokencount — count tokens in files or stdin using various LLM tokenizers
// Usage: tokencount [options] [path...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, countTokens, MODEL_NAMES } from "./lib/tokenizer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HELP = `Usage: tokencount [options] [path...]

Count tokens in files or stdin using LLM tokenizers.

Options:
  -m, --model <name>   Tokenizer model (default: claude)
  -a, --all            Show counts for all models
  -h, --help           Show this help

Models: ${MODEL_NAMES.join(", ")}

When no paths are given, reads from stdin.
Directories are recursed; binary files are skipped.`;

// ── Arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { model: "claude", all: false, help: false, paths: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-a" || arg === "--all") {
      args.all = true;
    } else if (arg === "-m" || arg === "--model") {
      i++;
      if (i >= argv.length) {
        process.stderr.write("Error: --model requires a value\n");
        process.exit(1);
      }
      args.model = argv[i];
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Error: unknown option: ${arg}\n`);
      process.exit(1);
    } else {
      args.paths.push(arg);
    }
    i++;
  }
  return args;
}

// ── Model directory discovery ────────────────────────────────────────────

function findModelsDir() {
  // 1. Environment variable
  const envDir = process.env.TOKEN_COUNT_MODELS;
  if (envDir) {
    if (fs.existsSync(envDir)) return envDir;
    process.stderr.write(`Warning: TOKEN_COUNT_MODELS path does not exist: ${envDir}\n`);
  }

  // 2. Relative to binary: ../share/tokencount/models/
  const relDir = path.resolve(__dirname, "..", "share", "tokencount", "models");
  if (fs.existsSync(relDir)) return relDir;

  // 3. Sibling models/ directory (dev / dist layout)
  const siblingDir = path.resolve(__dirname, "models");
  if (fs.existsSync(siblingDir)) return siblingDir;

  process.stderr.write(
    "Error: cannot find model data directory.\n" +
    "Set TOKEN_COUNT_MODELS or install via Nix.\n"
  );
  process.exit(1);
}

// ── File utilities ───────────────────────────────────────────────────────

function isBinary(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(8192);
  const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
  fs.closeSync(fd);
  for (let i = 0; i < bytesRead; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function expandPaths(paths) {
  const files = [];
  for (const p of paths) {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) {
      process.stderr.write(`Error: ${p}: No such file or directory\n`);
      process.exit(1);
    }
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(p, { recursive: true });
      for (const entry of entries) {
        const full = path.join(p, entry);
        const s = fs.statSync(full, { throwIfNoEntry: false });
        if (s && s.isFile() && !isBinary(full)) {
          files.push(full);
        }
      }
    } else if (stat.isFile()) {
      files.push(p);
    }
  }
  return files;
}

// ── Output formatting ────────────────────────────────────────────────────

function formatLine(count, label) {
  return `${String(count).padStart(8)} ${label}\n`;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const models = args.all ? MODEL_NAMES : [args.model];

  // Validate model names
  for (const m of models) {
    if (!MODEL_NAMES.includes(m)) {
      process.stderr.write(
        `Error: unknown model '${m}'\nAvailable: ${MODEL_NAMES.join(", ")}\n`
      );
      process.exit(1);
    }
  }

  const modelsDir = findModelsDir();

  // Load requested models
  for (const m of models) {
    await loadModel(m, modelsDir);
  }

  // Read input
  let inputs; // [{ name, text }]
  if (args.paths.length === 0) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    inputs = [{ name: null, text }];
  } else {
    const files = expandPaths(args.paths);
    inputs = files.map((f) => ({ name: f, text: fs.readFileSync(f, "utf8") }));
  }

  // Count and output
  if (args.all) {
    // All-models mode: show each model for each input
    for (const input of inputs) {
      const label = input.name || "stdin";
      for (const m of models) {
        const count = countTokens(m, input.text);
        process.stdout.write(formatLine(count, `${label} (${m})`));
      }
    }
  } else {
    const model = models[0];
    let total = 0;
    for (const input of inputs) {
      const count = countTokens(model, input.text);
      total += count;
      if (inputs.length > 1) {
        process.stdout.write(formatLine(count, input.name));
      }
    }
    if (inputs.length > 1) {
      process.stdout.write(formatLine(total, "total"));
    } else if (inputs.length === 1) {
      process.stdout.write(formatLine(total, inputs[0].name || ""));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
