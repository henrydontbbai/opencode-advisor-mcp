import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const outsidePath = process.platform === "win32" ? "C:\\Windows" : "/tmp/not-allowed";
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    env: {
      OPENCODE_ADVISOR_ALLOWED_ROOTS: repoRoot,
      OPENCODE_ADVISOR_OPENCODE_DATA_HOME: path.join(os.tmpdir(), "opencode-advisor-mcp-integration-profile"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test-client", version: "0.0.0" });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close?.().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function parseToolJson(result) {
  assert.equal(Array.isArray(result.content), true);
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

test("stdio MCP server lists all public tools", async () => {
  await withClient(async (client) => {
    assert.equal(client.getServerVersion()?.version, packageJson.version);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      "ask_opencode_advisor",
      "ask_opencode_planner",
      "get_opencode_task",
    ]);
  });
});

test("stdio MCP server returns stable contracts for each public tool", async () => {
  await withClient(async (client) => {
    const advisor = parseToolJson(
      await client.callTool({
        name: "ask_opencode_advisor",
        arguments: {
          cwd: outsidePath,
          include_diff: false,
          include_status: false,
        },
      }),
    );
    assert.equal(advisor.ok, false);
    assert.equal(advisor.error, "invalid_cwd");
    assert.deepEqual(advisor.details, {});

    const planner = parseToolJson(
      await client.callTool({
        name: "ask_opencode_planner",
        arguments: {
          cwd: outsidePath,
          current_plan: "1. Verify\n2. Review",
        },
      }),
    );
    assert.equal(planner.ok, false);
    assert.equal(planner.error, "invalid_cwd");
    assert.deepEqual(planner.details, {});

    const task = parseToolJson(
      await client.callTool({
        name: "get_opencode_task",
        arguments: {
          task_id: "../not-a-task",
        },
      }),
    );
    assert.equal(task.ok, false);
    assert.equal(task.error, "opencode_failed");
    assert.equal(task.details.status, "invalid_task_id");
    assert.equal(task.details.phase_pending, false);
  });
});
