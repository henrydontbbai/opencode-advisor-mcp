#!/usr/bin/env node
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { askOpenCodeAdvisor, askOpenCodePlanner, extractOpenCodeText } from "../src/server.mjs";
import { runProcess } from "../src/opencode-core.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  PLANNER_SUCCESS_RESPONSE_KEYS,
  SUCCESS_RESPONSE_KEYS,
  outputHasAgentFallback,
  outputHasUpstreamUnavailable,
  positiveNumber,
  resolveOpencodeCommand,
  textHasAgentFallback,
  textHasUpstreamUnavailable,
} from "../src/runtime-shared.mjs";

const FORBIDDEN_SUCCESS_KEYS = new Set(["cwd", "stderr_tail", "stdout_tail", "allowed_roots"]);
const ALLOWED_SUCCESS_KEYS_BY_ROLE = {
  reviewer: new Set(SUCCESS_RESPONSE_KEYS),
  planner: new Set(PLANNER_SUCCESS_RESPONSE_KEYS),
};
const DIRECT_AGENT_CHECKS = [
  { agentName: "codex-advisor", label: "Direct OpenCode review agent check" },
  { agentName: "codex-planning-partner", label: "Direct OpenCode planning agent check" },
];

const runCommand = runProcess;

function unique(items) {
  return [...new Set(items)];
}

export function findPayloadLeaks(payload, { role = "reviewer", cwd } = {}) {
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

  return unique(leaks);
}

function buildFailureReport(bucket, steps, summary) {
  return { ok: false, bucket, steps, summary };
}

function classifySpawnError(error) {
  return /ENOENT|could not be started|not recognized/i.test(String(error?.message || error))
    ? "opencode_not_found"
    : "generic_opencode_failure";
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

async function runDirectAgentCheck({
  opencodeCommand,
  agentName,
  label,
  cwd,
  env,
  platform,
  timeoutMs,
  runCommandImpl,
}) {
  let directResult;
  try {
    directResult = await runCommandImpl(
      opencodeCommand,
      ["run", "--agent", agentName, "--format", "json", "Say OK only."],
      { cwd, env, platform, timeoutMs },
    );
  } catch (error) {
    return {
      ok: false,
      bucket: classifySpawnError(error),
      step: {
        id: agentName,
        label,
        ok: false,
        detail: error.message,
      },
      summary: error.message,
    };
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

  return {
    ok: true,
    step: {
      id: agentName,
      label,
      ok: true,
      detail: extractOpenCodeText(directResult.stdout) || `${agentName} responded`,
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
} = {}) {
  const timeoutMs = positiveNumber(env.OPENCODE_ADVISOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const steps = [];
  const opencodeCommand = resolveOpencodeCommand(env.OPENCODE_ADVISOR_OPENCODE_CMD || "opencode", { env, platform, exists });

  for (const directCheck of DIRECT_AGENT_CHECKS) {
    const result = await runDirectAgentCheck({
      opencodeCommand,
      cwd,
      env,
      platform,
      timeoutMs,
      runCommandImpl,
      ...directCheck,
    });
    steps.push(result.step);
    if (!result.ok) {
      return buildFailureReport(result.bucket, steps, result.summary);
    }
  }

  const advisorHealthResult = await askOpenCodeAdvisorImpl(
    {
      cwd,
      include_diff: false,
      include_status: false,
    },
    {
      env,
      platform,
      useQueue: false,
    },
  );

  if (!advisorHealthResult.ok) {
    let bucket = "generic_opencode_failure";
    if (advisorHealthResult.error === "invalid_cwd") bucket = "invalid_cwd_or_allowed_roots";
    else if (advisorHealthResult.error === "timeout") bucket = "timeout";
    else if (advisorHealthResult.error === "opencode_not_found") bucket = "opencode_not_found";
    else if (textHasAgentFallback(advisorHealthResult.message || "")) bucket = "agent_missing_or_fallback";
    else if (textHasUpstreamUnavailable(advisorHealthResult.message || "")) bucket = "upstream_unavailable";

    steps.push({
      id: "advisor-health",
      label: "askOpenCodeAdvisor health check",
      ok: false,
      detail: `${advisorHealthResult.error}: ${advisorHealthResult.message}`,
    });
    return buildFailureReport(bucket, steps, advisorHealthResult.message);
  }

  steps.push({
    id: "advisor-health",
    label: "askOpenCodeAdvisor health check",
    ok: true,
    detail: "ok: true with include_diff:false/include_status:false",
  });

  const advisorLeaks = findPayloadLeaks(advisorHealthResult, { cwd, role: "reviewer" });
  if (advisorLeaks.length > 0) {
    steps.push({
      id: "advisor-sanitize",
      label: "Sanitized advisor success payload",
      ok: false,
      detail: `forbidden fields or path leaks: ${advisorLeaks.join(", ")}`,
    });
    return buildFailureReport("generic_opencode_failure", steps, `Forbidden success payload leaks: ${advisorLeaks.join(", ")}`);
  }

  steps.push({
    id: "advisor-sanitize",
    label: "Sanitized advisor success payload",
    ok: true,
    detail: "no forbidden fields detected",
  });

  const plannerHealthResult = await askOpenCodePlannerImpl(
    {
      cwd,
      include_diff: false,
      include_status: false,
      current_plan: "1. Validate config\n2. Run doctor",
    },
    {
      env,
      platform,
      useQueue: false,
    },
  );

  if (!plannerHealthResult.ok) {
    let bucket = "generic_opencode_failure";
    if (plannerHealthResult.error === "invalid_cwd") bucket = "invalid_cwd_or_allowed_roots";
    else if (plannerHealthResult.error === "timeout") bucket = "timeout";
    else if (plannerHealthResult.error === "opencode_not_found") bucket = "opencode_not_found";
    else if (textHasAgentFallback(plannerHealthResult.message || "")) bucket = "agent_missing_or_fallback";
    else if (textHasUpstreamUnavailable(plannerHealthResult.message || "")) bucket = "upstream_unavailable";

    steps.push({
      id: "planner-health",
      label: "askOpenCodePlanner health check",
      ok: false,
      detail: `${plannerHealthResult.error}: ${plannerHealthResult.message}`,
    });
    return buildFailureReport(bucket, steps, plannerHealthResult.message);
  }

  steps.push({
    id: "planner-health",
    label: "askOpenCodePlanner health check",
    ok: true,
    detail: "ok: true with include_diff:false/include_status:false",
  });

  const plannerLeaks = findPayloadLeaks(plannerHealthResult, { cwd, role: "planner" });
  if (plannerLeaks.length > 0) {
    steps.push({
      id: "planner-sanitize",
      label: "Sanitized planner success payload",
      ok: false,
      detail: `forbidden fields or path leaks: ${plannerLeaks.join(", ")}`,
    });
    return buildFailureReport("generic_opencode_failure", steps, `Forbidden planner success payload leaks: ${plannerLeaks.join(", ")}`);
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

async function main() {
  try {
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    const report = {
      ok: false,
      bucket: "generic_opencode_failure",
      steps: [
        {
          id: "doctor",
          label: "Doctor runtime",
          ok: false,
          detail: error.message,
        },
      ],
      summary: error.message,
    };
    console.error(formatDoctorReport(report));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
