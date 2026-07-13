import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const installDoc = readFileSync(new URL("../docs/INSTALL.md", import.meta.url), "utf8");
const usageDoc = readFileSync(new URL("../docs/USAGE.md", import.meta.url), "utf8");
const configurationDoc = readFileSync(new URL("../docs/CONFIGURATION.md", import.meta.url), "utf8");
const architectureDoc = readFileSync(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8");
const exampleToml = readFileSync(new URL("../examples/codex-mcp.toml", import.meta.url), "utf8");
const acceptanceDoc = readFileSync(new URL("../docs/ACCEPTANCE.md", import.meta.url), "utf8");
const compatibilityDoc = readFileSync(new URL("../docs/COMPATIBILITY.md", import.meta.url), "utf8");
const releasingDoc = readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
const serverTestSource = readFileSync(new URL("./server.test.mjs", import.meta.url), "utf8");
const repoRoot = new URL("../", import.meta.url);
const testRunnerScript = readFileSync(
  new URL("../scripts/run-test-files.mjs", import.meta.url),
  "utf8",
);
const publishedMarkdown = [
  { path: "README.md", text: readme },
  ...readdirSync(new URL("../docs/", import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      path: `docs/${name}`,
      text: readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8"),
    })),
];
const publishedExamples = readdirSync(new URL("../examples/", import.meta.url))
  .filter((name) => /\.(?:json|md|toml|ya?ml)$/i.test(name))
  .map((name) => ({
    path: `examples/${name}`,
    text: readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"),
  }));

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveNpmInvocation({
  nodeExecPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  isFile = isRegularFile,
} = {}) {
  const bundledNpmCli = join(
    dirname(nodeExecPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );

  for (const npmCliPath of [bundledNpmCli, npmExecPath]) {
    if (
      typeof npmCliPath === "string"
      && basename(npmCliPath) === "npm-cli.js"
      && isFile(npmCliPath)
    ) {
      return { command: nodeExecPath, args: [npmCliPath] };
    }
  }

  throw new Error("Unable to locate a verified npm CLI for package contract test.");
}

function runNpmJson(args) {
  const invocation = resolveNpmInvocation();
  const stdout = execFileSync(invocation.command, [...invocation.args, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function readTarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${name || "unnamed entry"}.`);
    }

    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) {
      throw new Error(`Truncated tar entry for ${name || "unnamed entry"}.`);
    }

    const entryPath = prefix ? `${prefix}/${name}` : name;
    if (entryPath.startsWith("package/")) {
      entries.set(entryPath.slice("package/".length), archive.subarray(bodyStart, bodyEnd).toString("utf8"));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readPublishedTarball() {
  const destination = mkdtempSync(join(tmpdir(), "opencode-advisor-pack-"));
  try {
    const packResult = runNpmJson(["pack", "--json", "--pack-destination", destination]);
    const tarball = Array.isArray(packResult) ? packResult[0] : packResult;
    return readTarEntries(join(destination, tarball.filename));
  } finally {
    rmSync(destination, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("package contract npm launcher requires a verified Node CLI without a shell fallback", () => {
  const nodeExecPath = join(
    "test-node-home",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const npmExecPath = join("test-npm", "npm-cli.js");

  assert.deepEqual(
    resolveNpmInvocation({
      nodeExecPath,
      npmExecPath,
      isFile: (candidate) => candidate === npmExecPath,
    }),
    { command: nodeExecPath, args: [npmExecPath] },
  );
  let isFileCalled = false;
  assert.throws(
    () => resolveNpmInvocation({
      nodeExecPath,
      npmExecPath,
      isFile: () => {
        isFileCalled = true;
        return false;
      },
    }),
    /Unable to locate a verified npm CLI/,
  );
  assert.equal(isFileCalled, true);
});

test("package contract npm launcher rejects directory and non-JS CLI candidates", () => {
  const missingNodeExecPath = join(
    "missing-node-home",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const directoryLikeCandidate = join("test-directory", "npm-cli.js");
  const checkedCandidates = [];

  assert.throws(
    () => resolveNpmInvocation({
      nodeExecPath: missingNodeExecPath,
      npmExecPath: directoryLikeCandidate,
      isFile: (candidate) => {
        checkedCandidates.push(candidate);
        return false;
      },
    }),
    /Unable to locate a verified npm CLI/,
  );
  assert.equal(checkedCandidates.includes(directoryLikeCandidate), true);

  assert.throws(
    () => resolveNpmInvocation({
      nodeExecPath: missingNodeExecPath,
      npmExecPath: process.execPath,
      isFile: (candidate) => candidate === process.execPath,
    }),
    /Unable to locate a verified npm CLI/,
  );
});

test("default npm test excludes doctor-specific test coverage", () => {
  assert.equal(packageJson.scripts.test, "node scripts/run-test-files.mjs");
  assert.match(testRunnerScript, /--test-force-exit/);
  assert.match(testRunnerScript, /test\/server\.test\.mjs/);
  assert.match(testRunnerScript, /test\/runtime-shared\.test\.mjs/);
  assert.match(testRunnerScript, /test\/package-contract\.test\.mjs/);
  assert.match(testRunnerScript, /test\/queue\.test\.mjs/);
  assert.match(testRunnerScript, /test\/mcp-integration\.test\.mjs/);
  assert.match(testRunnerScript, /test\/queue-integration\.test\.mjs/);
  assert.match(testRunnerScript, /test\/bin\.test\.mjs/);
  assert.match(testRunnerScript, /test\/provider-credentials\.test\.mjs/);
  assert.match(testRunnerScript, /test\/provider-profile\.test\.mjs/);
  assert.match(testRunnerScript, /test\/provider-runtime\.test\.mjs/);
  assert.match(testRunnerScript, /test\/setup-cli\.test\.mjs/);
  assert.doesNotMatch(testRunnerScript, /doctor\.test\.mjs/);
  assert.equal(packageJson.scripts["test:doctor"], "node --test test/doctor.test.mjs");
  assert.match(ciWorkflow, /npm run test:doctor/);
});

test("smoke script verifies startup with allowed roots and failure without configuration", () => {
  assert.match(packageJson.scripts.smoke, /createServer\(\{ env \}\)/);
  assert.doesNotMatch(packageJson.scripts.smoke, /OPENCODE_ADVISOR_OPENCODE_DATA_HOME/);
  assert.match(packageJson.scripts.smoke, /createServer\(\{ env: \{\} \}\)/);
  assert.doesNotMatch(packageJson.scripts.smoke, /_registeredTools/);
  assert.doesNotMatch(serverTestSource, /_registeredTools/);
});

test("package.json is the single source for the advertised server version", () => {
  const literalServerVersionPattern = /version:\s*["']\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?["']/;
  assert.match(serverSource, /package\.json/);
  assert.match(serverSource, /version:\s*packageMetadata\.version/);
  for (const version of ["0.3.0", "0.3.0-rc.1", "0.3.0+build.7", "0.3.0-rc.1+build.7"]) {
    assert.match(`version: "${version}"`, literalServerVersionPattern);
  }
  assert.doesNotMatch(serverSource, literalServerVersionPattern);
  assert.match(
    changelog,
    new RegExp(`^## ${packageJson.version.replaceAll(".", "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m"),
  );
});

test("setup and doctor are published as separate non-MCP CLIs", () => {
  assert.equal(
    packageJson.bin["opencode-advisor-setup"],
    "bin/opencode-advisor-setup.mjs",
  );
  assert.equal(
    packageJson.bin["opencode-advisor-doctor"],
    "bin/opencode-advisor-doctor.mjs",
  );
  assert.equal(
    packageJson.files.some((entry) => entry === "test/" || entry.startsWith("test")),
    false,
  );
  assert.deepEqual(packageJson.files, ["src/", "agents/", "bin/", "docs/", "examples/", "README.md", "LICENSE"]);
  assert.equal(packageJson.scripts.setup, "node bin/opencode-advisor-setup.mjs");
  assert.equal(packageJson.scripts.doctor, "node bin/opencode-advisor-doctor.mjs");
});

test("package ships the documentation and MCP example referenced by its README", () => {
  assert.equal(packageJson.files.includes("docs/"), true);
  assert.equal(packageJson.files.includes("examples/"), true);
  assert.match(readme, /\[examples\/codex-mcp\.toml\]/);
  assert.match(readme, /\[docs\/CONFIGURATION\.md\]/);
});

test("published docs require independent provider setup and exclude legacy profile setup", () => {
  for (const document of [readme, installDoc, configurationDoc, usageDoc, architectureDoc]) {
    assert.match(document, /opencode-advisor-setup/i);
  }

  for (const { path, text } of publishedMarkdown) {
    assert.doesNotMatch(text, /opencode auth login/i, path);
    assert.doesNotMatch(text, /OPENCODE_ADVISOR_OPENCODE_DATA_HOME/, path);
  }

  for (const { path, text } of publishedExamples) {
    assert.doesNotMatch(text, /opencode auth login/i, path);
    assert.doesNotMatch(text, /OPENCODE_ADVISOR_OPENCODE_DATA_HOME/, path);
    assert.doesNotMatch(
      text,
      /OPENCODE_CONFIG|api[_-]?key|\b(?:url|model|key|token|credential)\b/i,
      path,
    );
  }

  assert.equal(
    existsSync(new URL("../docs/opencode-advisor.example.toml", import.meta.url)),
    false,
  );
  assert.match(configurationDoc, /OPENCODE_ADVISOR_ALLOWED_ROOTS/);
  assert.match(configurationDoc, /OPENCODE_ADVISOR_HOME/);
  assert.match(architectureDoc, /OPENCODE_CONFIG_CONTENT/);
  assert.match(architectureDoc, /OPENCODE_DISABLE_PROJECT_CONFIG/);
  assert.match(architectureDoc, /OPENCODE_ADVISOR_PROVIDER_KEY/);
  assert.match(exampleToml, /OPENCODE_ADVISOR_ALLOWED_ROOTS/);
  assert.doesNotMatch(exampleToml, /API_KEY|TOKEN|SECRET|base_url|model/i);
  assert.doesNotMatch(releasingDoc, /opencode auth login|OPENCODE_ADVISOR_OPENCODE_DATA_HOME/i);
});

test("docs distinguish source and GitHub Release tarball setup paths and list every queue control", () => {
  assert.match(readme, /npm run setup/);
  assert.match(readme, /src\\\\server\.mjs/);
  const releaseSha256 = "47a4697ad28e99fd85ba2951ac21289a566378948743526f2b1cde5cbd905fa1";
  for (const document of [readme, installDoc]) {
    assert.match(document, /releases\/download\/v0\.3\.0\/opencode-advisor-mcp-0\.3\.0\.tgz/i);
    assert.match(document, /SHA256SUMS\.txt/);
    assert.match(document, new RegExp(releaseSha256));
    assert.match(document, /\$expected {2}opencode-advisor-mcp-0\.3\.0\.tgz/);
    assert.match(document, /did not publish to npm/i);
    assert.match(document, /no npm-registry install path is supported/i);
  }
  assert.match(releasingDoc, /credential-manifest binding/i);
  assert.match(releasingDoc, /manifest-overlay binding/i);

  const queueControls = [
    "OPENCODE_ADVISOR_CONCURRENCY_GLOBAL",
    "OPENCODE_ADVISOR_CONCURRENCY_PLANNER",
    "OPENCODE_ADVISOR_CONCURRENCY_REVIEWER",
    "OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS",
    "OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS",
    "OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS",
    "OPENCODE_ADVISOR_SESSION_RETENTION_MS",
    "OPENCODE_ADVISOR_QUEUE_TASK_RETENTION_MS",
    "OPENCODE_ADVISOR_MAINTENANCE_INTERVAL_MS",
  ];
  for (const control of queueControls) {
    assert.match(usageDoc, new RegExp(control));
    assert.match(configurationDoc, new RegExp(control));
  }
});

test("real tarball contents stay aligned with the published package contract", () => {
  const packedContents = readPublishedTarball();
  const packedFiles = [...packedContents.keys()].sort();

  assert.deepEqual(packedFiles, [
    "LICENSE",
    "README.md",
    "agents/codex-advisor.md",
    "agents/codex-planning-partner.md",
    "bin/opencode-advisor-agent.mjs",
    "bin/opencode-advisor-doctor.mjs",
    "bin/opencode-advisor-setup.mjs",
    "docs/ACCEPTANCE.md",
    "docs/ARCHITECTURE.md",
    "docs/COMPATIBILITY.md",
    "docs/CONFIGURATION.md",
    "docs/GIT.md",
    "docs/INSTALL.md",
    "docs/USAGE.md",
    "examples/codex-mcp.toml",
    "package.json",
    "src/doctor.mjs",
    "src/opencode-core.mjs",
    "src/provider-credentials.mjs",
    "src/provider-profile.mjs",
    "src/queue-runner.mjs",
    "src/runtime-shared.mjs",
    "src/server.mjs",
    "src/session-lifecycle.mjs",
    "src/task-queue.mjs",
  ]);

  for (const required of [
    "agents/codex-advisor.md",
    "agents/codex-planning-partner.md",
    "bin/opencode-advisor-agent.mjs",
    "bin/opencode-advisor-setup.mjs",
    "bin/opencode-advisor-doctor.mjs",
    "docs/CONFIGURATION.md",
    "examples/codex-mcp.toml",
    "src/server.mjs",
    "src/session-lifecycle.mjs",
    "README.md",
    "LICENSE",
    "package.json",
  ]) {
    assert.equal(packedFiles.includes(required), true);
  }

  for (const forbiddenPrefix of [
    "scripts/",
    "test/",
    ".github/",
    ".worktrees/",
    "node_modules/",
  ]) {
    assert.equal(packedFiles.some((entry) => entry.startsWith(forbiddenPrefix)), false);
  }

  for (const forbiddenName of [
    "package-lock.json",
    "issue-release.yml",
  ]) {
    assert.equal(packedFiles.includes(forbiddenName), false);
  }

  const packedMarkdown = packedFiles
    .filter((entry) => entry === "README.md" || /^docs\/.*\.md$/i.test(entry))
    .map((entry) => ({ path: entry, text: packedContents.get(entry) }));
  for (const { path, text } of packedMarkdown) {
    assert.doesNotMatch(text, /opencode auth login/i, path);
    assert.doesNotMatch(text, /OPENCODE_ADVISOR_OPENCODE_DATA_HOME/, path);
  }

  const packedExamples = packedFiles
    .filter((entry) => /^examples\//.test(entry))
    .map((entry) => ({ path: entry, text: packedContents.get(entry) }));
  assert.deepEqual(packedExamples.map(({ path }) => path), ["examples/codex-mcp.toml"]);
  for (const { path, text } of packedExamples) {
    assert.doesNotMatch(text, /OPENCODE_CONFIG|api[_-]?key|\b(?:url|model|key|token|credential)\b/i, path);
  }
});

test("package-lock root metadata stays in sync with package.json", () => {
  const root = packageLock.packages[""];

  assert.equal(root.name, packageJson.name);
  assert.equal(root.version, packageJson.version);
  assert.deepEqual(root.bin, packageJson.bin);
  assert.deepEqual(root.engines, packageJson.engines);
  assert.deepEqual(root.dependencies, packageJson.dependencies);
});

test("docs advertise the two roles plus queued task lookup", () => {
  assert.match(readme, /ask_opencode_planner/);
  assert.match(readme, /get_opencode_task/);
  assert.match(readme, /codex-planning-partner/);
  assert.match(installDoc, /codex-planning-partner\.md/);
  assert.match(usageDoc, /queued\/running is pending, not failed/i);
  assert.match(acceptanceDoc, /codex-planning-partner/);
  assert.match(usageDoc, /get_opencode_task.*same public result shape/i);
  assert.match(acceptanceDoc, /manual queued-path poll/i);
  assert.match(acceptanceDoc, /completed result should preserve `advisor_text` or `planner_text`/i);
  assert.match(readme, /opencode-advisor-setup/);
  assert.match(usageDoc, /provider_setup_required|opencode-advisor-setup/i);
});

test("docs keep doctor JSON output machine-readable from package and source installs", () => {
  for (const text of [readme, usageDoc, configurationDoc, acceptanceDoc]) {
    assert.match(text, /opencode-advisor-doctor --json/);
    assert.match(text, /npm run --silent doctor -- --json/);
  }
  assert.match(usageDoc, /one object containing `ok`, `bucket`, `steps`, and `summary`/i);
  assert.match(usageDoc, /exit with `0`.*with `1` otherwise/i);
});

test("docs describe optional role-specific variants without treating them as universal provider settings", () => {
  assert.match(readme, /reviewer `high` and planner `max`/i);
  assert.match(installDoc, /optional reasoning variant/i);
  assert.match(configurationDoc, /"variant": "high"/);
  assert.match(configurationDoc, /"variant": "max"/);
  assert.match(configurationDoc, /reasoning\.effort/);
  assert.match(configurationDoc, /not values guaranteed by every provider or model/i);
  assert.match(usageDoc, /--variant <role-variant>/);
  assert.match(architectureDoc, /--variant <role-variant>/);
  assert.match(architectureDoc, /reasoning\.effort/);
  assert.match(acceptanceDoc, /reviewer `high` and planner `max`/i);
  assert.match(acceptanceDoc, /reasoning\.effort/);
});

test("docs describe the current queue knobs and pending semantics", () => {
  const combinedDocs = [readme, usageDoc, acceptanceDoc].join("\n");

  for (const key of [
    "OPENCODE_ADVISOR_QUEUE_MAX_PENDING",
    "OPENCODE_ADVISOR_TASK_TTL_MS",
    "OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS",
    "OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS",
    "OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS",
    "OPENCODE_ADVISOR_QUEUE_POLL_MS",
  ]) {
    assert.match(combinedDocs, new RegExp(key));
  }

  assert.match(usageDoc, /expired .* not timeout/i);
  assert.match(usageDoc, /local diagnosis/i);
  assert.match(acceptanceDoc, /expired status rather than timeout/i);
});

test("docs provide a complete configuration, architecture, and compatibility reference", () => {
  for (const key of [
    "OPENCODE_ADVISOR_ALLOWED_ROOTS",
    "OPENCODE_ADVISOR_HOME",
    "OPENCODE_ADVISOR_OPENCODE_CMD",
    "OPENCODE_ADVISOR_TIMEOUT_MS",
    "OPENCODE_ADVISOR_GIT_TIMEOUT_MS",
    "OPENCODE_ADVISOR_MAX_DIFF_CHARS",
    "OPENCODE_ADVISOR_REDACT_SECRETS",
    "OPENCODE_ADVISOR_SESSION_RETENTION_MS",
    "OPENCODE_ADVISOR_QUEUE_TASK_RETENTION_MS",
    "OPENCODE_ADVISOR_MAINTENANCE_INTERVAL_MS",
    "OPENCODE_ADVISOR_TEST_FILE_TIMEOUT_MS",
  ]) {
    assert.match(configurationDoc, new RegExp(key));
  }

  assert.match(architectureDoc, /server validates allowed roots and input/i);
  assert.match(architectureDoc, /collected Git status/i);
  assert.match(architectureDoc, /Queue Boundary/i);
  assert.match(architectureDoc, /opencode run --pure/i);
  assert.match(architectureDoc, /single-user/i);
  assert.match(compatibilityDoc, /Node\.js.*>=20/i);
  assert.match(compatibilityDoc, /Windows/i);
  assert.match(compatibilityDoc, /CurrentUser DPAPI/i);
  assert.match(compatibilityDoc, /macOS|Linux|POSIX/i);
  assert.match(compatibilityDoc, /0700/);
  assert.match(compatibilityDoc, /0600/);
  assert.match(compatibilityDoc, /stdio MCP/i);
  assert.match(compatibilityDoc, /OpenCode CLI/i);
  assert.match(compatibilityDoc, /does not migrate a normal OpenCode profile/i);
  assert.doesNotMatch(
    compatibilityDoc,
    /1\.17\.13|both bundled agents must be installed|install(?:ed)? .*normal OpenCode profile/i,
  );
  assert.match(usageDoc, /\bgoal\b/i);
  assert.match(usageDoc, /base_ref/i);
  assert.match(usageDoc, /get_opencode_task/i);
});
