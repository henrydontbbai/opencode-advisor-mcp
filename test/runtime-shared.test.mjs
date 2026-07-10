import test from "node:test";
import assert from "node:assert/strict";
import {
  createSuccessResponse,
  outputHasAgentFallback,
  outputHasUpstreamUnavailable,
  positiveNumber,
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

test("positiveNumber accepts only strict positive numeric configuration values", () => {
  assert.equal(positiveNumber("12", 7), 12);
  assert.equal(positiveNumber(" 12", 7), 7);
  assert.equal(positiveNumber(true, 7), 7);
  assert.equal(positiveNumber("0x10", 7), 7);
});

test("valueHasPattern safely traverses circular diagnostic values", () => {
  const circular = { message: "needle" };
  circular.self = circular;
  assert.equal(valueHasPattern(circular, /needle/i), true);

  const noMatch = {};
  noMatch.self = noMatch;
  assert.equal(valueHasPattern(noMatch, /needle/i), false);
});
