import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_DIFF_CHARS,
  DEFAULT_TIMEOUT_MS,
  createPlannerSuccessResponse,
  createSuccessResponse,
  outputHasAgentFallback,
  pathForPlatform,
  positiveNumber,
  resolveOpencodeCommand,
} from "./runtime-shared.mjs";

export const INVALID_CWD_MESSAGE = "cwd is outside configured allowed roots";
export const GIT_FAILED_MESSAGE = "Git context collection failed";
export const OPENCODE_NOT_FOUND_MESSAGE = "OpenCode command could not be started";
export const DEFAULT_MAX_PROCESS_OUTPUT_CHARS = 1024 * 1024;
const PEM_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const SECRET_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g;
const SECRET_ASSIGNMENT_PATTERN = /^([+\- ]?(?:.*?(?:token|secret|api[_-]?key|password|pass|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*))(.*)$/gim;

function splitAllowedRootEntries(source) {
  const entries = [];
  let current = "";
  let quoted = false;

  for (const character of source) {
    if (character === "\"") {
      quoted = !quoted;
    } else if (character === ";" && !quoted) {
      entries.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  entries.push(current);
  return entries;
}

export function parseAllowedRoots(input, env = process.env, pathApi = path) {
  const source = input ?? env.OPENCODE_ADVISOR_ALLOWED_ROOTS ?? "";

  return splitAllowedRootEntries(source)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes("\0")) {
        throw new Error("allowed roots must not contain NUL bytes");
      }
      return pathApi.resolve(entry);
    });
}

export function isPathInsideAllowedRoots(candidate, allowedRoots = parseAllowedRoots(), pathApi = path) {
  const resolved = pathApi.resolve(candidate);
  const caseInsensitive = pathApi.sep === "\\";
  const comparableResolved = caseInsensitive ? resolved.normalize("NFC").toLowerCase() : resolved.normalize("NFC");

  return allowedRoots.some((root) => {
    const rootResolved = pathApi.resolve(root);
    const comparableRoot = caseInsensitive ? rootResolved.normalize("NFC").toLowerCase() : rootResolved.normalize("NFC");
    const rootPrefix = comparableRoot.endsWith(pathApi.sep) ? comparableRoot : `${comparableRoot}${pathApi.sep}`;
    return comparableResolved === comparableRoot || comparableResolved.startsWith(rootPrefix);
  });
}

export function truncateText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }

  const lastLineBreak = text.lastIndexOf("\n", maxChars - 1);
  const cutoff = lastLineBreak === -1 ? 0 : lastLineBreak + 1;
  const visible = text.slice(0, cutoff);

  return {
    text: `${visible}${visible ? "\n" : ""}[truncated: ${text.length - cutoff} chars omitted]`,
    truncated: true,
  };
}

function shouldRedactSecrets(env = process.env) {
  const value = env.OPENCODE_ADVISOR_REDACT_SECRETS;
  if (value == null) return true;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function redactSensitiveText(text) {
  return String(text)
    .replace(PEM_BLOCK_PATTERN, "[REDACTED_SECRET]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(SECRET_TOKEN_PATTERN, "[REDACTED_SECRET]");
}

function stripModelReasoning(text) {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  for (;;) {
    const danglingMatch = /<think>/i.exec(cleaned);
    if (!danglingMatch) {
      return cleaned;
    }

    const start = danglingMatch.index;
    const remainder = cleaned.slice(start);
    const headingMatch = /(^|\r?\n)(#{1,6}\s)/m.exec(remainder);

    if (!headingMatch) {
      cleaned = cleaned.slice(0, start);
      continue;
    }

    const headingOffset = headingMatch.index + headingMatch[0].length - headingMatch[2].length;
    cleaned = `${cleaned.slice(0, start)}${remainder.slice(headingOffset)}`;
  }
}

export function extractOpenCodeText(stdout) {
  const textParts = [];
  const fallbackLines = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (typeof event?.part?.text === "string") {
        textParts.push(event.part.text);
      } else if (event?.type === "text" && typeof event?.text === "string") {
        textParts.push(event.text);
      }
    } catch {
      fallbackLines.push(line);
    }
  }

  const text = textParts.length > 0 ? textParts.join("") : fallbackLines.join("\n").trim();
  return stripModelReasoning(text).replace(/[ \t]{2,}/g, " ").trim();
}

function appendOutput(output, chunk, maxChars = DEFAULT_MAX_PROCESS_OUTPUT_CHARS) {
  if (output.length >= maxChars) return output;
  return `${output}${String(chunk).slice(0, maxChars - output.length)}`;
}

export function runProcess(
  command,
  args,
  {
    cwd,
    input = "",
    timeoutMs = 30000,
    maxOutputChars = DEFAULT_MAX_PROCESS_OUTPUT_CHARS,
    env = process.env,
    platform = process.platform,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const needsShell = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const stopChild = () => {
      try {
        child.kill();
      } catch {}
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk, maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk, maxOutputChars);
    });
    child.stdout.on("error", (error) => {
      stopChild();
      settle(reject, error);
    });
    child.stderr.on("error", (error) => {
      stopChild();
      settle(reject, error);
    });
    child.on("error", (error) => {
      settle(reject, error);
    });
    child.on("close", (code) => {
      settle(resolve, { code, stdout, stderr, timedOut });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function normalizeReviewPaths(paths = [], pathApi = path) {
  if (!Array.isArray(paths)) return [];

  return paths
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes("\0")) throw new Error("paths must not contain NUL bytes");
      if (entry.startsWith(":")) throw new Error("paths must be literal relative paths");
      if (/[*?[\]]/.test(entry)) throw new Error("paths must be literal relative paths");
      if (pathApi.isAbsolute(entry) || path.win32.isAbsolute(entry) || path.posix.isAbsolute(entry)) {
        throw new Error("paths must be relative to cwd");
      }
      if (entry.split(/[\\/]+/).includes("..")) {
        throw new Error("paths must not escape cwd");
      }
      const normalized = pathApi.normalize(entry);
      if (normalized === ".." || normalized.startsWith(`..${pathApi.sep}`)) {
        throw new Error("paths must not escape cwd");
      }
      return normalized;
    });
}

