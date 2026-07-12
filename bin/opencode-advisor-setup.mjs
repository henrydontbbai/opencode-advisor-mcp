#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  getAdvisorConfigFingerprint,
  getAdvisorProfilePaths,
  validateAdvisorConfig,
  writeAdvisorProfile,
} from "../src/provider-profile.mjs";
import { writeProviderCredential } from "../src/provider-credentials.mjs";

const NON_INTERACTIVE_MESSAGE = "OpenCode Advisor setup requires an interactive terminal. Run `opencode-advisor-setup` from a terminal to configure the provider.\n";
const ARGUMENTS_MESSAGE = "OpenCode Advisor setup does not accept command-line configuration or credentials. Run `opencode-advisor-setup` interactively.\n";
const SETUP_FAILED_MESSAGE = "OpenCode Advisor setup could not complete. Check the entered provider settings and try again.\n";
const SETUP_SUCCESS_MESSAGE = "OpenCode Advisor profile configured.\n";

const binDirectory = path.dirname(fileURLToPath(import.meta.url));
const agentTemplatePaths = {
  "codex-advisor.md": path.join(binDirectory, "..", "agents", "codex-advisor.md"),
  "codex-planning-partner.md": path.join(binDirectory, "..", "agents", "codex-planning-partner.md"),
};

const defaultDependencies = {
  getAdvisorConfigFingerprint,
  getAdvisorProfilePaths,
  validateAdvisorConfig,
  writeAdvisorProfile,
  writeProviderCredential,
  readFile,
};

function cleanInput(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseModels(value) {
  const source = cleanInput(value);
  if (!source) throw new Error("No provider models were supplied.");
  const models = source.split(",").map((model) => model.trim());
  if (models.some((model) => !model)) throw new Error("Provider model entries must not be empty.");
  return models.map((id) => ({ id, name: id }));
}

function buildConfig(answers, validateConfig) {
  const reviewerVariant = cleanInput(answers.reviewerVariant);
  const plannerVariant = cleanInput(answers.plannerVariant);
  const config = {
    version: 1,
    provider: {
      id: cleanInput(answers.providerId),
      name: cleanInput(answers.providerName),
      base_url: cleanInput(answers.baseUrl),
      transport: cleanInput(answers.transport),
      models: parseModels(answers.models),
    },
    roles: {
      reviewer: {
        model: cleanInput(answers.reviewerModel),
        ...(reviewerVariant ? { variant: reviewerVariant } : {}),
      },
      planner: {
        model: cleanInput(answers.plannerModel),
        ...(plannerVariant ? { variant: plannerVariant } : {}),
      },
    },
  };
  return validateConfig(config);
}

function createTerminalPrompt({ stdin, stdout }) {
  const readline = createInterface({ input: stdin, output: stdout, terminal: true });
  return {
    async ask({ label }) {
      return readline.question(`${label}: `);
    },
    async askHidden({ label }) {
      const originalWriteToOutput = readline._writeToOutput;
      readline._writeToOutput = (value) => {
        if (value === "\n" || value === "\r\n") stdout.write(value);
      };
      try {
        stdout.write(`${label}: `);
        return await readline.question("");
      } finally {
        readline._writeToOutput = originalWriteToOutput;
      }
    },
    close() {
      readline.close();
    },
  };
}

async function ask(prompt, field, label) {
  if (!prompt || typeof prompt.ask !== "function") {
    throw new Error("Interactive prompt is unavailable.");
  }
  return prompt.ask({ field, label });
}

async function askHidden(prompt, field, label) {
  if (!prompt || typeof prompt.askHidden !== "function") {
    throw new Error("Hidden interactive prompt is unavailable.");
  }
  return prompt.askHidden({ field, label });
}

async function readAgentTemplates(readTemplate) {
  const entries = await Promise.all(
    Object.entries(agentTemplatePaths).map(async ([name, filePath]) => {
      const content = await readTemplate(filePath, "utf8");
      return [name, typeof content === "string" ? content : String(content)];
    }),
  );
  return Object.fromEntries(entries);
}

function writeFailure(stderr, message, code) {
  stderr.write(message);
  return { ok: false, code };
}

export async function runSetup({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  prompt,
  dependencies = {},
} = {}) {
  if (stdin?.isTTY !== true || stdout?.isTTY !== true) {
    return writeFailure(stderr, NON_INTERACTIVE_MESSAGE, "non_interactive");
  }
  if (!Array.isArray(argv) || argv.length > 0) {
    return writeFailure(stderr, ARGUMENTS_MESSAGE, "arguments_not_supported");
  }

  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  const interactivePrompt = prompt ?? createTerminalPrompt({ stdin, stdout });
  try {
    const answers = {
      providerId: await ask(interactivePrompt, "providerId", "Provider ID"),
      providerName: await ask(interactivePrompt, "providerName", "Provider name"),
      baseUrl: await ask(interactivePrompt, "baseUrl", "Provider API base URL"),
      transport: await ask(interactivePrompt, "transport", "Transport (responses or chat_completions)"),
      models: await ask(interactivePrompt, "models", "Model IDs (comma separated)"),
      reviewerModel: await ask(interactivePrompt, "reviewerModel", "Reviewer model ID"),
      reviewerVariant: await ask(interactivePrompt, "reviewerVariant", "Reviewer reasoning variant (optional, e.g. high)"),
      plannerModel: await ask(interactivePrompt, "plannerModel", "Planner model ID"),
      plannerVariant: await ask(interactivePrompt, "plannerVariant", "Planner reasoning variant (optional, e.g. max)"),
      apiKey: await askHidden(interactivePrompt, "apiKey", "Provider API key"),
    };
    const credential = cleanInput(answers.apiKey);
    if (!credential) throw new Error("Provider API key is required.");

    const config = buildConfig(answers, resolvedDependencies.validateAdvisorConfig);
    const paths = resolvedDependencies.getAdvisorProfilePaths(env, platform);
    const agentTemplates = await readAgentTemplates(resolvedDependencies.readFile);
    await resolvedDependencies.writeAdvisorProfile({ config, paths, agentTemplates, platform });
    await resolvedDependencies.writeProviderCredential({
      credentialPath: paths.credentialPath,
      credential,
      manifestFingerprint: resolvedDependencies.getAdvisorConfigFingerprint(config),
      platform,
    });
    stdout.write(SETUP_SUCCESS_MESSAGE);
    return { ok: true };
  } catch {
    return writeFailure(stderr, SETUP_FAILED_MESSAGE, "setup_failed");
  } finally {
    interactivePrompt.close?.();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await runSetup();
  if (!result.ok) process.exitCode = 1;
}
