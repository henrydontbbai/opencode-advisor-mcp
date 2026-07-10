#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  extractOpenCodeText,
  getOpenCodeDataHome,
  isPathInsideAllowedRoots,
  parseAllowedRoots,
  preflightOpenCodeTask,
  runOpenCodeAdvisorNow,
  runOpenCodePlannerNow,
  truncateText,
} from "./opencode-core.mjs";
import { createTaskQueue } from "./task-queue.mjs";
import { pathForPlatform } from "./runtime-shared.mjs";

function getTaskQueue(deps = {}) {
  return deps.taskQueue ?? createTaskQueue({
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
  });
}

export {
  extractOpenCodeText,
  isPathInsideAllowedRoots,
  parseAllowedRoots,
  truncateText,
};

export async function askOpenCodeAdvisor(input = {}, deps = {}) {
  if (deps.useQueue === false) {
    return runOpenCodeAdvisorNow(input, deps);
  }

  const preflight = await preflightOpenCodeTask("reviewer", input, deps);
  if (!preflight.ok) {
    return preflight;
  }

  return getTaskQueue(deps).submitAndWait({
    role: "reviewer",
    input: { ...input, cwd: preflight.normalized.cwd },
  });
}

export async function askOpenCodePlanner(input = {}, deps = {}) {
  if (deps.useQueue === false) {
    return runOpenCodePlannerNow(input, deps);
  }

  const preflight = await preflightOpenCodeTask("planner", input, deps);
  if (!preflight.ok) {
    return preflight;
  }

  return getTaskQueue(deps).submitAndWait({
    role: "planner",
    input: { ...input, cwd: preflight.normalized.cwd },
  });
}

export function getOpenCodeTask(input = {}, deps = {}) {
  if (deps.useQueue === false) {
    return {
      ok: false,
      error: "opencode_failed",
      message: "OpenCode task lookup is unavailable when queue mode is disabled.",
      details: {},
    };
  }

  return getTaskQueue(deps).getTaskResult({
    task_id: input.task_id,
  });
}

export function createServer(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const pathApi = deps.path ?? pathForPlatform(platform);
  const allowedRoots = parseAllowedRoots(undefined, env, pathApi);
  if (allowedRoots.length === 0) {
    throw new Error("OPENCODE_ADVISOR_ALLOWED_ROOTS must be configured before the MCP server starts.");
  }
  getOpenCodeDataHome(env, pathApi);

  const server = new McpServer({ name: "opencode-advisor", version: "0.2.0" });

  const commonInput = {
    cwd: z.string().optional(),
    question: z.string().optional(),
    goal: z.string().optional(),
    paths: z.array(z.string()).optional(),
    include_diff: z.boolean().optional(),
    include_status: z.boolean().optional(),
    base_ref: z.string().optional(),
    max_diff_chars: z.number().int().positive().optional(),
  };

  server.registerTool(
    "ask_opencode_advisor",
    {
      title: "Ask OpenCode Advisor",
      description: "Ask the local read-only OpenCode codex-advisor agent to review current git changes.",
      inputSchema: commonInput,
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await askOpenCodeAdvisor(input, deps), null, 2) }],
    }),
  );

  server.registerTool(
    "ask_opencode_planner",
    {
      title: "Ask OpenCode Planner",
      description: "Ask the local read-only OpenCode planning partner to improve a plan without taking over implementation.",
      inputSchema: {
        ...commonInput,
        current_plan: z.string().optional(),
        constraints: z.array(z.string()).optional(),
      },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await askOpenCodePlanner(input, deps), null, 2) }],
    }),
  );

  server.registerTool(
    "get_opencode_task",
    {
      title: "Get OpenCode Task",
      description: "Check whether a queued or running OpenCode planner/reviewer task has finished.",
      inputSchema: {
        task_id: z.string(),
      },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await getOpenCodeTask(input, deps), null, 2) }],
    }),
  );

  return server;
}

async function main() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
