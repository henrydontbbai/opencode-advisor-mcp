#!/usr/bin/env node
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { askOpenCodeAdvisor, askOpenCodePlanner } from "./server.mjs";
import { extractOpenCodeSessionId, preflightOpenCodeTask, runProcess } from "./opencode-core.mjs";
import { getQueueConfig } from "./task-queue.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  PLANNER_SUCCESS_RESPONSE_KEYS,
  SUCCESS_RESPONSE_KEYS,
  isProcessLaunchError,
  outputHasAgentFallback,
  outputHasStructuredAssistantText,
  outputHasUpstreamUnavailable,
  positiveNumber,
  resolveOpencodeCommands,
  textHasAgentFallback,
  textHasUpstreamUnavailable,
} from "./runtime-shared.mjs";
import {
  buildOpenCodeChildEnv,
  containsAdvisorProviderValue,
  loadAdvisorProfile,
  SETUP_GUIDANCE,
} from "./provider-profile.mjs";
import {
  createManagedSessionOwnerId,
  createManagedSessionTitle,
  recordManagedSession as recordManagedSessionOnDisk,
} from "./session-lifecycle.mjs";

const FORBIDDEN_SUCCESS_KEYS = new Set(["cwd", "stderr_tail", "stdout_tail", "allowed_roots"]);
const ALLOWED_SUCCESS_KEYS_BY_ROLE = {
  reviewer: new Set(SUCCESS_RESPONSE_KEYS),
  planner: new Set(PLANNER_SUCCESS_RESPONSE_KEYS),
};
const DIRECT_AGENT_CHECKS = [
  { role: "reviewer", agentName: "codex-advisor", label: "Direct OpenCode review agent check" },
  { role: "planner", agentName: "codex-planning-partner", label: "Direct OpenCode planning agent check" },
];
const PROVIDER_AUTHENTICATION_PATTERN =
  /\b401\b|unauthori[sz]ed|invalid (?:api )?(?:key|token)|authentication (?:failed|required)|invalid token/i;

const runCommand = runProcess;

function unique(items) {
  return [...new Set(items)];
}

function valueContainsProviderSetting(value, profile) {
  if (typeof value === "string") return containsAdvisorProviderValue(value, profile);
  if (Array.isArray(value)) return value.some((entry) => valueContainsProviderSetting(entry, profile));
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => valueContainsProviderSetting(entry, profile));
  }
  return false;
}

export function findPayloadLeaks(payload, { role = "reviewer", profile } = {}) {
  const leaks = [];
  const allowedSuccessKeys = ALLOWED_SUCCESS_KEYS_BY_ROLE[role] ?? ALLOWED_SUCCESS_KEYS_BY_ROLE.reviewer;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return leaks;
  }

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_SUCCESS_KEYS.has(key) || !allowedSuccessKeys.has(key)) {
      leaks.push(key);
    }
  }

  if (profile && valueContainsProviderSetting(payload, profile)) {
    leaks.push("provider_settings");
  }

  return unique(leaks);
}

function buildFailureReport(bucket, steps, summary) {
  return { ok: false, bucket, steps, summary };
}

function classifyLaunchFailure(error) {
  return isProcessLaunchError(error) ? "opencode_not_found" : "generic_opencode_failure";
}

function outputHasProviderAuthenticationFailure(stdout = "", stderr = "") {
  return PROVIDER_AUTHENTICATION_PATTERN.test(`${stdout}\n${stderr}`);
}

function classifyHealthFailure(result) {
  if (result.error === "invalid_cwd") return "invalid_cwd_or_allowed_roots";
  if (result.error === "timeout") return "timeout";
  if (result.error === "opencode_not_found") return "opencode_not_found";
  if (PROVIDER_AUTHENTICATION_PATTERN.test(String(result.message || ""))) return "provider_authentication_failed";
  if (textHasAgentFallback(result.message || "")) return "agent_missing_or_fallback";
  if (textHasUpstreamUnavailable(result.message || "")) return "upstream_unavailable";
  return "generic_opencode_failure";
}

