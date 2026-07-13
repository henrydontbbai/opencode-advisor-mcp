import test from "node:test";
import assert from "node:assert/strict";
import {
  runDoctor as runDoctorImpl,
  findPayloadLeaks,
  formatDoctorJsonReport,
} from "../scripts/opencode-advisor-doctor.mjs";
import { main as runDoctorCli } from "../src/doctor.mjs";
import {
  createPlannerSuccessResponse,
  createSuccessResponse,
  PLANNER_SUCCESS_RESPONSE_KEYS,
  SUCCESS_RESPONSE_KEYS,
} from "../src/runtime-shared.mjs";

const WINDOWS_ALLOWED_ROOT = "C:\\workspace\\repo-root";
const WINDOWS_CHILD_REPO = `${WINDOWS_ALLOWED_ROOT}\\project`;
const TEST_ADVISOR_PROFILE = {
  config: {
    version: 1,
    provider: {
      id: "test-provider",
      name: "Test Provider",
      base_url: "https://models.example.test/v1",
      transport: "responses",
      models: [{ id: "test-model", name: "Test Model" }],
    },
    roles: {
      reviewer: { model: "test-model", variant: "high" },
      planner: { model: "test-model", variant: "max" },
    },
  },
  paths: {
    home: "C:\\advisor-profile",
    configHome: "C:\\advisor-profile\\config",
    dataHome: "C:\\advisor-profile\\data",
    cacheHome: "C:\\advisor-profile\\cache",
    stateHome: "C:\\advisor-profile\\state",
    opencodeConfigPath: "C:\\advisor-profile\\config\\opencode.json",
    opencodeConfigDir: "C:\\advisor-profile\\config-dir",
  },
  credential: "test-provider-secret",
};

function runDoctor(options = {}) {
  return runDoctorImpl({
    platform: "linux",
    loadAdvisorProfile: async () => TEST_ADVISOR_PROFILE,
    realpath: async (candidate) => candidate,
    ...options,
  });
}

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

function createCanonicalPlannerSuccessPayload(overrides = {}) {
  return {
    ...createPlannerSuccessResponse({
      baseRef: "HEAD",
      status: "",
      diffTruncated: false,
      plannerText: "OK",
      opencodeExitCode: 0,
    }),
    ...overrides,
  };
}

