import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runOpenCodeAdvisorNow,
  runOpenCodePlannerNow,
} from "../src/opencode-core.mjs";
import { writeProviderCredential } from "../src/provider-credentials.mjs";
import {
  getAdvisorProfilePaths,
  getAdvisorConfigFingerprint,
  writeAdvisorProfile,
} from "../src/provider-profile.mjs";

const RUN_PROVIDER_CONTRACT = process.env.OPENCODE_ADVISOR_RUN_PROVIDER_CONTRACT === "1";
const OPT_IN_SKIP_REASON = "Set OPENCODE_ADVISOR_RUN_PROVIDER_CONTRACT=1 to run the local OpenCode provider contract.";
const PROVIDER_CREDENTIAL = "provider-contract-credential";
const MAX_REQUEST_BYTES = 1024 * 1024;

function installedOpenCodeCommand() {
  if (process.platform === "win32" && process.env.APPDATA) {
    const candidate = path.join(
      process.env.APPDATA,
      "npm",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (existsSync(candidate)) return candidate;
  }
  return "opencode";
}

function commandIsAvailable(command) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ["--version"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function writeSse(response, event, value) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function writeSseData(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function responseObject(id, text, status = "completed", error = null) {
  const output = status === "completed"
    ? [{
      id: "msg_contract",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }]
    : [];
  return {
    id,
    object: "response",
    created_at: 0,
    status,
    error,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "contract-model",
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    user: null,
    metadata: {},
  };
}

function sendResponsesSuccess(response, text) {
  const id = "resp_contract";
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(response, "response.created", {
    type: "response.created",
    response: responseObject(id, "", "in_progress"),
  });
  writeSse(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_contract", type: "message", status: "in_progress", role: "assistant", content: [] },
  });
  writeSse(response, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: "msg_contract",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  writeSse(response, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_contract",
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  writeSse(response, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: "msg_contract",
    output_index: 0,
    content_index: 0,
    text,
  });
  writeSse(response, "response.completed", {
    type: "response.completed",
    response: responseObject(id, text),
  });
  response.end();
}

function sendResponsesError(response, recordEvent) {
  const id = "resp_contract_error";
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const created = {
    type: "response.created",
    response: responseObject(id, "", "in_progress"),
  };
  const error = {
    type: "error",
    code: "fixture_error",
    message: "The local provider fixture rejected this stream.",
  };
  const failed = {
    type: "response.failed",
    response: responseObject(id, "", "failed", {
      code: "fixture_error",
      message: "The local provider fixture rejected this stream.",
    }),
  };
  for (const [event, value] of [
    ["response.created", created],
    ["error", error],
    ["response.failed", failed],
  ]) {
    recordEvent({ event, type: value.type });
    writeSse(response, event, value);
  }
  response.end();
}

function sendResponsesToolCall(response, recordEvent) {
  const id = "resp_contract_tool";
  const functionCall = {
    id: "fc_contract",
    type: "function_call",
    status: "in_progress",
    call_id: "call_contract",
    name: "read",
    arguments: "",
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const completedCall = { ...functionCall, status: "completed", arguments: "{}" };
  const completedResponse = responseObject(id, "");
  completedResponse.output = [completedCall];
  for (const [event, value] of [
    ["response.created", { type: "response.created", response: responseObject(id, "", "in_progress") }],
    ["response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: functionCall,
    }],
    ["response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 0,
      delta: "{}",
    }],
    ["response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: functionCall.id,
      output_index: 0,
      arguments: "{}",
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: completedCall,
    }],
    ["response.completed", { type: "response.completed", response: completedResponse }],
  ]) {
    recordEvent({ event, type: value.type });
    writeSse(response, event, value);
  }
  response.end();
}

function sendChatCompletionsSuccess(response, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSseData(response, {
    id: "chatcmpl_contract",
    object: "chat.completion.chunk",
    created: 0,
    model: "contract-model",
    choices: [{
      index: 0,
      delta: { role: "assistant", content: text },
      logprobs: null,
      finish_reason: null,
    }],
  });
  writeSseData(response, {
    id: "chatcmpl_contract",
    object: "chat.completion.chunk",
    created: 0,
    model: "contract-model",
    choices: [{
      index: 0,
      delta: {},
      logprobs: null,
      finish_reason: "stop",
    }],
  });
  response.end("data: [DONE]\n\n");
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("fixture request exceeded the size limit");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startProviderFixture({ transport, outcome }) {
  const observations = [];
  const responseEvents = [];
  let sentErrorSse = false;
  const expectedPath = transport === "responses" ? "/v1/responses" : "/v1/chat/completions";
  const successText = transport === "responses" ? "CONTRACT_RESPONSES_OK" : "CONTRACT_CHAT_COMPLETIONS_OK";

  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request);
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      observations.push({
        pathname,
        stream: body?.stream,
        model: typeof body?.model === "string" ? body.model : null,
        reasoningEffort: body?.reasoning?.effort ?? null,
        hasExpectedAuthorization: request.headers.authorization === `Bearer ${PROVIDER_CREDENTIAL}`,
      });

      if (request.method !== "POST" || pathname !== expectedPath) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Unexpected local fixture route." } }));
        return;
      }

      if (outcome === "error") {
        sentErrorSse = true;
        sendResponsesError(response, (event) => responseEvents.push(event));
        return;
      }

      if (outcome === "tool") {
        sendResponsesToolCall(response, (event) => responseEvents.push(event));
        return;
      }

      if (transport === "responses") {
        sendResponsesSuccess(response, successText);
      } else {
        sendChatCompletionsSuccess(response, successText);
      }
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid local fixture request." } }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("The local provider fixture did not bind a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
    observations,
    responseEvents,
    sentErrorSse: () => sentErrorSse,
    successText,
  };
}

