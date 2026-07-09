#!/usr/bin/env node
import { spawn } from "node:child_process";

const TEST_FILES = [
  "test/server.test.mjs",
  "test/runtime-shared.test.mjs",
  "test/package-contract.test.mjs",
  "test/queue.test.mjs",
  "test/mcp-integration.test.mjs",
  "test/queue-integration.test.mjs",
  "test/bin.test.mjs",
];

const DEFAULT_TIMEOUT_MS = 120000;
const parsedTimeoutMs = Number.parseInt(process.env.OPENCODE_ADVISOR_TEST_FILE_TIMEOUT_MS ?? "", 10);
const timeoutMs =
  Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? parsedTimeoutMs
    : DEFAULT_TIMEOUT_MS;

async function runTestFile(testFile) {
  console.log(`\n=== ${testFile} ===`);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-force-exit", testFile], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      console.error(`Timed out after ${timeoutMs}ms: ${testFile}`);
      try {
        child.kill("SIGTERM");
      } catch {}

      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, 5000).unref?.();
    }, timeoutMs);
    killTimer.unref?.();

    child.once("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`Test file timed out: ${testFile}`));
        return;
      }
      if (signal) {
        reject(new Error(`Test file exited from signal ${signal}: ${testFile}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Test file failed with exit code ${code}: ${testFile}`));
        return;
      }
      resolve();
    });
  });
}

for (const testFile of TEST_FILES) {
  await runTestFile(testFile);
}
