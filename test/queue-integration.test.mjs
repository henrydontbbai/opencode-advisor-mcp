import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync as createTempDirOnDisk,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskFile, ensureQueueRunner, readTaskFile, runQueueRunner, writeTaskFile } from "../src/task-queue.mjs";

const tempDirs = new Set();
const STARTUP_WORKER = fileURLToPath(new URL("./fixtures/queue-startup-worker.mjs", import.meta.url));

function createTempDir(prefix) {
  const directory = createTempDirOnDisk(path.join(os.tmpdir(), prefix));
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  tempDirs.clear();
});

function runStartupWorker(queueDir, spawnLog, runnerStaleMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STARTUP_WORKER, queueDir, spawnLog, runnerStaleMs].filter(Boolean), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`startup worker exited ${code}: ${stderr}`));
      }
    });
  });
}

test("separate server processes start only one runner before a lease is published", async () => {
  const queueDir = createTempDir("ocq-startup-processes-");
  const spawnLog = path.join(queueDir, "spawn.log");

  await Promise.all([runStartupWorker(queueDir, spawnLog), runStartupWorker(queueDir, spawnLog)]);

  const spawns = readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(spawns.length, 1);
});

test("separate server processes reclaim one stale startup reservation before a lease is published", async () => {
  const queueDir = createTempDir("ocq-stale-startup-processes-");
  const spawnLog = path.join(queueDir, "spawn.log");
  const markerPath = path.join(queueDir, "_runner.starting");
  writeFileSync(
    markerPath,
    `${JSON.stringify({ id: "stale-startup-token", started_at: new Date(0).toISOString() })}\n`,
    "utf8",
  );
  const staleDate = new Date(Date.now() - 1100);
  utimesSync(markerPath, staleDate, staleDate);

  await Promise.all([runStartupWorker(queueDir, spawnLog, "1"), runStartupWorker(queueDir, spawnLog, "1")]);

  const spawns = readFileSync(spawnLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(spawns.length, 1);
});

test("a runner acknowledges its startup reservation after it acquires a lease", async () => {
  const queueDir = createTempDir("ocq-startup-ack-");
  const startupToken = "startup-reservation-token";
  const markerPath = path.join(queueDir, "_runner.starting");
  writeFileSync(markerPath, `${JSON.stringify({ id: startupToken, started_at: new Date().toISOString() })}\n`, "utf8");
  await writeTaskFile(
    queueDir,
    createTaskFile({
      id: "ocq_startupack",
      role: "planner",
      input: { cwd: "/repo", current_plan: "acknowledge startup" },
    }),
  );

  const result = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_STARTUP_TOKEN: startupToken,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async () => ({
      ok: true,
      base_ref: "HEAD",
      status: "",
      diff_truncated: false,
      planner_text: "acknowledged",
      opencode_exit_code: 0,
    }),
  });

  assert.equal(result.started, true);
  assert.equal(existsSync(markerPath), false);
});

function writeFreshRunnerLease(queueDir, { pid = process.pid } = {}) {
  const runner = {
    runner_id: "runner_live",
    pid,
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 600000).toISOString(),
    started_at: new Date().toISOString(),
  };
  writeFileSync(path.join(queueDir, "_runner.lock"), `${JSON.stringify(runner)}\n`, "utf8");
  writeFileSync(path.join(queueDir, "_runner.json"), `${JSON.stringify(runner)}\n`, "utf8");
}

test("a runner releases its matching startup reservation when a fresh lease prevents acquisition", async () => {
  const queueDir = createTempDir("ocq-startup-live-lease-");
  const startupToken = "live-lease-startup-token";
  const markerPath = path.join(queueDir, "_runner.starting");
  writeFileSync(markerPath, `${JSON.stringify({ id: startupToken, started_at: new Date().toISOString() })}\n`, "utf8");
  writeFreshRunnerLease(queueDir);

  const result = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_STARTUP_TOKEN: startupToken,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "600000",
    },
    platform: process.platform,
    signals: null,
  });

  assert.deepEqual(result, { started: false });
  assert.equal(existsSync(markerPath), false);
});

test("a runner blocked by a fresh lease preserves a replacement startup reservation", async () => {
  const queueDir = createTempDir("ocq-startup-live-replacement-");
  const startupToken = "delayed-startup-token";
  const replacementToken = "replacement-startup-token";
  const markerPath = path.join(queueDir, "_runner.starting");
  const replacement = `${JSON.stringify({ id: replacementToken, started_at: new Date().toISOString() })}\n`;
  writeFileSync(markerPath, replacement, "utf8");
  writeFreshRunnerLease(queueDir);

  const result = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_STARTUP_TOKEN: startupToken,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "600000",
    },
    platform: process.platform,
    signals: null,
  });

  assert.deepEqual(result, { started: false });
  assert.equal(readFileSync(markerPath, "utf8"), replacement);
});

test("a runner releases its matching startup reservation when lease acquisition throws", async () => {
  const queueDir = createTempDir("ocq-startup-lease-error-");
  const startupToken = "lease-error-startup-token";
  const markerPath = path.join(queueDir, "_runner.starting");
  writeFileSync(markerPath, `${JSON.stringify({ id: startupToken, started_at: new Date().toISOString() })}\n`, "utf8");
  writeFreshRunnerLease(queueDir, { pid: process.pid + 1 });

  await assert.rejects(
    runQueueRunner({
      env: {
        OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
        OPENCODE_ADVISOR_QUEUE_STARTUP_TOKEN: startupToken,
        OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "600000",
      },
      platform: process.platform,
      signals: null,
      processControl: {
        isProcessAlive() {
          throw new Error("lease inspection failed");
        },
      },
    }),
    /lease inspection failed/,
  );

  assert.equal(existsSync(markerPath), false);
});

