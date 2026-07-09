import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, pathForPlatform, positiveNumber } from "./runtime-shared.mjs";

const QUEUE_PENDING_MESSAGE =
  "OpenCode task is queued or running, not failed. Keep this phase pending and call get_opencode_task later.";
const RUNNER_LOCK_FILENAME = "_runner.lock";
const RUNNER_STATE_FILENAME = "_runner.json";
const RUNNER_SCRIPT_PATH = fileURLToPath(new URL("./queue-runner.mjs", import.meta.url));
const TASK_ID_PATTERN = /^ocq_[A-Za-z0-9]+$/;

function isoFrom(value) {
  return new Date(value).toISOString();
}

function taskFilename(id) {
  return `${id}.json`;
}

function taskPath(queueDir, id) {
  return path.join(queueDir, taskFilename(id));
}

function runnerLockPath(queueDir) {
  return path.join(queueDir, RUNNER_LOCK_FILENAME);
}

function runnerStatePath(queueDir) {
  return path.join(queueDir, RUNNER_STATE_FILENAME);
}

async function ensureQueueDir(queueDir) {
  await fs.mkdir(queueDir, { recursive: true });
}

async function readJsonIfExists(filePath) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        return null;
      }
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  return null;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getDefaultQueueDir(env = process.env, platform = process.platform) {
  const pathApi = pathForPlatform(platform);
  const home =
    env.OPENCODE_ADVISOR_QUEUE_DIR ||
    env.USERPROFILE ||
    env.HOME ||
    os.homedir();

  return pathApi.join(home, ".codex", "opencode-advisor", "queue");
}

function roleLimit(role, config) {
  return role === "planner" ? config.limitPlanner : config.limitReviewer;
}

function normalizeTaskAge(task, now) {
  const updatedAt = Date.parse(task.updated_at || task.created_at || now);
  const createdAt = Date.parse(task.created_at || now);
  return {
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
  };
}

function sortByCreatedAt(tasks) {
  return [...tasks].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || 0);
    const rightTime = Date.parse(right.created_at || 0);
    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
}

function createPendingResponse(task, tasks, config) {
  const queuedTasks = sortByCreatedAt(tasks.filter((entry) => entry.status === "queued"));
  const position = task.status === "queued"
    ? Math.max(1, queuedTasks.findIndex((entry) => entry.id === task.id) + 1)
    : 0;

  return {
    ok: false,
    error: "queued",
    message: QUEUE_PENDING_MESSAGE,
    details: {
      task_id: task.id,
      role: task.role,
      status: task.status,
      phase_pending: true,
      retry_after_ms: config.retryAfterMs,
      position,
      limit_global: config.limitGlobal,
      limit_role: roleLimit(task.role, config),
    },
  };
}

function createExpiredResponse(taskId) {
  return {
    ok: false,
    error: "opencode_failed",
    message: "OpenCode task expired before completion or is no longer available.",
    details: {
      task_id: taskId,
      status: "expired",
      phase_pending: false,
    },
  };
}

function createInvalidTaskIdResponse() {
  return {
    ok: false,
    error: "opencode_failed",
    message: "Invalid OpenCode task id.",
    details: {
      status: "invalid_task_id",
      phase_pending: false,
    },
  };
}

function createQueueFullResponse(config) {
  return {
    ok: false,
    error: "opencode_failed",
    message: "OpenCode task queue is full. Retry after queued work drains.",
    details: {
      status: "queue_full",
      phase_pending: false,
      retry_after_ms: config.retryAfterMs,
      max_pending: config.maxPending,
    },
  };
}

function isValidTaskId(taskId) {
  return typeof taskId === "string" && TASK_ID_PATTERN.test(taskId);
}

function finalizeTaskResult(task) {
  if (task?.result) {
    return task.result;
  }

  if (task?.status === "timeout") {
    return {
      ok: false,
      error: "timeout",
      message: "OpenCode task timed out.",
      details: {},
    };
  }

  if (task?.status === "expired") {
    return createExpiredResponse(task.id);
  }

  return {
    ok: false,
    error: "opencode_failed",
    message: "OpenCode task failed before a result could be recovered.",
    details: {},
  };
}

async function listTaskFiles(queueDir) {
  await ensureQueueDir(queueDir);
  const entries = await fs.readdir(queueDir, { withFileTypes: true });
  const taskEntries = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("_"))
    .map((entry) => path.join(queueDir, entry.name));

  const tasks = [];
  for (const filePath of taskEntries) {
    const task = await readJsonIfExists(filePath);
    if (task) {
      tasks.push(task);
    }
  }
  return sortByCreatedAt(tasks);
}

async function readRunnerState(queueDir) {
  return readJsonIfExists(runnerStatePath(queueDir));
}

function isRunnerFresh(state, now, config) {
  if (!state?.heartbeat_at) {
    return false;
  }

  const heartbeatAt = Date.parse(state.heartbeat_at);
  return Number.isFinite(heartbeatAt) && now - heartbeatAt <= config.runnerStaleMs;
}

