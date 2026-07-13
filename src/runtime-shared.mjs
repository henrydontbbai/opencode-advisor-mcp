import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_DIFF_CHARS = 60000;
export const DEFAULT_TIMEOUT_MS = 300000;

const AGENT_FALLBACK_PATTERN =
  /agent "(codex-advisor|codex-planning-partner)" not found|Falling back to default agent/i;
const UPSTREAM_UNAVAILABLE_PATTERN = /upstream service temporarily unavailable|service temporarily unavailable/i;
const DIAGNOSTIC_FIELDS = ["message", "error", "stderr", "stdout", "detail", "details", "reason"];
const SENSITIVE_ENVIRONMENT_NAME =
  /^(?:OPENCODE_|XDG_|NODE_|BUN_|DENO_|LD_|DYLD_)|(?:^|_)(?:API_?KEY|ACCESS_?KEY|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|BASE_?URL|ENDPOINT)(?:_|$)/i;
const PROCESS_LAUNCH_ERROR = Symbol("opencode-advisor.process-launch-error");

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

export function createSuccessResponse({ baseRef, status, diffTruncated, advisorText, opencodeExitCode }) {
  return {
    ok: true,
    base_ref: baseRef,
    status,
    diff_truncated: diffTruncated,
    advisor_text: advisorText,
    opencode_exit_code: opencodeExitCode,
  };
}

export function createPlannerSuccessResponse({ baseRef, status, diffTruncated, plannerText, opencodeExitCode }) {
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
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
  ) {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function isSensitiveEnvironmentName(name) {
  return SENSITIVE_ENVIRONMENT_NAME.test(String(name));
}

function configuredWindowsOpencodePaths(env, platform) {
  const pathApi = pathForPlatform(platform);
  const candidates = [];
  if (typeof env.APPDATA === "string" && pathApi.isAbsolute(env.APPDATA)) {
    candidates.push(pathApi.join(env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
  }
  if (typeof env.LOCALAPPDATA === "string" && pathApi.isAbsolute(env.LOCALAPPDATA)) {
    candidates.push(
      pathApi.join(env.LOCALAPPDATA, "pnpm", "global", "5", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    );
  }
  if (typeof env.ProgramFiles === "string" && pathApi.isAbsolute(env.ProgramFiles)) {
    candidates.push(pathApi.join(env.ProgramFiles, "nodejs", "node_modules", "opencode-ai", "bin", "opencode.exe"));
  }
  return candidates;
}

function defaultIsFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isExistingFile(candidate, exists, isFile) {
  try {
    return Boolean(exists(candidate)) && Boolean(isFile(candidate));
  } catch {
    return false;
  }
}

function getWindowsPathValues(env) {
  const values = [];
  for (const name of ["PATH", "Path"]) {
    if (typeof env[name] === "string" && env[name]) values.push(env[name]);
  }

  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === "path" && typeof value === "string" && value) values.push(value);
  }

  return [...new Set(values)];
}

function getWindowsPathOpencodeCommand(env, platform, exists, isFile) {
  const pathApi = pathForPlatform(platform);
  for (const pathValue of getWindowsPathValues(env)) {
    for (const rawDirectory of pathValue.split(pathApi.delimiter)) {
      const directory = rawDirectory.trim();
      if (!directory || directory.includes("\0") || !pathApi.isAbsolute(directory)) continue;

      for (const executableName of ["opencode.com", "opencode.exe"]) {
        const candidate = pathApi.join(directory, executableName);
        if (isExistingFile(candidate, exists, isFile)) return candidate;
      }
    }
  }

  return null;
}

export function getOpencodeFallbackCommands({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  isFile = defaultIsFile,
} = {}) {
  if (platform !== "win32") return [];
  const pathApi = pathForPlatform(platform);
  return configuredWindowsOpencodePaths(env, platform).filter(
    (candidate) => pathApi.isAbsolute(candidate) && isExistingFile(candidate, exists, isFile),
  );
}

export function resolveOpencodeCommand(
  base,
  { env: _env = process.env, platform = process.platform, exists = existsSync, isFile = defaultIsFile } = {},
) {
  if (base === "opencode") return "opencode";

  const pathApi = pathForPlatform(platform);
  if (typeof base !== "string" || !base || base.includes("\0") || /[\r\n]/.test(base) || !pathApi.isAbsolute(base)) {
    throw new Error("OPENCODE_ADVISOR_OPENCODE_CMD must be an absolute executable path.");
  }
  if (platform === "win32" && !/\.exe$/i.test(base)) {
    throw new Error("OPENCODE_ADVISOR_OPENCODE_CMD must point to an .exe file on Windows.");
  }
  if (!isExistingFile(base, exists, isFile)) {
    throw new Error("OPENCODE_ADVISOR_OPENCODE_CMD must point to an existing executable.");
  }
  return base;
}

export function resolveOpencodeCommands(
  base,
  { env = process.env, platform = process.platform, exists = existsSync, isFile = defaultIsFile } = {},
) {
  if (base !== "opencode") {
    return [resolveOpencodeCommand(base, { env, platform, exists, isFile })];
  }
  if (platform !== "win32") return ["opencode"];

  const pathCommand = getWindowsPathOpencodeCommand(env, platform, exists, isFile);
  return [...new Set([pathCommand, ...getOpencodeFallbackCommands({ env, platform, exists, isFile })].filter(Boolean))];
}

export function markProcessLaunchError(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return error;
  try {
    Object.defineProperty(error, PROCESS_LAUNCH_ERROR, { value: true });
  } catch {}
  return error;
}

export function isProcessLaunchError(error) {
  try {
    return Boolean(
      error?.[PROCESS_LAUNCH_ERROR] || (typeof error?.syscall === "string" && /^spawn(?:\s|$)/i.test(error.syscall)),
    );
  } catch {
    return false;
  }
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

export function outputHasStructuredAssistantText(stdout = "") {
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      const text =
        typeof event?.part?.text === "string"
          ? event.part.text
          : event?.type === "text" && typeof event?.text === "string"
            ? event.text
            : "";
      if (text.trim()) return true;
    } catch {}
  }
  return false;
}

export function valueHasPattern(value, pattern, seen = new WeakSet()) {
  if (typeof value === "string") return pattern.test(value);
  if (value && typeof value === "object") {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((entry) => valueHasPattern(entry, pattern, seen));
  }
  return false;
}

function diagnosticValueHasPattern(event, pattern) {
  return valueHasPattern(
    DIAGNOSTIC_FIELDS.map((field) => event?.[field]),
    pattern,
  );
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
