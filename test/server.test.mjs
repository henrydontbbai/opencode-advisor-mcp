import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  askOpenCodeAdvisor,
  createServer,
  extractOpenCodeText,
  isPathInsideAllowedRoots,
  parseAllowedRoots,
  truncateText,
} from "../src/server.mjs";

const WINDOWS_ALLOWED_ROOT = "C:\\workspace\\repo-root";
const WINDOWS_CHILD_REPO = `${WINDOWS_ALLOWED_ROOT}\\project`;
const WINDOWS_REVIEW_ROOT = "C:\\workspace\\review-root";
const WINDOWS_REVIEW_CHILD = `${WINDOWS_REVIEW_ROOT}\\project`;
const WINDOWS_OTHER_PATH = "C:\\windows\\not-allowed.txt";

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

  return { calls, runProcess };
}

test("parseAllowedRoots splits semicolon-separated Windows paths", () => {
  const roots = parseAllowedRoots("C:\\workspace\\repo-root; C:\\workspace\\allowed-roots ", {}, path.win32);
  assert.equal(roots.length, 2);
  assert.equal(path.win32.basename(roots[0]).toLowerCase(), "repo-root");
  assert.equal(path.win32.basename(roots[1]).toLowerCase(), "allowed-roots");
});

test("parseAllowedRoots defaults to no allowed roots when env is unset", () => {
  assert.deepEqual(parseAllowedRoots(undefined, {}), []);
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

test("truncateText reports when text is truncated", () => {
  const result = truncateText("abcdef", 4);
  assert.deepEqual(result, { text: "abcd\n\n[truncated: 2 chars omitted]", truncated: true });
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
    },
  );

  const opencodeCall = calls.find((call) => call.command === "opencode");
  assert.equal(result.ok, true);
  assert.equal(opencodeCall.options.timeoutMs, 120000);
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
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.diff_truncated, true);
});

test("askOpenCodeAdvisor returns git_failed when git command fails", async () => {
  const { runProcess } = createMockRunProcess({
    git: {
      "status --short": { code: 1, stdout: "", stderr: `fatal: cannot access '${WINDOWS_CHILD_REPO}'`, timedOut: false },
    },
  });

  const result = await askOpenCodeAdvisor(
    { cwd: WINDOWS_CHILD_REPO },
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
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
    { runProcess, env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT }, platform: "win32" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.advisor_text, "Looks consistent");
});

test("createServer registers advisor tool with injected dependencies", async () => {
  const { runProcess } = createMockRunProcess();
  const server = createServer({
    runProcess,
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: WINDOWS_ALLOWED_ROOT },
    platform: "win32",
  });

  assert.deepEqual(Object.keys(server._registeredTools), ["ask_opencode_advisor"]);

  const response = await server._registeredTools.ask_opencode_advisor.handler({
    cwd: WINDOWS_CHILD_REPO,
    include_diff: false,
    include_status: false,
  });
  const result = JSON.parse(response.content[0].text);

  assert.equal(result.ok, true);
  assert.equal(result.advisor_text, "Advisor OK");
  assert.equal("cwd" in result, false);
});
