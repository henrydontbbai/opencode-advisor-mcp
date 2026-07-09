#!/usr/bin/env node
import { runOpenCodeAdvisorNow, runOpenCodePlannerNow } from "./opencode-core.mjs";
import { runQueueRunner } from "./task-queue.mjs";

function runTask(task) {
  if (task.role === "planner") {
    return runOpenCodePlannerNow(task.input, {});
  }

  return runOpenCodeAdvisorNow(task.input, {});
}

runQueueRunner({ runTask }).catch((error) => {
  console.error(error);
  process.exit(1);
});