function normalizeBaseRef(baseRef = "HEAD") {
  const ref = String(baseRef || "HEAD");
  if (ref.includes("\0") || /[\r\n]/.test(ref)) {
    throw new Error("base_ref must not contain control characters");
  }
  if (ref.startsWith("-")) {
    throw new Error("base_ref must not start with '-'");
  }
  if (ref.includes("..")) {
    throw new Error("base_ref must name one ref, not a range");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/.test(ref)) {
    throw new Error("base_ref contains unsupported characters");
  }
  return ref;
}

async function runGit(cwd, args, deps) {
  const result = await deps.runProcess("git", args, { cwd, timeoutMs: 30000, env: deps.env, platform: deps.platform });
  if (result.timedOut) throw new Error(`git ${args.join(" ")} timed out`);
  if (result.code !== 0) throw new Error(result.stderr || `git ${args.join(" ")} exited ${result.code}`);
  return result.stdout.trim();
}

async function collectGitSection(cwd, args, deps) {
  try {
    return { ok: true, output: await runGit(cwd, args, deps) };
  } catch {
    return { ok: false, output: "" };
  }
}

async function collectGitContext({ cwd, includeStatus, includeDiff, baseRef, paths, maxDiffChars, deps }) {
  const safePaths = normalizeReviewPaths(paths, deps.path);
  const pathspec = ["--", ...safePaths];
  let successfulCommands = 0;
  let status = "";

  if (includeStatus) {
    const statusResult = await collectGitSection(cwd, ["status", "--short"], deps);
    if (statusResult.ok) {
      successfulCommands += 1;
      status = statusResult.output;
    }
  }

  if (!includeDiff) {
    if (includeStatus && successfulCommands === 0) {
      throw new Error("Git status collection failed");
    }
    return { status, diff: "", diffTruncated: false };
  }

  const sections = [];
  for (const [heading, args] of [
    [`## git diff --stat ${baseRef}`, ["diff", "--stat", baseRef, ...pathspec]],
    [`## git diff ${baseRef}`, ["diff", baseRef, ...pathspec]],
    ["## git diff --cached --stat", ["diff", "--cached", "--stat", ...pathspec]],
    ["## git diff --cached", ["diff", "--cached", ...pathspec]],
  ]) {
    const section = await collectGitSection(cwd, args, deps);
    if (section.ok) successfulCommands += 1;
    sections.push(`${heading}\n${section.ok ? section.output : "[unavailable]"}`);
  }

  if (successfulCommands === 0) {
    throw new Error("Git context collection failed");
  }

  const maxChars = positiveNumber(maxDiffChars, DEFAULT_MAX_DIFF_CHARS);
  const combinedDiff = sections.join("\n\n");
  const sanitizedDiff = shouldRedactSecrets(deps.env) ? redactSensitiveText(combinedDiff) : combinedDiff;
  const truncated = truncateText(sanitizedDiff, maxChars);
  return { status, diff: truncated.text, diffTruncated: truncated.truncated };
}

