import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractChangelogSection, validateReleaseIdentity } from "../scripts/source-release.mjs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const releasing = readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");

test("release identity requires exact tag and lockfile alignment", () => {
  const packageMetadata = { name: "example", version: "1.2.3" };
  const packageLock = { name: "example", version: "1.2.3", packages: { "": { name: "example", version: "1.2.3" } } };

  assert.equal(validateReleaseIdentity({ tag: "v1.2.3", packageMetadata, packageLock }), "1.2.3");
  assert.throws(() => validateReleaseIdentity({ tag: "v1.2.4", packageMetadata, packageLock }), /must equal/);
  assert.throws(
    () =>
      validateReleaseIdentity({ tag: "v1.2.3", packageMetadata, packageLock: { ...packageLock, version: "1.2.2" } }),
    /version does not match/,
  );
});

test("release notes come from the matching dated changelog section", () => {
  const changelog =
    "# Changelog\n\n## Unreleased\n\n- next\n\n## 1.2.3 - 2026-07-14\n\n- shipped\n\n## 1.2.2 - 2026-07-01\n\n- old\n";
  assert.equal(extractChangelogSection(changelog, "1.2.3"), "- shipped");
  assert.throws(() => extractChangelogSection(changelog, "1.2.4"), /no dated section/);
});

test("release workflow creates a source-only draft with least privilege", () => {
  assert.match(workflow, /tags:\s*\n\s*- ["']v\*["']/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /source-release\.mjs build/);
  assert.match(workflow, /source-release\.mjs verify/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN|packages:\s*write|id-token:\s*write|--clobber/i);
  assert.match(releasing, /Draft GitHub Release/);
  assert.match(releasing, /does not use the npm registry/);
});

test("source-release CLI forces process exit after MCP smoke work", () => {
  const script = readFileSync(new URL("../scripts/source-release.mjs", import.meta.url), "utf8");
  assert.match(script, /process\.exit\(process\.exitCode \?\? 0\)/);
  assert.match(script, /process\.exit\(1\)/);
  assert.match(script, /transport\.pid/);
});
