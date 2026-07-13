import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createManagedSessionOwnerId,
  createManagedSessionTitle,
  listManagedSessionRecords,
  recordManagedSession,
  removeManagedSessionRecord,
} from "../src/session-lifecycle.mjs";

const tempDirs = new Set();

function createTempDir() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "opencode-advisor-sessions-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  tempDirs.clear();
});

test("managed session ownership records are atomic, private, path-safe, and minimal", async () => {
  const queueDir = createTempDir();
  const sessionId = "ses_path/unsafe?provider-key";
  const title = createManagedSessionTitle(createManagedSessionOwnerId("direct-reviewer"));

  await Promise.all(Array.from({ length: 8 }, () => recordManagedSession({
    queueDir,
    sessionId,
    cwd: "/repo",
    title,
    observedAt: "2026-07-13T00:00:00.000Z",
    providerKey: "must-not-persist",
    baseUrl: "https://provider.example.test/v1",
    model: "private-model",
  })));

  const registryDir = path.join(queueDir, "_sessions");
  const files = readdirSync(registryDir);
  assert.equal(files.length, 1);
  assert.equal(files[0].endsWith(".json"), true);
  assert.equal(files[0].includes(sessionId), false);
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  const persistedText = await fs.readFile(path.join(registryDir, files[0]), "utf8");
  assert.equal(persistedText.includes("must-not-persist"), false);
  assert.equal(persistedText.includes("provider.example.test"), false);
  assert.equal(persistedText.includes("private-model"), false);

  const records = await listManagedSessionRecords(queueDir);
  assert.deepEqual(records, [{
    version: 1,
    session_id: sessionId,
    cwd: "/repo",
    title,
    observed_at: "2026-07-13T00:00:00.000Z",
  }]);
  assert.deepEqual(Object.keys(records[0]), ["version", "session_id", "cwd", "title", "observed_at"]);

  if (process.platform !== "win32") {
    assert.equal(statSync(registryDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(registryDir, files[0])).mode & 0o777, 0o600);
  }

  await removeManagedSessionRecord(queueDir, sessionId);
  assert.deepEqual(await listManagedSessionRecords(queueDir), []);
});

test("managed session registry skips corrupt and forged records without deleting them", async () => {
  const queueDir = createTempDir();
  const registryDir = path.join(queueDir, "_sessions");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(registryDir, "corrupt.json"), "{", "utf8");
  await fs.writeFile(path.join(registryDir, "forged.json"), JSON.stringify({
    version: 1,
    session_id: "ses_forged",
    cwd: "/repo",
    title: "normal user session",
    observed_at: "2026-07-13T00:00:00.000Z",
  }), "utf8");

  assert.deepEqual(await listManagedSessionRecords(queueDir), []);
  assert.deepEqual(readdirSync(registryDir).sort(), ["corrupt.json", "forged.json"]);
});

test("managed session registry rejects option-like session ids before persistence", async () => {
  const queueDir = createTempDir();
  await assert.rejects(
    recordManagedSession({
      queueDir,
      sessionId: "--help",
      cwd: "/repo",
      title: createManagedSessionTitle("direct_rejected"),
      observedAt: "2026-07-13T00:00:00.000Z",
    }),
    /session id is invalid/i,
  );
  assert.deepEqual(await listManagedSessionRecords(queueDir), []);
});

test("managed session registry keeps the newest observation when queue backfill is older", async () => {
  const queueDir = createTempDir();
  const title = createManagedSessionTitle("ocq_retained");
  await recordManagedSession({
    queueDir,
    sessionId: "ses_retained",
    cwd: "/repo",
    title,
    observedAt: "2026-07-13T02:00:00.000Z",
  });
  await recordManagedSession({
    queueDir,
    sessionId: "ses_retained",
    cwd: "/repo",
    title,
    observedAt: "2026-07-13T01:00:00.000Z",
  });

  assert.equal((await listManagedSessionRecords(queueDir))[0].observed_at, "2026-07-13T02:00:00.000Z");
});

test("managed session registry replaces an older observation with newer metadata", async () => {
  const queueDir = createTempDir();
  const sessionId = "ses_updated";
  await recordManagedSession({
    queueDir,
    sessionId,
    cwd: "/repo/old",
    title: createManagedSessionTitle("direct_old"),
    observedAt: "2026-07-13T01:00:00.000Z",
  });
  await recordManagedSession({
    queueDir,
    sessionId,
    cwd: "/repo/new",
    title: createManagedSessionTitle("direct_new"),
    observedAt: "2026-07-13T02:00:00.000Z",
  });

  assert.deepEqual(await listManagedSessionRecords(queueDir), [{
    version: 1,
    session_id: sessionId,
    cwd: "/repo/new",
    title: "opencode-advisor:direct_new",
    observed_at: "2026-07-13T02:00:00.000Z",
  }]);
});

test("managed session registry retries replacement contention instead of accepting an older record", async () => {
  const queueDir = createTempDir();
  const sessionId = "ses_contended";
  await recordManagedSession({
    queueDir,
    sessionId,
    cwd: "/repo/old",
    title: createManagedSessionTitle("direct_old"),
    observedAt: "2026-07-13T01:00:00.000Z",
  });

  let renameAttempts = 0;
  const fsImpl = Object.create(fs);
  fsImpl.rename = async (...args) => {
    renameAttempts += 1;
    if (renameAttempts < 3) {
      const error = new Error("replacement is temporarily contended");
      error.code = renameAttempts === 1 ? "EACCES" : "EPERM";
      throw error;
    }
    return fs.rename(...args);
  };

  await recordManagedSession({
    queueDir,
    sessionId,
    cwd: "/repo/new",
    title: createManagedSessionTitle("direct_new"),
    observedAt: "2026-07-13T02:00:00.000Z",
  }, {
    fs: fsImpl,
    sleep: async () => {},
  });

  assert.equal(renameAttempts, 3);
  assert.equal((await listManagedSessionRecords(queueDir))[0].observed_at, "2026-07-13T02:00:00.000Z");
});
