"use strict";

/**
 * Locates the prebuilt tokencount binary that ships in the per-platform
 * optional dependency for the host (@tokencount/<platform>-<arch>).
 *
 * Kept dependency-free and CommonJS on purpose: this runs before anything
 * else the package does, on whatever Node the user happens to have.
 */

const fs = require("node:fs");
const path = require("node:path");

const { targets } = require("./targets.json");

const ENV_OVERRIDE = "TOKENCOUNT_BINARY_PATH";

/** Thrown when no usable binary could be found; carries a user-facing message. */
class BinaryNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "BinaryNotFoundError";
  }
}

/** The release target matching the current process, or undefined. */
function currentTarget() {
  return targets.find((t) => t.os === process.platform && t.cpu === process.arch);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Candidate paths for the binary, most authoritative first. */
function candidatePaths(target) {
  const subpath = path.join("bin", target.binary);
  const found = [];

  try {
    const manifest = require.resolve(`${target.package}/package.json`, {
      paths: [__dirname, process.cwd()],
    });
    found.push(path.join(path.dirname(manifest), subpath));
  } catch {
    // Not installed, or an installer that hides it from Node resolution.
  }

  // pnpm/bun and hand-assembled layouts: sibling directory of this package.
  const [scope, name] = target.package.split("/");
  found.push(path.resolve(__dirname, "..", "..", scope, name, subpath));

  return found;
}

function unsupportedMessage() {
  const supported = targets.map((t) => `${t.os}-${t.cpu}`).join(", ");
  return [
    `tokencount: no prebuilt binary for ${process.platform}-${process.arch}.`,
    "",
    `Prebuilt binaries exist for: ${supported}.`,
    "",
    "Build one yourself, then point this launcher at it:",
    "  nix build github:eordano/tokencount",
    `  ${ENV_OVERRIDE}=$PWD/result/bin/tokencount tokencount ...`,
    "",
    "Without Nix, from a clone (build.rs needs the tokenizer tables; the error",
    "it prints without them names every file and its source URL):",
    "  node scripts/fetch-models.mjs ./models",
    "  TOKEN_COUNT_MODELS=./models cargo build --release --locked",
    `  ${ENV_OVERRIDE}=$PWD/target/release/tokencount tokencount ...`,
    "",
    "There is no `cargo install tokencount`: the crate is not published to",
    "crates.io. See docs/INSTALL.md#building-from-source.",
  ].join("\n");
}

function missingPackageMessage(target) {
  return [
    `tokencount: the prebuilt binary for ${target.os}-${target.cpu} is missing.`,
    "",
    `It ships in the optional dependency ${target.package}, which was not`,
    "installed. That normally means one of:",
    "  - the install ran with --no-optional / --omit=optional",
    "  - a lockfile made on another platform is pinning this one",
    "  - npm dropped the optional dependency (npm/cli#4828)",
    "",
    "Fixes, in order of least effort:",
    `  npm install ${target.package}@${packageVersion()} --no-save`,
    "  rm -rf node_modules package-lock.json && npm install",
    "",
    "Or use a binary you already have:",
    `  ${ENV_OVERRIDE}=/path/to/tokencount tokencount ...`,
  ].join("\n");
}

function packageVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return "latest";
  }
}

/**
 * Absolute path to the native binary.
 * @throws {BinaryNotFoundError}
 */
function resolveBinary() {
  const override = process.env[ENV_OVERRIDE];
  if (override) {
    if (isFile(override)) return path.resolve(override);
    throw new BinaryNotFoundError(
      `tokencount: ${ENV_OVERRIDE} is set to ${override}, which is not a file.`
    );
  }

  const target = currentTarget();
  if (!target) throw new BinaryNotFoundError(unsupportedMessage());

  for (const candidate of candidatePaths(target)) {
    if (isFile(candidate)) return candidate;
  }

  throw new BinaryNotFoundError(missingPackageMessage(target));
}

module.exports = { BinaryNotFoundError, currentTarget, resolveBinary, targets, ENV_OVERRIDE };
