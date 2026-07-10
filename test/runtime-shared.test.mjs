import test from "node:test";
import assert from "node:assert/strict";
import {
  createSuccessResponse,
  getOpencodeFallbackCommands,
  outputHasAgentFallback,
  outputHasUpstreamUnavailable,
  resolveOpencodeCommand,
  SUCCESS_RESPONSE_KEYS,
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

test("resolveOpencodeCommand rejects custom commands that are not absolute existing executables", () => {
  assert.throws(
    () => resolveOpencodeCommand("opencode --unsafe", {
      platform: "win32",
      exists: () => true,
    }),
    /absolute/i,
  );
  assert.throws(
    () => resolveOpencodeCommand("C:\\tools\\opencode.cmd", {
      platform: "win32",
      exists: () => true,
    }),
    /\.exe/i,
  );
  assert.throws(
    () => resolveOpencodeCommand("C:\\tools\\opencode.exe", {
      platform: "win32",
      exists: () => false,
    }),
    /existing/i,
  );
  assert.equal(
    resolveOpencodeCommand("C:\\Program Files\\OpenCode\\opencode.exe", {
      platform: "win32",
      exists: () => true,
    }),
    "C:\\Program Files\\OpenCode\\opencode.exe",
  );
});

test("getOpencodeFallbackCommands only returns existing Windows installation candidates", () => {
  const fallback = "C:\\Users\\codex\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  assert.deepEqual(
    getOpencodeFallbackCommands({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\codex\\AppData\\Roaming" },
      exists: (candidate) => candidate === fallback,
    }),
    [fallback],
  );
  assert.deepEqual(
    getOpencodeFallbackCommands({
      platform: "linux",
      env: { APPDATA: "C:\\Users\\codex\\AppData\\Roaming" },
      exists: () => true,
    }),
    [],
  );
});
