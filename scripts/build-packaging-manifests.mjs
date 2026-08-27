#!/usr/bin/env node
/**
 * Renders the Scoop and WinGet manifests for a release, with real digests.
 *
 * The copies under packaging/ are templates: they carry the current version but
 * a placeholder hash, because a release's digests do not exist until the
 * release is built. This fills them in from a release's SHA256SUMS and writes
 * the result somewhere else, leaving the templates alone.
 *
 * The Homebrew formula has its own renderer, packaging/homebrew/update-formula.sh,
 * which rewrites four url/sha256 pairs in place; run that alongside this.
 *
 * Neither output can be pushed by the release workflow: the tap, the bucket and
 * microsoft/winget-pkgs are separate repositories, and writing to them needs a
 * cross-repository credential this project deliberately does not hold. The
 * workflow therefore renders them into an artifact for a human to copy. See
 * RELEASE-PACKAGING.md.
 *
 * Usage:
 *   node scripts/build-packaging-manifests.mjs --sums dist/SHA256SUMS --out dist/packaging
 *   node scripts/build-packaging-manifests.mjs --check
 *
 *   --sums <file>   release SHA256SUMS (required unless --check)
 *   --out <dir>     where to write the rendered manifests (default dist/packaging)
 *   --version <v>   override the version (default: read from Cargo.toml)
 *   --check         verify the templates carry the Cargo.toml version; write nothing
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGING = path.join(ROOT, "packaging");

const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const PLACEHOLDER = "0".repeat(64);

const WINGET_FILES = [
  "eordano.tokencount.yaml",
  "eordano.tokencount.installer.yaml",
  "eordano.tokencount.locale.en-US.yaml",
];

function fail(message) {
  process.stderr.write(`build-packaging-manifests: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { sums: null, out: path.join(ROOT, "dist", "packaging"), version: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      i++;
      if (i >= argv.length) fail(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--sums") args.sums = path.resolve(value());
    else if (arg === "--out") args.out = path.resolve(value());
    else if (arg === "--version") args.version = value();
    else if (arg === "--check") args.check = true;
    else fail(`unknown option: ${arg}`);
  }
  return args;
}

function cargoVersion() {
  const toml = fs.readFileSync(path.join(ROOT, "Cargo.toml"), "utf8");
  const pkg = toml.split(/^\[/m).find((section) => section.startsWith("package]"));
  if (!pkg) fail("Cargo.toml has no [package] section");
  const match = pkg.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) fail("Cargo.toml [package] has no version");
  return match[1];
}

/** asset name -> lowercase hex digest, from a coreutils-format SHA256SUMS. */
function readSums(file) {
  if (!fs.existsSync(file)) fail(`checksum file not found: ${file}`);
  const sums = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !/^[0-9a-fA-F]{64}$/.test(parts[0])) continue;
    sums.set(parts[1].replace(/^\*/, ""), parts[0].toLowerCase());
  }
  return sums;
}

/** Every place the templates hardcode a version, and what it must say. */
function versionProblems(version) {
  const problems = [];
  const expect = (file, text) => {
    for (const match of text.matchAll(/(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== version) problems.push(`${file}: mentions ${match[1]}, Cargo.toml says ${version}`);
    }
  };

  const scoop = JSON.parse(fs.readFileSync(path.join(PACKAGING, "scoop", "tokencount.json"), "utf8"));
  if (scoop.version !== version) {
    problems.push(`packaging/scoop/tokencount.json: version ${scoop.version}, Cargo.toml says ${version}`);
  }
  const url = scoop.architecture?.["64bit"]?.url ?? "";
  expect("packaging/scoop/tokencount.json (url)", url);

  for (const name of WINGET_FILES) {
    const text = fs.readFileSync(path.join(PACKAGING, "winget", name), "utf8");
    for (const line of text.split("\n")) {
      if (/^PackageVersion:/.test(line) || /InstallerUrl:/.test(line) || /ReleaseNotesUrl:/.test(line)) {
        expect(`packaging/winget/${name}`, line);
      }
    }
  }

  const formula = fs.readFileSync(path.join(PACKAGING, "homebrew", "tokencount.rb"), "utf8");
  for (const line of formula.split("\n")) {
    if (/^\s*version "/.test(line) || /^\s*url "/.test(line)) {
      expect("packaging/homebrew/tokencount.rb", line);
    }
  }

  return [...new Set(problems)];
}

function renderScoop(version, digest, outDir) {
  const file = path.join(PACKAGING, "scoop", "tokencount.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = version;
  manifest.architecture["64bit"].url =
    `https://github.com/eordano/tokencount/releases/download/v${version}/tokencount-${version}-${WINDOWS_TARGET}.zip`;
  manifest.architecture["64bit"].hash = digest;
  const dest = path.join(outDir, "scoop", "tokencount.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Scoop manifests are 4-space indented, matching the bucket's own style.
  fs.writeFileSync(dest, JSON.stringify(manifest, null, 4) + "\n");
  return dest;
}

function renderWinget(version, digest, outDir) {
  const written = [];
  for (const name of WINGET_FILES) {
    let text = fs.readFileSync(path.join(PACKAGING, "winget", name), "utf8");
    text = text.replace(/^PackageVersion:.*$/m, `PackageVersion: ${version}`);
    text = text.replace(
      /^(\s*InstallerUrl:\s*).*$/m,
      `$1https://github.com/eordano/tokencount/releases/download/v${version}/tokencount-${version}-${WINDOWS_TARGET}.zip`
    );
    // Quoted: an all-digit digest would otherwise parse as a YAML integer.
    text = text.replace(/^(\s*InstallerSha256:\s*).*$/m, `$1"${digest.toUpperCase()}"`);
    // The template's note about the placeholder does not belong in the output.
    text = text.replace(
      /^\s*# Placeholder in this template;[\s\S]*?all-digit digest would otherwise parse as an integer\.\n/m,
      ""
    );
    text = text.replace(
      /^(ReleaseNotesUrl:\s*).*$/m,
      `$1https://github.com/eordano/tokencount/releases/tag/v${version}`
    );
    const dest = path.join(outDir, "winget", name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    written.push(dest);
  }
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version || cargoVersion();

  if (args.check) {
    const problems = versionProblems(version);
    if (problems.length) {
      fail(
        `packaging/ templates are stale:\n  ${problems.join("\n  ")}\n` +
          "Bump the version in packaging/scoop/tokencount.json, packaging/winget/*.yaml\n" +
          "and packaging/homebrew/tokencount.rb to match Cargo.toml."
      );
    }
    process.stdout.write(`packaging templates all say ${version}\n`);
    return;
  }

  if (!args.sums) fail("--sums <SHA256SUMS> is required (or pass --check)");
  const sums = readSums(args.sums);
  const asset = `tokencount-${version}-${WINDOWS_TARGET}.zip`;
  const digest = sums.get(asset);
  if (!digest) fail(`${asset} is not listed in ${args.sums}`);
  if (digest === PLACEHOLDER) fail(`${asset} has a placeholder digest in ${args.sums}`);

  const outputs = [renderScoop(version, digest, args.out), ...renderWinget(version, digest, args.out)];
  for (const file of outputs) process.stdout.write(`wrote ${path.relative(ROOT, file)}\n`);

  const stale = outputs.filter((file) => fs.readFileSync(file, "utf8").includes(PLACEHOLDER));
  if (stale.length) fail(`placeholder digest survived in: ${stale.join(", ")}`);
}

main();
