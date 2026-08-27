#!/usr/bin/env node
/**
 * Assembles the npm publishing tree for the native tokencount CLI.
 *
 * Out of one version number (Cargo.toml, the single source of truth) and the
 * archives attached to a GitHub release, this produces:
 *
 *   dist/npm/tokencount/                 root package: launcher + optionalDependencies
 *   dist/npm/@tokencount/<plat>-<arch>/  one package per release target, binary inside
 *
 * Staging lives under dist/ because dist/ is already gitignored.
 *
 * The root package is staged rather than published straight from the repo so
 * that the five optionalDependencies exist only in the published manifest:
 * putting them in the repo's package.json would desynchronise
 * package-lock.json and break `npm ci` for every contributor.
 *
 * Usage:
 *   node scripts/build-npm-packages.mjs [options]
 *
 *   --artifacts <dir>  release archives + SHA256SUMS (default: dist/release-artifacts)
 *   --out <dir>        staging root (default: dist/npm)
 *   --version <ver>    override the version (default: read from Cargo.toml)
 *   --root-only        stage just the root package (needs no archives)
 *   --stamp            also rewrite the repo's package.json/package-lock.json version
 *   --check            verify versions only; write nothing, exit 1 on drift
 *   --print-version    print the Cargo.toml version and exit
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS_FILE = path.join(ROOT, "npm", "lib", "targets.json");

function fail(message) {
  process.stderr.write(`build-npm-packages: ${message}\n`);
  process.exit(1);
}

const USAGE = `Usage: node scripts/build-npm-packages.mjs [options]

Stages the npm packages that ship the native tokencount binary.

  --artifacts <dir>  release archives + SHA256SUMS (default: dist/release-artifacts)
  --out <dir>        staging root (default: dist/npm)
  --version <ver>    override the version (default: read from Cargo.toml)
  --root-only        stage just the root package (needs no archives)
  --stamp            also rewrite the repo's package.json/package-lock.json version
  --check            verify versions only; write nothing, exit 1 on drift
  --print-version    print the Cargo.toml version and exit
  -h, --help         show this help
`;

function parseArgs(argv) {
  const args = {
    artifacts: path.join(ROOT, "dist", "release-artifacts"),
    out: path.join(ROOT, "dist", "npm"),
    version: null,
    rootOnly: false,
    stamp: false,
    check: false,
    printVersion: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = () => {
      i++;
      if (i >= argv.length) fail(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--artifacts") args.artifacts = path.resolve(needsValue());
    else if (arg === "--out") args.out = path.resolve(needsValue());
    else if (arg === "--version") args.version = needsValue();
    else if (arg === "--root-only") args.rootOnly = true;
    else if (arg === "--stamp") args.stamp = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--print-version") args.printVersion = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  return args;
}

/** The version from Cargo.toml's [package] table. */
function cargoVersion() {
  const toml = fs.readFileSync(path.join(ROOT, "Cargo.toml"), "utf8");
  const pkg = toml.split(/^\[/m).find((section) => section.startsWith("package]"));
  if (!pkg) fail("Cargo.toml has no [package] section");
  const match = pkg.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) fail("Cargo.toml [package] has no version");
  return match[1];
}

// ---------------------------------------------------------------- archives

