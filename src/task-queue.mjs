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
const RUNNER_RELEASE_PREFIX = "_runner.release.";
const RUNNER_SCRIPT_PATH = fileURLToPath(new URL("./queue-runner.mjs", import.meta.url));
const TASK_ID_PATTERN = /^ocq_[A-Za-z0-9]+$/;
const SUBMISSION_LOCK_STALE_MS = 10000;
const DEFAULT_STALE_FLOOR_MS = DEFAULT_TIMEOUT_MS + 120000;
const QUEUE_DIR_ERROR_CODES = new Set(["EACCES", "EEXIST", "ENOENT", "ENOTDIR", "EPERM", "EROFS"]);
const QUEUE_READ_RETRY_CODE = "OPENCODE_ADVISOR_QUEUE_READ_RETRY";
const MAX_CONSECUTIVE_RUNNER_ERRORS = 3;
const RUNNER_TERMINATION_WAIT_MS = 5000;

class QueueReadRetryError extends Error {
  constructor(filePath, cause) {
    super(`Queue file is temporarily unreadable: ${filePath}`);
    this.code = QUEUE_READ_RETRY_CODE;
    this.cause = cause;
  }
}

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
        throw new QueueReadRetryError(filePath);
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
        throw new QueueReadRetryError(filePath, error);
      }
      throw error;
    }
  }

  return null;
}

async function writeJson(filePath, value) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code) || attempt === 4) {
        throw error;
      }
      await delay(5 * (attempt + 1));
    }
  }
}

function getDefaultQueueDir(env = process.env, platform = process.platform) {
  const pathApi = pathForPlatform(platform);
  if (env.OPENCODE_ADVISOR_QUEUE_DIR) {
    return pathApi.resolve(env.OPENCODE_ADVISOR_QUEUE_DIR);
  }

  const home =
    env.USERPROFILE ||
    env.HOME ||
    os.homedir();

  return pathApi.join(home, ".codex", "opencode-advisor", "queue");
}

function getQueueLogDir(env = process.env, platform = process.platform) {
  const configured = env.OPENCODE_ADVISOR_QUEUE_LOG_DIR;
  if (!configured) {
    return null;
  }
  return pathForPlatform(platform).resolve(configured);
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

function createQueueDirUnavailableResponse() {
  return {
    ok: false,
    error: "opencode_failed",
    message: "OpenCode task queue directory is unavailable.",
    details: {},
  };
}

function isQueueDirUnavailableError(error) {
  return QUEUE_DIR_ERROR_CODES.has(error?.code);
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

async function withFileLock(queueDir, filename, fn, deps = {}) {
  const pathApi = deps.pathApi ?? path;
  const openImpl = deps.openImpl ?? ((filePath, flags) => fs.open(filePath, flags));
  const unlinkImpl = deps.unlinkImpl ?? ((filePath) => fs.unlink(filePath));
  const statImpl = deps.statImpl ?? ((filePath) => fs.stat(filePath));
  const delayImpl = deps.delayImpl ?? delay;
  const lockPath = pathApi.join(queueDir, filename);

  for (;;) {
    try {
      const handle = await openImpl(lockPath, "wx");
      try {
        return await fn();
      } finally {
        await handle.close();
        await unlinkImpl(lockPath).catch(() => {});
      }
    } catch (error) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
      try {
        const stats = await statImpl(lockPath);
        if (Date.now() - stats.mtimeMs > SUBMISSION_LOCK_STALE_MS) {
          await unlinkImpl(lockPath).catch(() => {});
          continue;
        }
      } catch (statError) {
        if (["ENOENT", "EPERM", "EACCES"].includes(statError?.code)) {
          continue;
        }
        throw statError;
      }
      await delayImpl(5);
    }
  }
}

async function withSubmissionLock(queueDir, fn, deps = {}) {
  return withFileLock(queueDir, "_submit.lock", fn, deps);
}

async function withRunnerReleaseLock(queueDir, fn) {
  return withFileLock(queueDir, `${RUNNER_RELEASE_PREFIX}lock`, fn);
}

async function submitTaskAtomically(queueDir, task, config) {
  await ensureQueueDir(queueDir);
  return withSubmissionLock(queueDir, async () => {
    const now = Date.now();
    const tasks = await listTaskFiles(queueDir);
    await recoverOrExpireTasks(queueDir, tasks, config, now);
    const refreshedTasks = await listTaskFiles(queueDir);
    const pendingCount = refreshedTasks.filter((entry) => entry.status === "queued" || entry.status === "running").length;
    if (pendingCount >= config.maxPending) {
      return { ok: false, result: createQueueFullResponse(config) };
    }

    await writeTaskFile(queueDir, task);
    return { ok: true };
  });
}

function isRunnerFresh(state, now, config) {
  if (!state?.heartbeat_at) {
    return false;
  }

  const heartbeatAt = Date.parse(state.heartbeat_at);
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > config.runnerStaleMs) {
    return false;
  }

  if (!state.lease_expires_at) {
    return true;
  }

  const leaseExpiresAt = Date.parse(state.lease_expires_at);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now;
}

