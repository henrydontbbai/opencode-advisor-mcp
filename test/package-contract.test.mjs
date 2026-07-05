import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const installDoc = readFileSync(new URL("../docs/INSTALL.md", import.meta.url), "utf8");
const releasingDoc = readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");

test("default npm test excludes doctor-specific test coverage", () => {
  assert.match(packageJson.scripts.test, /test\/server\.test\.mjs/);
  assert.match(packageJson.scripts.test, /test\/runtime-shared\.test\.mjs/);
  assert.match(packageJson.scripts.test, /test\/package-contract\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts.test, /doctor\.test\.mjs/);
  assert.equal(packageJson.scripts["test:doctor"], "node --test test/doctor.test.mjs");
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
});

test("docs keep source install as the current path while npm stays unpublished", () => {
  assert.match(readme, /Supported mode: source\/GitHub install/i);
  assert.match(readme, /has not been published to npm yet/i);
  assert.match(installDoc, /currently supports one public install mode:\s+[\r\n]+\s*1\. source checkout from GitHub/i);
  assert.match(releasingDoc, /npm publication is a future optional path/i);
});
