import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readProviderCredential } from "./provider-credentials.mjs";
import { isSensitiveEnvironmentName } from "./runtime-shared.mjs";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_ID_MAX_LENGTH = 256;
const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const AGENT_TEMPLATE_FILENAMES = Object.freeze([
  "codex-advisor.md",
  "codex-planning-partner.md",
]);
const BUNDLED_AGENT_TEMPLATE_URLS = Object.freeze(
  Object.fromEntries(
    AGENT_TEMPLATE_FILENAMES.map((filename) => [filename, new URL(`../agents/${filename}`, import.meta.url)]),
  ),
);
const POSIX_CHILD_ENVIRONMENT_NAMES = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NO_COLOR",
];
const WINDOWS_CHILD_ENVIRONMENT_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NO_COLOR",
];

function canEnforcePosixPermissions(platform) {
  return platform !== "win32" && process.platform !== "win32";
}

export const PROVIDER_KEY_ENV = "OPENCODE_ADVISOR_PROVIDER_KEY";
export const PROFILE_VERSION = 1;
export const SETUP_GUIDANCE = "OpenCode Advisor is not configured. Run `opencode-advisor-setup` before using the MCP tools.";
export const SETUP_REQUIRED_CODE = "OPENCODE_ADVISOR_SETUP_REQUIRED";

function pathForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultAdvisorHome(env, platform, pathApi) {
  const base = platform === "win32" ? env.USERPROFILE : env.HOME;
  if (typeof base !== "string" || !base.trim()) {
    throw profileError("OPENCODE_ADVISOR_HOME must be configured when the user home directory is unavailable.");
  }
  return pathApi.join(base, ".codex", "opencode-advisor");
}

export function getAdvisorProfilePaths(env = process.env, platform = process.platform) {
  const pathApi = pathForPlatform(platform);
  const configured = env.OPENCODE_ADVISOR_HOME;
  const home = configured == null || !String(configured).trim()
    ? defaultAdvisorHome(env, platform, pathApi)
    : String(configured).trim();
  if (home.includes("\0") || !pathApi.isAbsolute(home)) {
    throw profileError("OPENCODE_ADVISOR_HOME must be an absolute path.");
  }
  const resolvedHome = pathApi.resolve(home);
  const configHome = pathApi.join(resolvedHome, "opencode-config");
  const opencodeConfigDir = pathApi.join(resolvedHome, "opencode-config-dir");
  return {
    home: resolvedHome,
    manifestPath: pathApi.join(resolvedHome, "advisor-config.json"),
    credentialPath: pathApi.join(resolvedHome, "provider-credential.json"),
    configHome,
    dataHome: pathApi.join(resolvedHome, "opencode-data"),
    cacheHome: pathApi.join(resolvedHome, "opencode-cache"),
    stateHome: pathApi.join(resolvedHome, "opencode-state"),
    opencodeConfigPath: pathApi.join(configHome, "opencode.json"),
    opencodeConfigDir,
    agentsDir: pathApi.join(opencodeConfigDir, "agents"),
  };
}

function profileError(message) {
  const error = new Error(message);
  error.code = "OPENCODE_ADVISOR_PROFILE_INVALID";
  return error;
}

function setupRequiredError() {
  const error = new Error(SETUP_GUIDANCE);
  error.code = SETUP_REQUIRED_CODE;
  return error;
}

async function readBundledAgentTemplates() {
  const entries = await Promise.all(
    AGENT_TEMPLATE_FILENAMES.map(async (filename) => [
      filename,
      await fs.readFile(BUNDLED_AGENT_TEMPLATE_URLS[filename], "utf8"),
    ]),
  );
  return Object.fromEntries(entries);
}

function requiredString(value, label, maximum = 1024) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0-\x1F\x7F]/.test(value)) {
    throw profileError(`${label} must be a non-empty single-line string.`);
  }
  return value.trim();
}

function requireOnlyKeys(value, allowedKeys, label) {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw profileError(`${label} contains unsupported fields.`);
  }
}

function validateBaseUrl(value) {
  const source = requiredString(value, "provider.base_url");
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw profileError("provider.base_url must be an absolute HTTP or HTTPS URL.");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw profileError("provider.base_url must be an HTTP or HTTPS API root without credentials, query, or fragment.");
  }
  try {
    if (/[\0-\x1F\x7F]/.test(decodeURIComponent(parsed.pathname))) {
      throw profileError("provider.base_url must not contain control characters.");
    }
  } catch (error) {
    if (error?.code === "OPENCODE_ADVISOR_PROFILE_INVALID") throw error;
    throw profileError("provider.base_url must not contain invalid percent encoding.");
  }
  return source.replace(/\/+$/, "");
}

