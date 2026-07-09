import { existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_DIFF_CHARS = 60000;
export const DEFAULT_TIMEOUT_MS = 300000;

const AGENT_FALLBACK_PATTERN = /agent "(codex-advisor|codex-planning-partner)" not found|Falling back to default agent/i;
const UPSTREAM_UNAVAILABLE_PATTERN = /upstream service temporarily unavailable|service temporarily unavailable/i;
const DIAGNOSTIC_FIELDS = ["message", "error", "stderr", "stdout", "detail", "details", "reason"];

export const SUCCESS_RESPONSE_KEYS = Object.freeze([
  "ok",
  "base_ref",
  "status",
  "diff_truncated",
  "advisor_text",
  "opencode_exit_code",
]);

export const PLANNER_SUCCESS_RESPONSE_KEYS = Object.freeze([
  "ok",
  "base_ref",
  "status",
  "diff_truncated",
  "planner_text",
  "opencode_exit_code",
]);

export function createSuccessResponse({
  baseRef,
  status,
  diffTruncated,
  advisorText,
  opencodeExitCode,
}) {
  return {
    ok: true,
    base_ref: baseRef,
    status,
    diff_truncated: diffTruncated,
    advisor_text: advisorText,
    opencode_exit_code: opencodeExitCode,
  };
}

export function createPlannerSuccessResponse({
  baseRef,
  status,
  diffTruncated,
  plannerText,
  opencodeExitCode,
}) {
  return {
    ok: true,
    base_ref: baseRef,
    status,
    diff_truncated: diffTruncated,
    planner_text: plannerText,
    opencode_exit_code: opencodeExitCode,
  };
}

export function pathForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function resolveOpencodeCommand(
  base,
  { env = process.env, platform = process.platform, exists = existsSync } = {},
) {
  if (base !== "opencode") return base;
  if (platform !== "win32") return "opencode";

  const appData = env.APPDATA;
  if (appData) {
    const exePath = pathForPlatform(platform).join(
      appData,
      "npm",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (exists(exePath)) return exePath;
  }

  return "opencode";
}

export function textHasAgentFallback(text = "") {
  return AGENT_FALLBACK_PATTERN.test(String(text));
}

export function textHasUpstreamUnavailable(text = "") {
  return UPSTREAM_UNAVAILABLE_PATTERN.test(String(text));
}

function isAssistantTextEvent(event) {
  return typeof event?.part?.text === "string" || (event?.type === "text" && typeof event?.text === "string");
}

function valueHasPattern(value, pattern) {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) return value.some((entry) => valueHasPattern(entry, pattern));
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => valueHasPattern(entry, pattern));
  }
  return false;
}

function diagnosticValueHasPattern(event, pattern) {
  return valueHasPattern(DIAGNOSTIC_FIELDS.map((field) => event?.[field]), pattern);
}

function outputHasDiagnosticPattern(stdout = "", stderr = "", pattern) {
  for (const output of [stdout, stderr]) {
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        if (!isAssistantTextEvent(event) && diagnosticValueHasPattern(event, pattern)) {
          return true;
        }
        continue;
      } catch {
        if (pattern.test(trimmed)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function outputHasAgentFallback(stdout = "", stderr = "") {
  return outputHasDiagnosticPattern(stdout, stderr, AGENT_FALLBACK_PATTERN);
}

export function outputHasUpstreamUnavailable(stdout = "", stderr = "") {
  return outputHasDiagnosticPattern(stdout, stderr, UPSTREAM_UNAVAILABLE_PATTERN);
}
