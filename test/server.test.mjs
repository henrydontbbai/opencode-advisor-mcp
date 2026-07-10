import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  askOpenCodeAdvisor,
  askOpenCodePlanner,
  createServer,
  extractOpenCodeText,
  getOpenCodeTask,
  isPathInsideAllowedRoots,
  parseAllowedRoots,
  truncateText,
} from "../src/server.mjs";
import { DEFAULT_MAX_PROCESS_OUTPUT_CHARS, runProcess } from "../src/opencode-core.mjs";

const WINDOWS_ALLOWED_ROOT = "C:\\workspace\\repo-root";
const WINDOWS_CHILD_REPO = `${WINDOWS_ALLOWED_ROOT}\\project`;
const WINDOWS_REVIEW_ROOT = "C:\\workspace\\review-root";
const WINDOWS_REVIEW_CHILD = `${WINDOWS_REVIEW_ROOT}\\project`;
const WINDOWS_OTHER_PATH = "C:\\windows\\not-allowed.txt";
const tempDirs = new Set();
const PROCESS_FIXTURE = fileURLToPath(new URL("./fixtures/process-fixture.mjs", import.meta.url));

function createTempDir(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(directory);
  return directory;
}

function createDirectoryLink(target, linkPath) {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  tempDirs.clear();
});

function createMockRunProcess({ git = {}, opencode } = {}) {
  const calls = [];

  const runProcess = async (command, args, options = {}) => {
    calls.push({ command, args, options });

    if (command === "git") {
      const key = args.join(" ");
      if (git[key] instanceof Error) throw git[key];
      if (git[key]) return git[key];
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }

    if (opencode instanceof Error) throw opencode;
    if (opencode) return opencode;
    return {
      code: 0,
      stdout: JSON.stringify({ type: "text", part: { text: "Advisor OK" } }),
      stderr: "",
      timedOut: false,
    };
  };
  runProcess.realpath = async (candidate) => path.resolve(candidate);

  return { calls, runProcess };
}

function createStreamErrorSpawn(streamName) {
  return (...spawnArgs) => {
    const child = spawn(...spawnArgs);
    child[streamName].once("error", () => {});
    setTimeout(() => {
      child[streamName].destroy(new Error(`synthetic ${streamName} failure`));
    }, 10).unref?.();
    return child;
  };
}

test("parseAllowedRoots splits semicolon-separated Windows paths", () => {
  const roots = parseAllowedRoots("C:\\workspace\\repo-root; C:\\workspace\\allowed-roots ", {}, path.win32);
  assert.equal(roots.length, 2);
  assert.equal(path.win32.basename(roots[0]).toLowerCase(), "repo-root");
  assert.equal(path.win32.basename(roots[1]).toLowerCase(), "allowed-roots");
});

test("parseAllowedRoots preserves quoted Windows roots containing semicolons", () => {
  const roots = parseAllowedRoots('"C:\\workspace\\team;alpha"; C:\\workspace\\allowed-roots', {}, path.win32);

  assert.deepEqual(roots, [
    "C:\\workspace\\team;alpha",
    "C:\\workspace\\allowed-roots",
  ]);
});

test("parseAllowedRoots defaults to no allowed roots when env is unset", () => {
  assert.deepEqual(parseAllowedRoots(undefined, {}), []);
});

test("createServer rejects startup when allowed roots are not configured", () => {
  assert.throws(
    () => createServer({ env: {}, platform: "win32" }),
    /OPENCODE_ADVISOR_ALLOWED_ROOTS/i,
  );
});

test("isPathInsideAllowedRoots accepts child paths and rejects sibling prefixes", () => {
  const roots = parseAllowedRoots(WINDOWS_ALLOWED_ROOT, {}, path.win32);
  assert.equal(isPathInsideAllowedRoots(WINDOWS_CHILD_REPO, roots, path.win32), true);
  assert.equal(isPathInsideAllowedRoots("C:\\workspace\\repo-root-other", roots, path.win32), false);
});

test("isPathInsideAllowedRoots uses platform case sensitivity", () => {
  assert.equal(isPathInsideAllowedRoots("/tmp/REPO", ["/tmp/repo"], path.posix), false);
  assert.equal(isPathInsideAllowedRoots("C:\\WORKSPACE\\REPO-ROOT\\project", [WINDOWS_ALLOWED_ROOT], path.win32), true);
});