function validateModels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw profileError("provider.models must contain at least one model.");
  }

  const ids = new Set();
  return value.map((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw profileError("provider.models entries must be objects.");
    }
    requireOnlyKeys(model, ["id", "name"], "provider.models entry");
    const id = requiredString(model.id, "provider.models[].id", MODEL_ID_MAX_LENGTH);
    if (ids.has(id)) throw profileError("provider.models must not contain duplicate ids.");
    ids.add(id);
    const name = model.name == null ? id : requiredString(model.name, "provider.models[].name", MODEL_ID_MAX_LENGTH);
    return { id, name };
  });
}

function validateRole(value, role, modelIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw profileError(`roles.${role} must be configured.`);
  }
  requireOnlyKeys(value, ["model", "variant"], `roles.${role}`);
  const model = requiredString(value.model, `roles.${role}.model`, MODEL_ID_MAX_LENGTH);
  if (!modelIds.has(model)) throw profileError(`roles.${role}.model must name a configured provider model.`);
  if (value.variant == null) return { model };
  return {
    model,
    variant: requiredString(value.variant, `roles.${role}.variant`, 128),
  };
}

export function validateAdvisorConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw profileError("Advisor configuration must be an object.");
  }
  requireOnlyKeys(value, ["version", "provider", "roles"], "Advisor configuration");
  if (value.version !== PROFILE_VERSION) {
    throw profileError(`Advisor configuration version must be ${PROFILE_VERSION}.`);
  }
  const provider = value.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw profileError("provider must be configured.");
  }
  requireOnlyKeys(provider, ["id", "name", "base_url", "transport", "models"], "provider");
  const id = requiredString(provider.id, "provider.id", 64);
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw profileError("provider.id must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.");
  }
  const transport = provider.transport;
  if (transport !== "responses" && transport !== "chat_completions") {
    throw profileError("provider.transport must be responses or chat_completions.");
  }
  const models = validateModels(provider.models);
  const modelIds = new Set(models.map((model) => model.id));
  const roles = value.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw profileError("roles must be configured.");
  }
  requireOnlyKeys(roles, ["reviewer", "planner"], "roles");

  return {
    version: PROFILE_VERSION,
    provider: {
      id,
      name: requiredString(provider.name, "provider.name", 128),
      base_url: validateBaseUrl(provider.base_url),
      transport,
      models,
    },
    roles: {
      reviewer: validateRole(roles.reviewer, "reviewer", modelIds),
      planner: validateRole(roles.planner, "planner", modelIds),
    },
  };
}

export function getAdvisorConfigFingerprint(config) {
  const validated = validateAdvisorConfig(config);
  return createHash("sha256").update(JSON.stringify(validated)).digest("base64url");
}

export function buildOpenCodeOverlay(config) {
  const validated = validateAdvisorConfig(config);
  const provider = validated.provider;
  const variantsByModel = new Map();
  for (const role of Object.values(validated.roles)) {
    if (!role.variant) continue;
    const variants = variantsByModel.get(role.model) ?? {};
    variants[role.variant] = { reasoningEffort: role.variant };
    variantsByModel.set(role.model, variants);
  }
  const models = Object.fromEntries(provider.models.map((model) => [
    model.id,
    {
      name: model.name,
      ...(variantsByModel.has(model.id) ? { variants: variantsByModel.get(model.id) } : {}),
    },
  ]));
  return JSON.stringify({
    $schema: OPENCODE_SCHEMA_URL,
    enabled_providers: [provider.id],
    provider: {
      [provider.id]: {
        npm: provider.transport === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        name: provider.name,
        options: {
          baseURL: provider.base_url,
          apiKey: `{env:${PROVIDER_KEY_ENV}}`,
        },
        models,
      },
    },
  });
}

function overlaysMatch(expected, actual) {
  if (isDeepStrictEqual(actual, expected)) return true;

  // OpenCode versions that saw an older generated overlay may add this standard
  // schema field on first load. Preserve strict validation for every other field.
  const withoutSchema = (overlay) => {
    if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return overlay;
    if (overlay.$schema !== OPENCODE_SCHEMA_URL) return overlay;
    const { $schema, ...rest } = overlay;
    return rest;
  };
  return isDeepStrictEqual(withoutSchema(actual), withoutSchema(expected));
}