/** Reads a POSIX/GNU tar stream into a Map of name -> { mode, data }. */
function readTar(buf) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buf.length; ) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const str = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8").trim();
    };
    const octal = (start, len) => parseInt(str(start, len) || "0", 8) || 0;

    const name = str(0, 100);
    const mode = octal(100, 8);
    const size = octal(124, 12);
    const typeflag = String.fromCharCode(header[156]) || "0";
    const prefix = str(345, 155);
    const full = prefix ? `${prefix}/${name}` : name;

    const dataStart = offset + 512;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      entries.set(full, { mode, data: buf.subarray(dataStart, dataStart + size) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Reads a ZIP central directory into a Map of name -> { mode, data }. */
function readZip(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) fail("zip: end of central directory not found");

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) fail("zip: bad central directory entry");
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const externalAttrs = buf.readUInt32LE(ptr + 38);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) fail("zip: bad local header");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    if (!name.endsWith("/")) {
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else fail(`zip: unsupported compression method ${method} for ${name}`);
      entries.set(name, { mode: (externalAttrs >>> 16) & 0o7777, data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readArchive(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith(".zip")) return readZip(buf);
  if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) return readTar(zlib.gunzipSync(buf));
  return fail(`unsupported archive: ${path.basename(file)}`);
}

/** Checks one archive against the SHA256SUMS file shipped with the release. */
function verifyChecksum(sumsFile, archive) {
  if (!fs.existsSync(sumsFile)) {
    fail(
      `${sumsFile} not found -- refusing to publish an unverified archive.\n` +
        "SHA256SUMS is uploaded by .github/workflows/release.yml alongside the\n" +
        "archives; download it into the artifacts directory and retry."
    );
  }
  const wanted = new Map(
    fs
      .readFileSync(sumsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([sum, name]) => [name.replace(/^\*/, ""), sum.toLowerCase()])
  );
  const name = path.basename(archive);
  const expected = wanted.get(name);
  if (!expected) fail(`${name} is not listed in SHA256SUMS`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (actual !== expected) fail(`${name}: sha256 mismatch\n  expected ${expected}\n  got      ${actual}`);
  return "sha256 ok";
}

// ---------------------------------------------------------------- packages

const REPOSITORY = { type: "git", url: "git+https://github.com/eordano/tokencount.git" };
const HOMEPAGE = "https://github.com/eordano/tokencount#readme";
const BUGS = "https://github.com/eordano/tokencount/issues";
const LICENSE = "AGPL-3.0-only";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function platformManifest(target, version) {
  return {
    name: target.package,
    version,
    description: `Prebuilt tokencount binary for ${target.os}-${target.cpu} (${target.rustTarget})`,
    license: LICENSE,
    repository: REPOSITORY,
    homepage: HOMEPAGE,
    bugs: { url: BUGS },
    os: [target.os],
    cpu: [target.cpu],
    files: ["bin", "LICENSE", "README.md"],
    preferUnplugged: true,
    publishConfig: { access: "public" },
  };
}

function platformReadme(target, version) {
  return [
    `# ${target.package}`,
    "",
    `The \`${target.rustTarget}\` build of the [tokencount](${HOMEPAGE}) CLI, v${version}.`,
    "",
    "This package exists only so that `npm install tokencount` can pull down a",
    "prebuilt binary for your platform. Install `tokencount` instead; it lists this",
    "package as an optional dependency and picks the right one at run time.",
    "",
    "```sh",
    "npm install -g tokencount",
    "```",
    "",
    `Licensed ${LICENSE}; see LICENSE.`,
    "",
  ].join("\n");
}

function rootManifest(version, targets) {
  const optionalDependencies = {};
  for (const target of targets) optionalDependencies[target.package] = version;
  return {
    name: "tokencount",
    version,
    description: "Lightning-fast offline token counter for 9 LLM tokenizers",
    keywords: ["tokenizer", "tokens", "token-count", "llm", "claude", "gpt", "gemini", "cli"],
    license: LICENSE,
    repository: REPOSITORY,
    homepage: HOMEPAGE,
    bugs: { url: BUGS },
    bin: { tokencount: "bin/tokencount.cjs" },
    files: ["bin", "lib", "LICENSE", "README.md"],
    engines: { node: ">=18" },
    optionalDependencies,
    publishConfig: { access: "public" },
  };
}

function copyInto(dir, files) {
  for (const file of files) fs.copyFileSync(path.join(ROOT, file), path.join(dir, path.basename(file)));
}

function stageRoot(outDir, version, targets) {
  const dir = path.join(outDir, "tokencount");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });

  fs.copyFileSync(path.join(ROOT, "npm", "bin", "tokencount.cjs"), path.join(dir, "bin", "tokencount.cjs"));
  fs.chmodSync(path.join(dir, "bin", "tokencount.cjs"), 0o755);
  for (const file of ["resolve-binary.cjs", "targets.json"]) {
    fs.copyFileSync(path.join(ROOT, "npm", "lib", file), path.join(dir, "lib", file));
  }
  copyInto(dir, ["LICENSE", "README.md"]);
  writeJson(path.join(dir, "package.json"), rootManifest(version, targets));
  return dir;
}

