import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOpenCodeChildEnv,
  buildOpenCodeOverlay,
  getAdvisorConfigFingerprint,
  getAdvisorProfilePaths,
  loadAdvisorProfile,
  redactAdvisorProviderValue,
  validateAdvisorConfig,
  writeAdvisorProfile,
} from "../src/provider-profile.mjs";
import { readProviderCredential, writeProviderCredential } from "../src/provider-credentials.mjs";

const RESPONSES_CONFIG = {
  version: 1,
  provider: {
    id: "advisor-provider",
    name: "Advisor Provider",
    base_url: "https://models.example.test/v1",
    transport: "responses",
    models: [
      { id: "reasoning-model", name: "Reasoning Model" },
      { id: "fast-model", name: "Fast Model" },
    ],
  },
  roles: {
    reviewer: { model: "reasoning-model" },
    planner: { model: "fast-model" },
  },
};

const BUNDLED_AGENT_TEMPLATES = {
  "codex-advisor.md": readFileSync(new URL("../agents/codex-advisor.md", import.meta.url), "utf8"),
  "codex-planning-partner.md": readFileSync(new URL("../agents/codex-planning-partner.md", import.meta.url), "utf8"),
};
const TEST_CREDENTIAL_PLATFORM = "linux";

function readTestCredential({ credentialPath, expectedManifestFingerprint }) {
  return readProviderCredential({
    credentialPath,
    expectedManifestFingerprint,
    platform: TEST_CREDENTIAL_PLATFORM,
  });
}

