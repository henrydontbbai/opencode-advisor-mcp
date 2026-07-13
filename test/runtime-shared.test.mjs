import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlannerSuccessResponse,
  createSuccessResponse,
  getOpencodeFallbackCommands,
  isSensitiveEnvironmentName,
  outputHasAgentFallback,
  outputHasUpstreamUnavailable,
  PLANNER_SUCCESS_RESPONSE_KEYS,
  positiveNumber,
  resolveOpencodeCommand,
  resolveOpencodeCommands,
  SUCCESS_RESPONSE_KEYS,
  valueHasPattern,
} from "../src/runtime-shared.mjs";

test("createSuccessResponse returns the canonical public success shape", () => {
  const result = createSuccessResponse({
    baseRef: "HEAD",
    status: "M src/server.mjs",
    diffTruncated: false,
    advisorText: "Looks good",
    opencodeExitCode: 0,
  });

  assert.deepEqual(Object.keys(result), SUCCESS_RESPONSE_KEYS);
  assert.deepEqual(result, {
    ok: true,
    base_ref: "HEAD",
    status: "M src/server.mjs",
    diff_truncated: false,
    advisor_text: "Looks good",
    opencode_exit_code: 0,
  });
});

test("createPlannerSuccessResponse returns the canonical public success shape", () => {
  const result = createPlannerSuccessResponse({
    baseRef: "HEAD",
    status: "M docs/plan.md",
    diffTruncated: true,
    plannerText: "Tighten the validation gate.",
    opencodeExitCode: 0,
  });

  assert.deepEqual(Object.keys(result), PLANNER_SUCCESS_RESPONSE_KEYS);
  assert.deepEqual(result, {
    ok: true,
    base_ref: "HEAD",
    status: "M docs/plan.md",
    diff_truncated: true,
    planner_text: "Tighten the validation gate.",
    opencode_exit_code: 0,
  });
});

test("positiveNumber accepts only finite positive decimal values", () => {
  const fallback = 42;

  for (const value of [0, -1, Number.NaN, Infinity, "0", "-1", "not-a-number", null, undefined]) {
    assert.equal(positiveNumber(value, fallback), fallback, String(value));
  }
  assert.equal(positiveNumber(2.5, fallback), 2.5);
  assert.equal(positiveNumber("12.5", fallback), 12.5);
});

test("outputHasAgentFallback ignores fallback phrases inside assistant text events", () => {
  const stdout = JSON.stringify({
    type: "text",
    part: { text: "The phrase Falling back to default agent appears in docs." },
  });

  assert.equal(outputHasAgentFallback(stdout, ""), false);
});

test("outputHasAgentFallback detects structured diagnostics", () => {
  const stdout = JSON.stringify({
    type: "log",
    message: 'agent "codex-advisor" not found',
  });

  assert.equal(outputHasAgentFallback(stdout, ""), true);
});

test("outputHasUpstreamUnavailable ignores upstream phrases inside assistant text events", () => {
  const stdout = JSON.stringify({
    type: "text",
    part: { text: "The docs mention upstream service temporarily unavailable." },
  });

  assert.equal(outputHasUpstreamUnavailable(stdout, ""), false);
});

test("outputHasUpstreamUnavailable detects structured diagnostics", () => {
  const stderr = JSON.stringify({
    type: "error",
    message: "upstream service temporarily unavailable",
  });

  assert.equal(outputHasUpstreamUnavailable("", stderr), true);
});

test("sensitive environment detection rejects generic credentials and runtime injection", () => {
  for (const name of [
    "CUSTOM_PROVIDER_KEY",
    "MY_KEY",
    "OPENCODE_ADVISOR_PROVIDER_KEY",
    "OPENAI_API_KEY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "XDG_CONFIG_HOME",
  ]) {
    assert.equal(isSensitiveEnvironmentName(name), true, name);
  }

  for (const name of ["PATH", "Path", "SystemRoot", "SAFE_VALUE"]) {
    assert.equal(isSensitiveEnvironmentName(name), false, name);
  }
});

test("custom OpenCode commands must be absolute executables and Windows fallbacks are executable files", () => {
  assert.throws(
    () => resolveOpencodeCommand("opencode --unsafe", { platform: "win32", exists: () => true }),
    /absolute/i,
  );
  assert.throws(
    () => resolveOpencodeCommand("C:\\tools\\opencode.cmd", { platform: "win32", exists: () => true }),
    /\.exe/i,
  );
  assert.throws(
    () => resolveOpencodeCommand("C:\\tools\\opencode.exe", { platform: "win32", exists: () => false }),
    /existing/i,
  );
  assert.equal(
    resolveOpencodeCommand("C:\\Program Files\\OpenCode\\opencode.exe", {
      platform: "win32",
      exists: () => true,
      isFile: () => true,
    }),
    "C:\\Program Files\\OpenCode\\opencode.exe",
  );

  assert.throws(
    () =>
      resolveOpencodeCommand("C:\\tools\\opencode.exe", {
        platform: "win32",
        exists: () => true,
        isFile: () => false,
      }),
    /existing/i,
  );

  const fallback = "C:\\Users\\codex\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  assert.deepEqual(
    getOpencodeFallbackCommands({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\codex\\AppData\\Roaming" },
      exists: (candidate) => candidate === fallback,
      isFile: (candidate) => candidate === fallback,
    }),
    [fallback],
  );
});

test("Windows default command resolution chooses the first absolute PATH executable without cwd entries", () => {
  const first = "C:\\tools-first\\opencode.exe";
  const second = "C:\\tools-second\\opencode.exe";
  const fallback = "C:\\Users\\codex\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const checkedCandidates = [];

  const commands = resolveOpencodeCommands("opencode", {
    platform: "win32",
    env: {
      Path: "C:\\tools-first;.;relative-tools;C:\\tools-second",
      APPDATA: "C:\\Users\\codex\\AppData\\Roaming",
    },
    exists: (candidate) => {
      checkedCandidates.push(candidate);
      return [first, second, fallback].includes(candidate);
    },
    isFile: (candidate) => [first, second, fallback].includes(candidate),
  });

  assert.deepEqual(commands, [first, fallback]);
  assert.equal(checkedCandidates.includes("opencode.exe"), false);
  assert.equal(checkedCandidates.includes("opencode.com"), false);
});

test("Windows PATH resolution skips directory-like executable candidates", () => {
  const directoryCandidate = "C:\\tools-first\\opencode.exe";
  const fileCandidate = "C:\\tools-second\\opencode.exe";

  const commands = resolveOpencodeCommands("opencode", {
    platform: "win32",
    env: { PATH: "C:\\tools-first;C:\\tools-second" },
    exists: (candidate) => [directoryCandidate, fileCandidate].includes(candidate),
    isFile: (candidate) => candidate === fileCandidate,
  });

  assert.deepEqual(commands, [fileCandidate]);
});

test("Windows PATH resolution uses Path when PATH is empty", () => {
  const command = "C:\\tools\\opencode.exe";

  const commands = resolveOpencodeCommands("opencode", {
    platform: "win32",
    env: {
      PATH: "",
      Path: "C:\\tools",
    },
    exists: (candidate) => candidate === command,
    isFile: (candidate) => candidate === command,
  });

  assert.deepEqual(commands, [command]);
});
