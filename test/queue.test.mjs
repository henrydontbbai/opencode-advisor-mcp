import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as createTempDirOnDisk, promises as fs, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  runQueueMaintenance,
  runQueueRunner,
  sortByCreatedAt,
  writeTaskFile,
} from "../src/task-queue.mjs";

const tempDirs = new Set();

function createTempDir(prefix = "ocq-") {
  const template = path.isAbsolute(prefix) ? prefix : path.join(os.tmpdir(), prefix);
  const directory = createTempDirOnDisk(template);
  tempDirs.add(directory);
  return directory;
}

function mkdtempSync(prefix) {
  return createTempDir(prefix);
}

function createBarrier(participants) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });

  return async () => {
    arrivals += 1;
    if (arrivals === participants) {
      release();
    }
    await ready;
  };
}

function createGate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return {
    open,
    wait: () => promise,
  };
}

async function waitFor(promise, timeoutMs = 1000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function successfulTaskResult(task) {
  return {
    ok: true,
    base_ref: "HEAD",
    status: "",
    diff_truncated: false,
    [task.role === "planner" ? "planner_text" : "advisor_text"]: "ok",
    opencode_exit_code: 0,
  };
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  tempDirs.clear();
});

test("getQueueConfig uses 4/2/2 defaults", () => {
  const config = getQueueConfig({}, "win32");
  assert.equal(config.limitGlobal, 4);
  assert.equal(config.limitPlanner, 2);
  assert.equal(config.limitReviewer, 2);
  assert.equal(config.inlineWaitMs, 60000);
  assert.equal(config.retryAfterMs, 30000);
  assert.equal(config.maxPending, 16);
  assert.equal(config.sessionRetentionMs, 259200000);
  assert.equal(config.taskRetentionMs, 604800000);
});

test("writeTaskFile keeps queue data private on POSIX", async () => {
  const queueDir = createTempDir();
  const task = createTaskFile({
    id: "ocq_privatefile",
    role: "planner",
    input: { cwd: "/repo", current_plan: "private" },
  });

  await writeTaskFile(queueDir, task);

  if (process.platform !== "win32") {
    assert.equal(statSync(queueDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(queueDir, "ocq_privatefile.json")).mode & 0o777, 0o600);
  }
});

test("processQueueOnce saves a session id without exposing it in the public result", async () => {
  const queueDir = createTempDir();
  const task = createTaskFile({
    id: "ocq_sessiontask",
    role: "planner",
    input: { cwd: "/repo", current_plan: "record session" },
  });
  await writeTaskFile(queueDir, task);

  await processQueueOnce({
    queueDir,
    config: getQueueConfig({}, process.platform),
    runnerId: "runner_sessionmetadata",
    runTask: async (claimedTask, { onSessionId }) => {
      await onSessionId("ses_queueinternal");
      return successfulTaskResult(claimedTask);
    },
  });

  const saved = await readTaskFile(queueDir, task.id);
  assert.equal(saved.session_id, "ses_queueinternal");
  assert.equal("session_id" in saved.result, false);
});

