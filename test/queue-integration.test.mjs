import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTaskFile,
  readTaskFile,
  runQueueRunner,
  writeTaskFile,
} from "../src/task-queue.mjs";

test("runQueueRunner recovers a stale running task after a crashed runner", async () => {
  const queueDir = mkdtempSync(path.join(os.tmpdir(), "ocq-runner-recovery-"));
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
