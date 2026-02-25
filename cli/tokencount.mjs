// tokencount — count tokens in files or stdin using various LLM tokenizers
// Usage: tokencount [options] [path...]

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadModel, countTokens, MODEL_NAMES } from "./lib/tokenizer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BASE_URL = "https://tokencount.eordano.com/";

const HELP = `Usage: tokencount [options] [path...]

Count tokens in files or stdin using LLM tokenizers.

Options:
  -m, --model <name>   Tokenizer model (default: claude)
  -a, --all            Show counts for all models
  -r, --recursive      Recurse into directories
  --ignore <pattern>   Skip files/dirs matching pattern (repeatable)
  --no-gitignore       Don't skip .gitignore'd files when recursing
  -s, --share          Print a shareable URL instead of counts
  -h, --help           Show this help

Models: ${MODEL_NAMES.join(", ")}

When no paths are given, reads from stdin.
Directories require -r; binary files are skipped.

Share mode (-s) takes one or two files (or stdin) and prints a URL
that opens the web app with the text pre-filled. Use two files to
get a side-by-side diff. Override the base URL with TOKEN_COUNT_URL.`;

// ── Arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { model: "claude", all: false, recursive: false, gitignore: true, ignore: [], share: false, help: false, paths: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-r" || arg === "--recursive") {
      args.recursive = true;
    } else if (arg === "--ignore") {
      i++;
      if (i >= argv.length) {
        process.stderr.write("Error: --ignore requires a value\n");
        process.exit(1);
      }
      args.ignore.push(argv[i]);
    } else if (arg === "--no-gitignore") {
      args.gitignore = false;
    } else if (arg === "-s" || arg === "--share") {
      args.share = true;
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

function isInGitRepo(dir) {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function gitListFiles(dir) {
  const out = execSync("git ls-files -z", { cwd: dir, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return out.split("\0").filter(Boolean).map((f) => path.join(dir, f));
}

/**
 * Test whether a file path matches an ignore pattern.
 * Patterns without / match against the basename (like .gitignore).
 * Patterns with / match against the full relative path.
 * Supports * (any chars except /) and ** (any chars including /).
 */
function matchesIgnore(filePath, baseDir, patterns) {
  if (patterns.length === 0) return false;
  const rel = path.relative(baseDir, filePath);
  const basename = path.basename(filePath);
  for (const pat of patterns) {
    const target = pat.includes("/") ? rel : basename;
    const regex = new RegExp(
      "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, "\0")
              .replace(/\*/g, "[^/]*")
              .replace(/\0/g, ".*")
      + "$"
    );
    if (regex.test(target)) return true;
    // Pattern without a glob also matches as a directory prefix
    if (!pat.includes("*") && (rel === pat || rel.startsWith(pat + "/"))) return true;
  }
  return false;
}

function expandDir(dir, useGitignore) {
  if (useGitignore && isInGitRepo(dir)) {
    return gitListFiles(dir).filter((f) => !isBinary(f));
  }
  const entries = fs.readdirSync(dir, { recursive: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const s = fs.statSync(full, { throwIfNoEntry: false });
    if (s && s.isFile() && !isBinary(full)) files.push(full);
  }
  return files;
}

function expandPaths(paths, recursive, useGitignore, ignorePatterns) {
  const files = [];
  for (const p of paths) {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) {
      process.stderr.write(`Error: ${p}: No such file or directory\n`);
      process.exit(1);
    }
    if (stat.isDirectory()) {
      if (!recursive) {
        process.stderr.write(`Error: ${p}: Is a directory (use -r to recurse)\n`);
        process.exit(1);
      }
      for (const f of expandDir(p, useGitignore)) {
        if (!matchesIgnore(f, p, ignorePatterns)) files.push(f);
      }
    } else if (stat.isFile()) {
      files.push(p);
    }
  }
  return files;
}

// ── URL sharing ─────────────────────────────────────────────────────────

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildShareUrl(textA, textB, model, tokens) {
  const obj = { a: textA, b: textB };
  if (model && model !== "claude") obj.m = model;
  if (tokens) obj.t = tokens;
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(obj), "utf8"));
  const base = process.env.TOKEN_COUNT_URL || DEFAULT_BASE_URL;
  return `${base.replace(/\/$/, "")}/?b=${encoded}`;
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
    const files = expandPaths(args.paths, args.recursive, args.gitignore, args.ignore);
    inputs = files.map((f) => ({ name: f, text: fs.readFileSync(f, "utf8") }));
  }

  const modelsDir = findModelsDir();

  // Load requested models
  for (const m of models) {
    await loadModel(m, modelsDir);
  }

  // Share mode — show comparison and print URL
  if (args.share) {
    if (inputs.length > 2) {
      process.stderr.write("Error: --share accepts at most two files (text A and text B)\n");
      process.exit(1);
    }
    const textA = inputs[0]?.text || "";
    const textB = inputs[1]?.text || "";
    const labelA = inputs[0]?.name || "A";
    const labelB = inputs[1]?.name || "B";
    const countA = countTokens(args.model, textA);
    const countB = inputs.length > 1 ? countTokens(args.model, textB) : 0;
    const delta = countB - countA;
    const sign = delta > 0 ? "+" : "";

    process.stderr.write(`  ${args.model}\n`);
    process.stderr.write(formatLine(countA, labelA));
    if (inputs.length > 1) {
      process.stderr.write(formatLine(countB, labelB));
      process.stderr.write(formatLine(`${sign}${delta}`, "delta"));
    }
    process.stderr.write("\n");

    const tokens = { a: countA, b: countB };
    const url = buildShareUrl(textA, textB, args.model, tokens);
    process.stdout.write(url + "\n");
    return;
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