test("runQueueMaintenance deletes expired managed sessions and terminal task files", async () => {
  const queueDir = createTempDir();
  const now = Date.now();
  const expiredTask = {
    ...createTaskFile({
      id: "ocq_retainedtask",
      role: "reviewer",
      input: { cwd: "/repo", question: "cleanup" },
      now: now - 7000,
    }),
    status: "completed",
    completed_at: new Date(now - 7000).toISOString(),
    result: successfulTaskResult({ role: "reviewer" }),
  };
  await writeTaskFile(queueDir, expiredTask);

  const commands = [];
  const config = {
    ...getQueueConfig({
      OPENCODE_ADVISOR_OPENCODE_DATA_HOME: path.join(queueDir, "profile"),
      OPENCODE_ADVISOR_SESSION_RETENTION_MS: "5000",
      OPENCODE_ADVISOR_QUEUE_TASK_RETENTION_MS: "5000",
      OPENCODE_ADVISOR_MAINTENANCE_INTERVAL_MS: "1",
    }, process.platform),
    queueDir,
  };
  await runQueueMaintenance({
    queueDir,
    config,
    now,
    runSessionCommand: async (command, args, options) => {
      commands.push({ command, args, options });
      if (args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "ses_expired",
              title: "opencode-advisor:ocq_retainedtask",
              updated: now - 7000,
            },
            {
              id: "ses_unmanaged",
              title: "normal user session",
              updated: now - 7000,
            },
            {
              id: "ses_fresh",
              title: "opencode-advisor:ocq_fresh",
              updated: now,
            },
          ]),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(await readTaskFile(queueDir, expiredTask.id), null);
  assert.deepEqual(
    commands.map((command) => command.args),
    [
      ["session", "list", "--format", "json"],
      ["session", "delete", "ses_expired"],
    ],
  );
  assert.equal(commands[0].options.env.XDG_DATA_HOME, config.opencodeDataHome);
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

test("getQueueConfig selects the platform-appropriate home directory", () => {
  const config = getQueueConfig(
    {
      HOME: "/home/posix-user",
      USERPROFILE: "C:\\Users\\windows-user",
    },
    "linux",
  );

  assert.equal(config.queueDir, "/home/posix-user/.codex/opencode-advisor/queue");
});

test("sortByCreatedAt orders malformed timestamps deterministically and coerces task ids", () => {
  const sorted = sortByCreatedAt([
    { id: 2, created_at: "not-a-date" },
    { id: "valid", created_at: "2026-01-01T00:00:00.000Z" },
    { id: 10, created_at: "not-a-date" },
  ]);

  assert.deepEqual(sorted.map((task) => String(task.id)), ["valid", "10", "2"]);
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

test("ensureQueueRunner restarts a fresh lease whose owner PID is dead", async () => {
  const queueDir = createTempDir();
  const deadOwner = {
    runner_id: "runner_dead",
    pid: 4242,
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 600000).toISOString(),
    started_at: new Date().toISOString(),
  };
  writeFileSync(path.join(queueDir, "_runner.lock"), `${JSON.stringify(deadOwner)}\n`, "utf8");
  writeFileSync(path.join(queueDir, "_runner.json"), `${JSON.stringify(deadOwner)}\n`, "utf8");

  let spawnCount = 0;
  const started = await ensureQueueRunner({
    env: { OPENCODE_ADVISOR_QUEUE_DIR: queueDir },
    platform: process.platform,
    spawnProcess: () => {
      spawnCount += 1;
      return { unref() {} };
    },
    processControl: {
      isProcessAlive: () => false,
    },
  });

  assert.equal(started, true);
  assert.equal(spawnCount, 1);
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

test("processQueueOnce claims a queued task exactly once across competing runners", async () => {
  const queueDir = createTempDir();
  const config = getQueueConfig(
    {
      OPENCODE_ADVISOR_CONCURRENCY_GLOBAL: "1",
      OPENCODE_ADVISOR_CONCURRENCY_PLANNER: "1",
      OPENCODE_ADVISOR_CONCURRENCY_REVIEWER: "1",
    },
    process.platform,
  );
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_competingclaim",
    role: "planner",
    input: { cwd: "/repo", current_plan: "claim once" },
  }));

  const barrier = createBarrier(2);
  const executions = [];
  const runTask = async (task) => {
    executions.push(task.id);
    return successfulTaskResult(task);
  };

  const [first, second] = await Promise.all([
    processQueueOnce({
      queueDir,
      config,
      runTask,
      runnerId: "runner_first",
      beforeClaim: barrier,
    }),
    processQueueOnce({
      queueDir,
      config,
      runTask,
      runnerId: "runner_second",
      beforeClaim: barrier,
    }),
  ]);

  const task = await readTaskFile(queueDir, "ocq_competingclaim");
  assert.deepEqual(executions, ["ocq_competingclaim"]);
  assert.equal(task.status, "completed");
  assert.equal(task.attempt_count, 1);
  assert.deepEqual(
    [...first.startedIds, ...second.startedIds],
    ["ocq_competingclaim"],
  );
});

test("runQueueRunner refreshes its lease while a task is still running", async () => {
  const queueDir = createTempDir();
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_longrunninglease",
    role: "planner",
    input: { cwd: "/repo", current_plan: "keep lease fresh" },
  }));

  const started = createGate();
  const finish = createGate();
  const runnerPromise = runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "50",
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => {
      started.open();
      await finish.wait();
      return successfulTaskResult(task);
    },
  });

  await started.wait();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const state = JSON.parse(readFileSync(path.join(queueDir, "_runner.json"), "utf8"));
  assert.ok(Date.now() - Date.parse(state.heartbeat_at) < 80);

  finish.open();
  await runnerPromise;
});