test("provider profile maps Responses to the native OpenAI SDK without storing a key", () => {
  const config = validateAdvisorConfig(RESPONSES_CONFIG);
  const overlay = JSON.parse(buildOpenCodeOverlay(config));

  assert.equal(overlay.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(overlay.enabled_providers, ["advisor-provider"]);
  assert.equal(overlay.provider["advisor-provider"].npm, "@ai-sdk/openai");
  assert.equal(overlay.provider["advisor-provider"].options.baseURL, "https://models.example.test/v1");
  assert.equal(overlay.provider["advisor-provider"].options.apiKey, "{env:OPENCODE_ADVISOR_PROVIDER_KEY}");
  assert.equal(JSON.stringify(overlay).includes("sk-"), false);
  assert.equal(config.roles.reviewer.model, "reasoning-model");
  assert.equal(config.roles.planner.model, "fast-model");
});

test("provider profile maps Chat Completions to the OpenAI-compatible SDK", () => {
  const config = validateAdvisorConfig({
    ...RESPONSES_CONFIG,
    provider: { ...RESPONSES_CONFIG.provider, transport: "chat_completions" },
  });
  const overlay = JSON.parse(buildOpenCodeOverlay(config));

  assert.equal(overlay.provider["advisor-provider"].npm, "@ai-sdk/openai-compatible");
  assert.equal(overlay.provider["advisor-provider"].options.apiKey, "{env:OPENCODE_ADVISOR_PROVIDER_KEY}");
});

test("provider profile accepts optional per-role OpenCode variants", () => {
  const config = validateAdvisorConfig({
    ...RESPONSES_CONFIG,
    roles: {
      reviewer: { model: "reasoning-model", variant: "high" },
      planner: { model: "fast-model", variant: "max" },
    },
  });

  assert.deepEqual(config.roles, {
    reviewer: { model: "reasoning-model", variant: "high" },
    planner: { model: "fast-model", variant: "max" },
  });
  const overlay = JSON.parse(buildOpenCodeOverlay(config));
  assert.deepEqual(overlay.provider["advisor-provider"].models["reasoning-model"].variants, {
    high: { reasoningEffort: "high" },
  });
  assert.deepEqual(overlay.provider["advisor-provider"].models["fast-model"].variants, {
    max: { reasoningEffort: "max" },
  });
});

test("provider profile preserves distinct variants when reviewer and planner share one model", () => {
  const config = validateAdvisorConfig({
    ...RESPONSES_CONFIG,
    provider: {
      ...RESPONSES_CONFIG.provider,
      models: [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol" }],
    },
    roles: {
      reviewer: { model: "gpt-5.6-sol", variant: "high" },
      planner: { model: "gpt-5.6-sol", variant: "max" },
    },
  });

  const overlay = JSON.parse(buildOpenCodeOverlay(config));

  assert.deepEqual(overlay.provider["advisor-provider"].models["gpt-5.6-sol"].variants, {
    high: { reasoningEffort: "high" },
    max: { reasoningEffort: "max" },
  });
});

test("provider redaction removes configured values from nested object keys and values", () => {
  const profile = { config: RESPONSES_CONFIG, credential: "provider-secret" };
  const sensitiveValues = [
    "provider-secret",
    "https://models.example.test/v1",
    "reasoning-model",
    "advisor-provider/reasoning-model",
  ];
  const redacted = redactAdvisorProviderValue(
    {
      [`provider-secret-${sensitiveValues[1]}`]: {
        [`advisor-provider/reasoning-model-key`]: "provider-secret reasoning-model",
      },
    },
    profile,
  );

  const serialized = JSON.stringify(redacted);
  for (const value of sensitiveValues) {
    assert.equal(serialized.includes(value), false, value);
  }
});

test("provider profile rejects URL credentials, query keys, and encoded control characters", () => {
  for (const baseUrl of [
    "https://user:pass@models.example.test/v1",
    "https://models.example.test/v1?api_key=secret",
    "https://models.example.test/v1%0Ainjected",
  ]) {
    assert.throws(
      () =>
        validateAdvisorConfig({
          ...RESPONSES_CONFIG,
          provider: { ...RESPONSES_CONFIG.provider, base_url: baseUrl },
        }),
      /provider\.base_url/i,
    );
  }
});

test("provider profile rejects undeclared manifest fields that could persist secrets or dynamic roles", () => {
  assert.throws(
    () =>
      validateAdvisorConfig({
        ...RESPONSES_CONFIG,
        provider: { ...RESPONSES_CONFIG.provider, api_key: "plaintext-secret" },
      }),
    /provider/i,
  );
  assert.throws(
    () =>
      validateAdvisorConfig({
        ...RESPONSES_CONFIG,
        roles: {
          ...RESPONSES_CONFIG.roles,
          implementer: { model: "reasoning-model" },
        },
      }),
    /roles/i,
  );
});

test("provider child environment isolates OpenCode settings and inherited credentials", () => {
  const config = validateAdvisorConfig(RESPONSES_CONFIG);
  const paths = getAdvisorProfilePaths(
    {
      OPENCODE_ADVISOR_HOME: "C:\\advisor-profile",
    },
    "win32",
  );
  const childEnv = buildOpenCodeChildEnv({
    config,
    paths,
    credential: "provider-secret",
    platform: "win32",
    env: {
      PATH: "C:\\Windows\\System32",
      USERPROFILE: "C:\\normal-profile",
      APPDATA: "C:\\normal-profile\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\normal-profile\\AppData\\Local",
      OPENAI_API_KEY: "normal-profile-key",
      ANTHROPIC_API_KEY: "other-provider-key",
      OPENAI_BASE_URL: "https://normal-openai.example.test/v1",
      THIRD_PARTY_ENDPOINT: "https://normal-third-party.example.test/v1",
      OPENCODE_CONFIG: "C:\\normal\\opencode.json",
      OPENCODE_CONFIG_CONTENT: '{"provider":{}}',
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      XDG_DATA_HOME: "C:\\normal\\data",
      CUSTOM_PROVIDER_KEY: "custom-provider-key",
      MY_KEY: "generic-key",
      NODE_OPTIONS: "--require untrusted-hook",
      NODE_PATH: "C:\\normal\\modules",
      LD_PRELOAD: "/tmp/untrusted.so",
      SAFE_VALUE: "kept",
    },
  });

  assert.equal(childEnv.PATH, "C:\\Windows\\System32");
  assert.equal(childEnv.SAFE_VALUE, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.OPENAI_BASE_URL, undefined);
  assert.equal(childEnv.THIRD_PARTY_ENDPOINT, undefined);
  assert.equal(childEnv.CUSTOM_PROVIDER_KEY, undefined);
  assert.equal(childEnv.MY_KEY, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.NODE_PATH, undefined);
  assert.equal(childEnv.LD_PRELOAD, undefined);
  assert.equal(childEnv.OPENCODE_CONFIG, paths.opencodeConfigPath);
  assert.equal(childEnv.OPENCODE_CONFIG_DIR, paths.opencodeConfigDir);
  assert.equal(childEnv.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(childEnv.XDG_CONFIG_HOME, paths.configHome);
  assert.equal(childEnv.XDG_DATA_HOME, paths.dataHome);
  assert.equal(childEnv.XDG_CACHE_HOME, paths.cacheHome);
  assert.equal(childEnv.XDG_STATE_HOME, paths.stateHome);
  assert.equal(childEnv.USERPROFILE, paths.home);
  assert.equal(childEnv.APPDATA, paths.configHome);
  assert.equal(childEnv.LOCALAPPDATA, paths.dataHome);
  assert.equal(childEnv.OPENCODE_ADVISOR_PROVIDER_KEY, "provider-secret");
  assert.equal(childEnv.OPENCODE_CONFIG_CONTENT.includes("provider-secret"), false);
});

test("provider setup writes only non-secret profile data and isolated agent templates", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-"));
  try {
    const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
    await writeAdvisorProfile({
      config: RESPONSES_CONFIG,
      paths,
      agentTemplates: {
        "codex-advisor.md": "reviewer template",
        "codex-planning-partner.md": "planner template",
      },
    });

    assert.deepEqual(JSON.parse(readFileSync(paths.manifestPath, "utf8")), RESPONSES_CONFIG);
    const opencodeConfig = readFileSync(paths.opencodeConfigPath, "utf8");
    assert.match(opencodeConfig, /@ai-sdk\/openai/);
    assert.match(opencodeConfig, /OPENCODE_ADVISOR_PROVIDER_KEY/);
    assert.equal(opencodeConfig.includes("provider-secret"), false);
    assert.equal(readFileSync(path.join(paths.agentsDir, "codex-advisor.md"), "utf8"), "reviewer template");
    assert.equal(readFileSync(path.join(paths.agentsDir, "codex-planning-partner.md"), "utf8"), "planner template");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider profile loading rejects a missing setup before any task can be queued", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-missing-"));
  try {
    await assert.rejects(
      () => loadAdvisorProfile({ env: { OPENCODE_ADVISOR_HOME: home } }),
      (error) => error?.code === "OPENCODE_ADVISOR_SETUP_REQUIRED",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider profile loading validates the manifest before exposing a decrypted credential", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-load-"));
  try {
    const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
    await writeAdvisorProfile({
      config: RESPONSES_CONFIG,
      paths,
      agentTemplates: BUNDLED_AGENT_TEMPLATES,
    });

    const profile = await loadAdvisorProfile({
      env: { OPENCODE_ADVISOR_HOME: home },
      readCredential: async ({ credentialPath }) => {
        assert.equal(credentialPath, paths.credentialPath);
        return "provider-secret";
      },
    });

    assert.deepEqual(profile.config, RESPONSES_CONFIG);
    assert.equal(profile.credential, "provider-secret");
    assert.equal(
      buildOpenCodeChildEnv({
        config: profile.config,
        paths: profile.paths,
        env: { OPENAI_API_KEY: "normal-profile-key" },
        includeCredential: false,
      }).OPENCODE_ADVISOR_PROVIDER_KEY,
      undefined,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider profile rejects an agent template changed after setup before decrypting the credential", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-agent-integrity-"));
  try {
    const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
    await writeAdvisorProfile({
      config: RESPONSES_CONFIG,
      paths,
      agentTemplates: BUNDLED_AGENT_TEMPLATES,
    });
    await writeProviderCredential({
      credentialPath: paths.credentialPath,
      credential: "provider-secret",
      manifestFingerprint: getAdvisorConfigFingerprint(RESPONSES_CONFIG),
      platform: TEST_CREDENTIAL_PLATFORM,
    });
    writeFileSync(
      path.join(paths.agentsDir, "codex-advisor.md"),
      '---\npermission:\n  "*": allow\n---\nmodified\n',
      "utf8",
    );

    let credentialRead = false;
    await assert.rejects(
      () =>
        loadAdvisorProfile({
          env: { OPENCODE_ADVISOR_HOME: home },
          readCredential: async () => {
            credentialRead = true;
            return "provider-secret";
          },
        }),
      (error) => error?.code === "OPENCODE_ADVISOR_SETUP_REQUIRED",
    );
    assert.equal(credentialRead, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider profile rejects a credential bound to a prior manifest or a stale OpenCode overlay", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-binding-"));
  const rotatedConfig = {
    ...RESPONSES_CONFIG,
    provider: {
      ...RESPONSES_CONFIG.provider,
      base_url: "https://rotated.example.test/v1",
    },
  };

  try {
    const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
    const agentTemplates = BUNDLED_AGENT_TEMPLATES;
    await writeAdvisorProfile({ config: RESPONSES_CONFIG, paths, agentTemplates });
    await writeProviderCredential({
      credentialPath: paths.credentialPath,
      credential: "old-provider-key",
      manifestFingerprint: getAdvisorConfigFingerprint(RESPONSES_CONFIG),
      platform: TEST_CREDENTIAL_PLATFORM,
    });

    await writeAdvisorProfile({ config: rotatedConfig, paths, agentTemplates });
    await assert.rejects(
      () => loadAdvisorProfile({ env: { OPENCODE_ADVISOR_HOME: home }, readCredential: readTestCredential }),
      (error) => error?.code === "OPENCODE_ADVISOR_SETUP_REQUIRED",
    );

    await writeProviderCredential({
      credentialPath: paths.credentialPath,
      credential: "rotated-provider-key",
      manifestFingerprint: getAdvisorConfigFingerprint(rotatedConfig),
      platform: TEST_CREDENTIAL_PLATFORM,
    });
    writeFileSync(paths.opencodeConfigPath, `${buildOpenCodeOverlay(RESPONSES_CONFIG)}\n`, "utf8");
    await assert.rejects(
      () => loadAdvisorProfile({ env: { OPENCODE_ADVISOR_HOME: home }, readCredential: readTestCredential }),
      (error) => error?.code === "OPENCODE_ADVISOR_SETUP_REQUIRED",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider profile accepts the OpenCode schema field added to an older generated overlay", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-schema-upgrade-"));
  try {
    const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
    await writeAdvisorProfile({
      config: RESPONSES_CONFIG,
      paths,
      agentTemplates: BUNDLED_AGENT_TEMPLATES,
    });
    await writeProviderCredential({
      credentialPath: paths.credentialPath,
      credential: "provider-secret",
      manifestFingerprint: getAdvisorConfigFingerprint(RESPONSES_CONFIG),
      platform: TEST_CREDENTIAL_PLATFORM,
    });

    const legacyOverlay = JSON.parse(buildOpenCodeOverlay(RESPONSES_CONFIG));
    delete legacyOverlay.$schema;
    writeFileSync(paths.opencodeConfigPath, `${JSON.stringify(legacyOverlay, null, 2)}\n`, "utf8");

    const loaded = await loadAdvisorProfile({
      env: { OPENCODE_ADVISOR_HOME: home },
      readCredential: readTestCredential,
    });
    assert.equal(loaded.config.provider.id, "advisor-provider");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "POSIX profile loading rejects writable profile artifacts",
  {
    skip: process.platform === "win32" ? "POSIX permission bits are not enforceable on Windows" : false,
  },
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "advisor-profile-permissions-"));
    try {
      const paths = getAdvisorProfilePaths({ OPENCODE_ADVISOR_HOME: home });
      const agentTemplates = BUNDLED_AGENT_TEMPLATES;
      await writeAdvisorProfile({ config: RESPONSES_CONFIG, paths, agentTemplates });
      await writeProviderCredential({
        credentialPath: paths.credentialPath,
        credential: "provider-secret",
        manifestFingerprint: getAdvisorConfigFingerprint(RESPONSES_CONFIG),
        platform: TEST_CREDENTIAL_PLATFORM,
      });
      chmodSync(paths.manifestPath, 0o644);

      await assert.rejects(
        () => loadAdvisorProfile({ env: { OPENCODE_ADVISOR_HOME: home } }),
        (error) => error?.code === "OPENCODE_ADVISOR_SETUP_REQUIRED",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
