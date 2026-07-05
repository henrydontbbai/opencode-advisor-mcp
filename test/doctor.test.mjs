import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor, findPayloadLeaks } from "../scripts/opencode-advisor-doctor.mjs";
import { createSuccessResponse, SUCCESS_RESPONSE_KEYS } from "../src/runtime-shared.mjs";

const WINDOWS_ALLOWED_ROOT = "C:\\workspace\\repo-root";
const WINDOWS_CHILD_REPO = `${WINDOWS_ALLOWED_ROOT}\\project`;

function createCommandResult(overrides = {}) {
  return {
    code: 0,
    stdout: JSON.stringify({ type: "text", part: { text: "OK" } }),
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function createCanonicalSuccessPayload(overrides = {}) {
  return {
    ...createSuccessResponse({
      baseRef: "HEAD",
      status: "",
      diffTruncated: false,
      advisorText: "OK",
      opencodeExitCode: 0,
    }),
    ...overrides,
  };
}

test("runDoctor succeeds with source-local health checks and sanitized payload", async () => {
  const commandCalls = [];
  let advisorInput;
  let advisorDeps;

  const report = await runDoctor({
    cwd: WINDOWS_CHILD_REPO,
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
    platform: "win32",
    runCommand: async (command, args, options) => {
      commandCalls.push({ command, args, options });
      return createCommandResult();
    },
    askOpenCodeAdvisorImpl: async (input, deps) => {
      advisorInput = input;
      advisorDeps = deps;
      return createCanonicalSuccessPayload();
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.bucket, null);
  assert.deepEqual(commandCalls, [
    {
      command: "opencode",
      args: ["run", "--agent", "codex-advisor", "--format", "json", "Say OK only."],
      options: { cwd: WINDOWS_CHILD_REPO, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", timeoutMs: 120000 },
    },
  ]);
  assert.deepEqual(advisorInput, {
    cwd: WINDOWS_CHILD_REPO,
    include_diff: false,
    include_status: false,
  });
  assert.deepEqual(advisorDeps, {
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
    platform: "win32",
  });
  assert.equal(report.steps.every((step) => step.ok), true);
});

test("runDoctor classifies missing opencode command", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => {
      throw new Error("spawn opencode ENOENT");
    },
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "opencode_not_found");
  assert.equal(report.steps[0].ok, false);
});

test("runDoctor classifies agent fallback from direct OpenCode output", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () =>
      createCommandResult({
        stdout: 'agent "codex-advisor" not found\nFalling back to default agent',
      }),
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "agent_missing_or_fallback");
});

test("runDoctor ignores fallback phrases inside direct assistant text output", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () =>
      createCommandResult({
        stdout: JSON.stringify({
          type: "text",
          part: { text: "The phrase Falling back to default agent appears in docs." },
        }),
      }),
    askOpenCodeAdvisorImpl: async () => createCanonicalSuccessPayload(),
  });

  assert.equal(report.ok, true);
  assert.equal(report.bucket, null);
});

test("runDoctor classifies invalid_cwd from health check as allowed-roots problem", async () => {
  const report = await runDoctor({
    cwd: WINDOWS_CHILD_REPO,
    env: {},
    platform: "win32",
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ok: false,
      error: "invalid_cwd",
      message: "cwd is outside configured allowed roots",
      details: {},
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "invalid_cwd_or_allowed_roots");
});

test("runDoctor classifies upstream unavailable from direct OpenCode output", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () =>
      createCommandResult({
        code: 1,
        stderr: "upstream service temporarily unavailable",
      }),
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "upstream_unavailable");
});

test("runDoctor classifies timeout from health check", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ok: false,
      error: "timeout",
      message: "OpenCode advisor timed out after 120000ms",
      details: {},
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "timeout");
});

test("runDoctor classifies agent fallback from health check message", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ok: false,
      error: "opencode_failed",
      message: 'agent "codex-advisor" not found. Falling back to default agent',
      details: {},
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "agent_missing_or_fallback");
});

test("runDoctor classifies upstream unavailable from health check message", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ok: false,
      error: "opencode_failed",
      message: "upstream service temporarily unavailable",
      details: {},
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "upstream_unavailable");
});

test("runDoctor classifies nonzero health check failure as generic opencode failure", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ok: false,
      error: "opencode_failed",
      message: "OpenCode exited with code 2",
      details: {},
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
});

test("findPayloadLeaks reports forbidden success fields", () => {
  assert.deepEqual(
    findPayloadLeaks({
      ok: true,
      cwd: "/repo",
      stderr_tail: "tail",
      allowed_roots: ["/repo"],
      advisor_text: "OK",
    }),
    ["cwd", "stderr_tail", "allowed_roots"],
  );
});

test("findPayloadLeaks ignores cwd mentions inside advisor_text", () => {
  assert.deepEqual(
    findPayloadLeaks(createCanonicalSuccessPayload({
      advisor_text: `Reviewed ${WINDOWS_CHILD_REPO}`,
    }), { cwd: WINDOWS_CHILD_REPO }),
    [],
  );
});

test("findPayloadLeaks accepts the canonical server success response shape", () => {
  const payload = Object.fromEntries(
    SUCCESS_RESPONSE_KEYS.map((key) => [key, createCanonicalSuccessPayload()[key]]),
  );

  assert.deepEqual(findPayloadLeaks(payload), []);
});

test("runDoctor fails sanitization check when success payload exposes forbidden fields", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ...createCanonicalSuccessPayload(),
      cwd: "/repo",
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.equal(report.steps.at(-1).ok, false);
});
