import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const installDoc = readFileSync(new URL("../docs/INSTALL.md", import.meta.url), "utf8");
const usageDoc = readFileSync(new URL("../docs/USAGE.md", import.meta.url), "utf8");
const acceptanceDoc = readFileSync(new URL("../docs/ACCEPTANCE.md", import.meta.url), "utf8");
const releasingDoc = readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
const serverTestSource = readFileSync(new URL("./server.test.mjs", import.meta.url), "utf8");
const repoRoot = new URL("../", import.meta.url);
const testRunnerScript = readFileSync(
  new URL("../scripts/run-test-files.mjs", import.meta.url),
  "utf8",
);

function runNpmJson(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    const stdout = execFileSync(process.execPath, [npmExecPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const stdout = execFileSync(npmCommand, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

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
  assert.doesNotMatch(testRunnerScript, /doctor\.test\.mjs/);
  assert.equal(packageJson.scripts["test:doctor"], "node --test test/doctor.test.mjs");
  assert.match(ciWorkflow, /npm run test:doctor/);
});

test("smoke script verifies both startup success with allowed roots and startup failure without them", () => {
  assert.match(packageJson.scripts.smoke, /createServer\(\{ env \}\)/);
  assert.match(packageJson.scripts.smoke, /createServer\(\{ env: \{\} \}\)/);
  assert.doesNotMatch(packageJson.scripts.smoke, /_registeredTools/);
  assert.doesNotMatch(serverTestSource, /_registeredTools/);
});

test("package.json is the single source for the advertised server version", () => {
  assert.match(serverSource, /package\.json/);
  assert.match(serverSource, /version:\s*packageMetadata\.version/);
  assert.doesNotMatch(serverSource, /version:\s*["']0\.2\.0["']/);
});

test("doctor stays out of the published CLI and files contract", () => {
  assert.equal(
    Object.values(packageJson.bin).includes("scripts/opencode-advisor-doctor.mjs"),
    false,
  );
  assert.equal(
    packageJson.files.some((entry) => entry === "scripts/" || entry.startsWith("scripts")),
    false,
  );
  assert.equal(
    packageJson.files.some((entry) => entry === "test/" || entry.startsWith("test")),
    false,
  );
  assert.deepEqual(packageJson.files, ["src/", "agents/", "bin/", "README.md", "LICENSE"]);
  assert.match(packageJson.scripts.doctor, /source checkout/i);
});

test("docs keep source install as the current path while npm stays unpublished", () => {
  assert.match(readme, /Supported mode: source\/GitHub install/i);
  assert.match(readme, /has not been published to npm yet/i);
  assert.match(installDoc, /currently supports one public install mode:\s+[\r\n]+\s*1\. source checkout from GitHub/i);
  assert.match(releasingDoc, /npm publication is a future optional path/i);
});

test("real tarball contents stay aligned with the published package contract", () => {
  const packResult = runNpmJson(["pack", "--dry-run", "--json"]);
  const tarball = Array.isArray(packResult) ? packResult[0] : packResult;
  const packedFiles = tarball.files.map((entry) => entry.path).sort();

  assert.deepEqual(packedFiles, [
    "LICENSE",
    "README.md",
    "agents/codex-advisor.md",
    "agents/codex-planning-partner.md",
    "bin/opencode-advisor-agent.mjs",
    "package.json",
    "src/opencode-core.mjs",
    "src/queue-runner.mjs",
    "src/runtime-shared.mjs",
    "src/server.mjs",
    "src/task-queue.mjs",
  ]);

  for (const required of [
    "agents/codex-advisor.md",
    "agents/codex-planning-partner.md",
    "bin/opencode-advisor-agent.mjs",
    "src/server.mjs",
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
});

test("package-lock root metadata stays in sync with package.json", () => {
  const root = packageLock.packages[""];

  assert.equal(root.name, packageJson.name);
  assert.equal(root.version, packageJson.version);
  assert.deepEqual(root.bin, packageJson.bin);
  assert.deepEqual(root.engines, packageJson.engines);
  assert.deepEqual(root.dependencies, packageJson.dependencies);
});

test("docs advertise planner plus queued task lookup without claiming npm release", () => {
  assert.match(readme, /ask_opencode_planner/);
  assert.match(readme, /get_opencode_task/);
  assert.match(readme, /codex-planning-partner/);
  assert.match(installDoc, /codex-planning-partner\.md/);
  assert.match(usageDoc, /queued\/running is pending, not failed/i);
  assert.match(acceptanceDoc, /codex-planning-partner/);
  assert.match(usageDoc, /get_opencode_task.*same public result shape/i);
  assert.match(acceptanceDoc, /manual queued-path poll/i);
  assert.match(acceptanceDoc, /completed result should preserve `advisor_text` or `planner_text`/i);
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