function sameRunner(left, right) {
  return Boolean(left?.runner_id && right?.runner_id && left.runner_id === right.runner_id);
}

async function readRunnerLock(queueDir) {
  return readRunnerLockFromPath(runnerLockPath(queueDir));
}

async function readRunnerLockFromPath(filePath) {
  try {
    return await readJsonIfExists(filePath);
  } catch (error) {
    if (error?.code === QUEUE_READ_RETRY_CODE) {
      const raw = await fs.readFile(filePath, "utf8").catch((readError) => {
        if (readError?.code === "ENOENT") {
          return "";
        }
        throw readError;
      });
      const legacyRunnerId = raw.trim();
      if (legacyRunnerId && !legacyRunnerId.startsWith("{")) {
        return { runner_id: legacyRunnerId };
      }
      return null;
    }
    throw error;
  }
}

async function readRunnerLockStats(queueDir) {
  try {
    return await fs.stat(runnerLockPath(queueDir));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isRunnerLeaseFresh(lock, state, lockStats, now, config) {
  if (!lockStats) {
    return false;
  }
  if (sameRunner(lock, state)) {
    return isRunnerFresh(state, now, config);
  }
  return Boolean(lockStats && now - lockStats.mtimeMs <= config.runnerStaleMs);
}

function defaultProcessControl() {
  return {
    isProcessAlive(pid) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    },
    async terminateProcess(pid) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
      }
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    },
    async waitForProcessExit(pid, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!this.isProcessAlive(pid)) {
          return true;
        }
        await delay(25);
      }
      return !this.isProcessAlive(pid);
    },
  };
}

function createRunnerLease(runnerState, now, config) {
  return {
    ...runnerState,
    heartbeat_at: isoFrom(now),
    lease_expires_at: isoFrom(now + config.runnerStaleMs),
  };
}

async function writeRunnerLease(queueDir, runnerState, config) {
  const lease = createRunnerLease(runnerState, Date.now(), config);
  await writeJson(runnerStatePath(queueDir), lease);
  return lease;
}

async function writeRunnerLock(queueDir, runnerState) {
  const handle = await fs.open(runnerLockPath(queueDir), "wx");
  try {
    await handle.writeFile(`${JSON.stringify({
      runner_id: runnerState.runner_id,
      pid: runnerState.pid,
      started_at: runnerState.started_at,
    })}\n`);
  } finally {
    await handle.close();
  }
}

async function removeRunnerStateIfOwned(queueDir, runnerId) {
  const state = await readRunnerState(queueDir);
  if (state?.runner_id !== runnerId) {
    return false;
  }
  await fs.unlink(runnerStatePath(queueDir)).catch(() => {});
  return true;
}

