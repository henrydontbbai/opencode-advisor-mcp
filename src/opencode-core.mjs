import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

export function parseAllowedRoots(input, env = process.env, pathApi = path) {
  const source = input ?? env.OPENCODE_ADVISOR_ALLOWED_ROOTS ?? "";

  return source
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => pathApi.resolve(entry));
}

export function isPathInsideAllowedRoots(candidate, allowedRoots = parseAllowedRoots(), pathApi = path) {
  const resolved = pathApi.resolve(candidate);
  const caseInsensitive = pathApi.sep === "\\";
  const comparableResolved = caseInsensitive ? resolved.toLowerCase() : resolved;

  return allowedRoots.some((root) => {
    const rootResolved = pathApi.resolve(root);
    const comparableRoot = caseInsensitive ? rootResolved.toLowerCase() : rootResolved;
    const rootPrefix = comparableRoot.endsWith(pathApi.sep) ? comparableRoot : `${comparableRoot}${pathApi.sep}`;
    return comparableResolved === comparableRoot || comparableResolved.startsWith(rootPrefix);
  });
}

export function truncateText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`,
    truncated: true,
  };
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

export function runProcess(command, args, { cwd, input = "", timeoutMs = 30000, env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const needsShell = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      env,
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
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

async function collectGitContext({ cwd, includeStatus, includeDiff, baseRef, paths, maxDiffChars, deps }) {
  const safePaths = normalizeReviewPaths(paths, deps.path);
  const pathspec = ["--", ...safePaths];
  const status = includeStatus ? await runGit(cwd, ["status", "--short"], deps) : "";

  if (!includeDiff) {
    return { status, diff: "", diffTruncated: false };
  }

  const sections = [];
  sections.push(`## git diff --stat ${baseRef}\n${await runGit(cwd, ["diff", "--stat", baseRef, ...pathspec], deps)}`);
  sections.push(`## git diff ${baseRef}\n${await runGit(cwd, ["diff", baseRef, ...pathspec], deps)}`);
  sections.push(`## git diff --cached --stat\n${await runGit(cwd, ["diff", "--cached", "--stat", ...pathspec], deps)}`);
  sections.push(`## git diff --cached\n${await runGit(cwd, ["diff", "--cached", ...pathspec], deps)}`);

  const maxChars = positiveNumber(maxDiffChars, DEFAULT_MAX_DIFF_CHARS);
  const truncated = truncateText(sections.join("\n\n"), maxChars);
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
  return runtime;
}

export function preflightOpenCodeTask(role, input = {}, deps = {}) {
  const runtime = buildRuntime(deps);
  const roleDefaults = getRoleDefaults(role);

  const cwd = runtime.path.resolve(input.cwd || process.cwd());
  const allowedRoots = parseAllowedRoots(undefined, runtime.env, runtime.path);
  if (!isPathInsideAllowedRoots(cwd, allowedRoots, runtime.path)) {
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

  return {
    ok: true,
    normalized: {
      runtime,
      roleDefaults,
      cwd,
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
  const preflight = preflightOpenCodeTask(role, input, deps);
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