test("runQueueRunner waits for an in-flight heartbeat without queuing later refreshes", async () => {
  const queueDir = createTempDir();
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_heartbeatcleanup",
    role: "planner",
    input: { cwd: "/repo", current_plan: "finish heartbeat cleanup" },
  }));

  const taskStarted = createGate();
  const finishTask = createGate();
  const heartbeatStarted = createGate();
  const releaseHeartbeat = createGate();
  const open = fs.open;
  let holdNextHeartbeat = false;
  let heartbeatHeld = false;
  let heartbeatReleased = false;
  let releaseLockAcquisitionsAfterHeartbeat = 0;
  const handlers = new Map();
  const signals = {
    on(signal, handler) {
      handlers.set(signal, handler);
    },
    off(signal, handler) {
      assert.equal(handlers.get(signal), handler);
      handlers.delete(signal);
    },
  };
  fs.open = async (filePath, flags, ...args) => {
    const isRunnerReleaseLock = flags === "wx" && String(filePath).endsWith("_runner.release.lock");
    if (heartbeatReleased && isRunnerReleaseLock) {
      releaseLockAcquisitionsAfterHeartbeat += 1;
    }
    if (
      holdNextHeartbeat &&
      !heartbeatHeld &&
      isRunnerReleaseLock
    ) {
      heartbeatHeld = true;
      heartbeatStarted.open();
      await releaseHeartbeat.wait();
    }
    return open(filePath, flags, ...args);
  };

  let runnerPromise;
  try {
    runnerPromise = runQueueRunner({
      env: {
        OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
        OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "30",
        OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
        OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
      },
      platform: process.platform,
      signals,
      runTask: async (task) => {
        taskStarted.open();
        await finishTask.wait();
        return successfulTaskResult(task);
      },
    });

    await waitFor(taskStarted.wait());
    holdNextHeartbeat = true;
    await waitFor(heartbeatStarted.wait());
    await new Promise((resolve) => setTimeout(resolve, 60));
    finishTask.open();
    handlers.get("SIGTERM")();

    const runnerState = await Promise.race([
      runnerPromise.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    assert.equal(runnerState, "pending");
    heartbeatReleased = true;
    releaseHeartbeat.open();
    await waitFor(runnerPromise);
    assert.equal(releaseLockAcquisitionsAfterHeartbeat, 1);
  } finally {
    releaseHeartbeat.open();
    fs.open = open;
    await waitFor(runnerPromise);
  }
});

test("runQueueRunner does not start work when the initial heartbeat loses its lease", async () => {
  const queueDir = createTempDir();
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_initialheartbeat",
    role: "planner",
    input: { cwd: "/repo", current_plan: "wait for initial heartbeat" },
  }));

  const readFile = fs.readFile;
  let runnerLockReads = 0;
  let taskRuns = 0;
  fs.readFile = async (filePath, ...args) => {
    if (String(filePath).endsWith("_runner.lock")) {
      runnerLockReads += 1;
      if (runnerLockReads === 3) {
        return `${JSON.stringify({ runner_id: "runner_successor", pid: 999999 })}\n`;
      }
    }
    return readFile(filePath, ...args);
  };

  try {
    await assert.rejects(
      runQueueRunner({
        env: {
          OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
          OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
          OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
        },
        platform: process.platform,
        runTask: async (task) => {
          taskRuns += 1;
          return successfulTaskResult(task);
        },
        sleep: async () => {
          throw new Error("stop after lost lease");
        },
      }),
      /stop after lost lease/,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(taskRuns, 0);
  } finally {
    fs.readFile = readFile;
  }
});

test("a public poll keeps an over-TTL running task with a fresh lease pending", async () => {
  const queueDir = createTempDir();
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_publiclongrun",
    role: "planner",
    input: { cwd: "/repo", current_plan: "stay pending" },
  }));

  const started = createGate();
  const finish = createGate();
  const runnerPromise = runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS: "600000",
      OPENCODE_ADVISOR_TASK_TTL_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => {
      started.open();
      await finish.wait();
      return successfulTaskResult(task);
    },
  });

  await started.wait();
  const runningTask = await readTaskFile(queueDir, "ocq_publiclongrun");
  await writeTaskFile(queueDir, {
    ...runningTask,
    created_at: new Date(Date.now() - 60000).toISOString(),
  });
  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "50",
      OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS: "50",
      OPENCODE_ADVISOR_TASK_TTL_MS: "50",
    },
    platform: process.platform,
    spawnProcess: () => ({ unref() {} }),
  });
  const result = await queue.getTaskResult({ task_id: "ocq_publiclongrun" });
  assert.equal(result.error, "queued");
  assert.equal(result.details.status, "running");
  assert.equal(result.details.phase_pending, true);

  finish.open();
  await runnerPromise;
});

