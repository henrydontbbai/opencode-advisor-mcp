import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTaskQueue,
  createTaskFile,
  ensureQueueRunner,
  getQueueConfig,
  lockSubmissionForTest,
  processQueueOnce,
  readTaskFile,
  runQueueRunner,
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

test("getQueueConfig keeps stale thresholds at or above the default floor when timeout is reduced", () => {
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_TIMEOUT_MS: "1000",
    },
    process.platform,
  );

  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.runnerStaleMs, 420000);
  assert.equal(config.runningStaleMs, 420000);
});

test("getQueueConfig still honors explicit stale threshold overrides", () => {
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_TIMEOUT_MS: "1000",
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "500000",
      OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS: "700000",
    },
    process.platform,
  );

  assert.equal(config.runnerStaleMs, 500000);
  assert.equal(config.runningStaleMs, 700000);
});

test("getQueueConfig treats OPENCODE_ADVISOR_QUEUE_DIR as the direct queue directory", () => {
  const queueDir = path.join(os.tmpdir(), "ocq-direct");
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
    },
    process.platform,
  );

  assert.equal(config.queueDir, path.resolve(queueDir));
});

test("ensureQueueRunner normalizes a relative queue override before spawning the runner", async () => {
  const relativeQueueDir = path.relative(process.cwd(), path.join(os.tmpdir(), "ocq-relative-runner"));
  const env = {
    OPENCODE_ADVISOR_QUEUE_DIR: relativeQueueDir,
  };

  let spawnOptions;
  await ensureQueueRunner({
    env,
    platform: process.platform,
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return { unref() {} };
    },
    nodeExec: process.execPath,
  });

  assert.equal(
    spawnOptions.env.OPENCODE_ADVISOR_QUEUE_DIR,
    path.resolve(relativeQueueDir),
  );
  assert.equal(spawnOptions.cwd, path.resolve(relativeQueueDir));
});

test("ensureQueueRunner writes runner logs when a queue log directory is configured", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-logs-"));
  const logDir = mkdtempSync(path.join(os.tmpdir(), "ocq-runner-logs-"));
  let spawnOptions;

  await ensureQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_LOG_DIR: logDir,
    },
    platform: process.platform,
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return { unref() {} };
    },
    nodeExec: process.execPath,
  });

  assert.equal(spawnOptions.stdio[0], "ignore");
  assert.notEqual(spawnOptions.stdio[1], "ignore");
  assert.notEqual(spawnOptions.stdio[2], "ignore");
  assert.equal(spawnOptions.env.OPENCODE_ADVISOR_QUEUE_LOG_DIR, logDir);
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

test("processQueueOnce expires stale running tasks when TTL is already exceeded", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_CONCURRENCY_GLOBAL: "1",
      OPENCODE_ADVISOR_CONCURRENCY_PLANNER: "1",
      OPENCODE_ADVISOR_CONCURRENCY_REVIEWER: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "1",
      OPENCODE_ADVISOR_TASK_TTL_MS: "1",
    },
    process.platform,
  );

  const staleExpiredRunningTask = {
    ...createTaskFile({
      id: "ocq_stalerunningexpired",
      role: "planner",
      input: { cwd: "/repo", current_plan: "stale running" },
    }),
    status: "running",
    created_at: new Date(Date.now() - 5000).toISOString(),
    updated_at: new Date(Date.now() - 5000).toISOString(),
    started_at: new Date(Date.now() - 5000).toISOString(),
    runner_id: "runner_dead",
  };

  await writeTaskFile(queueDir, staleExpiredRunningTask);

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

  const expiredTask = await readTaskFile(queueDir, "ocq_stalerunningexpired");
  assert.deepEqual(started, []);
  assert.equal(expiredTask.status, "expired");
  assert.equal(expiredTask.result.details.status, "expired");
  assert.equal(expiredTask.result.details.phase_pending, false);
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

test("createTaskQueue returns completed reviewer results without respawning the runner", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const completedTask = {
    ...createTaskFile({
      id: "ocq_completedreviewer",
      role: "reviewer",
      input: { cwd: "/repo", question: "review" },
    }),
    status: "completed",
    completed_at: new Date().toISOString(),
    result: {
      ok: true,
      base_ref: "HEAD",
      status: "M src/server.mjs",
      diff_truncated: false,
      advisor_text: "Looks good",
      opencode_exit_code: 0,
    },
  };
  await writeTaskFile(queueDir, completedTask);

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: { OPENCODE_ADVISOR_QUEUE_DIR: queueDir },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.getTaskResult({ task_id: "ocq_completedreviewer" });
  assert.equal(result.ok, true);
  assert.equal(result.advisor_text, "Looks good");
  assert.equal(spawnCalled, false);
});