function buildAdvisorPrompt({ question, goal, cwd, status, diff, diffTruncated, paths }) {
  return `## Codex -> OpenCode Advisor Review Request

You are running as codex-advisor, a read-only reviewer. Do not modify files, run shell commands, launch subagents, or change project state.

**Working directory:** ${cwd}
**Goal:** ${goal || "(not provided)"}
**Question:** ${question || "Review the current changes and provide a second-opinion code review."}
**Requested paths:** ${paths?.length ? paths.join(", ") : "(all changed paths)"}
**Diff truncated:** ${diffTruncated ? "yes" : "no"}

**Git status:**
\`\`\`
${status || "(empty)"}
\`\`\`

**Git diff context:**
\`\`\`diff
${diff || "(empty)"}
\`\`\`

Return concise Markdown with these sections:
1. Summary
2. Risks
3. Missed Tests
4. Recommendations

Reference specific files or diff hunks when possible. If context is insufficient, say exactly what is missing.`;
}

function buildPlannerPrompt({ question, goal, cwd, status, diff, diffTruncated, currentPlan, constraints, paths }) {
  const normalizedConstraints = Array.isArray(constraints) ? constraints.filter(Boolean) : [];

  return `## Codex -> OpenCode Planning Partner Request

You are running as codex-planning-partner, a read-only planning collaborator. You do not make final decisions, implement code, run shell commands, or change project state.

Your job is to strengthen an existing plan by identifying gaps, risks, ordering issues, missing validation, and scope creep.

**Working directory:** ${cwd}
**Goal:** ${goal || "(not provided)"}
**Question:** ${question || "Review and improve the current implementation plan."}
**Current plan draft:**
\`\`\`
${currentPlan || "(not provided)"}
\`\`\`
**Constraints:** ${normalizedConstraints.length > 0 ? normalizedConstraints.join("; ") : "(none provided)"}
**Requested paths:** ${paths?.length ? paths.join(", ") : "(all changed paths)"}
**Diff truncated:** ${diffTruncated ? "yes" : "no"}

**Git status:**
\`\`\`
${status || "(empty)"}
\`\`\`

**Git diff context:**
\`\`\`diff
${diff || "(empty)"}
\`\`\`

Return concise Markdown with these sections:
1. Summary
2. Missing Context
3. Risks
4. Suggested Adjustments
5. Validation Points
6. Scope Control
7. Verdict

You are a planning partner, not the final owner of the plan. Tighten and improve the existing direction instead of replacing it wholesale.`;
}

function getRoleDefaults(role) {
  if (role === "planner") {
    return {
      agentName: "codex-planning-partner",
      defaultIncludeDiff: false,
      defaultIncludeStatus: true,
      promptBuilder: buildPlannerPrompt,
      successBuilder: createPlannerSuccessResponse,
      successTextKey: "plannerText",
    };
  }

  return {
    agentName: "codex-advisor",
    defaultIncludeDiff: true,
    defaultIncludeStatus: true,
    promptBuilder: buildAdvisorPrompt,
    successBuilder: createSuccessResponse,
    successTextKey: "advisorText",
  };
}

function buildRuntime(deps = {}) {
  const runtime = {
    runProcess: deps.runProcess ?? runProcess,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    existsSync: deps.existsSync ?? existsSync,
  };
  runtime.path = deps.path ?? pathForPlatform(runtime.platform);
  runtime.realpath = deps.realpath
    ?? deps.runProcess?.realpath
    ?? deps.taskQueue?.realpath
    ?? fs.realpath;
  return runtime;
}

async function canonicalizeAllowedCwd(cwd, allowedRoots, runtime) {
  let canonicalCwd;
  try {
    canonicalCwd = await runtime.realpath(cwd);
  } catch {
    return null;
  }

  const canonicalRoots = (await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await runtime.realpath(root);
    } catch {
      return null;
    }
  }))).filter(Boolean);

  if (!isPathInsideAllowedRoots(canonicalCwd, canonicalRoots, runtime.path)) {
    return null;
  }

  return canonicalCwd;
}