function copyChildEnvironment(env, platform) {
  const allowedNames = platform === "win32"
    ? WINDOWS_CHILD_ENVIRONMENT_NAMES
    : POSIX_CHILD_ENVIRONMENT_NAMES;
  const childEnv = {};
  for (const name of allowedNames) {
    if (typeof env[name] === "string" && env[name] && !isSensitiveEnvironmentName(name)) {
      childEnv[name] = env[name];
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (
      /^LC_[A-Z0-9_]+$/i.test(name)
      && typeof value === "string"
      && value
      && !isSensitiveEnvironmentName(name)
    ) {
      childEnv[name] = value;
    }
  }
  return childEnv;
}

function providerSensitiveValues(config, credential) {
  const validated = validateAdvisorConfig(config);
  const values = new Set([
    credential,
    validated.provider.base_url,
    ...Object.values(validated.roles).flatMap(({ model, variant }) => [
      model,
      `${validated.provider.id}/${model}`,
      variant,
    ]),
  ]);
  return [...values]
    .filter((value) => typeof value === "string" && value)
    .sort((left, right) => right.length - left.length);
}

export function redactAdvisorProviderText(text, { config, credential } = {}) {
  let redacted = String(text ?? "");
  for (const value of providerSensitiveValues(config, credential)) {
    redacted = redacted.split(value).join("[REDACTED_PROVIDER_VALUE]");
  }
  return redacted;
}

export function containsAdvisorProviderValue(text, profile) {
  return redactAdvisorProviderText(text, profile) !== String(text ?? "");
}

export function redactAdvisorProviderValue(value, profile) {
  if (typeof value === "string") return redactAdvisorProviderText(value, profile);
  if (Array.isArray(value)) return value.map((entry) => redactAdvisorProviderValue(entry, profile));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactAdvisorProviderText(key, profile),
        redactAdvisorProviderValue(entry, profile),
      ]),
    );
  }
  return value;
}

async function assertPrivateEntry(filePath, {
  directory = false,
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  const details = await fsImpl.lstat(filePath);
  if (details.isSymbolicLink() || (directory ? !details.isDirectory() : !details.isFile())) {
    throw profileError("Advisor profile contains an unsafe filesystem entry.");
  }
  if (canEnforcePosixPermissions(platform)) {
    if ((details.mode & 0o077) !== 0) {
      throw profileError("Advisor profile permissions are not private.");
    }
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw profileError("Advisor profile is not owned by the current user.");
    }
  }
}

export function buildOpenCodeChildEnv({
  config,
  paths,
  credential,
  env = process.env,
  includeCredential = true,
  platform = process.platform,
} = {}) {
  const validated = validateAdvisorConfig(config);
  if (!paths?.home || !paths?.configHome || !paths?.dataHome || !paths?.opencodeConfigPath || !paths?.opencodeConfigDir) {
    throw profileError("Advisor profile paths are incomplete.");
  }
  if (includeCredential && (typeof credential !== "string" || !credential)) {
    throw profileError("Advisor provider credential is unavailable.");
  }

  const childEnv = copyChildEnvironment(env, platform);
  Object.assign(childEnv, {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_STATE_HOME: paths.stateHome,
    OPENCODE_CONFIG: paths.opencodeConfigPath,
    OPENCODE_CONFIG_DIR: paths.opencodeConfigDir,
    OPENCODE_CONFIG_CONTENT: buildOpenCodeOverlay(validated),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  });
  if (platform === "win32") {
    childEnv.USERPROFILE = paths.home;
    childEnv.APPDATA = paths.configHome;
    childEnv.LOCALAPPDATA = paths.dataHome;
    const root = path.win32.parse(paths.home).root;
    childEnv.HOMEDRIVE = root.replace(/[\\/]+$/, "");
    childEnv.HOMEPATH = paths.home.slice(root.length) || "\\";
  }
  if (includeCredential) {
    childEnv[PROVIDER_KEY_ENV] = credential;
  }
  return childEnv;
}

