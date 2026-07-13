import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binPath = fileURLToPath(new URL("../bin/opencode-advisor-agent.mjs", import.meta.url));
const doctorBinPath = fileURLToPath(new URL("../bin/opencode-advisor-doctor.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("print-agent defaults to the advisor template", async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath]);
  assert.match(stdout, /You are codex-advisor/i);
});

test("print-agent can print the planning partner template", async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, "planner"]);
  assert.match(stdout, /You are codex-planning-partner/i);
});

test("bundled agents deny every filesystem tool", async () => {
  for (const role of [undefined, "planner"]) {
    const args = role ? [binPath, role] : [binPath];
    const { stdout } = await execFileAsync(process.execPath, args);

    assert.match(stdout, /permission:\s*\n\s+"\*": deny/m);
    assert.doesNotMatch(stdout, /^\s*(?:read|glob|grep):/m);
    assert.match(stdout, /Do not call tools/i);
  }
});

test("doctor writes its failure report before exiting", async () => {
  const missingProfileHome = path.join(os.tmpdir(), `opencode-advisor-missing-${randomUUID()}`);

  await assert.rejects(
    execFileAsync(process.execPath, [doctorBinPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCODE_ADVISOR_ALLOWED_ROOTS: repoRoot,
        OPENCODE_ADVISOR_HOME: missingProfileHome,
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /OpenCode Advisor doctor: FAIL \(provider_setup_required\)/);
      assert.match(error.stdout, /opencode-advisor-setup/);
      return true;
    },
  );
});
