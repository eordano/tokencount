#!/usr/bin/env node
"use strict";

/**
 * Launcher for the native tokencount binary.
 *
 * Node has no execve(2), so this is the closest thing: hand the child our own
 * stdio, forward every signal we are allowed to catch, and exit with exactly
 * the status the child exited with (re-raising the signal on ourselves when the
 * child died from one, so the calling shell sees the real cause of death).
 */

const { spawn } = require("node:child_process");
const os = require("node:os");

const { resolveBinary, BinaryNotFoundError } = require("../lib/resolve-binary.cjs");

function die(message) {
  process.stderr.write(message.replace(/\n?$/, "\n"));
  process.exit(1);
}

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  if (err instanceof BinaryNotFoundError) die(err.message);
  throw err;
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

const SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGUSR1",
  "SIGUSR2",
  "SIGBREAK",
];

// Taking a listener also stops the default disposition from killing us while
// the child is still draining stdout.
for (const signal of SIGNALS) {
  try {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // Child already reaped.
        }
      }
    });
  } catch {
    // Signal unknown on this platform (SIGBREAK off Windows, SIGQUIT on it).
  }
}

child.on("error", (err) => {
  if (err.code === "EACCES") {
    die(`tokencount: ${binary} is not executable (chmod +x it, or reinstall).`);
  }
  die(`tokencount: could not run ${binary}: ${err.message}`);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Restore the default disposition, then die the same way the child did.
    process.removeAllListeners(signal);
    try {
      process.kill(process.pid, signal);
    } catch {
      // Not deliverable here (Windows); fall through to the numeric form.
    }
    process.exit(128 + (os.constants.signals[signal] || 0));
  }
  process.exit(code === null ? 1 : code);
});
