#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { askOpenCodeAdvisor, extractOpenCodeText } from "../src/server.mjs";

const DEFAULT_TIMEOUT_MS = 120000;
const FALLBACK_PATTERN = /agent "codex-advisor" not found|Falling back to default agent/i;
const UPSTREAM_UNAVAILABLE_PATTERN = /upstream service temporarily unavailable|service temporarily unavailable/i;
const FORBIDDEN_SUCCESS_KEYS = new Set(["cwd", "stderr_tail", "stdout_tail", "allowed_roots"]);
const ALLOWED_SUCCESS_KEYS = new Set(["ok", "base_ref", "status", "diff_truncated", "advisor_text", "opencode_exit_code"]);

function pathForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function resolveOpencodeCommand(base, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (base !== "opencode") return base;
  if (platform !== "win32") return "opencode";

  const appData = env.APPDATA;
  if (appData) {
    const exePath = pathForPlatform(platform).join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (exists(exePath)) return exePath;
  }

  return "opencode";
}

function runCommand(command, args, { cwd, env = process.env, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const needsShell = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      env,
      shell: needsShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function outputHasFallback(stdout = "", stderr = "") {
  return FALLBACK_PATTERN.test(`${stdout}\n${stderr}`);
}

function outputHasUpstreamUnavailable(stdout = "", stderr = "") {
  return UPSTREAM_UNAVAILABLE_PATTERN.test(`${stdout}\n${stderr}`);
}

function unique(items) {
  return [...new Set(items)];
}

export function findPayloadLeaks(payload, { cwd } = {}) {
  const leaks = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return leaks;
  }

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_SUCCESS_KEYS.has(key) || !ALLOWED_SUCCESS_KEYS.has(key)) {
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
      return "Reinstall the bundled codex-advisor agent template and confirm `opencode agent list` shows `codex-advisor (primary)`.";
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

export async function runDoctor({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  runCommand: runCommandImpl = runCommand,
  askOpenCodeAdvisorImpl = askOpenCodeAdvisor,
  existsSync: exists = existsSync,
} = {}) {
  const timeoutMs = positiveNumber(env.OPENCODE_ADVISOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const steps = [];
  const opencodeCommand = resolveOpencodeCommand(env.OPENCODE_ADVISOR_OPENCODE_CMD || "opencode", { env, platform, exists });

  let directResult;
  try {
    directResult = await runCommandImpl(
      opencodeCommand,
      ["run", "--agent", "codex-advisor", "--format", "json", "Say OK only."],
      { cwd, env, platform, timeoutMs },
    );
  } catch (error) {
    const bucket = classifySpawnError(error);
    steps.push({
      id: "agent",
      label: "Direct OpenCode agent check",
      ok: false,
      detail: error.message,
    });
    return buildFailureReport(bucket, steps, error.message);
  }

  if (directResult.timedOut) {
    steps.push({
      id: "agent",
      label: "Direct OpenCode agent check",
      ok: false,
      detail: `timed out after ${timeoutMs}ms`,
    });
    return buildFailureReport("timeout", steps, "Direct OpenCode agent check timed out");
  }

  if (outputHasFallback(directResult.stdout, directResult.stderr)) {
    steps.push({
      id: "agent",
      label: "Direct OpenCode agent check",
      ok: false,
      detail: "codex-advisor missing or fallback detected",
    });
    return buildFailureReport("agent_missing_or_fallback", steps, "Fallback detected during direct OpenCode agent check");
  }

  if (outputHasUpstreamUnavailable(directResult.stdout, directResult.stderr)) {
    steps.push({
      id: "agent",
      label: "Direct OpenCode agent check",
      ok: false,
      detail: "upstream service temporarily unavailable",
    });
    return buildFailureReport("upstream_unavailable", steps, "Upstream service temporarily unavailable");
  }

  if (directResult.code !== 0) {
    steps.push({
      id: "agent",
      label: "Direct OpenCode agent check",
      ok: false,
      detail: `exit code ${directResult.code}`,
    });
    return buildFailureReport("generic_opencode_failure", steps, `Direct OpenCode agent check failed with code ${directResult.code}`);
  }

  const directText = extractOpenCodeText(directResult.stdout);
  steps.push({
    id: "agent",
    label: "Direct OpenCode agent check",
    ok: true,
    detail: directText || "agent responded",
  });

  const healthResult = await askOpenCodeAdvisorImpl(
    {
      cwd,
      include_diff: false,
      include_status: false,
    },
    {
      env,
      platform,
    },
  );

  if (!healthResult.ok) {
    let bucket = "generic_opencode_failure";
    if (healthResult.error === "invalid_cwd") bucket = "invalid_cwd_or_allowed_roots";
    else if (healthResult.error === "timeout") bucket = "timeout";
    else if (healthResult.error === "opencode_not_found") bucket = "opencode_not_found";
    else if (FALLBACK_PATTERN.test(healthResult.message || "")) bucket = "agent_missing_or_fallback";
    else if (UPSTREAM_UNAVAILABLE_PATTERN.test(healthResult.message || "")) bucket = "upstream_unavailable";

    steps.push({
      id: "health",
      label: "askOpenCodeAdvisor health check",
      ok: false,
      detail: `${healthResult.error}: ${healthResult.message}`,
    });
    return buildFailureReport(bucket, steps, healthResult.message);
  }

  steps.push({
    id: "health",
    label: "askOpenCodeAdvisor health check",
    ok: true,
    detail: "ok: true with include_diff:false/include_status:false",
  });

  const leaks = findPayloadLeaks(healthResult, { cwd });
  if (leaks.length > 0) {
    steps.push({
      id: "sanitize",
      label: "Sanitized success payload",
      ok: false,
      detail: `forbidden fields or path leaks: ${leaks.join(", ")}`,
    });
    return buildFailureReport("generic_opencode_failure", steps, `Forbidden success payload leaks: ${leaks.join(", ")}`);
  }

  steps.push({
    id: "sanitize",
    label: "Sanitized success payload",
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