test("a delayed child cannot remove a replacement startup reservation", async () => {
  const queueDir = createTempDir("ocq-startup-fence-");
  const markerPath = path.join(queueDir, "_runner.starting");
  const staleToken = "stale-startup-token";
  writeFileSync(markerPath, `${JSON.stringify({ id: staleToken, started_at: new Date(0).toISOString() })}\n`, "utf8");
  const staleDate = new Date(Date.now() - 1100);
  utimesSync(markerPath, staleDate, staleDate);

  const replacementStarted = await ensureQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "1",
    },
    platform: process.platform,
    spawnProcess: () => ({ unref() {} }),
  });
  assert.equal(replacementStarted, true);
  const replacement = readFileSync(markerPath, "utf8");

  const delayedResult = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_STARTUP_TOKEN: staleToken,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async () => {
      throw new Error("no task should run");
    },
  });

  assert.equal(delayedResult.started, true);
  assert.equal(readFileSync(markerPath, "utf8"), replacement);
});

test("runQueueRunner recovers a stale running task after a crashed runner", async () => {
  const queueDir = createTempDir("ocq-runner-recovery-");
  const staleIso = new Date(Date.now() - 5000).toISOString();
  const task = {
    ...createTaskFile({
      id: "ocq_recoveraftercrash",
      role: "planner",
      input: { cwd: "/repo", current_plan: "recover crashed task" },
    }),
    status: "running",
    created_at: staleIso,
    updated_at: staleIso,
    started_at: staleIso,
    runner_id: "runner_crashed",
  };

  await writeTaskFile(queueDir, task);
  writeFileSync(path.join(queueDir, "_runner.lock"), "runner_crashed\n", "utf8");
  writeFileSync(
    path.join(queueDir, "_runner.json"),
    `${JSON.stringify({ runner_id: "runner_crashed", pid: 999999, heartbeat_at: staleIso, started_at: staleIso }, null, 2)}\n`,
    "utf8",
  );

  const seen = [];
  const runnerResult = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (currentTask) => {
      seen.push(currentTask.id);
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        planner_text: "Recovered successfully",
        opencode_exit_code: 0,
      };
    },
  });

  const recovered = await readTaskFile(queueDir, "ocq_recoveraftercrash");
  assert.equal(runnerResult.started, true);
  assert.deepEqual(seen, ["ocq_recoveraftercrash"]);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.result.planner_text, "Recovered successfully");
  assert.equal(existsSync(path.join(queueDir, "_runner.lock")), false);
  assert.equal(existsSync(path.join(queueDir, "_runner.json")), false);
});

test("runQueueRunner recovers an orphaned stale lock without a readable owner record", async () => {
  const queueDir = createTempDir("ocq-orphaned-lock-");
  await writeTaskFile(
    queueDir,
    createTaskFile({
      id: "ocq_orphanedlock",
      role: "planner",
      input: { cwd: "/repo", current_plan: "recover orphaned lock" },
    }),
  );
  writeFileSync(path.join(queueDir, "_runner.lock"), "{", "utf8");
  const oldDate = new Date(Date.now() - 5000);
  utimesSync(path.join(queueDir, "_runner.lock"), oldDate, oldDate);

  const seen = [];
  const runnerResult = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => {
      seen.push(task.id);
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        planner_text: "Recovered orphaned lock",
        opencode_exit_code: 0,
      };
    },
  });

  assert.equal(runnerResult.started, true);
  assert.deepEqual(seen, ["ocq_orphanedlock"]);
  assert.equal((await readTaskFile(queueDir, "ocq_orphanedlock")).status, "completed");
  assert.equal(existsSync(path.join(queueDir, "_runner.lock")), false);
  assert.equal(existsSync(path.join(queueDir, "_runner.json")), false);
});

test("two runner processes execute a queued task exactly once", async () => {
  const queueDir = createTempDir("ocq-two-runners-");
  await writeTaskFile(
    queueDir,
    createTaskFile({
      id: "ocq_two_runners",
      role: "planner",
      input: { cwd: "/repo", current_plan: "single owner" },
    }),
  );

  const firstSeen = [];
  const secondSeen = [];
  let startFirstTask;
  let finishFirstTask;
  const firstTaskStarted = new Promise((resolve) => {
    startFirstTask = resolve;
  });
  const firstTaskFinished = new Promise((resolve) => {
    finishFirstTask = resolve;
  });
  const firstPromise = runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => {
      firstSeen.push(task.id);
      startFirstTask();
      await firstTaskFinished;
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        planner_text: "first runner",
        opencode_exit_code: 0,
      };
    },
  });

  await firstTaskStarted;
  const second = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => {
      secondSeen.push(task.id);
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        planner_text: "second runner",
        opencode_exit_code: 0,
      };
    },
  });
  finishFirstTask();
  const first = await firstPromise;

  const saved = await readTaskFile(queueDir, "ocq_two_runners");
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.deepEqual([...firstSeen, ...secondSeen], ["ocq_two_runners"]);
  assert.equal(saved.status, "completed");
  assert.equal(saved.attempt_count, 1);
});
