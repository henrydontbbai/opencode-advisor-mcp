import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binPath = fileURLToPath(new URL("../bin/opencode-advisor-agent.mjs", import.meta.url));

test("print-agent defaults to the advisor template", async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath]);
  assert.match(stdout, /You are codex-advisor/i);
});

test("print-agent can print the planning partner template", async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, "planner"]);
  assert.match(stdout, /You are codex-planning-partner/i);
});
