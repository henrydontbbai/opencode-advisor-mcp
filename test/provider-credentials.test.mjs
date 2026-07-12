import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readProviderCredential,
  writeProviderCredential,
} from "../src/provider-credentials.mjs";

const MANIFEST_FINGERPRINT = "a".repeat(43);

test("credential storage keeps the provider key out of plaintext profile files", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-credential-"));
  const credentialPath = path.join(home, "provider-credential.json");
  try {
    await writeProviderCredential({
      credentialPath,
      credential: "provider-secret-value",
      manifestFingerprint: MANIFEST_FINGERPRINT,
      platform: "linux",
    });

    const stored = readFileSync(credentialPath, "utf8");
    assert.equal(stored.includes("provider-secret-value"), false);
    assert.equal(
      await readProviderCredential({
        credentialPath,
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        platform: "linux",
      }),
      "provider-secret-value",
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialPath).mode & 0o077, 0);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows credential storage delegates protection and unprotection without exposing the key in metadata", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-windows-credential-"));
  const credentialPath = path.join(home, "provider-credential.json");
  const seen = [];
  try {
    await writeProviderCredential({
      credentialPath,
      credential: "provider-secret-value",
      manifestFingerprint: MANIFEST_FINGERPRINT,
      platform: "win32",
      protect: async (value) => {
        seen.push(["protect", value]);
        return "ciphertext";
      },
    });

    assert.equal(readFileSync(credentialPath, "utf8").includes("provider-secret-value"), false);
    assert.equal(
      await readProviderCredential({
        credentialPath,
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        platform: "win32",
        unprotect: async (value) => {
          seen.push(["unprotect", value]);
          return "provider-secret-value";
        },
      }),
      "provider-secret-value",
    );
    assert.deepEqual(seen, [["protect", "provider-secret-value"], ["unprotect", "ciphertext"]]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("credential storage rejects invalid input and corrupted data without echoing a credential", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "advisor-invalid-credential-"));
  const credentialPath = path.join(home, "provider-credential.json");
  const secret = "provider-secret-value";
  try {
    await assert.rejects(
      writeProviderCredential({
        credentialPath,
        credential: "",
        manifestFingerprint: MANIFEST_FINGERPRINT,
        platform: "linux",
      }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );

    writeFileSync(credentialPath, `{not valid JSON ${secret}`, "utf8");
    await assert.rejects(
      readProviderCredential({
        credentialPath,
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        platform: "linux",
      }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