async function updateRunnerState(queueDir, runnerState) {
  await writeJson(runnerStatePath(queueDir), runnerState);
}

async function acquireRunnerLock(queueDir, config, runnerState) {
  await ensureQueueDir(queueDir);
  const lockPath = runnerLockPath(queueDir);
  const now = Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${runnerState.runner_id}\n`);
      await handle.close();
      await updateRunnerState(queueDir, runnerState);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existingState = await readRunnerState(queueDir);
      if (existingState && isRunnerFresh(existingState, now, config)) {
        return false;
      }

      await fs.unlink(lockPath).catch(() => {});
      await fs.unlink(runnerStatePath(queueDir)).catch(() => {});
    }
  }

  return false;
}

async function releaseRunnerLock(queueDir) {
  await fs.unlink(runnerLockPath(queueDir)).catch(() => {});
  await fs.unlink(runnerStatePath(queueDir)).catch(() => {});
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recoverOrExpireTasks(queueDir, tasks, config, now) {
  for (const task of tasks) {
    const { updatedAt, createdAt } = normalizeTaskAge(task, now);
    const age = now - createdAt;
    const staleRuntime = now - updatedAt;

    if (task.status === "running" && staleRuntime > config.runningStaleMs) {
      task.status = "queued";
      task.updated_at = isoFrom(now);
      delete task.runner_id;
      delete task.started_at;
      await writeTaskFile(queueDir, task);
      continue;
    }

    if (age > config.taskTtlMs && task.status !== "completed" && task.status !== "failed" && task.status !== "timeout") {
      task.status = "expired";
      task.updated_at = isoFrom(now);
      task.result = task.result ?? createExpiredResponse(task.id);
      await writeTaskFile(queueDir, task);
    }
  }
}

async function executeTask(queueDir, task, runTask, now, runnerId) {
  task.status = "running";
  task.runner_id = runnerId;
  task.started_at = task.started_at || isoFrom(now);
  task.updated_at = isoFrom(now);
  task.attempt_count = Number(task.attempt_count || 0) + 1;
  await writeTaskFile(queueDir, task);

  try {
    const result = await runTask(task);
    const finishedAt = Date.now();
    task.result = result;
    task.status = result?.ok
      ? "completed"
      : result?.error === "timeout"
        ? "timeout"
        : result?.details?.status === "expired"
          ? "expired"
          : "failed";
    task.updated_at = isoFrom(finishedAt);
    task.completed_at = isoFrom(finishedAt);
    delete task.runner_id;
    await writeTaskFile(queueDir, task);
  } catch (error) {
    const finishedAt = Date.now();
    task.result = {
      ok: false,
      error: "opencode_failed",
      message: error?.message || "OpenCode queue runner failed unexpectedly.",
      details: {},
    };
    task.status = "failed";
    task.updated_at = isoFrom(finishedAt);
    task.completed_at = isoFrom(finishedAt);
    delete task.runner_id;
    await writeTaskFile(queueDir, task);
  }
}

async function getTaskResultInternal(queueDir, taskId, config) {
  if (!isValidTaskId(taskId)) {
    return createInvalidTaskIdResponse();
  }

  const task = await readTaskFile(queueDir, taskId);
  if (!task) {
    return createExpiredResponse(taskId);
  }

  if (task.status === "queued" || task.status === "running") {
    const tasks = await listTaskFiles(queueDir);
    return createPendingResponse(task, tasks, config);
  }

  return finalizeTaskResult(task);
}

export function getQueueConfig(env = process.env, platform = process.platform) {
  const timeoutMs = positiveNumber(env.OPENCODE_ADVISOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return {
    queueDir: getDefaultQueueDir(env, platform),
    limitGlobal: positiveNumber(env.OPENCODE_ADVISOR_CONCURRENCY_GLOBAL, 4),
    limitPlanner: positiveNumber(env.OPENCODE_ADVISOR_CONCURRENCY_PLANNER, 2),
    limitReviewer: positiveNumber(env.OPENCODE_ADVISOR_CONCURRENCY_REVIEWER, 2),
    inlineWaitMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS, 60000),
    retryAfterMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS, 30000),
    maxPending: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_MAX_PENDING, 16),
    taskTtlMs: positiveNumber(env.OPENCODE_ADVISOR_TASK_TTL_MS, 86400000),
    runnerIdleMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS, 15000),
    runnerStaleMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS, timeoutMs + 120000),
    runningStaleMs: positiveNumber(
      env.OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS ?? env.OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS,
      timeoutMs + 120000,
    ),
    pollIntervalMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_POLL_MS, 1000),
    timeoutMs,
  };
}

export function createTaskFile({ id = `ocq_${randomUUID().replace(/-/g, "")}`, role, input, now = Date.now() }) {
  return {
    id,
    role,
    input,
    status: "queued",
    created_at: isoFrom(now),
    updated_at: isoFrom(now),
    attempt_count: 0,
  };
}

export async function writeTaskFile(queueDir, task) {
  await ensureQueueDir(queueDir);
  await writeJson(taskPath(queueDir, task.id), task);
}

export async function readTaskFile(queueDir, taskId) {
  return readJsonIfExists(taskPath(queueDir, taskId));
}

export async function processQueueOnce({
  queueDir,
  config,
  runTask,
  now = Date.now(),
  runnerId = `runner_${process.pid}`,
}) {
  const tasks = await listTaskFiles(queueDir);
  await recoverOrExpireTasks(queueDir, tasks, config, now);
  const refreshedTasks = await listTaskFiles(queueDir);

  const runningTasks = refreshedTasks.filter((task) => task.status === "running");
  const queuedTasks = refreshedTasks.filter((task) => task.status === "queued");

  let availableGlobal = Math.max(0, config.limitGlobal - runningTasks.length);
  const roleCounts = {
    planner: runningTasks.filter((task) => task.role === "planner").length,
    reviewer: runningTasks.filter((task) => task.role === "reviewer").length,
  };

  const toStart = [];
  for (const task of queuedTasks) {
    if (availableGlobal <= 0) {
      break;
    }

    const limit = roleLimit(task.role, config);
    if ((roleCounts[task.role] ?? 0) >= limit) {
      continue;
    }

    roleCounts[task.role] = (roleCounts[task.role] ?? 0) + 1;
    availableGlobal -= 1;
    toStart.push(task);
  }

  await Promise.all(toStart.map((task) => executeTask(queueDir, task, runTask, now, runnerId)));

  const latestTasks = await listTaskFiles(queueDir);
  const pendingCount = latestTasks.filter((task) => task.status === "queued" || task.status === "running").length;
  return {
    startedIds: toStart.map((task) => task.id),
    pendingCount,
  };
}

export async function ensureQueueRunner({
  env = process.env,
  platform = process.platform,
  config = getQueueConfig(env, platform),
  spawnProcess = spawn,
  nodeExec = process.execPath,
} = {}) {
  await ensureQueueDir(config.queueDir);
  const state = await readRunnerState(config.queueDir);

  if (state && isRunnerFresh(state, Date.now(), config)) {
    return false;
  }

  const child = spawnProcess(nodeExec, [RUNNER_SCRIPT_PATH], {
    cwd: config.queueDir,
    env,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

export function createTaskQueue({
  env = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  nodeExec = process.execPath,
} = {}) {
  const config = getQueueConfig(env, platform);

  return {
    async submitAndWait({ role, input }) {
      const tasks = await listTaskFiles(config.queueDir);
      const pendingCount = tasks.filter((task) => task.status === "queued" || task.status === "running").length;
      if (pendingCount >= config.maxPending) {
        return createQueueFullResponse(config);
      }

      const task = createTaskFile({ role, input });
      await writeTaskFile(config.queueDir, task);
      await ensureQueueRunner({ env, platform, config, spawnProcess, nodeExec });

      const deadline = Date.now() + config.inlineWaitMs;
      for (;;) {
        const result = await getTaskResultInternal(config.queueDir, task.id, config);
        if (!(result?.error === "queued" && result?.details?.phase_pending)) {
          return result;
        }

        if (Date.now() >= deadline) {
          return result;
        }

        await delay(Math.min(config.pollIntervalMs, Math.max(250, config.retryAfterMs / 10)));
      }
    },

    async getTaskResult(payload) {
      const taskId = typeof payload === "string" ? payload : payload?.task_id;
      if (!isValidTaskId(taskId)) {
        return createInvalidTaskIdResponse();
      }
      await ensureQueueRunner({ env, platform, config, spawnProcess, nodeExec });
      return getTaskResultInternal(config.queueDir, taskId, config);
    },
  };
}

export async function runQueueRunner({
  env = process.env,
  platform = process.platform,
  runTask,
  sleep = delay,
} = {}) {
  const config = getQueueConfig(env, platform);
  const runnerId = `runner_${process.pid}_${Date.now()}`;
  const acquired = await acquireRunnerLock(config.queueDir, config, {
    runner_id: runnerId,
    pid: process.pid,
    heartbeat_at: isoFrom(Date.now()),
    started_at: isoFrom(Date.now()),
  });

  if (!acquired) {
    return { started: false };
  }

  let idleSince = null;
  try {
    for (;;) {
      await updateRunnerState(config.queueDir, {
        runner_id: runnerId,
        pid: process.pid,
        heartbeat_at: isoFrom(Date.now()),
      });

      const cycle = await processQueueOnce({
        queueDir: config.queueDir,
        config,
        runTask,
        now: Date.now(),
        runnerId,
      });

      if (cycle.pendingCount === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= config.runnerIdleMs) {
          break;
        }
      } else {
        idleSince = null;
      }

      await sleep(config.pollIntervalMs);
    }

    return { started: true };
  } finally {
    await releaseRunnerLock(config.queueDir);
  }
}