test("createTaskQueue returns completed planner results without respawning the runner", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const completedTask = {
    ...createTaskFile({
      id: "ocq_completedplanner",
      role: "planner",
      input: { cwd: "/repo", current_plan: "1. Validate" },
    }),
    status: "completed",
    completed_at: new Date().toISOString(),
    result: {
      ok: true,
      base_ref: "HEAD",
      status: "M docs/plan.md",
      diff_truncated: false,
      planner_text: "Tighten validation points.",
      opencode_exit_code: 0,
    },
  };
  await writeTaskFile(queueDir, completedTask);

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: { OPENCODE_ADVISOR_QUEUE_DIR: queueDir },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.getTaskResult({ task_id: "ocq_completedplanner" });
  assert.equal(result.ok, true);
  assert.equal(result.planner_text, "Tighten validation points.");
  assert.equal(spawnCalled, false);
});

test("createTaskQueue returns expired for missing tasks without respawning the runner", async () => {
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

  const result = await queue.getTaskResult({ task_id: "ocq_missingtask" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.equal(result.details.status, "expired");
  assert.equal(result.details.task_id, "ocq_missingtask");
  assert.equal(spawnCalled, false);
});

test("createTaskQueue returns queue_full without spawning the runner", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  await writeTaskFile(queueDir, createTaskFile({ id: "ocq_pendingone", role: "planner", input: { current_plan: "a" } }));
  await writeTaskFile(queueDir, createTaskFile({ id: "ocq_pendingtwo", role: "reviewer", input: { question: "b" } }));

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_MAX_PENDING: "2",
    },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.submitAndWait({ role: "planner", input: { current_plan: "overflow" } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.equal(result.details.status, "queue_full");
  assert.equal(result.details.max_pending, 2);
  assert.equal(spawnCalled, false);
});

test("createTaskQueue returns a structured error when the queue directory cannot be created", async () => {
  const failingQueue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: process.platform === "win32" ? "Z:\\__definitely_missing_perm__\\queue" : "/proc/1/queue",
    },
    platform: process.platform,
    spawnProcess: () => {
      throw new Error("should not spawn");
    },
  });

  const result = await failingQueue.submitAndWait({ role: "planner", input: { current_plan: "blocked" } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.match(result.message, /queue directory is unavailable/i);
});

test("createTaskQueue enforces maxPending atomically across concurrent submissions", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  let spawnCount = 0;
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_MAX_PENDING: "1",
      OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    spawnProcess: () => {
      spawnCount += 1;
      return { unref() {} };
    },
  });

  const [first, second] = await Promise.all([
    queue.submitAndWait({ role: "planner", input: { current_plan: "one" } }),
    queue.submitAndWait({ role: "reviewer", input: { question: "two" } }),
  ]);

  const queueFullCount = [first, second].filter((item) => item?.details?.status === "queue_full").length;
  const queueFiles = readdirSync(queueDir).filter((name) => name.endsWith(".json") && !name.startsWith("_"));

  assert.equal(queueFullCount, 1);
  assert.equal(spawnCount, 1);
  assert.equal(queueFiles.length, 1);
});

test("createTaskQueue recovers from a stale submission lock", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const staleLockPath = path.join(queueDir, "_submit.lock");
  writeFileSync(staleLockPath, "stale\n", "utf8");
  const oldDate = new Date(Date.now() - 15000);
  utimesSync(staleLockPath, oldDate, oldDate);

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.submitAndWait({ role: "planner", input: { current_plan: "recover stale lock" } });
  const queueFiles = readdirSync(queueDir).filter((name) => name.endsWith(".json") && !name.startsWith("_"));

  assert.equal(result.error, "queued");
  assert.equal(spawnCalled, true);
  assert.equal(queueFiles.length, 1);
});

