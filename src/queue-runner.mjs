#!/usr/bin/env node
import { runOpenCodeAdvisorNow, runOpenCodePlannerNow } from "./opencode-core.mjs";
import { runQueueRunner } from "./task-queue.mjs";

function runTask(task, { onSessionId } = {}) {
  const deps = {
    taskId: task.id,
    onSessionId,
  };
  if (task.role === "planner") {
    return runOpenCodePlannerNow(task.input, deps);
  }

  return runOpenCodeAdvisorNow(task.input, deps);
}

runQueueRunner({ runTask }).catch((error) => {
  console.error(error);
  process.exit(1);
});
