import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const MANAGED_SESSION_TITLE_PREFIX = "opencode-advisor:";
const SESSION_REGISTRY_DIRECTORY = "_sessions";
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const recordWrites = new Map();

function registryDirectory(queueDir) {
  return path.join(queueDir, SESSION_REGISTRY_DIRECTORY);
}

function recordFilename(sessionId) {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function recordPath(queueDir, sessionId) {
  return path.join(registryDirectory(queueDir), recordFilename(sessionId));
}

function normalizeObservedAt(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Managed session observedAt must be a valid timestamp.");
  }
  return new Date(timestamp).toISOString();
}

function isValidSessionId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("-")
    && !/[\0-\x1f\x7f]/.test(value);
}

function normalizeRecord({ sessionId, cwd, title, observedAt }) {
  if (!isValidSessionId(sessionId)) {
    throw new TypeError("Managed session id is invalid.");
  }
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) {
    throw new TypeError("Managed session cwd is invalid.");
  }
  if (
    typeof title !== "string"
    || !title.startsWith(MANAGED_SESSION_TITLE_PREFIX)
    || !OWNER_ID_PATTERN.test(title.slice(MANAGED_SESSION_TITLE_PREFIX.length))
  ) {
    throw new TypeError("Managed session title is invalid.");
  }
  return {
    version: 1,
    session_id: sessionId,
    cwd,
    title,
    observed_at: normalizeObservedAt(observedAt),
  };
}

function parseRecord(value, filename) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let record;
  try {
    record = normalizeRecord({
      sessionId: value.session_id,
      cwd: value.cwd,
      title: value.title,
      observedAt: value.observed_at,
    });
  } catch {
    return null;
  }
  if (value.version !== 1 || filename !== recordFilename(record.session_id)) return null;
  return record;
}

async function ensureRegistryDirectory(queueDir, fsImpl = fs) {
  const directory = registryDirectory(queueDir);
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fsImpl.chmod(directory, 0o700);
  }
  return directory;
}

async function withRecordWriteLock(destination, action) {
  const previous = recordWrites.get(destination) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  recordWrites.set(destination, current);
  try {
    return await current;
  } finally {
    if (recordWrites.get(destination) === current) {
      recordWrites.delete(destination);
    }
  }
}

async function readRecordIfValid(queueDir, sessionId, fsImpl = fs) {
  const filename = recordFilename(sessionId);
  try {
    const value = JSON.parse(await fsImpl.readFile(path.join(registryDirectory(queueDir), filename), "utf8"));
    return parseRecord(value, filename);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function createManagedSessionOwnerId(scope = "direct") {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(scope)) {
    throw new TypeError("Managed session scope is invalid.");
  }
  return `${scope}_${randomUUID().replace(/-/g, "")}`;
}

export function createManagedSessionTitle(ownerId) {
  if (!OWNER_ID_PATTERN.test(ownerId || "")) {
    throw new TypeError("Managed session owner id is invalid.");
  }
  return `${MANAGED_SESSION_TITLE_PREFIX}${ownerId}`;
}

export async function recordManagedSession(
  { queueDir, sessionId, cwd, title, observedAt = Date.now() },
  { fs: fsImpl = fs, sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)) } = {},
) {
  const record = normalizeRecord({ sessionId, cwd, title, observedAt });
  await ensureRegistryDirectory(queueDir, fsImpl);
  const destination = recordPath(queueDir, sessionId);
  return withRecordWriteLock(destination, async () => {
    const existing = await readRecordIfValid(queueDir, sessionId, fsImpl);
    if (existing && Date.parse(existing.observed_at) > Date.parse(record.observed_at)) {
      return existing;
    }

    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fsImpl.rename(temporary, destination);
          break;
        } catch (error) {
          if (!["EACCES", "EPERM"].includes(error?.code)) throw error;
          const concurrent = await readRecordIfValid(queueDir, sessionId, fsImpl);
          if (
            concurrent
            && Date.parse(concurrent.observed_at) >= Date.parse(record.observed_at)
          ) {
            return concurrent;
          }
          if (attempt === 4) throw error;
          await sleep(5 * (attempt + 1));
        }
      }
      if (process.platform !== "win32") {
        await fsImpl.chmod(destination, 0o600);
      }
    } finally {
      await fsImpl.unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    return record;
  });
}

export async function listManagedSessionRecords(queueDir) {
  let filenames;
  try {
    filenames = await fs.readdir(registryDirectory(queueDir));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const filename of filenames) {
    if (!filename.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await fs.readFile(path.join(registryDirectory(queueDir), filename), "utf8"));
      const record = parseRecord(value, filename);
      if (record) records.push(record);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return records.sort((left, right) => left.session_id.localeCompare(right.session_id));
}

export async function removeManagedSessionRecord(queueDir, sessionId) {
  if (!isValidSessionId(sessionId)) return false;
  const source = recordPath(queueDir, sessionId);
  const tombstone = `${source}.${randomUUID()}.deleted`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(source, tombstone);
      break;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (!["EACCES", "EPERM"].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.unlink(tombstone);
      break;
    } catch (error) {
      if (error?.code === "ENOENT") break;
      if (!["EACCES", "EPERM"].includes(error?.code) || attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  return true;
}
