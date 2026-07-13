import { appendFileSync } from "node:fs";
import { ensureQueueRunner } from "../../src/task-queue.mjs";

const [queueDir, spawnLog, runnerStaleMs] = process.argv.slice(2);

const started = await ensureQueueRunner({
  env: {
    OPENCODE_ADVISOR_QUEUE_DIR: queueDir,
    ...(runnerStaleMs ? { OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS: runnerStaleMs } : {}),
  },
  platform: process.platform,
  spawnProcess: () => {
    appendFileSync(spawnLog, `${process.pid}\n`, "utf8");
    return { unref() {} };
  },
});

process.stdout.write(`${JSON.stringify({ started })}\n`);
