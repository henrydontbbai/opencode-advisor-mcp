import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