export async function preflightOpenCodeTask(role, input = {}, deps = {}) {
  const runtime = buildRuntime(deps);
  const roleDefaults = getRoleDefaults(role);

  const requestedCwd = input.cwd || process.cwd();
  if (String(requestedCwd).includes("\0")) {
    return {
      ok: false,
      error: "invalid_cwd",
      message: INVALID_CWD_MESSAGE,
      details: {},
    };
  }

  const includeStatus = input.include_status ?? roleDefaults.defaultIncludeStatus;
  const includeDiff = input.include_diff ?? roleDefaults.defaultIncludeDiff;
  let baseRef;
  try {
    baseRef = normalizeBaseRef(input.base_ref);
  } catch (error) {
    return {
      ok: false,
      error: "invalid_paths",
      message: error.message,
      details: {},
    };
  }

  let paths;
  try {
    paths = normalizeReviewPaths(input.paths || [], runtime.path);
  } catch (error) {
    return {
      ok: false,
      error: "invalid_paths",
      message: error.message,
      details: {},
    };
  }

  const cwd = runtime.path.resolve(requestedCwd);
  const allowedRoots = parseAllowedRoots(undefined, runtime.env, runtime.path);
  const canonicalCwd = await canonicalizeAllowedCwd(cwd, allowedRoots, runtime);
  if (!canonicalCwd) {
    return {
      ok: false,
      error: "invalid_cwd",
      message: INVALID_CWD_MESSAGE,
      details: {},
    };
  }

  return {
    ok: true,
    normalized: {
      runtime,
      roleDefaults,
      cwd: canonicalCwd,
      includeStatus,
      includeDiff,
      baseRef,
      paths,
      timeoutMs: positiveNumber(runtime.env.OPENCODE_ADVISOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      maxDiffChars: positiveNumber(input.max_diff_chars ?? runtime.env.OPENCODE_ADVISOR_MAX_DIFF_CHARS, DEFAULT_MAX_DIFF_CHARS),
    },
  };
}

export async function runOpenCodeTaskNow(role, input = {}, deps = {}) {
  const preflight = await preflightOpenCodeTask(role, input, deps);
  if (!preflight.ok) {
    return preflight;
  }

  const {
    runtime,
    roleDefaults,
    cwd,
    includeStatus,
    includeDiff,
    baseRef,
    paths,
    timeoutMs,
    maxDiffChars,
  } = preflight.normalized;

  let context;
  try {
    context = await collectGitContext({ cwd, includeStatus, includeDiff, baseRef, paths, maxDiffChars, deps: runtime });
  } catch {
    return {
      ok: false,
      error: "git_failed",
      message: GIT_FAILED_MESSAGE,
      details: {},
    };
  }

  const prompt = roleDefaults.promptBuilder({
    question: input.question,
    goal: input.goal,
    cwd,
    status: context.status,
    diff: context.diff,
    diffTruncated: context.diffTruncated,
    currentPlan: input.current_plan,
    constraints: input.constraints,
    paths,
  });

  const opencodeCommand = resolveOpencodeCommand(runtime.env.OPENCODE_ADVISOR_OPENCODE_CMD || "opencode", {
    env: runtime.env,
    platform: runtime.platform,
    exists: runtime.existsSync,
  });

  let result;
  try {
    result = await runtime.runProcess(
      opencodeCommand,
      ["run", "--agent", roleDefaults.agentName, "--dir", cwd, "--format", "json"],
      { cwd, input: prompt, timeoutMs, env: runtime.env, platform: runtime.platform },
    );
  } catch {
    return {
      ok: false,
      error: "opencode_not_found",
      message: OPENCODE_NOT_FOUND_MESSAGE,
      details: {},
    };
  }

  if (outputHasAgentFallback(result.stdout, result.stderr)) {
    return {
      ok: false,
      error: "opencode_failed",
      message: `OpenCode could not find ${roleDefaults.agentName} and attempted to fall back to the default agent.`,
      details: {},
    };
  }

  if (result.timedOut) {
    return {
      ok: false,
      error: "timeout",
      message: `OpenCode advisor timed out after ${timeoutMs}ms`,
      details: {},
    };
  }

  if (result.code !== 0) {
    return {
      ok: false,
      error: "opencode_failed",
      message: `OpenCode exited with code ${result.code}`,
      details: {},
    };
  }

  const text = extractOpenCodeText(result.stdout);
  return roleDefaults.successBuilder({
    baseRef,
    status: context.status,
    diffTruncated: context.diffTruncated,
    [roleDefaults.successTextKey]: text,
    opencodeExitCode: result.code,
  });
}

export function runOpenCodeAdvisorNow(input = {}, deps = {}) {
  return runOpenCodeTaskNow("reviewer", input, deps);
}

export function runOpenCodePlannerNow(input = {}, deps = {}) {
  return runOpenCodeTaskNow("planner", input, deps);
}