async function createIndependentProfile({ baseUrl, transport, reviewerVariant, plannerVariant }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-advisor-provider-contract-"));
  const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
  const config = {
    version: 1,
    provider: {
      id: transport === "responses" ? "contract-responses" : "contract-chat",
      name: "Local Provider Contract",
      base_url: baseUrl,
      transport,
      models: [{ id: "contract-model", name: "Contract Model" }],
    },
    roles: {
      reviewer: { model: "contract-model", ...(reviewerVariant ? { variant: reviewerVariant } : {}) },
      planner: { model: "contract-model", ...(plannerVariant ? { variant: plannerVariant } : {}) },
    },
  };
  const agentTemplates = {
    "codex-advisor.md": await fs.readFile(new URL("../agents/codex-advisor.md", import.meta.url), "utf8"),
    "codex-planning-partner.md": await fs.readFile(new URL("../agents/codex-planning-partner.md", import.meta.url), "utf8"),
  };

  await writeAdvisorProfile({ config, paths, agentTemplates });
  await writeProviderCredential({
    credentialPath: paths.credentialPath,
    credential: PROVIDER_CREDENTIAL,
    manifestFingerprint: getAdvisorConfigFingerprint(config),
  });
  return { home, config };
}

function runtimeEnv({ home, cwd, timeoutMs = "60000" }) {
  return {
    ...process.env,
    OPENCODE_ADVISOR_HOME: home,
    OPENCODE_ADVISOR_ALLOWED_ROOTS: cwd,
    OPENCODE_ADVISOR_OPENCODE_CMD: installedOpenCodeCommand(),
    OPENCODE_ADVISOR_TIMEOUT_MS: timeoutMs,
    OPENCODE_CONFIG: path.join(home, "must-not-be-read.json"),
    XDG_CONFIG_HOME: path.join(home, "must-not-be-read-xdg"),
    OPENAI_API_KEY: "normal-profile-credential-must-not-be-used",
  };
}

async function withProviderContract(options, callback) {
  const fixture = await startProviderFixture(options);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-advisor-provider-contract-cwd-"));
  let profile;
  try {
    profile = await createIndependentProfile({
      baseUrl: fixture.baseUrl,
      transport: options.transport,
      reviewerVariant: options.reviewerVariant,
      plannerVariant: options.plannerVariant,
    });
    return await callback({
      fixture,
      config: profile.config,
      cwd,
      env: runtimeEnv({ home: profile.home, cwd, timeoutMs: options.timeoutMs }),
    });
  } finally {
    await fixture.close();
    await fs.rm(cwd, { recursive: true, force: true });
    if (profile?.home) await fs.rm(profile.home, { recursive: true, force: true });
  }
}

function assertFixtureRequest(fixture, expectedPath) {
  assert.equal(fixture.observations.some((request) => (
    request.pathname === expectedPath
      && request.stream === true
      && request.model === "contract-model"
      && request.hasExpectedAuthorization
  )), true);
}

async function requireInstalledOpenCode(t) {
  if (await commandIsAvailable(installedOpenCodeCommand())) return true;
  t.skip("The opt-in provider contract requires a locally installed OpenCode executable.");
  return false;
}

test("local Responses provider streams usable reviewer JSON output through an isolated profile", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({ transport: "responses", outcome: "success" }, async ({ fixture, config, cwd, env }) => {
    const result = await runOpenCodeAdvisorNow({
      cwd,
      include_status: false,
      include_diff: false,
      question: "Return the fixture completion text.",
    }, { env });

    assert.equal(result.ok, true);
    assert.equal(result.advisor_text.includes(fixture.successText), true);
    assertFixtureRequest(fixture, "/v1/responses");
    assert.equal(result.advisor_text.includes(PROVIDER_CREDENTIAL), false);
    assert.equal(config.provider.transport, "responses");
  });
});

