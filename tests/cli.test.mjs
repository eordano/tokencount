#!/usr/bin/env node
// Integration tests for the tokencount CLI
// Run: npm run test:cli  (after npm run build:cli)

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const CLI = path.join(ROOT, "dist", "tokencount.mjs");

let passed = 0;
let failed = 0;

function run(args, { input, expectExit = 0 } = {}) {
  try {
    const result = execSync(`node "${CLI}" ${args}`, {
      cwd: ROOT,
      encoding: "utf8",
      input,
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (expectExit !== 0) {
      throw new Error(`Expected exit code ${expectExit}, got 0`);
    }
    return result;
  } catch (err) {
    if (expectExit !== 0 && err.status === expectExit) {
      return err.stderr || err.stdout || "";
    }
    throw err;
  }
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Pre-flight check ─────────────────────────────────────────────────────

if (!fs.existsSync(CLI)) {
  console.error("Error: dist/tokencount.mjs not found. Run 'npm run build:cli' first.");
  process.exit(1);
}

console.log("CLI integration tests\n");

// ── Tests ────────────────────────────────────────────────────────────────

test("--help shows usage", () => {
  const out = run("--help");
  assert(out.includes("Usage:"), "should contain Usage:");
  assert(out.includes("--model"), "should mention --model");
  assert(out.includes("--all"), "should mention --all");
});

test("stdin with default model (claude)", () => {
  const out = run("", { input: "Hello, world!" });
  const count = parseInt(out.trim().split(/\s+/)[0], 10);
  assert(count > 0, `token count should be > 0, got ${count}`);
});

test("stdin with --model openai", () => {
  const out = run("-m openai", { input: "Hello, world!" });
  const count = parseInt(out.trim().split(/\s+/)[0], 10);
  assert(count > 0, `token count should be > 0, got ${count}`);
});

test("stdin with --all shows all models", () => {
  const out = run("-a", { input: "Hello" });
  const lines = out.trim().split("\n");
  assert(lines.length === 9, `expected 9 lines, got ${lines.length}`);
  assert(out.includes("(claude)"), "should include claude");
  assert(out.includes("(openai)"), "should include openai");
  assert(out.includes("(gemini)"), "should include gemini");
});

test("single file shows count", () => {
  const out = run(`"${path.join(ROOT, "README.md")}"`);
  const count = parseInt(out.trim().split(/\s+/)[0], 10);
  assert(count > 0, `token count should be > 0, got ${count}`);
  assert(out.includes("README.md"), "should show filename");
});

test("directory shows per-file counts and total", () => {
  const jsDir = path.join(ROOT, "js");
  const out = run(`"${jsDir}"`);
  const lines = out.trim().split("\n");
  assert(lines.length > 2, `expected multiple lines, got ${lines.length}`);
  const lastLine = lines[lines.length - 1];
  assert(lastLine.includes("total"), "last line should be total");
});

test("multiple files show total", () => {
  const f1 = path.join(ROOT, "README.md");
  const f2 = path.join(ROOT, "package.json");
  const out = run(`"${f1}" "${f2}"`);
  const lines = out.trim().split("\n");
  assert(lines.length === 3, `expected 3 lines (2 files + total), got ${lines.length}`);
  assert(lines[2].includes("total"), "last line should be total");
});

test("invalid model name exits with error", () => {
  const out = run("-m bogus", { input: "test", expectExit: 1 });
  assert(out.includes("unknown model"), "should say unknown model");
});

test("empty stdin returns 0 tokens", () => {
  const out = run("", { input: "" });
  const count = parseInt(out.trim().split(/\s+/)[0], 10);
  assert(count === 0, `expected 0 tokens, got ${count}`);
});

// ── Share mode ──────────────────────────────────────────────────────────

test("--share with stdin prints URL with ?b= param", () => {
  const out = run("-s", { input: "Hello, world!" });
  assert(out.includes("?b="), "should contain ?b= query param");
  assert(out.includes("eordano.com"), "should use default base URL");
});

test("--share with two files prints URL and comparison to stderr", () => {
  const f1 = path.join(ROOT, "README.md");
  const f2 = path.join(ROOT, "package.json");
  const out = run(`-s "${f1}" "${f2}"`);
  assert(out.includes("?b="), "should contain ?b= query param");
});

test("--share URL decodes to valid JSON with a and b fields", () => {
  const out = run("-s", { input: "test text" });
  const url = new URL(out.trim());
  const b64 = url.searchParams.get("b");
  assert(b64, "should have b param");
  // Decode base64url
  let raw = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (raw.length % 4) raw += "=";
  const json = Buffer.from(raw, "base64").toString("utf8");
  const obj = JSON.parse(json);
  assert(obj.a === "test text", `expected a='test text', got '${obj.a}'`);
  assert(typeof obj.b === "string", "should have b field");
  assert(typeof obj.t === "object", "should have t (tokens) field");
  assert(typeof obj.t.a === "number" && obj.t.a > 0, "should have token count for a");
});

test("--share with --model includes model in payload", () => {
  const out = run("-s -m openai", { input: "Hello" });
  const url = new URL(out.trim());
  const b64 = url.searchParams.get("b");
  let raw = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (raw.length % 4) raw += "=";
  const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  assert(obj.m === "openai", `expected model 'openai', got '${obj.m}'`);
});

test("--share respects TOKEN_COUNT_URL env var", () => {
  const result = execSync(
    `echo "hi" | node "${CLI}" -s`,
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, TOKEN_COUNT_URL: "http://localhost:8000" } }
  );
  assert(result.includes("http://localhost:8000/?b="), `expected custom base URL, got: ${result.trim()}`);
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