function guidanceForBucket(bucket) {
  switch (bucket) {
    case "opencode_not_found":
      return "Confirm OpenCode is installed and OPENCODE_ADVISOR_OPENCODE_CMD points to a valid command.";
    case "agent_missing_or_fallback":
      return "Reinstall the bundled `codex-advisor` and `codex-planning-partner` agent templates, then confirm `opencode agent list` shows both agents.";
    case "invalid_cwd_or_allowed_roots":
      return "Set OPENCODE_ADVISOR_ALLOWED_ROOTS to the current repo or a narrow parent directory, then rerun doctor from the repo root.";
    case "upstream_unavailable":
      return "Your OpenCode runtime reached an upstream availability problem. Retry later or inspect the configured provider.";
    case "provider_setup_required":
      return "Run `opencode-advisor-setup` to configure the independent provider profile, then rerun doctor.";
    case "provider_authentication_failed":
      return "Run `opencode-advisor-setup` to update the independent provider URL, model selection, or API key, then rerun doctor.";
    case "timeout":
      return "The OpenCode runtime exceeded the configured timeout. Retry or raise OPENCODE_ADVISOR_TIMEOUT_MS for slow providers.";
    default:
      return "Inspect the failing step output, then rerun the manual OpenCode and askOpenCodeAdvisor checks from docs/ACCEPTANCE.md.";
  }
}

function formatStep(step) {
  const prefix = step.ok ? "[PASS]" : "[FAIL]";
  return `${prefix} ${step.label}${step.detail ? `: ${step.detail}` : ""}`;
}

export function formatDoctorReport(report) {
  const lines = [
    `OpenCode Advisor doctor: ${report.ok ? "PASS" : `FAIL (${report.bucket})`}`,
    ...report.steps.map(formatStep),
  ];

  if (!report.ok) {
    lines.push("", `Next step: ${guidanceForBucket(report.bucket)}`);
  }

  return lines.join("\n");
}

export function formatDoctorJsonReport(report) {
  return JSON.stringify(
    {
      ok: report.ok,
      bucket: report.bucket,
      steps: report.steps.map((step) => ({
        id: step.id,
        label: step.label,
        ok: step.ok,
        detail: step.detail,
      })),
      summary: report.summary,
    },
    null,
    2,
  );
}

