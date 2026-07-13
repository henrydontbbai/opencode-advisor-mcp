import test from "node:test";
import assert from "node:assert/strict";

import { runSetup } from "../bin/opencode-advisor-setup.mjs";

function captureStream() {
  let text = "";
  return {
    isTTY: true,
    write(chunk) {
      text += String(chunk);
    },
    get text() {
      return text;
    },
  };
}

function createInteractivePrompt(values) {
  const calls = [];
  return {
    calls,
    async ask({ field }) {
      calls.push({ field, hidden: false });
      return values[field];
    },
    async askHidden({ field }) {
      calls.push({ field, hidden: true });
      return values[field];
    },
    close() {},
  };
}

function createDependencies(overrides = {}) {
  const profileWrites = [];
  const credentialWrites = [];
  return {
    profileWrites,
    credentialWrites,
    getAdvisorConfigFingerprint() {
      return "a".repeat(43);
    },
    getAdvisorProfilePaths: () => ({
      home: "/private/advisor",
      credentialPath: "/private/advisor/provider-credential.json",
    }),
    async readFile(filePath) {
      return filePath.endsWith("codex-advisor.md") ? "reviewer template" : "planner template";
    },
    async writeAdvisorProfile(value) {
      profileWrites.push(value);
    },
    async writeProviderCredential(value) {
      credentialWrites.push(value);
    },
    ...overrides,
  };
}

test("setup writes a non-secret profile and passes the API key only to credential storage", async () => {
  const secret = "provider-secret-value";
  const stdout = captureStream();
  const stderr = captureStream();
  const prompt = createInteractivePrompt({
    providerId: "third-party",
    providerName: "Third Party API",
    baseUrl: "https://models.example.test/v1",
    transport: "responses",
    models: "reasoning-model, fast-model",
    reviewerModel: "reasoning-model",
    reviewerVariant: "high",
    plannerModel: "fast-model",
    plannerVariant: "max",
    apiKey: secret,
  });
  const dependencies = createDependencies();

  const result = await runSetup({
    argv: [],
    env: { OPENCODE_ADVISOR_HOME: "/private/advisor", OPENAI_API_KEY: "normal-profile-key" },
    platform: "linux",
    stdin: { isTTY: true },
    stdout,
    stderr,
    prompt,
    dependencies,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(stdout.text, "OpenCode Advisor profile configured.\n");
  assert.equal(stderr.text, "");
  assert.equal(stdout.text.includes(secret), false);
  assert.equal(stderr.text.includes(secret), false);
  assert.deepEqual(
    prompt.calls.map((call) => call.field),
    [
      "providerId",
      "providerName",
      "baseUrl",
      "transport",
      "models",
      "reviewerModel",
      "reviewerVariant",
      "plannerModel",
      "plannerVariant",
      "apiKey",
    ],
  );
  assert.deepEqual(prompt.calls.at(-1), { field: "apiKey", hidden: true });
  assert.equal(dependencies.profileWrites.length, 1);
  assert.deepEqual(dependencies.profileWrites[0].config, {
    version: 1,
    provider: {
      id: "third-party",
      name: "Third Party API",
      base_url: "https://models.example.test/v1",
      transport: "responses",
      models: [
        { id: "reasoning-model", name: "reasoning-model" },
        { id: "fast-model", name: "fast-model" },
      ],
    },
    roles: {
      reviewer: { model: "reasoning-model", variant: "high" },
      planner: { model: "fast-model", variant: "max" },
    },
  });
  assert.deepEqual(dependencies.profileWrites[0].agentTemplates, {
    "codex-advisor.md": "reviewer template",
    "codex-planning-partner.md": "planner template",
  });
  assert.deepEqual(dependencies.credentialWrites, [
    {
      credentialPath: "/private/advisor/provider-credential.json",
      credential: secret,
      manifestFingerprint: "a".repeat(43),
      platform: "linux",
    },
  ]);
  assert.equal(JSON.stringify(dependencies.profileWrites).includes(secret), false);
});

test("setup refuses non-interactive input without reading an API key from arguments, environment, or a pipe", async () => {
  const secret = "provider-secret-value";
  const stdout = captureStream();
  const stderr = captureStream();
  const dependencies = createDependencies({
    getAdvisorProfilePaths() {
      throw new Error("must not read the profile");
    },
  });

  const result = await runSetup({
    argv: ["--api-key", secret],
    env: { OPENCODE_ADVISOR_PROVIDER_KEY: secret, OPENAI_API_KEY: secret },
    stdin: { isTTY: false },
    stdout,
    stderr,
    prompt: {
      async ask() {
        throw new Error("must not prompt");
      },
      async askHidden() {
        throw new Error("must not prompt");
      },
    },
    dependencies,
  });

  assert.deepEqual(result, { ok: false, code: "non_interactive" });
  assert.equal(stdout.text, "");
  assert.equal(
    stderr.text,
    "OpenCode Advisor setup requires an interactive terminal. Run `opencode-advisor-setup` from a terminal to configure the provider.\n",
  );
  assert.equal(stderr.text.includes(secret), false);
  assert.equal(dependencies.profileWrites.length, 0);
  assert.equal(dependencies.credentialWrites.length, 0);
});

test("setup rejects API key command arguments before it prompts or writes a profile", async () => {
  const secret = "provider-secret-value";
  const stdout = captureStream();
  const stderr = captureStream();
  const dependencies = createDependencies();

  const result = await runSetup({
    argv: ["--api-key", secret],
    stdin: { isTTY: true },
    stdout,
    stderr,
    prompt: {
      async ask() {
        throw new Error("must not prompt");
      },
      async askHidden() {
        throw new Error("must not prompt");
      },
    },
    dependencies,
  });

  assert.deepEqual(result, { ok: false, code: "arguments_not_supported" });
  assert.equal(stdout.text, "");
  assert.equal(
    stderr.text,
    "OpenCode Advisor setup does not accept command-line configuration or credentials. Run `opencode-advisor-setup` interactively.\n",
  );
  assert.equal(stderr.text.includes(secret), false);
  assert.equal(dependencies.profileWrites.length, 0);
  assert.equal(dependencies.credentialWrites.length, 0);
});