function stagePlatform(outDir, target, version, artifactsDir) {
  const archive = path.join(artifactsDir, `tokencount-${version}-${target.rustTarget}.${target.archive}`);
  if (!fs.existsSync(archive)) fail(`missing release archive: ${archive}`);
  const checksum = verifyChecksum(path.join(artifactsDir, "SHA256SUMS"), archive);

  const entries = readArchive(archive);
  const entry = entries.get(target.binary) || entries.get(`./${target.binary}`);
  if (!entry) {
    fail(`${path.basename(archive)} has no ${target.binary} at its root (found: ${[...entries.keys()].join(", ")})`);
  }

  const dir = path.join(outDir, target.package);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });

  const binPath = path.join(dir, "bin", target.binary);
  fs.writeFileSync(binPath, entry.data);
  fs.chmodSync(binPath, 0o755);

  copyInto(dir, ["LICENSE"]);
  fs.writeFileSync(path.join(dir, "README.md"), platformReadme(target, version));
  writeJson(path.join(dir, "package.json"), platformManifest(target, version));

  return { dir, bytes: entry.data.length, checksum };
}

// ------------------------------------------------------------------ stamps

/**
 * Rewrites the `[[package]] name = "tokencount"` version in Cargo.lock.
 *
 * Release builds run `cargo build --locked`, which refuses to touch the lock:
 * a Cargo.toml bumped without the lock fails every target of the release
 * matrix, after the tag is already pushed. The lock's own entry for this crate
 * is the only line a version bump moves, so rewrite exactly that one.
 */
function stampCargoLock(version, write) {
  const lockFile = path.join(ROOT, "Cargo.lock");
  if (!fs.existsSync(lockFile)) return null;
  const text = fs.readFileSync(lockFile, "utf8");

  const block = /(\[\[package\]\]\nname = "tokencount"\nversion = ")([^"]+)(")/;
  const match = text.match(block);
  if (!match) {
    fail('Cargo.lock has no [[package]] entry for "tokencount" -- run `cargo metadata` to regenerate it');
  }
  if (match[2] === version) return null;

  const drift = `Cargo.lock version ${match[2]} != Cargo.toml ${version}`;
  if (write) fs.writeFileSync(lockFile, text.replace(block, `$1${version}$3`));
  return drift;
}

/**
 * Compares the repo's package.json/package-lock.json/Cargo.lock against the
 * Cargo version, rewriting them only when `write` is set. Returns the drift
 * found.
 */
function stampRepo(version, write) {
  const drift = [];
  const pkgFile = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  if (pkg.version !== version) {
    drift.push(`package.json version ${pkg.version} != Cargo.toml ${version}`);
    if (write) {
      pkg.version = version;
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    }
  }

  const lockFile = path.join(ROOT, "package-lock.json");
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const stale = lock.version !== version || lock.packages?.[""]?.version !== version;
    if (stale) {
      drift.push(`package-lock.json version != Cargo.toml ${version}`);
      if (write) {
        lock.version = version;
        if (lock.packages?.[""]) lock.packages[""].version = version;
        fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
      }
    }
  }

  const cargoDrift = stampCargoLock(version, write);
  if (cargoDrift) drift.push(cargoDrift);

  return drift;
}

// -------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { targets } = JSON.parse(fs.readFileSync(TARGETS_FILE, "utf8"));
  const version = args.version || cargoVersion();

  if (args.printVersion) {
    process.stdout.write(`${version}\n`);
    return;
  }

  if (args.check) {
    const drift = stampRepo(version, false);
    if (drift.length) {
      fail(`version drift:\n  ${drift.join("\n  ")}\nRun: node scripts/build-npm-packages.mjs --root-only --stamp`);
    }
    process.stdout.write(`versions agree on ${version}\n`);
    return;
  }

  // The published packages always take the Cargo version; the repo's own
  // manifests are only rewritten on request, so a release run cannot quietly
  // edit a developer's checkout.
  for (const line of stampRepo(version, args.stamp)) {
    process.stdout.write(`  ${args.stamp ? "stamped" : "warning"}: ${line}\n`);
  }

  const rootDir = stageRoot(args.out, version, targets);
  process.stdout.write(`root     tokencount@${version} -> ${path.relative(ROOT, rootDir)}\n`);

  if (args.rootOnly) return;

  for (const target of targets) {
    const { dir, bytes, checksum } = stagePlatform(args.out, target, version, args.artifacts);
    const mb = (bytes / 1024 / 1024).toFixed(1);
    process.stdout.write(`platform ${target.package}@${version} -> ${path.relative(ROOT, dir)} (${mb} MB, ${checksum})\n`);
  }
}

main();