test("runDoctor succeeds with source-local health checks and sanitized payload", async () => {
  const firstPathCommand = "C:\\tools-first\\opencode.exe";
  const secondPathCommand = "C:\\tools-second\\opencode.exe";
  const commandCalls = [];
  let advisorInput;
  let advisorDeps;
  let plannerInput;
  let plannerDeps;
  const recordedSessions = [];

  const report = await runDoctor({
    cwd: WINDOWS_CHILD_REPO,
    env: {
      OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT,
      Path: "C:\\tools-first;.;relative-tools;C:\\tools-second",
    },
    platform: "win32",
    existsSync: (candidate) => [firstPathCommand, secondPathCommand].includes(candidate),
    isFile: (candidate) => [firstPathCommand, secondPathCommand].includes(candidate),
    runCommand: async (command, args, options) => {
      commandCalls.push({ command, args, options });
      return createCommandResult({
        stdout: [
          JSON.stringify({ type: "step", sessionID: `ses_doctor_${commandCalls.length}` }),
          JSON.stringify({ type: "text", part: { text: "OK" } }),
        ].join("\n"),
      });
    },
    recordManagedSession: async (record) => recordedSessions.push(record),
    askOpenCodeAdvisorImpl: async (input, deps) => {
      advisorInput = input;
      advisorDeps = deps;
      await deps.recordManagedSession({
        queueDir: "unused-by-test-double",
        sessionId: "ses_doctor_health_reviewer",
        cwd: input.cwd,
        title: `opencode-advisor:${deps.taskId}`,
        observedAt: "2026-07-13T00:00:00.000Z",
      });
      return createCanonicalSuccessPayload();
    },
    askOpenCodePlannerImpl: async (input, deps) => {
      plannerInput = input;
      plannerDeps = deps;
      await deps.recordManagedSession({
        queueDir: "unused-by-test-double",
        sessionId: "ses_doctor_health_planner",
        cwd: input.cwd,
        title: `opencode-advisor:${deps.taskId}`,
        observedAt: "2026-07-13T00:00:00.000Z",
      });
      return createCanonicalPlannerSuccessPayload();
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.bucket, null);
  assert.deepEqual(
    commandCalls.map((call) => call.command),
    [firstPathCommand, firstPathCommand],
  );
  assert.equal(
    commandCalls.some((call) => call.command === "opencode"),
    false,
  );
  for (const [index, call] of commandCalls.entries()) {
    assert.deepEqual(call.args.slice(0, 13), [
      "run",
      "--pure",
      "--agent",
      index === 0 ? "codex-advisor" : "codex-planning-partner",
      "--model",
      "test-provider/test-model",
      "--variant",
      index === 0 ? "high" : "max",
      "--dir",
      WINDOWS_CHILD_REPO,
      "--format",
      "json",
      "--title",
    ]);
    assert.match(call.args[13], /^opencode-advisor:doctor-direct-(reviewer|planner)_[a-f0-9]{32}$/);
    assert.equal(call.args[14], "Say OK only.");
  }
  for (const call of commandCalls) {
    assert.equal(call.options.cwd, WINDOWS_CHILD_REPO);
    assert.equal(call.options.platform, "win32");
    assert.equal(call.options.timeoutMs, 300000);
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env.OPENCODE_ADVISOR_PROVIDER_KEY, "test-provider-secret");
    assert.equal(call.options.env.OPENCODE_CONFIG_CONTENT.includes("test-provider-secret"), false);
  }
  assert.deepEqual(advisorInput, {
    cwd: WINDOWS_CHILD_REPO,
    include_diff: false,
    include_status: false,
  });
  assert.equal(advisorDeps.env.OPENCODE_ADVISOR_ALLOWED_ROOTS, WINDOWS_ALLOWED_ROOT);
  assert.equal(advisorDeps.platform, "win32");
  assert.equal(advisorDeps.useQueue, false);
  assert.equal(typeof advisorDeps.loadAdvisorProfile, "function");
  assert.match(advisorDeps.taskId, /^doctor-health-reviewer_[a-f0-9]{32}$/);
  assert.deepEqual(plannerInput, {
    cwd: WINDOWS_CHILD_REPO,
    include_diff: false,
    include_status: false,
    current_plan: "1. Validate config\n2. Run doctor",
  });
  assert.equal(plannerDeps.env.OPENCODE_ADVISOR_ALLOWED_ROOTS, WINDOWS_ALLOWED_ROOT);
  assert.equal(plannerDeps.platform, "win32");
  assert.equal(plannerDeps.useQueue, false);
  assert.equal(typeof plannerDeps.loadAdvisorProfile, "function");
  assert.match(plannerDeps.taskId, /^doctor-health-planner_[a-f0-9]{32}$/);
  assert.deepEqual(
    recordedSessions.map((record) => ({
      sessionId: record.sessionId,
      cwd: record.cwd,
      title: record.title,
    })),
    [
      {
        sessionId: "ses_doctor_1",
        cwd: WINDOWS_CHILD_REPO,
        title: commandCalls[0].args[13],
      },
      {
        sessionId: "ses_doctor_2",
        cwd: WINDOWS_CHILD_REPO,
        title: commandCalls[1].args[13],
      },
      {
        sessionId: "ses_doctor_health_reviewer",
        cwd: WINDOWS_CHILD_REPO,
        title: `opencode-advisor:${advisorDeps.taskId}`,
      },
      {
        sessionId: "ses_doctor_health_planner",
        cwd: WINDOWS_CHILD_REPO,
        title: `opencode-advisor:${plannerDeps.taskId}`,
      },
    ],
  );
  assert.equal(
    report.steps.every((step) => step.ok),
    true,
  );
});

test("runDoctor fails closed when direct session ownership cannot be persisted", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () =>
      createCommandResult({
        stdout: [
          JSON.stringify({ type: "step", sessionID: "ses_doctor_unrecorded" }),
          JSON.stringify({ type: "text", part: { text: "OK" } }),
        ].join("\n"),
      }),
    recordManagedSession: async () => {
      throw new Error("ownership storage unavailable");
    },
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.match(report.summary, /session ownership could not be persisted/i);
});