test("askOpenCodeAdvisor rejects a cwd that escapes an allowed root through a directory link", async () => {
  const fixtureDir = createTempDir("ocq-realpath-");
  const allowedRoot = path.join(fixtureDir, "allowed");
  const outsideRoot = path.join(fixtureDir, "outside");
  const linkPath = path.join(allowedRoot, "escape");
  mkdirSync(allowedRoot);
  mkdirSync(outsideRoot);
  createDirectoryLink(outsideRoot, linkPath);

  const { runProcess, calls } = createMockRunProcess();
  const result = await askOpenCodeAdvisor(
    { cwd: linkPath, include_diff: false, include_status: false },
    {
      runProcess,
      realpath,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: allowedRoot },
      platform: process.platform,
      useQueue: false,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_cwd");
  assert.equal(calls.length, 0);
});

test("askOpenCodeAdvisor accepts a real cwd inside an allowed root", async () => {
  const fixtureDir = createTempDir("ocq-realpath-");
  const allowedRoot = path.join(fixtureDir, "allowed");
  const childDir = path.join(allowedRoot, "child");
  mkdirSync(childDir, { recursive: true });

  const { runProcess, calls } = createMockRunProcess();
  const result = await askOpenCodeAdvisor(
    { cwd: childDir, include_diff: false, include_status: false },
    {
      runProcess,
      realpath,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: allowedRoot },
      platform: process.platform,
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.command === "opencode"), true);
});

test("askOpenCodeAdvisor rejects cwd values containing NUL bytes", async () => {
  const { runProcess, calls } = createMockRunProcess();
  const result = await askOpenCodeAdvisor(
    { cwd: `${process.cwd()}\0outside`, include_diff: false, include_status: false },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: process.cwd() },
      platform: process.platform,
      useQueue: false,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_cwd");
  assert.equal(calls.length, 0);
});

test("truncateText reports when text is truncated", () => {
  const result = truncateText("abcdef", 4);
  assert.deepEqual(result, { text: "[truncated: 6 chars omitted]", truncated: true });
});

test("truncateText preserves complete diff lines when truncating", () => {
  const text = "first line\nsecond line\nthird line";

  assert.deepEqual(truncateText(text, 15), {
    text: "first line\n\n[truncated: 22 chars omitted]",
    truncated: true,
  });
});

test("truncateText does not truncate invalid or boundary max values", () => {
  assert.deepEqual(truncateText("abcdef", 0), { text: "abcdef", truncated: false });
  assert.deepEqual(truncateText("abcdef", Number.NaN), { text: "abcdef", truncated: false });
  assert.deepEqual(truncateText("abcdef", 6), { text: "abcdef", truncated: false });
});

test("extractOpenCodeText reads final text from json event stream", () => {
  const stdout = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "text", part: { text: "First " } }),
    JSON.stringify({ type: "text", part: { text: "Second" } }),
    JSON.stringify({ type: "step_finish" }),
  ].join("\n");

  assert.equal(extractOpenCodeText(stdout), "First Second");
});

test("extractOpenCodeText removes model think blocks", () => {
  const stdout = JSON.stringify({
    type: "text",
    part: { text: "<think>private reasoning</think>\n## Summary\nOK" },
  });

  assert.equal(extractOpenCodeText(stdout), "## Summary\nOK");
});

test("extractOpenCodeText removes dangling think preambles before the final answer", () => {
  const stdout = JSON.stringify({
    type: "text",
    part: {
      text: "<think>\nprivate reasoning\n<think>\nmore reasoning\n## Summary\nOK",
    },
  });

  assert.equal(extractOpenCodeText(stdout), "## Summary\nOK");
});

test("extractOpenCodeText supports top-level text and mixed fallback lines", () => {
  const stdout = [
    "plain fallback",
    JSON.stringify({ type: "text", text: "Top level " }),
    JSON.stringify({ type: "text", part: { text: "<think>one</think>Visible<think>two</think> done" } }),
    "{not json",
  ].join("\n");

  assert.equal(extractOpenCodeText(stdout), "Top level Visible done");
});

