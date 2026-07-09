import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTaskQueue,
  createTaskFile,
  getQueueConfig,
  processQueueOnce,
  readTaskFile,
  writeTaskFile,
} from "../src/task-queue.mjs";

test("getQueueConfig uses 4/2/2 defaults", () => {
  const config = getQueueConfig({}, "win32");
  assert.equal(config.limitGlobal, 4);
  assert.equal(config.limitPlanner, 2);
  assert.equal(config.limitReviewer, 2);
  assert.equal(config.inlineWaitMs, 60000);
  assert.equal(config.retryAfterMs, 30000);
  assert.equal(config.maxPending, 16);
});

test("processQueueOnce respects per-role and global limits", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_CONCURRENCY_GLOBAL: "4",
      OPENCODE_ADVISOR_CONCURRENCY_PLANNER: "2",
      OPENCODE_ADVISOR_CONCURRENCY_REVIEWER: "2",
    },
    process.platform,
  );

  const plannerTasks = Array.from({ length: 3 }, (_, index) =>
    createTaskFile({
      id: `planner_${index}`,
      role: "planner",
      input: { cwd: "/repo", current_plan: `plan ${index}` },
    }),
  );
  const reviewerTasks = Array.from({ length: 3 }, (_, index) =>
    createTaskFile({
      id: `reviewer_${index}`,
      role: "reviewer",
      input: { cwd: "/repo", question: `review ${index}` },
    }),
  );

  for (const task of [...plannerTasks, ...reviewerTasks]) {
    await writeTaskFile(queueDir, task);
  }

  const started = [];
  await processQueueOnce({
    queueDir,
    config,
    runTask: async (task) => {
      started.push(task.id);
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        [task.role === "planner" ? "planner_text" : "advisor_text"]: "ok",
        opencode_exit_code: 0,
      };
    },
  });

  assert.equal(started.length, 4);
  assert.equal(started.filter((id) => id.startsWith("planner_")).length, 2);
  assert.equal(started.filter((id) => id.startsWith("reviewer_")).length, 2);

  const leftoverPlanner = await readTaskFile(queueDir, "planner_2");
  const leftoverReviewer = await readTaskFile(queueDir, "reviewer_2");
  assert.equal(leftoverPlanner.status, "queued");
  assert.equal(leftoverReviewer.status, "queued");
});

test("processQueueOnce requeues stale running tasks before starting new work", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_CONCURRENCY_GLOBAL: "1",
      OPENCODE_ADVISOR_CONCURRENCY_PLANNER: "1",
      OPENCODE_ADVISOR_CONCURRENCY_REVIEWER: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "1",
    },
    process.platform,
  );

  const staleTask = {
    ...createTaskFile({
      id: "planner_stale",
      role: "planner",
      input: { cwd: "/repo", current_plan: "stale plan" },
    }),
    status: "running",
    updated_at: new Date(Date.now() - 5000).toISOString(),
    started_at: new Date(Date.now() - 5000).toISOString(),
    runner_id: "runner_dead",
  };
  const waitingTask = createTaskFile({
    id: "planner_waiting",
    role: "planner",
    input: { cwd: "/repo", current_plan: "waiting plan" },
  });

  await writeTaskFile(queueDir, staleTask);
  await writeTaskFile(queueDir, waitingTask);

  const started = [];
  await processQueueOnce({
    queueDir,
    config,
    runTask: async (task) => {
      started.push(task.id);
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        planner_text: "ok",
        opencode_exit_code: 0,
      };
    },
  });

  assert.deepEqual(started, ["planner_stale"]);
  assert.equal((await readTaskFile(queueDir, "planner_stale")).status, "completed");
  assert.equal((await readTaskFile(queueDir, "planner_waiting")).status, "queued");
});

test("createTaskQueue rejects unsafe public task ids before any runner work", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  let spawnCalled = false;
  const queue = createTaskQueue({
    env: { OPENCODE_ADVISOR_QUEUE_DIR: queueDir },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.getTaskResult({ task_id: "../outside" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.match(result.message, /invalid/i);
  assert.equal(spawnCalled, false);
});

test("createTaskQueue tolerates concurrent runner-state reads during parallel submissions", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const env = {
    OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
    OPENCODE_ADVISOR_CONCURRENCY_GLOBAL: "4",
    OPENCODE_ADVISOR_CONCURRENCY_PLANNER: "2",
    OPENCODE_ADVISOR_CONCURRENCY_REVIEWER: "2",
    OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS: "10",
    OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS: "10",
    OPENCODE_ADVISOR_QUEUE_POLL_MS: "10",
    OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "50",
  };

  const queue = createTaskQueue({
    env,
    platform: process.platform,
    spawnProcess: () => ({ unref() {} }),
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { runQueueRunner } = await import("../src/task-queue.mjs");
  const runnerPromise = runQueueRunner({
    env,
    platform: process.platform,
    runTask: async (task) => {
      await sleep(40);
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        [task.role === "planner" ? "planner_text" : "advisor_text"]: "ok",
        opencode_exit_code: 0,
      };
    },
  });

  const submissions = await Promise.all([
    queue.submitAndWait({ role: "planner", input: { current_plan: "p1" } }),
    queue.submitAndWait({ role: "planner", input: { current_plan: "p2" } }),
    queue.submitAndWait({ role: "planner", input: { current_plan: "p3" } }),
    queue.submitAndWait({ role: "reviewer", input: { question: "r1" } }),
    queue.submitAndWait({ role: "reviewer", input: { question: "r2" } }),
    queue.submitAndWait({ role: "reviewer", input: { question: "r3" } }),
  ]);

  await runnerPromise;

  assert.equal(submissions.length, 6);
  assert.equal(submissions.some((item) => item?.error === "queued"), true);
});

test("createTaskQueue tolerates malformed runner state files", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  writeFileSync(path.join(queueDir, "_runner.json"), "", "utf8");

  const queue = createTaskQueue({
    env: { OPENCODE_ADVISOR_QUEUE_DIR: queueDir },
    platform: process.platform,
    spawnProcess: () => ({ unref() {} }),
  });

  const result = await queue.getTaskResult({ task_id: "ocq_missingtask" });
  assert.equal(result.ok, false);
  assert.notEqual(result.message?.length, 0);
});