export async function loadAdvisorProfile({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  readCredential = readProviderCredential,
} = {}) {
  let paths;
  let config;
  try {
    paths = getAdvisorProfilePaths(env, platform);
    const pathApi = pathForPlatform(platform);
    const agentPaths = Object.fromEntries(
      AGENT_TEMPLATE_FILENAMES.map((filename) => [filename, pathApi.join(paths.agentsDir, filename)]),
    );
    await Promise.all([
      ...[
        paths.home,
        paths.configHome,
        paths.dataHome,
        paths.cacheHome,
        paths.stateHome,
        paths.opencodeConfigDir,
        paths.agentsDir,
      ].map((directory) => assertPrivateEntry(directory, { directory: true, platform, fsImpl })),
      ...[
        paths.manifestPath,
        paths.opencodeConfigPath,
        ...Object.values(agentPaths),
      ].map((filePath) => assertPrivateEntry(filePath, { platform, fsImpl })),
    ]);
    const manifestText = await fsImpl.readFile(paths.manifestPath, "utf8");
    config = validateAdvisorConfig(JSON.parse(manifestText));
    const expectedOverlay = JSON.parse(buildOpenCodeOverlay(config));
    const storedOverlay = JSON.parse(await fsImpl.readFile(paths.opencodeConfigPath, "utf8"));
    if (!overlaysMatch(expectedOverlay, storedOverlay)) throw profileError("OpenCode overlay does not match the advisor manifest.");
    const [storedAgentTemplates, bundledAgentTemplates] = await Promise.all([
      Promise.all(
        AGENT_TEMPLATE_FILENAMES.map(async (filename) => [filename, await fsImpl.readFile(agentPaths[filename], "utf8")]),
      ).then(Object.fromEntries),
      readBundledAgentTemplates(),
    ]);
    if (!isDeepStrictEqual(storedAgentTemplates, bundledAgentTemplates)) {
      throw profileError("Advisor agent templates do not match the bundled templates.");
    }
  } catch {
    throw setupRequiredError();
  }

  try {
    const credential = await readCredential({
      credentialPath: paths.credentialPath,
      expectedManifestFingerprint: getAdvisorConfigFingerprint(config),
      platform,
    });
    if (typeof credential !== "string" || !credential) throw setupRequiredError();
    return { config, paths, credential };
  } catch {
    throw setupRequiredError();
  }
}

async function ensurePrivateDirectory(directory, { platform = process.platform, fsImpl = fs } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  if (canEnforcePosixPermissions(platform)) {
    await fsImpl.chmod(directory, 0o700);
  }
  await assertPrivateEntry(directory, { directory: true, platform, fsImpl });
}

async function writePrivateJson(filePath, value, { platform = process.platform, fsImpl = fs } = {}) {
  const pathApi = pathForPlatform(platform);
  await ensurePrivateDirectory(pathApi.dirname(filePath), { platform, fsImpl });
  const temporaryPath = pathApi.join(
    pathApi.dirname(filePath),
    `.${pathApi.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fsImpl.writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
  if (canEnforcePosixPermissions(platform)) {
    await fsImpl.chmod(temporaryPath, 0o600);
  }
  await fsImpl.rename(temporaryPath, filePath);
}

async function writePrivateText(filePath, text, { platform = process.platform, fsImpl = fs } = {}) {
  const pathApi = pathForPlatform(platform);
  await ensurePrivateDirectory(pathApi.dirname(filePath), { platform, fsImpl });
  const temporaryPath = pathApi.join(
    pathApi.dirname(filePath),
    `.${pathApi.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fsImpl.writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
  if (canEnforcePosixPermissions(platform)) {
    await fsImpl.chmod(temporaryPath, 0o600);
  }
  await fsImpl.rename(temporaryPath, filePath);
}

export async function writeAdvisorProfile({
  config,
  paths,
  agentTemplates,
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  const validated = validateAdvisorConfig(config);
  if (!paths?.home || !paths?.manifestPath || !paths?.opencodeConfigPath || !paths?.agentsDir) {
    throw profileError("Advisor profile paths are incomplete.");
  }
  const advisorTemplate = agentTemplates?.["codex-advisor.md"];
  const plannerTemplate = agentTemplates?.["codex-planning-partner.md"];
  if (typeof advisorTemplate !== "string" || typeof plannerTemplate !== "string") {
    throw profileError("Both bundled agent templates are required.");
  }

  await Promise.all([
    ensurePrivateDirectory(paths.home, { platform, fsImpl }),
    ensurePrivateDirectory(paths.configHome, { platform, fsImpl }),
    ensurePrivateDirectory(paths.dataHome, { platform, fsImpl }),
    ensurePrivateDirectory(paths.cacheHome, { platform, fsImpl }),
    ensurePrivateDirectory(paths.stateHome, { platform, fsImpl }),
    ensurePrivateDirectory(paths.opencodeConfigDir, { platform, fsImpl }),
    ensurePrivateDirectory(paths.agentsDir, { platform, fsImpl }),
  ]);
  await writePrivateJson(paths.manifestPath, validated, { platform, fsImpl });
  await writePrivateJson(paths.opencodeConfigPath, JSON.parse(buildOpenCodeOverlay(validated)), { platform, fsImpl });
  await writePrivateText(pathForPlatform(platform).join(paths.agentsDir, "codex-advisor.md"), advisorTemplate, { platform, fsImpl });
  await writePrivateText(
    pathForPlatform(platform).join(paths.agentsDir, "codex-planning-partner.md"),
    plannerTemplate,
    { platform, fsImpl },
  );
  return { config: validated, paths };
}
