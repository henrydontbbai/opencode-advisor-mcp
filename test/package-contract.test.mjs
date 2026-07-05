import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("default npm test excludes doctor-specific test coverage", () => {
  assert.match(packageJson.scripts.test, /test\/server\.test\.mjs/);
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
});