async function runDirectAgentCheck({
  opencodeCommands,
  agentName,
  label,
  cwd,
  env,
  platform,
  timeoutMs,
  model,
  variant,
  title,
  onSessionId,
  runCommandImpl,
}) {
  let directResult;
  let spawnError;
  for (const opencodeCommand of opencodeCommands) {
    try {
      directResult = await runCommandImpl(
        opencodeCommand,
        [
          "run",
          "--pure",
          "--agent",
          agentName,
          "--model",
          model,
          ...(variant ? ["--variant", variant] : []),
          "--dir",
          cwd,
          "--format",
          "json",
          "--title",
          title,
          "Say OK only.",
        ],
        { cwd, env, platform, timeoutMs },
      );
      break;
    } catch (error) {
      spawnError = error;
      if (!isProcessLaunchError(error) || opencodeCommand === opencodeCommands.at(-1)) break;
    }
  }

  if (!directResult) {
    const bucket = classifyLaunchFailure(spawnError);
    return {
      ok: false,
      bucket,
      step: {
        id: agentName,
        label,
        ok: false,
        detail:
          bucket === "opencode_not_found"
            ? "OpenCode command could not be started"
            : "OpenCode command failed to start",
      },
      summary: "OpenCode command could not be started",
    };
  }

  const sessionId = extractOpenCodeSessionId(directResult.stdout);
  if (sessionId) {
    try {
      await onSessionId(sessionId, {
        cwd,
        title,
        observedAt: new Date().toISOString(),
      });
    } catch {
      return {
        ok: false,
        bucket: "generic_opencode_failure",
        step: {
          id: agentName,
          label,
          ok: false,
          detail: "session ownership could not be persisted",
        },
        summary: `${label} session ownership could not be persisted`,
      };
    }
  }

  if (directResult.timedOut) {
    return {
      ok: false,
      bucket: "timeout",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: `timed out after ${timeoutMs}ms`,
      },
      summary: `${label} timed out`,
    };
  }

  if (directResult.outputTruncated) {
    return {
      ok: false,
      bucket: "generic_opencode_failure",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: "output exceeded the capture limit",
      },
      summary: `${label} exceeded the capture limit`,
    };
  }

  if (outputHasAgentFallback(directResult.stdout, directResult.stderr)) {
    return {
      ok: false,
      bucket: "agent_missing_or_fallback",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: `${agentName} missing or fallback detected`,
      },
      summary: `Fallback detected during ${label}`,
    };
  }

  if (outputHasProviderAuthenticationFailure(directResult.stdout, directResult.stderr)) {
    return {
      ok: false,
      bucket: "provider_authentication_failed",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: "provider authentication failed",
      },
      summary: "Provider authentication failed",
    };
  }

  if (outputHasUpstreamUnavailable(directResult.stdout, directResult.stderr)) {
    return {
      ok: false,
      bucket: "upstream_unavailable",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: "upstream service temporarily unavailable",
      },
      summary: "Upstream service temporarily unavailable",
    };
  }

  if (directResult.code !== 0) {
    return {
      ok: false,
      bucket: "generic_opencode_failure",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: `exit code ${directResult.code}`,
      },
      summary: `${label} failed with code ${directResult.code}`,
    };
  }

  if (!outputHasStructuredAssistantText(directResult.stdout)) {
    return {
      ok: false,
      bucket: "generic_opencode_failure",
      step: {
        id: agentName,
        label,
        ok: false,
        detail: "expected structured JSON text output",
      },
      summary: `${label} returned empty or non-JSON output`,
    };
  }

  return {
    ok: true,
    step: {
      id: agentName,
      label,
      ok: true,
      detail: "structured JSON text output received",
    },
  };
}

