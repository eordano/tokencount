#!/usr/bin/env node
"use strict";

/**
 * Exercises the launcher against a synthetic install tree: a fake platform
 * package standing in for the one the release workflow publishes.
 *
 * Run: npm run test:launcher
 */

const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const { targets } = require("../lib/targets.json");

const target = targets.find((t) => t.os === process.platform && t.cpu === process.arch);
if (!target) {
  process.stdout.write(`skip: no release target for ${process.platform}-${process.arch}\n`);
  process.exit(0);
}
if (process.platform === "win32") {
  process.stdout.write("skip: fake binary is a POSIX shell script\n");
  process.exit(0);
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (err) {
    failures++;
    process.stdout.write(`FAIL ${name}\n     ${err.message}\n`);
  }
}

/** A node_modules tree holding the launcher and, optionally, a fake binary. */
function makeInstall({ withPlatformPackage, script }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokencount-npm-"));
  const pkgDir = path.join(dir, "node_modules", "tokencount");
  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "npm", "bin", "tokencount.cjs"), path.join(pkgDir, "bin", "tokencount.cjs"));
  for (const file of ["resolve-binary.cjs", "targets.json"]) {
    fs.copyFileSync(path.join(ROOT, "npm", "lib", file), path.join(pkgDir, "lib", file));
  }
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "tokencount", version: "0.0.0-test", bin: { tokencount: "bin/tokencount.cjs" } })
  );

  if (withPlatformPackage) {
    const platDir = path.join(dir, "node_modules", target.package);
    fs.mkdirSync(path.join(platDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(platDir, "package.json"), JSON.stringify({ name: target.package, version: "0.0.0-test" }));
    const binPath = path.join(platDir, "bin", target.binary);
    fs.writeFileSync(binPath, script);
    fs.chmodSync(binPath, 0o755);
  }

  return { dir, launcher: path.join(pkgDir, "bin", "tokencount.cjs") };
}

const ECHO_ARGS = '#!/bin/sh\nprintf "args:%s\\n" "$*"\ncat\nexit 7\n';
const SLEEP = '#!/bin/sh\necho ready\nexec sleep 30\n';

const clean = { ...process.env };
delete clean.TOKENCOUNT_BINARY_PATH;

test("passes argv and stdin through, propagates the exit code", () => {
  const { launcher } = makeInstall({ withPlatformPackage: true, script: ECHO_ARGS });
  const r = cp.spawnSync(process.execPath, [launcher, "-m", "claude", "a b"], {
    input: "from stdin",
    encoding: "utf8",
    env: clean,
  });
  assert.strictEqual(r.status, 7, `exit code was ${r.status}`);
  assert.match(r.stdout, /args:-m claude a b/);
  assert.match(r.stdout, /from stdin/);
});

test("missing platform package gives an error, not a stack trace", () => {
  const { launcher } = makeInstall({ withPlatformPackage: false });
  const r = cp.spawnSync(process.execPath, [launcher], { encoding: "utf8", env: clean });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, "");
  assert.match(r.stderr, new RegExp(target.package.replace("/", "\\/")));
  assert.ok(!/at .*\(.*:\d+:\d+\)/.test(r.stderr), "stderr contained a stack frame");
  assert.ok(r.stderr.endsWith("\n"));
});

test("TOKENCOUNT_BINARY_PATH overrides resolution", () => {
  const { dir, launcher } = makeInstall({ withPlatformPackage: false });
  const override = path.join(dir, "custom-tokencount");
  fs.writeFileSync(override, ECHO_ARGS);
  fs.chmodSync(override, 0o755);
  const r = cp.spawnSync(process.execPath, [launcher, "x"], {
    input: "",
    encoding: "utf8",
    env: { ...clean, TOKENCOUNT_BINARY_PATH: override },
  });
  assert.strictEqual(r.status, 7);
  assert.match(r.stdout, /args:x/);
});

test("a bad TOKENCOUNT_BINARY_PATH is reported plainly", () => {
  const { launcher } = makeInstall({ withPlatformPackage: true, script: ECHO_ARGS });
  const r = cp.spawnSync(process.execPath, [launcher], {
    input: "",
    encoding: "utf8",
    env: { ...clean, TOKENCOUNT_BINARY_PATH: "/nonexistent/tokencount" },
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not a file/);
});

async function signalTest() {
  const { launcher } = makeInstall({ withPlatformPackage: true, script: SLEEP });
  const child = cp.spawn(process.execPath, [launcher], { env: clean, stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGTERM");
  const { code, signal } = await done;
  assert.strictEqual(signal, "SIGTERM", `exited with code=${code} signal=${signal}`);
}

signalTest().then(
  () => process.stdout.write("ok   forwards SIGTERM and dies of the same signal\n"),
  (err) => {
    failures++;
    process.stdout.write(`FAIL forwards SIGTERM and dies of the same signal\n     ${err.message}\n`);
  }
).then(() => {
  process.exit(failures ? 1 : 0);
});