test("a transient runner-state read cannot requeue an in-flight task", async () => {
  const queueDir = createTempDir();
  const now = Date.now();
  const runningTask = {
    ...createTaskFile({
      id: "ocq_unreadablerunnerstate",
      role: "planner",
      input: { cwd: "/repo", current_plan: "do not duplicate" },
    }),
    status: "running",
    created_at: new Date(now - 10000).toISOString(),
    updated_at: new Date(now - 10000).toISOString(),
    started_at: new Date(now - 10000).toISOString(),
    runner_id: "runner_live",
  };
  await writeTaskFile(queueDir, runningTask);
  writeFileSync(path.join(queueDir, "_runner.json"), "{", "utf8");

  const queue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS: "1",
      OPENCODE_ADVISOR_TASK_TTL_MS: "600000",
    },
    platform: process.platform,
    spawnProcess: () => ({ unref() {} }),
  });
  const result = await queue.getTaskResult({ task_id: "ocq_unreadablerunnerstate" });

  assert.equal(result.error, "queued");
  assert.equal(result.details.status, "running");
  assert.equal((await readTaskFile(queueDir, "ocq_unreadablerunnerstate")).status, "running");
});

test("runQueueRunner terminates a live stale owner before taking over its lease", async () => {
  const queueDir = createTempDir();
  const staleAt = new Date(Date.now() - 5000).toISOString();
  const staleOwner = {
    runner_id: "runner_stale",
    pid: 4242,
    heartbeat_at: staleAt,
    lease_expires_at: staleAt,
    started_at: staleAt,
  };
  writeFileSync(path.join(queueDir, "_runner.lock"), `${JSON.stringify(staleOwner)}\n`, "utf8");
  writeFileSync(path.join(queueDir, "_runner.json"), `${JSON.stringify(staleOwner)}\n`, "utf8");

  let ownerAlive = true;
  let terminationRequests = 0;
  const result = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => successfulTaskResult(task),
    processControl: {
      isProcessAlive: () => ownerAlive,
      terminateProcess: async () => {
        terminationRequests += 1;
        ownerAlive = false;
      },
      waitForProcessExit: async () => !ownerAlive,
    },
  });

  assert.equal(result.started, true);
  assert.equal(terminationRequests, 1);
});

test("runQueueRunner leaves a fresh legacy owner alone during an upgrade", async () => {
  const queueDir = createTempDir();
  const legacyOwner = {
    runner_id: "runner_legacy",
    pid: 4242,
    heartbeat_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  };
  writeFileSync(path.join(queueDir, "_runner.lock"), "runner_legacy\n", "utf8");
  writeFileSync(path.join(queueDir, "_runner.json"), `${JSON.stringify(legacyOwner)}\n`, "utf8");

  let terminationRequests = 0;
  const result = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: "600000",
    },
    platform: process.platform,
    runTask: async (task) => successfulTaskResult(task),
    processControl: {
      isProcessAlive: () => true,
      terminateProcess: async () => {
        terminationRequests += 1;
      },
      waitForProcessExit: async () => false,
    },
  });

  assert.equal(result.started, false);
  assert.equal(terminationRequests, 0);
});

test("runQueueRunner recovers immediately when a fresh lease owner is dead", async () => {
  const queueDir = createTempDir();
  const owner = {
    runner_id: "runner_dead",
    pid: 4242,
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 600000).toISOString(),
    started_at: new Date().toISOString(),
  };
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_freshdeadowner",
    role: "planner",
    input: { cwd: "/repo", current_plan: "recover dead owner" },
  }));
  writeFileSync(path.join(queueDir, "_runner.lock"), `${JSON.stringify(owner)}\n`, "utf8");
  writeFileSync(path.join(queueDir, "_runner.json"), `${JSON.stringify(owner)}\n`, "utf8");

  const seen = [];
  const result = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => {
      seen.push(task.id);
      return successfulTaskResult(task);
    },
    processControl: {
      isProcessAlive: () => false,
      terminateProcess: async () => {
        throw new Error("dead owner must not be terminated");
      },
      waitForProcessExit: async () => true,
    },
  });

  assert.equal(result.started, true);
  assert.deepEqual(seen, ["ocq_freshdeadowner"]);
  assert.equal((await readTaskFile(queueDir, "ocq_freshdeadowner")).status, "completed");
});