export async function runDoctor({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  runCommand: runCommandImpl = runCommand,
  askOpenCodeAdvisorImpl = askOpenCodeAdvisor,
  askOpenCodePlannerImpl = askOpenCodePlanner,
  existsSync: exists = existsSync,
  isFile,
  loadAdvisorProfile: loadProfile = loadAdvisorProfile,
  recordManagedSession: recordManagedSessionImpl = recordManagedSessionOnDisk,
  realpath,
} = {}) {
  const timeoutMs = positiveNumber(env.OPENCODE_ADVISOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const steps = [];

  let profile;
  let childEnv;
  let canonicalCwd;
  let preflight;
  try {
    const preflightDeps = {
      env,
      platform,
      loadAdvisorProfile: loadProfile,
    };
    if (realpath) preflightDeps.realpath = realpath;
    preflight = await preflightOpenCodeTask(
      "reviewer",
      { cwd, include_diff: false, include_status: false },
      preflightDeps,
    );
  } catch {
    steps.push({
      id: "preflight",
      label: "Doctor preflight",
      ok: false,
      detail: "Doctor preflight failed",
    });
    return buildFailureReport("generic_opencode_failure", steps, "Doctor preflight failed");
  }

  if (!preflight.ok) {
    const bucket =
      preflight.error === "invalid_cwd"
        ? "invalid_cwd_or_allowed_roots"
        : preflight.error === "opencode_failed" && preflight.message === SETUP_GUIDANCE
          ? "provider_setup_required"
          : "generic_opencode_failure";
    steps.push({
      id:
        bucket === "provider_setup_required"
          ? "provider-profile"
          : bucket === "invalid_cwd_or_allowed_roots"
            ? "allowed-roots"
            : "preflight",
      label:
        bucket === "provider_setup_required"
          ? "Independent provider profile"
          : bucket === "invalid_cwd_or_allowed_roots"
            ? "Allowed working directory"
            : "Doctor preflight",
      ok: false,
      detail:
        bucket === "provider_setup_required"
          ? SETUP_GUIDANCE
          : bucket === "invalid_cwd_or_allowed_roots"
            ? "cwd is outside configured allowed roots"
            : "Doctor preflight failed",
    });
    return buildFailureReport(
      bucket,
      steps,
      bucket === "provider_setup_required"
        ? "Independent provider setup is required"
        : bucket === "invalid_cwd_or_allowed_roots"
          ? "Doctor cwd is outside configured allowed roots"
          : "Doctor preflight failed",
    );
  }

  profile = preflight.normalized.profile;
  canonicalCwd = preflight.normalized.cwd;
  try {
    childEnv = buildOpenCodeChildEnv({
      config: profile.config,
      paths: profile.paths,
      credential: profile.credential,
      env,
      platform,
    });
  } catch {
    steps.push({
      id: "provider-profile",
      label: "Independent provider profile",
      ok: false,
      detail: SETUP_GUIDANCE,
    });
    return buildFailureReport("provider_setup_required", steps, "Independent provider setup is required");
  }

  const configuredCommand = env.OPENCODE_ADVISOR_OPENCODE_CMD || "opencode";
  let opencodeCommands;
  try {
    opencodeCommands = resolveOpencodeCommands(configuredCommand, { env, platform, exists, isFile });
  } catch {
    steps.push({
      id: "opencode-command",
      label: "OpenCode command",
      ok: false,
      detail: "OpenCode command configuration is invalid",
    });
    return buildFailureReport("generic_opencode_failure", steps, "OpenCode command configuration is invalid");
  }
  if (opencodeCommands.length === 0) {
    steps.push({
      id: "opencode-command",
      label: "OpenCode command",
      ok: false,
      detail: "OpenCode command could not be started",
    });
    return buildFailureReport("opencode_not_found", steps, "OpenCode command could not be started");
  }

  const queueDir = getQueueConfig(env, platform).queueDir;

  for (const directCheck of DIRECT_AGENT_CHECKS) {
    const ownerId = createManagedSessionOwnerId(`doctor-direct-${directCheck.role}`);
    const title = createManagedSessionTitle(ownerId);
    const result = await runDirectAgentCheck({
      opencodeCommands,
      cwd: canonicalCwd,
      env: childEnv,
      platform,
      timeoutMs,
      runCommandImpl,
      model: `${profile.config.provider.id}/${profile.config.roles[directCheck.role].model}`,
      variant: profile.config.roles[directCheck.role].variant,
      title,
      onSessionId: (sessionId, metadata) =>
        recordManagedSessionImpl({
          queueDir,
          sessionId,
          cwd: metadata.cwd,
          title: metadata.title,
          observedAt: metadata.observedAt,
        }),
      ...directCheck,
    });
    steps.push(result.step);
    if (!result.ok) {
      return buildFailureReport(result.bucket, steps, result.summary);
    }
  }

  const advisorHealthResult = await askOpenCodeAdvisorImpl(
    {
      cwd: canonicalCwd,
      include_diff: false,
      include_status: false,
    },
    {
      env,
      platform,
      useQueue: false,
      existsSync: exists,
      isFile,
      loadAdvisorProfile: async () => profile,
      taskId: createManagedSessionOwnerId("doctor-health-reviewer"),
      recordManagedSession: recordManagedSessionImpl,
    },
  );

  if (!advisorHealthResult.ok) {
    const bucket = classifyHealthFailure(advisorHealthResult);

    steps.push({
      id: "advisor-health",
      label: "askOpenCodeAdvisor health check",
      ok: false,
      detail: `${advisorHealthResult.error || "opencode_failed"}: health check failed`,
    });
    return buildFailureReport(bucket, steps, "Advisor health check failed");
  }

  steps.push({
    id: "advisor-health",
    label: "askOpenCodeAdvisor health check",
    ok: true,
    detail: "ok: true with include_diff:false/include_status:false",
  });

  const advisorLeaks = findPayloadLeaks(advisorHealthResult, { cwd: canonicalCwd, role: "reviewer", profile });
  if (advisorLeaks.length > 0) {
    steps.push({
      id: "advisor-sanitize",
      label: "Sanitized advisor success payload",
      ok: false,
      detail: `forbidden fields or path leaks: ${advisorLeaks.join(", ")}`,
    });
    return buildFailureReport(
      "generic_opencode_failure",
      steps,
      `Forbidden success payload leaks: ${advisorLeaks.join(", ")}`,
    );
  }

  steps.push({
    id: "advisor-sanitize",
    label: "Sanitized advisor success payload",
    ok: true,
    detail: "no forbidden fields detected",
  });

  const plannerHealthResult = await askOpenCodePlannerImpl(
    {
      cwd: canonicalCwd,
      include_diff: false,
      include_status: false,
      current_plan: "1. Validate config\n2. Run doctor",
    },
    {
      env,
      platform,
      useQueue: false,
      existsSync: exists,
      isFile,
      loadAdvisorProfile: async () => profile,
      taskId: createManagedSessionOwnerId("doctor-health-planner"),
      recordManagedSession: recordManagedSessionImpl,
    },
  );

  if (!plannerHealthResult.ok) {
    const bucket = classifyHealthFailure(plannerHealthResult);

    steps.push({
      id: "planner-health",
      label: "askOpenCodePlanner health check",
      ok: false,
      detail: `${plannerHealthResult.error || "opencode_failed"}: health check failed`,
    });
    return buildFailureReport(bucket, steps, "Planner health check failed");
  }

  steps.push({
    id: "planner-health",
    label: "askOpenCodePlanner health check",
    ok: true,
    detail: "ok: true with include_diff:false/include_status:false",
  });

  const plannerLeaks = findPayloadLeaks(plannerHealthResult, { cwd: canonicalCwd, role: "planner", profile });
  if (plannerLeaks.length > 0) {
    steps.push({
      id: "planner-sanitize",
      label: "Sanitized planner success payload",
      ok: false,
      detail: `forbidden fields or path leaks: ${plannerLeaks.join(", ")}`,
    });
    return buildFailureReport(
      "generic_opencode_failure",
      steps,
      `Forbidden planner success payload leaks: ${plannerLeaks.join(", ")}`,
    );
  }

  steps.push({
    id: "planner-sanitize",
    label: "Sanitized planner success payload",
    ok: true,
    detail: "no forbidden fields detected",
  });

  return {
    ok: true,
    bucket: null,
    steps,
    summary: "Doctor checks passed",
  };
}

export async function main({
  argv = process.argv.slice(2),
  runDoctorImpl = runDoctor,
  writeOutput = console.log,
  writeError = console.error,
} = {}) {
  const jsonOutput = argv.includes("--json");
  try {
    const report = await runDoctorImpl();
    writeOutput(jsonOutput ? formatDoctorJsonReport(report) : formatDoctorReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return report;
  } catch (error) {
    const report = {
      ok: false,
      bucket: "generic_opencode_failure",
      steps: [
        {
          id: "doctor",
          label: "Doctor runtime",
          ok: false,
          detail: "Doctor runtime failed.",
        },
      ],
      summary: "Doctor runtime failed.",
    };
    const formatted = jsonOutput ? formatDoctorJsonReport(report) : formatDoctorReport(report);
    if (jsonOutput) writeOutput(formatted);
    else writeError(formatted);
    process.exitCode = 1;
    return report;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
