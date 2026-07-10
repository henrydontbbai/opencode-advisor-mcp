import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync as createTempDirOnDisk, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTaskFile,
  readTaskFile,
  runQueueRunner,
  writeTaskFile,
} from "../src/task-queue.mjs";

const tempDirs = new Set();

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
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_orphanedlock",
    role: "planner",
    input: { cwd: "/repo", current_plan: "recover orphaned lock" },
  }));
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
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_two_runners",
    role: "planner",
    input: { cwd: "/repo", current_plan: "single owner" },
  }));

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