test("runQueueRunner only releases the lease it owns", async () => {
  const queueDir = createTempDir();
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_successorlease",
    role: "planner",
    input: { cwd: "/repo", current_plan: "preserve successor" },
  }));

  const handlers = new Map();
  const successor = {
    runner_id: "runner_successor",
    pid: 9876,
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    started_at: new Date().toISOString(),
  };
  await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    signals: {
      on(signal, handler) {
        handlers.set(signal, handler);
      },
      off() {},
    },
    runTask: async (task) => {
      writeFileSync(path.join(queueDir, "_runner.lock"), `${JSON.stringify(successor)}\n`, "utf8");
      writeFileSync(path.join(queueDir, "_runner.json"), `${JSON.stringify(successor)}\n`, "utf8");
      handlers.get("SIGTERM")();
      return successfulTaskResult(task);
    },
  });

  assert.deepEqual(
    JSON.parse(readFileSync(path.join(queueDir, "_runner.lock"), "utf8")),
    successor,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(queueDir, "_runner.json"), "utf8")),
    successor,
  );
});

test("a superseded runner cannot overwrite a successor task result", async () => {
  const queueDir = createTempDir();
  const task = createTaskFile({
    id: "ocq_supersededresult",
    role: "planner",
    input: { cwd: "/repo", current_plan: "preserve successor result" },
  });
  await writeTaskFile(queueDir, task);

  const started = createGate();
  const finish = createGate();
  const handlers = new Map();
  const firstRunner = runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    signals: {
      on(signal, handler) {
        handlers.set(signal, handler);
      },
      off() {},
    },
    runTask: async (currentTask) => {
      started.open();
      await finish.wait();
      return successfulTaskResult(currentTask);
    },
  });

  await started.wait();
  const successorResult = {
    ...successfulTaskResult(task),
    planner_text: "successor result",
  };
  await writeTaskFile(queueDir, {
    ...task,
    status: "completed",
    attempt_count: 2,
    completed_at: new Date().toISOString(),
    result: successorResult,
  });
  finish.open();
  handlers.get("SIGTERM")();
  await firstRunner;

  const saved = await readTaskFile(queueDir, "ocq_supersededresult");
  assert.equal(saved.status, "completed");
  assert.equal(saved.attempt_count, 2);
  assert.equal(saved.result.planner_text, "successor result");
});

test("runQueueRunner releases its lease after repeated loop errors", async () => {
  const queueDir = createTempDir();
  writeFileSync(path.join(queueDir, "ocq_looperror.json"), "{", "utf8");
  let sleeps = 0;
  const runnerResult = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "600000",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    sleep: async () => {
      sleeps += 1;
    },
    runTask: async () => successfulTaskResult({ role: "planner" }),
  });

  assert.equal(runnerResult.started, true);
  assert.equal(sleeps, 2);
  assert.equal(readdirSync(queueDir).includes("_runner.lock"), false);
  assert.equal(readdirSync(queueDir).includes("_runner.json"), false);

  unlinkSync(path.join(queueDir, "ocq_looperror.json"));
  await writeTaskFile(queueDir, createTaskFile({
    id: "ocq_recoveredaftererror",
    role: "planner",
    input: { cwd: "/repo", current_plan: "recover clean runner" },
  }));
  const recovered = await runQueueRunner({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
      OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS: "1",
      OPENCODE_ADVISOR_QUEUE_POLL_MS: "1",
    },
    platform: process.platform,
    runTask: async (task) => successfulTaskResult(task),
  });
  assert.equal(recovered.started, true);
  assert.equal((await readTaskFile(queueDir, "ocq_recoveredaftererror")).status, "completed");
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

test("createTaskQueue keeps a temporarily unreadable task pending instead of expiring it", async () => {
  const queueDir = createTempDir();
  writeFileSync(path.join(queueDir, "ocq_transientread.json"), "{", "utf8");
  const queue = createTaskQueue({
    env: { OPENCODE_ADVISOR_QUEUE_DIR: queueDir },
    platform: process.platform,
    spawnProcess: () => ({ unref() {} }),
  });

  const result = await queue.getTaskResult({ task_id: "ocq_transientread" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "queued");
  assert.equal(result.details.task_id, "ocq_transientread");
  assert.equal(result.details.phase_pending, true);
  assert.notEqual(result.details.status, "expired");
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
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "ocq-unavailable-"));
  const occupiedPath = path.join(baseDir, "occupied");
  writeFileSync(occupiedPath, "not a directory\n", "utf8");

  const failingQueue = createTaskQueue({
    env: {
      OPENCODE_ADVISOR_QUEUE_DIR: path.join(occupiedPath, "queue"),
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