async function moveRunnerLockIfOwned(queueDir, runnerId) {
  const lockPath = runnerLockPath(queueDir);
  const movedPath = `${lockPath}.${randomUUID()}.stale`;
  await fs.rename(lockPath, movedPath);
  const movedLock = await readRunnerLockFromPath(movedPath);
  if (runnerId && movedLock?.runner_id !== runnerId) {
    await fs.rename(movedPath, lockPath).catch(() => {});
    return false;
  }
  await fs.unlink(movedPath).catch(() => {});
  return true;
}

async function acquireRunnerLock(queueDir, config, runnerState, processControl = defaultProcessControl()) {
  await ensureQueueDir(queueDir);
  return withRunnerReleaseLock(queueDir, async () => {
    const [lock, state, lockStats] = await Promise.all([
      readRunnerLock(queueDir),
      readRunnerState(queueDir),
      readRunnerLockStats(queueDir),
    ]);
    const now = Date.now();
    const ownerPid = Number(lock?.pid ?? state?.pid);
    const ownerAlive = ownerPid === process.pid || processControl.isProcessAlive(ownerPid);
    if (isRunnerLeaseFresh(lock, state, lockStats, now, config) && ownerAlive) {
      return false;
    }

    if (lockStats) {
      const owner = lock?.runner_id || state?.runner_id;
      if (ownerAlive && ownerPid !== process.pid) {
        await processControl.terminateProcess(ownerPid);
        const terminationWaitMs = Math.max(
          1000,
          Math.min(config.runnerStaleMs, RUNNER_TERMINATION_WAIT_MS),
        );
        if (!await processControl.waitForProcessExit(ownerPid, terminationWaitMs)) {
          return false;
        }
      }

      if (!await moveRunnerLockIfOwned(queueDir, owner)) {
        return false;
      }
      if (owner) {
        await removeRunnerStateIfOwned(queueDir, owner);
      }
    }

    try {
      await writeRunnerLock(queueDir, runnerState);
      await writeRunnerLease(queueDir, runnerState, config);
      return true;
    } catch (error) {
      const currentLock = await readRunnerLock(queueDir);
      if (sameRunner(currentLock, runnerState)) {
        await fs.unlink(runnerLockPath(queueDir)).catch(() => {});
      }
      if (error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  });
}

async function refreshRunnerLease(queueDir, runnerState, config) {
  return withRunnerReleaseLock(queueDir, async () => {
    const lock = await readRunnerLock(queueDir);
    if (!sameRunner(lock, runnerState)) {
      return false;
    }
    await fs.utimes(runnerLockPath(queueDir), new Date(), new Date());
    await writeRunnerLease(queueDir, runnerState, config);
    return true;
  });
}

async function releaseRunnerLock(queueDir, runnerId) {
  return withRunnerReleaseLock(queueDir, async () => {
    const lock = await readRunnerLock(queueDir);
    if (lock?.runner_id !== runnerId) {
      return false;
    }
    const released = await moveRunnerLockIfOwned(queueDir, runnerId);
    if (released) {
      await removeRunnerStateIfOwned(queueDir, runnerId);
    }
    return released;
  });
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recoverOrExpireTasks(queueDir, tasks, config, now) {
  let runnerState;
  let runnerStateUnreadable = false;
  try {
    runnerState = await readRunnerState(queueDir);
  } catch (error) {
    if (error?.code === QUEUE_READ_RETRY_CODE) {
      runnerStateUnreadable = true;
    } else {
      throw error;
    }
  }
  for (const task of tasks) {
    const { updatedAt, createdAt } = normalizeTaskAge(task, now);
    const age = now - createdAt;
    const staleRuntime = now - updatedAt;
    const activeRunnerOwnsTask = task.status === "running"
      && (
        runnerStateUnreadable
        || (sameRunner(task, runnerState) && isRunnerFresh(runnerState, now, config))
      );

    const eligibleForExpiry = task.status === "queued"
      || (task.status === "running" && staleRuntime > config.runningStaleMs && !activeRunnerOwnsTask);
    if (age > config.taskTtlMs && eligibleForExpiry) {
      task.status = "expired";
      task.updated_at = isoFrom(now);
      task.result = task.result ?? createExpiredResponse(task.id);
      delete task.runner_id;
      delete task.started_at;
      await writeTaskFile(queueDir, task);
      continue;
    }

    if (task.status === "running" && staleRuntime > config.runningStaleMs && !activeRunnerOwnsTask) {
      task.status = "queued";
      task.updated_at = isoFrom(now);
      delete task.runner_id;
      delete task.started_at;
      await writeTaskFile(queueDir, task);
      continue;
    }
  }
}

async function claimTask(queueDir, taskId, runnerId, now) {
  return withSubmissionLock(queueDir, async () => {
    const task = await readTaskFile(queueDir, taskId);
    if (!task || task.status !== "queued") {
      return null;
    }

    task.status = "running";
    task.runner_id = runnerId;
    task.started_at = isoFrom(now);
    task.updated_at = isoFrom(now);
    task.attempt_count = Number(task.attempt_count || 0) + 1;
    await writeTaskFile(queueDir, task);
    return task;
  });
}

async function executeTask(queueDir, task, runTask, runnerId) {
  const finalize = async (result, status) => {
    await withSubmissionLock(queueDir, async () => {
      const currentTask = await readTaskFile(queueDir, task.id);
      if (
        currentTask?.status !== "running"
        || currentTask.runner_id !== runnerId
        || currentTask.attempt_count !== task.attempt_count
      ) {
        return;
      }

      const finishedAt = Date.now();
      currentTask.result = result;
      currentTask.status = status;
      currentTask.updated_at = isoFrom(finishedAt);
      currentTask.completed_at = isoFrom(finishedAt);
      delete currentTask.runner_id;
      await writeTaskFile(queueDir, currentTask);
    });
  };

  try {
    const result = await runTask(task);
    const status = result?.ok
      ? "completed"
      : result?.error === "timeout"
        ? "timeout"
        : result?.details?.status === "expired"
          ? "expired"
          : "failed";
    await finalize(result, status);
  } catch (error) {
    await finalize({
      ok: false,
      error: "opencode_failed",
      message: error?.message || "OpenCode queue runner failed unexpectedly.",
      details: {},
    }, "failed");
  }
}

async function runWithHeartbeat(taskPromise, refresh, intervalMs) {
  let timer;
  const heartbeat = async () => {
    const refreshed = await refresh();
    if (!refreshed) {
      throw new Error("OpenCode queue runner lost its lease.");
    }
  };

  try {
    await heartbeat();
    timer = setInterval(() => {
      heartbeat().catch(() => {});
    }, Math.max(1, Math.floor(intervalMs / 3)));
    return await taskPromise;
  } finally {
    clearInterval(timer);
  }
}

async function getTaskResultInternal(queueDir, taskId, config) {
  if (!isValidTaskId(taskId)) {
    return createInvalidTaskIdResponse();
  }

  const pendingReadResponse = () => createPendingResponse({
    id: taskId,
    role: "reviewer",
    status: "queued",
  }, [], config);
  let taskBeforeRecovery;
  try {
    taskBeforeRecovery = await readTaskFile(queueDir, taskId);
  } catch (error) {
    if (error?.code === QUEUE_READ_RETRY_CODE) {
      return pendingReadResponse();
    }
    throw error;
  }

  const now = Date.now();
  let tasks;
  try {
    tasks = await listTaskFiles(queueDir);
  } catch (error) {
    if (error?.code === QUEUE_READ_RETRY_CODE) {
      return taskBeforeRecovery
        ? createPendingResponse(taskBeforeRecovery, [], config)
        : pendingReadResponse();
    }
    throw error;
  }
  await recoverOrExpireTasks(queueDir, tasks, config, now);

  let task;
  try {
    task = await readTaskFile(queueDir, taskId);
  } catch (error) {
    if (error?.code === QUEUE_READ_RETRY_CODE) {
      return taskBeforeRecovery
        ? createPendingResponse(taskBeforeRecovery, tasks, config)
        : pendingReadResponse();
    }
    throw error;
  }
  if (!task) {
    return createExpiredResponse(taskId);
  }

  if (task.status === "queued" || task.status === "running") {
    let refreshedTasks;
    try {
      refreshedTasks = await listTaskFiles(queueDir);
    } catch (error) {
      if (error?.code === QUEUE_READ_RETRY_CODE) {
        return createPendingResponse(task, [], config);
      }
      throw error;
    }
    return createPendingResponse(task, refreshedTasks, config);
  }

  return finalizeTaskResult(task);
}

export function getQueueConfig(env = process.env, platform = process.platform) {
  const timeoutMs = positiveNumber(env.OPENCODE_ADVISOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const defaultRunnerStaleMs = Math.max(timeoutMs + 120000, DEFAULT_STALE_FLOOR_MS);
  const configuredRunnerStaleMs = env.OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS;
  const configuredRunningStaleMs = env.OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS;

  return {
    queueDir: getDefaultQueueDir(env, platform),
    queueLogDir: getQueueLogDir(env, platform),
    limitGlobal: positiveNumber(env.OPENCODE_ADVISOR_CONCURRENCY_GLOBAL, 4),
    limitPlanner: positiveNumber(env.OPENCODE_ADVISOR_CONCURRENCY_PLANNER, 2),
    limitReviewer: positiveNumber(env.OPENCODE_ADVISOR_CONCURRENCY_REVIEWER, 2),
    inlineWaitMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS, 60000),
    retryAfterMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS, 30000),
    maxPending: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_MAX_PENDING, 16),
    taskTtlMs: positiveNumber(env.OPENCODE_ADVISOR_TASK_TTL_MS, 86400000),
    runnerIdleMs: positiveNumber(env.OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS, 15000),
    runnerStaleMs: configuredRunnerStaleMs == null
      ? defaultRunnerStaleMs
      : positiveNumber(configuredRunnerStaleMs, defaultRunnerStaleMs),
    runningStaleMs: configuredRunningStaleMs == null
      ? configuredRunnerStaleMs == null
        ? defaultRunnerStaleMs
        : positiveNumber(configuredRunnerStaleMs, defaultRunnerStaleMs)
      : positiveNumber(configuredRunningStaleMs, defaultRunnerStaleMs),
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

export async function lockSubmissionForTest(queueDir, fn, deps = {}) {
  return withSubmissionLock(queueDir, fn, deps);
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
  beforeClaim,
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

  const claimedIds = await Promise.all(toStart.map(async (task) => {
    await beforeClaim?.(task);
    const claimedTask = await claimTask(queueDir, task.id, runnerId, now);
    if (!claimedTask) {
      return null;
    }

    await executeTask(queueDir, claimedTask, runTask, runnerId);
    return claimedTask.id;
  }));

  const latestTasks = await listTaskFiles(queueDir);
  const pendingCount = latestTasks.filter((task) => task.status === "queued" || task.status === "running").length;
  return {
    startedIds: claimedIds.filter(Boolean),
    pendingCount,
  };
}

export async function ensureQueueRunner({
  env = process.env,
  platform = process.platform,
  config = getQueueConfig(env, platform),
  spawnProcess = spawn,
  nodeExec = process.execPath,
  processControl = defaultProcessControl(),
} = {}) {
  await ensureQueueDir(config.queueDir);
  let stdoutHandle = null;
  let stderrHandle = null;
  if (config.queueLogDir) {
    await ensureQueueDir(config.queueLogDir);
  }
  const [lock, stateResult, lockStats] = await Promise.all([
    readRunnerLock(config.queueDir),
    readRunnerState(config.queueDir).then(
      (state) => ({ state }),
      (error) => ({ error }),
    ),
    readRunnerLockStats(config.queueDir),
  ]);
  if (stateResult.error) {
    if (stateResult.error?.code === QUEUE_READ_RETRY_CODE) {
      return false;
    }
    throw stateResult.error;
  }
  const state = stateResult.state;

  const ownerPid = Number(lock?.pid ?? state?.pid);
  const ownerAlive = ownerPid === process.pid || processControl.isProcessAlive(ownerPid);
  if (isRunnerLeaseFresh(lock, state, lockStats, Date.now(), config) && ownerAlive) {
    return false;
  }

  const runnerEnv = {
    ...env,
    OPENCODE_ADVISOR_QUEUE_DIR: config.queueDir,
  };

  let stdio = "ignore";
  if (config.queueLogDir) {
    stdoutHandle = await fs.open(path.join(config.queueLogDir, "runner.stdout.log"), "a");
    stderrHandle = await fs.open(path.join(config.queueLogDir, "runner.stderr.log"), "a");
    stdio = ["ignore", stdoutHandle.fd, stderrHandle.fd];
  }

  try {
    const child = spawnProcess(nodeExec, [RUNNER_SCRIPT_PATH], {
      cwd: config.queueDir,
      env: runnerEnv,
      detached: true,
      windowsHide: true,
      stdio,
    });
    child.unref();
    return true;
  } finally {
    await stdoutHandle?.close().catch(() => {});
    await stderrHandle?.close().catch(() => {});
  }
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
      try {
        const task = createTaskFile({ role, input });
        const submitted = await submitTaskAtomically(config.queueDir, task, config);
        if (!submitted.ok) {
          return submitted.result;
        }
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
      } catch (error) {
        if (isQueueDirUnavailableError(error)) {
          return createQueueDirUnavailableResponse();
        }
        throw error;
      }
    },

    async getTaskResult(payload) {
      try {
        const taskId = typeof payload === "string" ? payload : payload?.task_id;
        if (!isValidTaskId(taskId)) {
          return createInvalidTaskIdResponse();
        }
        const current = await getTaskResultInternal(config.queueDir, taskId, config);
        if (!(current?.error === "queued" && current?.details?.phase_pending)) {
          return current;
        }

        await ensureQueueRunner({ env, platform, config, spawnProcess, nodeExec });
        return getTaskResultInternal(config.queueDir, taskId, config);
      } catch (error) {
        if (isQueueDirUnavailableError(error)) {
          return createQueueDirUnavailableResponse();
        }
        throw error;
      }
    },
  };
}

export async function runQueueRunner({
  env = process.env,
  platform = process.platform,
  runTask,
  sleep = delay,
  signals = process,
  processControl = defaultProcessControl(),
} = {}) {
  let shuttingDown = false;
  const stop = () => {
    shuttingDown = true;
  };
  signals?.on?.("SIGTERM", stop);
  signals?.on?.("SIGINT", stop);

  const config = getQueueConfig(env, platform);
  const runnerId = `runner_${process.pid}_${Date.now()}`;
  const runnerState = {
    runner_id: runnerId,
    pid: process.pid,
    started_at: isoFrom(Date.now()),
  };
  const acquired = await acquireRunnerLock(config.queueDir, config, runnerState, processControl);

  if (!acquired) {
    return { started: false };
  }

  let idleSince = null;
  let consecutiveErrors = 0;
  try {
    for (;;) {
      let cycle;
      try {
        const ownsLease = await refreshRunnerLease(config.queueDir, runnerState, config);
        if (!ownsLease) {
          break;
        }

        cycle = await runWithHeartbeat(
          processQueueOnce({
            queueDir: config.queueDir,
            config,
            runTask,
            now: Date.now(),
            runnerId,
          }),
          () => refreshRunnerLease(config.queueDir, runnerState, config),
          config.runnerStaleMs,
        );
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_RUNNER_ERRORS) {
          break;
        }
        await sleep(Math.min(config.pollIntervalMs, 1000));
        continue;
      }

      if (shuttingDown) {
        break;
      }

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
    signals?.off?.("SIGTERM", stop);
    signals?.off?.("SIGINT", stop);
    await releaseRunnerLock(config.queueDir, runnerId);
  }
}