test("runDoctor classifies missing opencode command", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => {
      throw Object.assign(new Error("spawn opencode ENOENT"), {
        code: "ENOENT",
        syscall: "spawn opencode",
      });
    },
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "opencode_not_found");
  assert.equal(report.steps[0].ok, false);
});

test("runDoctor falls back from PATH to a trusted Windows OpenCode executable", async () => {
  const pathCommand = "C:\\tools-first\\opencode.exe";
  const fallbackCommand = "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const commandCalls = [];
  const report = await runDoctor({
    cwd: WINDOWS_CHILD_REPO,
    env: {
      OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT,
      PATH: "C:\\tools-first",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    },
    platform: "win32",
    existsSync: (candidate) => candidate === pathCommand || candidate === fallbackCommand,
    isFile: (candidate) => candidate === pathCommand || candidate === fallbackCommand,
    runCommand: async (command) => {
      commandCalls.push(command);
      if (command === pathCommand) {
        const error = new Error("OpenCode executable is unavailable");
        error.code = "ENOENT";
        error.syscall = `spawn ${pathCommand}`;
        throw error;
      }
      return createCommandResult();
    },
    askOpenCodeAdvisorImpl: async () => createCanonicalSuccessPayload(),
    askOpenCodePlannerImpl: async () => createCanonicalPlannerSuccessPayload(),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(commandCalls, [pathCommand, fallbackCommand, pathCommand, fallbackCommand]);
});

test("runDoctor does not fall back after a non-spawn ENOENT failure", async () => {
  const pathCommand = "C:\\tools-first\\opencode.exe";
  const fallbackCommand = "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const commandCalls = [];
  const report = await runDoctor({
    cwd: WINDOWS_CHILD_REPO,
    env: {
      OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT,
      PATH: "C:\\tools-first",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    },
    platform: "win32",
    existsSync: (candidate) => candidate === pathCommand || candidate === fallbackCommand,
    isFile: (candidate) => candidate === pathCommand || candidate === fallbackCommand,
    runCommand: async (command) => {
      commandCalls.push(command);
      if (command === pathCommand) {
        throw Object.assign(new Error("provider reported ENOENT"), { code: "ENOENT" });
      }
      return createCommandResult();
    },
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.deepEqual(commandCalls, [pathCommand]);
});

test("runDoctor rejects relative and batch OpenCode command overrides on Windows", async () => {
  for (const configuredCommand of [
    "opencode.cmd",
    ".\\opencode.cmd",
    "C:\\tools\\opencode.cmd",
    "C:\\tools\\opencode.bat",
  ]) {
    let commandCalls = 0;
    const report = await runDoctor({
      cwd: WINDOWS_CHILD_REPO,
      env: {
        OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT,
        OPENCODE_ADVISOR_OPENCODE_CMD: configuredCommand,
      },
      platform: "win32",
      existsSync: () => true,
      runCommand: async () => {
        commandCalls += 1;
        return createCommandResult();
      },
    });

    assert.equal(report.ok, false, configuredCommand);
    assert.equal(report.bucket, "generic_opencode_failure", configuredCommand);
    assert.equal(report.steps[0].id, "opencode-command", configuredCommand);
    assert.equal(commandCalls, 0, configuredCommand);
  }
});

test("runDoctor classifies provider authentication failures without leaking provider settings", async () => {
  const secret = "provider-secret-value";
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () =>
      createCommandResult({
        code: 1,
        stderr: `401 Invalid token for https://models.example.test/v1 using ${secret}`,
      }),
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "provider_authentication_failed");
  const reportText = JSON.stringify(report);
  assert.equal(reportText.includes(secret), false);
  assert.equal(reportText.includes("models.example.test"), false);
});

test("runDoctor fails closed with setup guidance when the isolated profile cannot load", async () => {
  let commandRan = false;
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    loadAdvisorProfile: async () => {
      throw new Error("credential decryption failed");
    },
    runCommand: async () => {
      commandRan = true;
      return createCommandResult();
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "provider_setup_required");
  assert.equal(commandRan, false);
  assert.match(report.steps[0].detail, /opencode-advisor-setup/);
});

test("runDoctor validates allowed roots before launching a direct agent check", async () => {
  let commandCalls = 0;
  const report = await runDoctor({
    cwd: "/outside-allowed-root",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/inside-allowed-root" },
    platform: "linux",
    runCommand: async () => {
      commandCalls += 1;
      return createCommandResult();
    },
    askOpenCodeAdvisorImpl: async () => createCanonicalSuccessPayload(),
    askOpenCodePlannerImpl: async () => createCanonicalPlannerSuccessPayload(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "invalid_cwd_or_allowed_roots");
  assert.equal(commandCalls, 0);
});

test("runDoctor rejects invalid allowed-root configuration before direct checks", async () => {
  let commandCalls = 0;
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo\0invalid" },
    platform: "linux",
    runCommand: async () => {
      commandCalls += 1;
      return createCommandResult();
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "invalid_cwd_or_allowed_roots");
  assert.equal(commandCalls, 0);
});

test("runDoctor classifies agent fallback from direct OpenCode output", async () => {
  let directCalls = 0;
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => {
      directCalls += 1;
      return createCommandResult({
        stdout:
          directCalls === 1
            ? 'agent "codex-advisor" not found\nFalling back to default agent'
            : JSON.stringify({ type: "text", part: { text: "OK" } }),
      });
    },
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "agent_missing_or_fallback");
});

test("runDoctor classifies planner fallback from direct OpenCode output", async () => {
  let directCalls = 0;
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => {
      directCalls += 1;
      if (directCalls === 1) {
        return createCommandResult();
      }
      return createCommandResult({
        stdout: 'agent "codex-planning-partner" not found\nFalling back to default agent',
      });
    },
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
    askOpenCodePlannerImpl: async () => createCanonicalPlannerSuccessPayload(),
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
    askOpenCodePlannerImpl: async () => {
      throw new Error("should not reach planner health check");
    },
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

test("runDoctor rejects direct-agent output that exceeded the capture limit", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult({ outputTruncated: true }),
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.match(report.steps[0].detail, /capture limit/i);
});

test("runDoctor rejects an empty direct agent response", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult({ stdout: "" }),
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.match(report.steps[0].detail, /structured JSON/i);
});

test("runDoctor rejects non-JSON direct agent output", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult({ stdout: "BLOCKER: none" }),
    askOpenCodeAdvisorImpl: async () => {
      throw new Error("should not reach health check");
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.match(report.steps[0].detail, /structured JSON/i);
});

test("runDoctor classifies timeout from health check", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => ({
      ok: false,
      error: "timeout",
      message: "OpenCode advisor timed out after 300000ms",
      details: {},
    }),
    askOpenCodePlannerImpl: async () => {
      throw new Error("should not reach planner health check");
    },
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
    askOpenCodePlannerImpl: async () => {
      throw new Error("should not reach planner health check");
    },
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
    askOpenCodePlannerImpl: async () => {
      throw new Error("should not reach planner health check");
    },
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
    askOpenCodePlannerImpl: async () => {
      throw new Error("should not reach planner health check");
    },
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
    findPayloadLeaks(
      createCanonicalSuccessPayload({
        advisor_text: `Reviewed ${WINDOWS_CHILD_REPO}`,
      }),
      { cwd: WINDOWS_CHILD_REPO },
    ),
    [],
  );
});

test("findPayloadLeaks accepts the canonical server success response shape", () => {
  const payload = Object.fromEntries(SUCCESS_RESPONSE_KEYS.map((key) => [key, createCanonicalSuccessPayload()[key]]));

  assert.deepEqual(findPayloadLeaks(payload), []);
});

test("findPayloadLeaks accepts the canonical planner success response shape", () => {
  const payload = Object.fromEntries(
    PLANNER_SUCCESS_RESPONSE_KEYS.map((key) => [key, createCanonicalPlannerSuccessPayload()[key]]),
  );

  assert.deepEqual(findPayloadLeaks(payload, { role: "planner" }), []);
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
    askOpenCodePlannerImpl: async () => createCanonicalPlannerSuccessPayload(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.equal(report.steps.at(-1).ok, false);
});

test("runDoctor rejects provider settings echoed inside an otherwise valid health payload", async () => {
  const secret = "test-provider-secret";
  const command = "C:\\tools\\opencode.exe";
  const report = await runDoctor({
    cwd: WINDOWS_CHILD_REPO,
    env: {
      OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT,
      Path: "C:\\tools",
    },
    platform: "win32",
    existsSync: (candidate) => candidate === command,
    isFile: (candidate) => candidate === command,
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () =>
      createCanonicalSuccessPayload({
        advisor_text: `${secret} https://models.example.test/v1 test-provider/test-model`,
      }),
    askOpenCodePlannerImpl: async () => createCanonicalPlannerSuccessPayload(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  const reportText = JSON.stringify(report);
  assert.equal(reportText.includes(secret), false);
  assert.equal(reportText.includes("models.example.test"), false);
});

test("runDoctor fails when planner health check leaks forbidden fields", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => createCanonicalSuccessPayload(),
    askOpenCodePlannerImpl: async () => ({
      ...createCanonicalPlannerSuccessPayload(),
      cwd: "/repo",
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "generic_opencode_failure");
  assert.equal(report.steps.at(-1).label, "Sanitized planner success payload");
});

test("runDoctor allows planner health to fail independently", async () => {
  const report = await runDoctor({
    cwd: "/repo",
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
    runCommand: async () => createCommandResult(),
    askOpenCodeAdvisorImpl: async () => createCanonicalSuccessPayload(),
    askOpenCodePlannerImpl: async () => ({
      ok: false,
      error: "opencode_failed",
      message: 'agent "codex-planning-partner" not found. Falling back to default agent',
      details: {},
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.bucket, "agent_missing_or_fallback");
  assert.equal(report.steps.at(-1).label, "askOpenCodePlanner health check");
});

test("formatDoctorJsonReport preserves the sanitized report contract", () => {
  const report = {
    ok: false,
    bucket: "provider_setup_required",
    provider_url: "https://provider-secret.example.test/v1",
    steps: [
      {
        id: "provider-profile",
        label: "Independent provider profile",
        ok: false,
        detail: "Run opencode-advisor-setup.",
        stderr: "provider-secret-step-output",
      },
    ],
    summary: "Independent provider setup is required",
  };

  const output = formatDoctorJsonReport(report);

  assert.deepEqual(JSON.parse(output), {
    ok: false,
    bucket: "provider_setup_required",
    steps: [
      {
        id: "provider-profile",
        label: "Independent provider profile",
        ok: false,
        detail: "Run opencode-advisor-setup.",
      },
    ],
    summary: "Independent provider setup is required",
  });
  assert.equal(output.includes("provider-secret"), false);
  assert.equal(output.endsWith("\n"), false);
});

test("doctor JSON mode preserves success reports and exit status", async () => {
  const originalExitCode = process.exitCode;
  const stdout = [];
  const stderr = [];
  const report = {
    ok: true,
    bucket: null,
    steps: [],
    summary: "Doctor checks passed",
  };

  try {
    const result = await runDoctorCli({
      argv: ["--json"],
      runDoctorImpl: async () => report,
      writeOutput: (value) => stdout.push(value),
      writeError: (value) => stderr.push(value),
    });

    assert.equal(result, report);
    assert.deepEqual(JSON.parse(stdout.join("")), report);
    assert.deepEqual(stderr, []);
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("doctor JSON mode keeps runtime failures machine-readable", async () => {
  const originalExitCode = process.exitCode;
  const stdout = [];
  const stderr = [];

  try {
    const result = await runDoctorCli({
      argv: ["--json"],
      runDoctorImpl: async () => {
        throw new Error("provider-secret-should-not-be-printed");
      },
      writeOutput: (value) => stdout.push(value),
      writeError: (value) => stderr.push(value),
    });

    assert.equal(result.ok, false);
    assert.equal(result.bucket, "generic_opencode_failure");
    assert.deepEqual(JSON.parse(stdout.join("")), result);
    assert.equal(stdout.join("").includes("provider-secret-should-not-be-printed"), false);
    assert.deepEqual(stderr, []);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});