test("local Responses provider forwards the reviewer reasoning variant", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({
    transport: "responses",
    outcome: "success",
    reviewerVariant: "high",
  }, async ({ fixture, cwd, env }) => {
    const result = await runOpenCodeAdvisorNow({
      cwd,
      include_status: false,
      include_diff: false,
      question: "Return the fixture completion text.",
    }, { env });

    assert.equal(result.ok, true);
    assertFixtureRequest(fixture, "/v1/responses");
    assert.equal(fixture.observations.at(-1).reasoningEffort, "high");
  });
});

test("local Responses provider forwards the planner reasoning variant", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({
    transport: "responses",
    outcome: "success",
    plannerVariant: "max",
  }, async ({ fixture, cwd, env }) => {
    const result = await runOpenCodePlannerNow({
      cwd,
      include_status: false,
      include_diff: false,
      current_plan: "Return the fixture completion text.",
    }, { env });

    assert.equal(result.ok, true);
    assertFixtureRequest(fixture, "/v1/responses");
    assert.equal(fixture.observations.at(-1).reasoningEffort, "max");
  });
});

test("local Responses provider preserves reviewer and planner variants in one shared-model profile", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({
    transport: "responses",
    outcome: "success",
    reviewerVariant: "high",
    plannerVariant: "max",
  }, async ({ fixture, cwd, env }) => {
    const reviewerResult = await runOpenCodeAdvisorNow({
      cwd,
      include_status: false,
      include_diff: false,
      question: "Return the fixture completion text.",
    }, { env });
    const plannerResult = await runOpenCodePlannerNow({
      cwd,
      include_status: false,
      include_diff: false,
      current_plan: "Return the fixture completion text.",
    }, { env });

    assert.equal(reviewerResult.ok, true);
    assert.equal(plannerResult.ok, true, JSON.stringify(plannerResult));
    assertFixtureRequest(fixture, "/v1/responses");
    const reasoningEfforts = fixture.observations
      .filter((request) => request.pathname === "/v1/responses")
      .map((request) => request.reasoningEffort);
    assert.equal(reasoningEfforts.includes("high"), true);
    assert.equal(reasoningEfforts.at(-1), "max");
  });
});

test("local Chat Completions provider streams usable planner JSON output through an isolated profile", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({ transport: "chat_completions", outcome: "success" }, async ({ fixture, config, cwd, env }) => {
    const result = await runOpenCodePlannerNow({
      cwd,
      include_status: false,
      include_diff: false,
      current_plan: "Return the fixture completion text.",
    }, { env });

    assert.equal(result.ok, true);
    assert.equal(result.planner_text.includes(fixture.successText), true);
    assertFixtureRequest(fixture, "/v1/chat/completions");
    assert.equal(result.planner_text.includes(PROVIDER_CREDENTIAL), false);
    assert.equal(config.provider.transport, "chat_completions");
  });
});

test("local Responses error SSE fails closed without returning the provider credential", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({ transport: "responses", outcome: "error" }, async ({ fixture, cwd, env }) => {
    const result = await runOpenCodeAdvisorNow({
      cwd,
      include_status: false,
      include_diff: false,
      question: "Return the fixture completion text.",
    }, { env });

    assert.equal(fixture.sentErrorSse(), true);
    assertFixtureRequest(fixture, "/v1/responses");
    assert.equal(fixture.responseEvents.some((event) => event.event === "error" && event.type === "error"), true);
    assert.equal(fixture.responseEvents.some((event) => event.event === "response.failed" && event.type === "response.failed"), true);
    assert.equal(result.ok, false);
    assert.equal(result.error, "opencode_failed");
    assert.equal(JSON.stringify(result).includes(PROVIDER_CREDENTIAL), false);
  });
});

test("local Responses tool-call SSE fails closed when the built-in agent denies tools", {
  skip: RUN_PROVIDER_CONTRACT ? false : OPT_IN_SKIP_REASON,
  timeout: 90000,
}, async (t) => {
  if (!(await requireInstalledOpenCode(t))) return;
  await withProviderContract({ transport: "responses", outcome: "tool", timeoutMs: "8000" }, async ({ fixture, cwd, env }) => {
    const result = await runOpenCodeAdvisorNow({
      cwd,
      include_status: false,
      include_diff: false,
      question: "Try the fixture tool call.",
    }, { env });

    assertFixtureRequest(fixture, "/v1/responses");
    assert.equal(
      fixture.responseEvents.some((event) => event.event === "response.function_call_arguments.delta"),
      true,
    );
    assert.equal(
      fixture.responseEvents.some((event) => event.event === "response.output_item.done"),
      true,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "timeout");
    assert.equal(JSON.stringify(result).includes(PROVIDER_CREDENTIAL), false);
  });
});