test("runProcess preserves CRLF-delimited JSON when CRLF spans stdout chunks", async () => {
  const result = await runProcess(process.execPath, [PROCESS_FIXTURE, "json-crlf-chunks"], {
    timeoutMs: 1000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(extractOpenCodeText(result.stdout), "First Second");
});

test("runProcess rejects exactly once when a real child stdout stream errors before close", async () => {
  await assert.rejects(
    runProcess(process.execPath, [PROCESS_FIXTURE, "delay"], {
      timeoutMs: 1000,
      spawnImpl: createStreamErrorSpawn("stdout"),
    }),
    /synthetic stdout failure/,
  );
});

test("runProcess rejects exactly once when a real child stderr stream errors before close", async () => {
  await assert.rejects(
    runProcess(process.execPath, [PROCESS_FIXTURE, "delay"], {
      timeoutMs: 1000,
      spawnImpl: createStreamErrorSpawn("stderr"),
    }),
    /synthetic stderr failure/,
  );
});

test("runProcess reports timeouts after terminating a long-running fixture", async () => {
  const result = await runProcess(process.execPath, [PROCESS_FIXTURE, "slow"], {
    timeoutMs: 20,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});

test("runProcess bounds default captured stdout and stderr independently", async () => {
  const outputLength = DEFAULT_MAX_PROCESS_OUTPUT_CHARS + 128;
  const result = await runProcess(process.execPath, [PROCESS_FIXTURE, "large-output", String(outputLength)], {
    timeoutMs: 1000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "x".repeat(DEFAULT_MAX_PROCESS_OUTPUT_CHARS));
  assert.equal(result.stderr, "y".repeat(DEFAULT_MAX_PROCESS_OUTPUT_CHARS));
});

test("runProcess honors a smaller explicit output cap", async () => {
  const result = await runProcess(process.execPath, [PROCESS_FIXTURE, "large-output", "128"], {
    timeoutMs: 1000,
    maxOutputChars: 32,
  });

  assert.equal(result.code, 0);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout, "x".repeat(32));
  assert.equal(result.stderr, "y".repeat(32));
});

test("runProcess rejects a prompt write after the child exits", async () => {
  await assert.rejects(
    runProcess(process.execPath, [PROCESS_FIXTURE, "exit-immediately"], {
      input: "x".repeat(1024 * 1024),
      timeoutMs: 1000,
    }),
    /EPIPE|EOF|write after end/i,
  );
});

test("askOpenCodeAdvisor treats capped output as a failed OpenCode run", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: JSON.stringify({ type: "text", part: { text: "partial" } }),
      stderr: "",
      timedOut: false,
      outputTruncated: true,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
      useQueue: false,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.match(result.message, /output exceeded/i);
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor rejects cwd when allowed roots are not configured", async () => {
  const { runProcess, calls } = createMockRunProcess();
  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: {}, platform: "win32" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_cwd");
  assert.equal(result.message, "cwd is outside configured allowed roots");
  assert.deepEqual(result.details, {});
  assert.equal(calls.length, 0);
});

test("askOpenCodeAdvisor returns structured json for invalid review paths", async () => {
  const result = await askOpenCodeAdvisor(
    {
      cwd: WINDOWS_REVIEW_CHILD,
      paths: [WINDOWS_OTHER_PATH],
      include_diff: false,
      include_status: false,
    },
    {
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_REVIEW_ROOT },
      platform: "win32",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_paths");
});

test("askOpenCodeAdvisor rejects paths that escape cwd", async () => {
  for (const paths of [[".."], ["..\\outside.txt"], ["safe\0bad.txt"]]) {
    const result = await askOpenCodeAdvisor(
      {
        cwd: WINDOWS_CHILD_REPO,
        paths,
        include_diff: false,
        include_status: false,
      },
      {
        env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
        platform: "win32",
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_paths");
  }
});

test("askOpenCodeAdvisor rejects windows absolute paths on posix platform", async () => {
  const result = await askOpenCodeAdvisor(
    {
      cwd: "/repo",
      paths: [WINDOWS_OTHER_PATH],
      include_diff: false,
      include_status: false,
    },
    {
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
      platform: "linux",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_paths");
});

test("askOpenCodeAdvisor rejects git pathspec magic in review paths", async () => {
  for (const paths of [
    [":(top)package.json"],
    [":(glob)**/*.mjs"],
    [":!secret.txt"],
    ["*.mjs"],
    ["src/**"],
    ["docs/[abc].md"],
    ["foo?.js"],
  ]) {
    const result = await askOpenCodeAdvisor(
      {
        cwd: "/repo",
        paths,
        include_diff: false,
        include_status: false,
      },
      {
        env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
        platform: "linux",
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_paths");
  }
});

test("askOpenCodeAdvisor rejects option-like base refs before running git", async () => {
  const { runProcess, calls } = createMockRunProcess();

  const result = await askOpenCodeAdvisor(
    {
      cwd: WINDOWS_CHILD_REPO,
      base_ref: "--output=SHOULD_NOT_EXIST.txt",
    },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_paths");
  assert.match(result.message, /base_ref/);
  assert.equal(calls.length, 0);
});

test("askOpenCodeAdvisor rejects malformed base refs", async () => {
  for (const baseRef of ["main\nHEAD", "main\0HEAD", "main..HEAD"]) {
    const result = await askOpenCodeAdvisor(
      {
        cwd: WINDOWS_CHILD_REPO,
        base_ref: baseRef,
      },
      {
        env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
        platform: "win32",
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_paths");
  }
});

test("askOpenCodeAdvisor returns advisor text on mocked success path", async () => {
  const reviewPath = path.win32.normalize("src/server.mjs");
  const { runProcess, calls } = createMockRunProcess({
    git: {
      "status --short": { code: 0, stdout: " M src/server.mjs\n", stderr: "", timedOut: false },
      [`diff --stat main -- ${reviewPath}`]: { code: 0, stdout: " src/server.mjs | 1 +", stderr: "", timedOut: false },
      [`diff main -- ${reviewPath}`]: { code: 0, stdout: "diff --git a/src/server.mjs b/src/server.mjs", stderr: "", timedOut: false },
      [`diff --cached --stat -- ${reviewPath}`]: { code: 0, stdout: "", stderr: "", timedOut: false },
      [`diff --cached -- ${reviewPath}`]: { code: 0, stdout: "", stderr: "", timedOut: false },
    },
    opencode: {
      code: 0,
      stdout: JSON.stringify({ type: "text", part: { text: "Looks good" } }),
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    {
      cwd: WINDOWS_CHILD_REPO,
      base_ref: "main",
      paths: ["src/server.mjs"],
    },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal("cwd" in result, false);
  assert.equal(result.status, "M src/server.mjs");
  assert.equal(result.advisor_text, "Looks good");
  assert.equal(result.base_ref, "main");
  assert.equal("stderr_tail" in result, false);
  assert.deepEqual(
    calls.filter((call) => call.command === "git").map((call) => call.args),
    [
      ["status", "--short"],
      ["diff", "--stat", "main", "--", reviewPath],
      ["diff", "main", "--", reviewPath],
      ["diff", "--cached", "--stat", "--", reviewPath],
      ["diff", "--cached", "--", reviewPath],
    ],
  );
});

test("askOpenCodePlanner defaults to status-only context and returns planner text", async () => {
  const { runProcess, calls } = createMockRunProcess({
    git: {
      "status --short": { code: 0, stdout: " M docs/plan.md\n", stderr: "", timedOut: false },
    },
    opencode: {
      code: 0,
      stdout: JSON.stringify({ type: "text", part: { text: "Tighten scope and add validation." } }),
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodePlanner(
    {
      cwd: WINDOWS_CHILD_REPO,
      goal: "Refine next-step plan",
      question: "What is missing?",
      current_plan: "1. Add queue\n2. Add planner tool",
      constraints: ["Keep one MCP", "Do not add second MCP"],
    },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.planner_text, "Tighten scope and add validation.");
  assert.equal(result.status, "M docs/plan.md");
  assert.equal(result.diff_truncated, false);
  assert.deepEqual(
    calls.filter((call) => call.command === "git").map((call) => call.args),
    [["status", "--short"]],
  );
});

test("askOpenCodeAdvisor skips git commands when status and diff are disabled", async () => {
  const { runProcess, calls } = createMockRunProcess();

  const result = await askOpenCodeAdvisor(
    {
      cwd: WINDOWS_CHILD_REPO,
      include_diff: false,
      include_status: false,
    },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.command === "git").length, 0);
});

test("askOpenCodeAdvisor falls back to default timeout for invalid timeout env", async () => {
  const { runProcess, calls } = createMockRunProcess();

  const result = await askOpenCodeAdvisor(
    {
      cwd: WINDOWS_CHILD_REPO,
      include_diff: false,
      include_status: false,
    },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT, OPENCODE_ADVISOR_TIMEOUT_MS: "not-a-number" },
      platform: "win32",
      useQueue: false,
    },
  );

  const opencodeCall = calls.find((call) => call.command === "opencode");
  assert.equal(result.ok, true);
  assert.equal(opencodeCall.options.timeoutMs, 300000);
});

test("askOpenCodeAdvisor applies max diff chars from env", async () => {
  const { runProcess } = createMockRunProcess({
    git: {
      "status --short": { code: 0, stdout: "", stderr: "", timedOut: false },
      "diff --stat HEAD --": { code: 0, stdout: "abcdef", stderr: "", timedOut: false },
      "diff HEAD --": { code: 0, stdout: "ghijkl", stderr: "", timedOut: false },
      "diff --cached --stat --": { code: 0, stdout: "mnopqr", stderr: "", timedOut: false },
      "diff --cached --": { code: 0, stdout: "stuvwx", stderr: "", timedOut: false },
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: "/repo" },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo", OPENCODE_ADVISOR_MAX_DIFF_CHARS: "12" },
      platform: "linux",
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.diff_truncated, true);
});

test("askOpenCodeAdvisor redacts common secrets before sending diff context to OpenCode", async () => {
  const { runProcess, calls } = createMockRunProcess({
    git: {
      "status --short": { code: 0, stdout: " M .env\n", stderr: "", timedOut: false },
      "diff --stat HEAD --": { code: 0, stdout: " .env | 4 ++--", stderr: "", timedOut: false },
      "diff HEAD --": {
        code: 0,
        stdout: [
          "diff --git a/.env b/.env",
          "+++ b/.env",
          "+GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
          "+AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
          '+API_KEY="super-secret-value"',
          "+-----BEGIN PRIVATE KEY-----",
          "+line-one",
          "+line-two",
          "+-----END PRIVATE KEY-----",
        ].join("\n"),
        stderr: "",
        timedOut: false,
      },
      "diff --cached --stat --": { code: 0, stdout: "", stderr: "", timedOut: false },
      "diff --cached --": { code: 0, stdout: "", stderr: "", timedOut: false },
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: "/repo" },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
      platform: "linux",
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  const opencodeCall = calls.find((call) => call.command === "opencode");
  assert.equal(opencodeCall.options.input.includes("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), false);
  assert.equal(opencodeCall.options.input.includes("AKIA1234567890ABCDEF"), false);
  assert.equal(opencodeCall.options.input.includes("super-secret-value"), false);
  assert.equal(opencodeCall.options.input.includes("line-one"), false);
  assert.match(opencodeCall.options.input, /\[REDACTED_SECRET\]/);
});

test("askOpenCodeAdvisor preserves successful git context when one diff command fails", async () => {
  const { runProcess, calls } = createMockRunProcess({
    git: {
      "status --short": { code: 0, stdout: " M src/server.mjs\n", stderr: "", timedOut: false },
      "diff --stat main --": { code: 0, stdout: " src/server.mjs | 1 +", stderr: "", timedOut: false },
      "diff main --": { code: 1, stdout: "", stderr: "fatal: synthetic diff failure", timedOut: false },
      "diff --cached --stat --": { code: 0, stdout: " src/server.mjs | 2 ++", stderr: "", timedOut: false },
      "diff --cached --": { code: 0, stdout: "diff --git a/src/server.mjs b/src/server.mjs", stderr: "", timedOut: false },
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: "/repo", base_ref: "main" },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: "/repo" },
      platform: "linux",
      useQueue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "M src/server.mjs");
  const opencodeCall = calls.find((call) => call.command === "opencode");
  assert.match(opencodeCall.options.input, /## git diff --stat main\nsrc\/server\.mjs \| 1 \+/);
  assert.match(opencodeCall.options.input, /## git diff main\n\[unavailable\]/);
  assert.match(opencodeCall.options.input, /## git diff --cached\n/);
});

test("askOpenCodeAdvisor returns git_failed when git command fails", async () => {
  const { runProcess } = createMockRunProcess({
    git: {
      "status --short": { code: 1, stdout: "", stderr: `fatal: cannot access '${WINDOWS_CHILD_REPO}'`, timedOut: false },
      "diff --stat HEAD --": { code: 1, stdout: "", stderr: "fatal: synthetic diff failure", timedOut: false },
      "diff HEAD --": { code: 1, stdout: "", stderr: "fatal: synthetic diff failure", timedOut: false },
      "diff --cached --stat --": { code: 1, stdout: "", stderr: "fatal: synthetic diff failure", timedOut: false },
      "diff --cached --": { code: 1, stdout: "", stderr: "fatal: synthetic diff failure", timedOut: false },
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "git_failed");
  assert.equal(result.message, "Git context collection failed");
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor returns opencode_not_found when process spawn fails", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: new Error(`spawn ${WINDOWS_ALLOWED_ROOT}\\tools\\opencode.exe ENOENT`),
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_not_found");
  assert.equal(result.message, "OpenCode command could not be started");
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor returns timeout when opencode times out", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: { code: null, stdout: "partial", stderr: `${WINDOWS_CHILD_REPO}\\slow.log`, timedOut: true },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    {
      runProcess,
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT, OPENCODE_ADVISOR_TIMEOUT_MS: "10" },
      platform: "win32",
      useQueue: false,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
  assert.match(result.message, /10ms/);
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor returns opencode_failed for nonzero exit", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: { code: 2, stdout: `${WINDOWS_CHILD_REPO}\\stdout.txt`, stderr: `${WINDOWS_CHILD_REPO}\\stderr.txt`, timedOut: false },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.match(result.message, /code 2/);
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor does not treat advisor text mentioning fallback as agent fallback", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: JSON.stringify({
        type: "text",
        part: { text: "The phrase Falling back to default agent appears in docs." },
      }),
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, true);
  assert.match(result.advisor_text, /Falling back to default agent/);
});

test("askOpenCodeAdvisor detects agent fallback in structured diagnostics", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: JSON.stringify({ type: "log", message: 'agent "codex-advisor" not found' }),
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor detects agent fallback in structured stderr diagnostics", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: "",
      stderr: JSON.stringify({ type: "log", message: 'agent "codex-advisor" not found' }),
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor detects actual agent fallback in non-json process output", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: 'agent "codex-advisor" not found\nFalling back to default agent',
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.deepEqual(result.details, {});
});

test("askOpenCodeAdvisor ignores fallback phrases inside top-level assistant text events", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: JSON.stringify({ type: "text", text: "Falling back to default agent is mentioned in docs." }),
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, true);
  assert.match(result.advisor_text, /Falling back to default agent/);
});

test("askOpenCodeAdvisor ignores fallback phrases inside tool output events", async () => {
  const { runProcess } = createMockRunProcess({
    opencode: {
      code: 0,
      stdout: [
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              output: 'tool output mentioning "Falling back to default agent" should stay inert',
            },
          },
        }),
        JSON.stringify({ type: "text", part: { text: "Looks consistent" } }),
      ].join("\n"),
      stderr: "",
      timedOut: false,
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO, include_diff: false, include_status: false },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32", useQueue: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.advisor_text, "Looks consistent");
});

test("askOpenCodeAdvisor returns queued result when task stays pending", async () => {
  const taskQueue = {
    submitAndWait: async () => ({
      ok: false,
      error: "queued",
      message: "OpenCode task is queued or running, not failed. Keep this phase pending and call get_opencode_task later.",
      details: {
        task_id: "ocq_test",
        role: "reviewer",
        status: "queued",
        phase_pending: true,
        retry_after_ms: 30000,
        position: 2,
        limit_global: 4,
        limit_role: 2,
      },
    }),
  };

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO },
    {
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
      taskQueue,
      realpath: async (candidate) => candidate,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "queued");
  assert.equal(result.details.phase_pending, true);
  assert.equal(result.details.role, "reviewer");
});

test("getOpenCodeTask returns completed reviewer results from the task queue", async () => {
  const taskQueue = {
    getTaskResult: async () => ({
      ok: true,
      base_ref: "HEAD",
      status: "M src/server.mjs",
      diff_truncated: false,
      advisor_text: "Looks good",
      opencode_exit_code: 0,
    }),
  };

  const server = createServer({
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
    platform: "win32",
    taskQueue,
  });

  const taskResponse = await server._registeredTools.get_opencode_task.handler({
    task_id: "ocq_completedreviewer",
  });
  const taskResult = JSON.parse(taskResponse.content[0].text);
  assert.equal(taskResult.ok, true);
  assert.equal(taskResult.advisor_text, "Looks good");
});

test("getOpenCodeTask returns completed planner results from the task queue", async () => {
  const taskQueue = {
    getTaskResult: async () => ({
      ok: true,
      base_ref: "HEAD",
      status: "M docs/plan.md",
      diff_truncated: false,
      planner_text: "Tighten validation points.",
      opencode_exit_code: 0,
    }),
  };

  const server = createServer({
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
    platform: "win32",
    taskQueue,
  });

  const taskResponse = await server._registeredTools.get_opencode_task.handler({
    task_id: "ocq_completedplanner",
  });
  const taskResult = JSON.parse(taskResponse.content[0].text);
  assert.equal(taskResult.ok, true);
  assert.equal(taskResult.planner_text, "Tighten validation points.");
});

test("getOpenCodeTask returns a stable failure when queue mode is disabled", async () => {
  const result = await getOpenCodeTask(
    { task_id: "ocq_disabledqueue" },
    {
      env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
      platform: "win32",
      useQueue: false,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "opencode_failed");
  assert.match(result.message, /queue mode is disabled/i);
  assert.deepEqual(result.details, {});
});

test("createServer registers planner, advisor, and task tools with injected dependencies", async () => {
  const { runProcess } = createMockRunProcess();
  const taskQueue = {
    submitAndWait: async (task) => {
      if (task.role === "planner") {
        return {
          ok: true,
          base_ref: "HEAD",
          status: "",
          diff_truncated: false,
          planner_text: "Planner OK",
          opencode_exit_code: 0,
        };
      }
      return {
        ok: true,
        base_ref: "HEAD",
        status: "",
        diff_truncated: false,
        advisor_text: "Advisor OK",
        opencode_exit_code: 0,
      };
    },
    getTaskResult: async () => ({
      ok: false,
      error: "queued",
      message: "OpenCode task is queued or running, not failed. Keep this phase pending and call get_opencode_task later.",
      details: {
        task_id: "ocq_test",
        role: "planner",
        status: "queued",
        phase_pending: true,
        retry_after_ms: 30000,
        position: 1,
        limit_global: 4,
        limit_role: 2,
      },
    }),
  };

  const server = createServer({
    runProcess,
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
    platform: "win32",
    taskQueue,
  });

  assert.deepEqual(
    Object.keys(server._registeredTools),
    ["ask_opencode_advisor", "ask_opencode_planner", "get_opencode_task"],
  );

  const advisorResponse = await server._registeredTools.ask_opencode_advisor.handler({
    cwd: WINDOWS_CHILD_REPO,
    include_diff: false,
    include_status: false,
  });
  const advisorResult = JSON.parse(advisorResponse.content[0].text);
  assert.equal(advisorResult.ok, true);
  assert.equal(advisorResult.advisor_text, "Advisor OK");

  const plannerResponse = await server._registeredTools.ask_opencode_planner.handler({
    cwd: WINDOWS_CHILD_REPO,
    current_plan: "1. Queue\n2. Review",
  });
  const plannerResult = JSON.parse(plannerResponse.content[0].text);
  assert.equal(plannerResult.ok, true);
  assert.equal(plannerResult.planner_text, "Planner OK");

  const taskResponse = await server._registeredTools.get_opencode_task.handler({
    task_id: "ocq_test",
  });
  const taskResult = JSON.parse(taskResponse.content[0].text);
  assert.equal(taskResult.error, "queued");
  assert.equal(taskResult.details.task_id, "ocq_test");
});