test("lockSubmissionForTest retries transient EPERM on Windows-style lock acquisition", async () => {
  let openAttempts = 0;
  const fakeHandle = {
    async close() {},
  };

  const result = await lockSubmissionForTest("C:\\fake-queue", async () => "ok", {
    openImpl: async () => {
      openAttempts += 1;
      if (openAttempts === 1) {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
      return fakeHandle;
    },
    unlinkImpl: async () => {},
    statImpl: async () => ({ mtimeMs: Date.now() }),
    delayImpl: async () => {},
    pathApi: path.win32,
  });

  assert.equal(result, "ok");
  assert.equal(openAttempts, 2);
});

test("createTaskQueue ignores TTL-expired pending tasks when checking queue_full", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const oldIso = new Date(Date.now() - 5000).toISOString();
  await writeTaskFile(queueDir, {
    ...createTaskFile({ id: "ocq_expiredone", role: "planner", input: { current_plan: "a" } }),
    created_at: oldIso,
    updated_at: oldIso,
  });
  await writeTaskFile(queueDir, {
    ...createTaskFile({ id: "ocq_expiredtwo", role: "reviewer", input: { question: "b" } }),
    created_at: oldIso,
    updated_at: oldIso,
  });

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_MAX_PENDING: "2",
      OPENCODE_ADVISOR_TASK_TTL_MS: "1000",
      OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS: "5",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.submitAndWait({ role: "planner", input: { current_plan: "fresh" } });
  assert.equal(result.error, "queued");
  assert.equal(spawnCalled, true);
  assert.equal((await readTaskFile(queueDir, "ocq_expiredone")).status, "expired");
  assert.equal((await readTaskFile(queueDir, "ocq_expiredtwo")).status, "expired");
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

test("writeTaskFile persists task files atomically", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const task = createTaskFile({
    id: "ocq_atomicwrite",
    role: "planner",
    input: { cwd: "/repo", current_plan: "atomic" },
  });

  await writeTaskFile(queueDir, task);

  const entries = readdirSync(queueDir).filter((name) => name.includes("atomicwrite"));
  assert.deepEqual(entries, ["ocq_atomicwrite.json"]);
});

test("runQueueRunner exits promptly after SIGTERM once the current task finishes", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const task = createTaskFile({
    id: "ocq_shutdown",
    role: "planner",
    input: { cwd: "/repo", current_plan: "shutdown" },
  });
  await writeTaskFile(queueDir, task);

  let stopHandler;
  let slept = false;
  const runnerPromise = runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async () => ({
      ok: true,
      base_ref: "HEAD",
      status: "",
      diff_truncated: false,
      planner_text: "done",
      opencode_exit_code: 0,
    }),
    sleep: async () => {
      slept = true;
      throw new Error("runner should not keep sleeping after shutdown is requested");
    },
    signals: {
      on: (signal, handler) => {
        if (signal === "SIGTERM") stopHandler = handler;
      },
    },
  });

  assert.equal(typeof stopHandler, "function");
  stopHandler();
  await runnerPromise;
  const saved = await readTaskFile(queueDir, "ocq_shutdown");
  assert.equal(saved.status, "completed");
  assert.equal(slept, false);
});

test("runQueueRunner removes signal handlers after shutdown", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const task = createTaskFile({
    id: "ocq_signalcleanup",
    role: "planner",
    input: { cwd: "/repo", current_plan: "cleanup" },
  });
  await writeTaskFile(queueDir, task);

  const handlers = new Map();
  const removed = [];
  const signals = {
    on(signal, handler) {
      handlers.set(signal, handler);
    },
    off(signal, handler) {
      removed.push(signal);
      assert.equal(handlers.get(signal), handler);
      handlers.delete(signal);
    },
  };

  await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    signals,
    runTask: async () => {
      handlers.get("SIGTERM")?.();
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        planner_text: "done",
        opencode_exit_code: 0,
      };
    },
  });

  assert.deepEqual(removed.sort(), ["SIGINT", "SIGTERM"]);
  assert.equal(handlers.size, 0);
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

test("createTaskQueue expires stale queued tasks on first public poll", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const staleQueuedTask = {
    ...createTaskFile({
      id: "ocq_stalepoll",
      role: "planner",
      input: { cwd: "/repo", current_plan: "stale" },
    }),
    created_at: new Date(Date.now() - 5000).toISOString(),
    updated_at: new Date(Date.now() - 5000).toISOString(),
  };
  await writeTaskFile(queueDir, staleQueuedTask);

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_TASK_TTL_MS: "1",
    },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.getTaskResult({ task_id: "ocq_stalepoll" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.equal(result.details.status, "expired");
  assert.equal(spawnCalled, false);
  assert.equal((await readTaskFile(queueDir, "ocq_stalepoll")).status, "expired");
});

test("createTaskQueue keeps an actively running task pending even when task TTL is shorter than runtime", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const activeRunningTask = {
    ...createTaskFile({
      id: "ocq_activerunning",
      role: "planner",
      input: { cwd: "/repo", current_plan: "long run" },
    }),
    status: "running",
    created_at: new Date(Date.now() - 5000).toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    runner_id: "runner_live",
  };
  await writeTaskFile(queueDir, activeRunningTask);

  let spawnCalled = false;
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_TASK_TTL_MS: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS: "600000",
    },
    platform: process.platform,
    spawnProcess: () => {
      spawnCalled = true;
      return { unref() {} };
    },
  });

  const result = await queue.getTaskResult({ task_id: "ocq_activerunning" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "queued");
  assert.equal(result.details.status, "running");
  assert.equal(result.details.phase_pending, true);
  assert.equal((await readTaskFile(queueDir, "ocq_activerunning")).status, "running");
  assert.equal(spawnCalled, true);
});

test("processQueueOnce expires stale queued tasks after TTL without starting them", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-"));
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_TASK_TTL_MS: "1",
    },
    process.platform,
  );

  const staleQueuedTask = {
    ...createTaskFile({
      id: "ocq_stalequeued",
      role: "planner",
      input: { cwd: "/repo", current_plan: "stale" },
    }),
    created_at: new Date(Date.now() - 5000).toISOString(),
    updated_at: new Date(Date.now() - 5000).toISOString(),
  };

  await writeTaskFile(queueDir, staleQueuedTask);

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

  const expiredTask = await readTaskFile(queueDir, "ocq_stalequeued");
  assert.deepEqual(started, []);
  assert.equal(expiredTask.status, "expired");
  assert.equal(expiredTask.result.error, "opencode_failed");
  assert.equal(expiredTask.result.details.status, "expired");
});
