import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CREDENTIAL_FORMAT_VERSION = 2;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_STORED_TEXT_LENGTH = 2 * 1024 * 1024;
const CREDENTIAL_ERROR_CODE = "OPENCODE_ADVISOR_CREDENTIAL_UNAVAILABLE";
const MANIFEST_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const POWERSHELL_TIMEOUT_MS = 30000;
const HELPER_ENVIRONMENT_NAMES = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "PATH",
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
];

function canEnforcePosixPermissions(platform) {
  return platform !== "win32" && process.platform !== "win32";
}

const PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$encoded = [Console]::In.ReadToEnd().Trim()",
  "$plain = [Convert]::FromBase64String($encoded)",
  "$cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($cipher))",
].join("; ");

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$encoded = [Console]::In.ReadToEnd().Trim()",
  "$cipher = [Convert]::FromBase64String($encoded)",
  "$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join("; ");

function credentialError(message = "Provider credential is unavailable or invalid.") {
  const error = new Error(message);
  error.code = CREDENTIAL_ERROR_CODE;
  return error;
}

function validateCredential(credential) {
  if (typeof credential !== "string" || credential.length === 0) {
    throw credentialError("Provider credential must be a non-empty string.");
  }
  if (Buffer.byteLength(credential, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw credentialError("Provider credential is too large to store securely.");
  }
  return credential;
}

function validateManifestFingerprint(value) {
  if (typeof value !== "string" || !MANIFEST_FINGERPRINT_PATTERN.test(value)) {
    throw credentialError("Provider credential manifest binding is invalid.");
  }
  return value;
}

function validateCredentialPath(credentialPath) {
  if (typeof credentialPath !== "string" || credentialPath.length === 0 || credentialPath.includes("\0")) {
    throw credentialError("Provider credential storage path is invalid.");
  }
  return credentialPath;
}

function isCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STORED_TEXT_LENGTH) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length > 0 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function decodeBase64(value) {
  if (!isCanonicalBase64(value)) throw credentialError();
  return Buffer.from(value, "base64");
}

function parseStoredJson(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_STORED_TEXT_LENGTH) {
    throw credentialError();
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw credentialError();
    return value;
  } catch (error) {
    if (error?.code === CREDENTIAL_ERROR_CODE) throw error;
    throw credentialError();
  }
}

function hasOnlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseWindowsMetadata(text) {
  const value = parseStoredJson(text);
  if (
    !hasOnlyKeys(value, ["version", "platform", "manifest_fingerprint", "ciphertext"]) ||
    value.version !== CREDENTIAL_FORMAT_VERSION ||
    value.platform !== "win32" ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length === 0 ||
    value.ciphertext.length > MAX_STORED_TEXT_LENGTH
  ) {
    throw credentialError();
  }
  return {
    ciphertext: value.ciphertext,
    manifestFingerprint: validateManifestFingerprint(value.manifest_fingerprint),
  };
}

function parsePosixMetadata(text) {
  const value = parseStoredJson(text);
  if (
    !hasOnlyKeys(value, ["version", "platform", "encoding", "manifest_fingerprint", "credential"]) ||
    value.version !== CREDENTIAL_FORMAT_VERSION ||
    value.platform !== "posix" ||
    value.encoding !== "base64"
  ) {
    throw credentialError();
  }
  const encoded = decodeBase64(value.credential);
  const credential = encoded.toString("utf8");
  if (!Buffer.from(credential, "utf8").equals(encoded)) throw credentialError();
  return {
    credential,
    manifestFingerprint: validateManifestFingerprint(value.manifest_fingerprint),
  };
}

function createHelperEnvironment(env = process.env) {
  const helperEnv = {};
  for (const name of HELPER_ENVIRONMENT_NAMES) {
    if (typeof env[name] === "string" && env[name]) {
      helperEnv[name] = env[name];
    }
  }
  return helperEnv;
}

function getPowerShellExecutable(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw credentialError();
  }
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(executable)) throw credentialError();
  return executable;
}

function runPowerShell(script, input, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    try {
      child = spawn(getPowerShellExecutable(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        env: createHelperEnvironment(env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(credentialError());
      return;
    }

    let output = "";
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(credentialError());
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > MAX_STORED_TEXT_LENGTH) {
        child.kill();
        fail();
      }
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stderr.resume?.();
    child.on("close", (code) => {
      const value = output.trim();
      if (code !== 0 || !isCanonicalBase64(value)) {
        fail();
        return;
      }
      succeed(value);
    });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      fail();
    }, POWERSHELL_TIMEOUT_MS);
    try {
      child.stdin.end(`${input}\n`, "utf8");
    } catch {
      fail();
    }
  });
}

async function defaultProtect(credential) {
  const plaintext = Buffer.from(credential, "utf8").toString("base64");
  return runPowerShell(PROTECT_SCRIPT, plaintext);
}

async function defaultUnprotect(ciphertext) {
  const plaintext = await runPowerShell(UNPROTECT_SCRIPT, ciphertext);
  return Buffer.from(plaintext, "base64").toString("utf8");
}

async function ensurePrivateDirectory(directory, platform) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let details = await fs.lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw credentialError();
  if (canEnforcePosixPermissions(platform)) {
    await fs.chmod(directory, 0o700);
    details = await fs.lstat(directory);
    if ((details.mode & 0o077) !== 0) throw credentialError();
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw credentialError();
  }
}

async function assertPrivateFile(filePath, platform) {
  const details = await fs.lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw credentialError();
  if (!canEnforcePosixPermissions(platform)) return;
  if ((details.mode & 0o077) !== 0) throw credentialError();
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw credentialError();
}

async function writeAtomically(credentialPath, value, platform) {
  const directory = path.dirname(credentialPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(credentialPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await ensurePrivateDirectory(directory, platform);
    await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    if (canEnforcePosixPermissions(platform)) {
      await fs.chmod(temporaryPath, 0o600);
    }
    await fs.rename(temporaryPath, credentialPath);
    if (canEnforcePosixPermissions(platform)) {
      await fs.chmod(credentialPath, 0o600);
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (error?.code === CREDENTIAL_ERROR_CODE) throw error;
    throw credentialError("Provider credential could not be stored securely.");
  }
}

export async function writeProviderCredential({
  credentialPath,
  credential,
  manifestFingerprint,
  platform = process.platform,
  protect,
} = {}) {
  validateCredentialPath(credentialPath);
  validateCredential(credential);
  validateManifestFingerprint(manifestFingerprint);
  try {
    if (platform === "win32") {
      const protectValue = protect ?? defaultProtect;
      if (typeof protectValue !== "function") throw credentialError();
      const ciphertext = await protectValue(credential);
      if (typeof ciphertext !== "string" || ciphertext.length === 0 || ciphertext === credential) {
        throw credentialError();
      }
      await writeAtomically(
        credentialPath,
        {
          version: CREDENTIAL_FORMAT_VERSION,
          platform: "win32",
          manifest_fingerprint: manifestFingerprint,
          ciphertext,
        },
        platform,
      );
      return;
    }

    await writeAtomically(
      credentialPath,
      {
        version: CREDENTIAL_FORMAT_VERSION,
        platform: "posix",
        encoding: "base64",
        manifest_fingerprint: manifestFingerprint,
        credential: Buffer.from(credential, "utf8").toString("base64"),
      },
      platform,
    );
  } catch (error) {
    if (error?.code === CREDENTIAL_ERROR_CODE) throw error;
    throw credentialError("Provider credential could not be stored securely.");
  }
}

export async function readProviderCredential({
  credentialPath,
  expectedManifestFingerprint,
  platform = process.platform,
  unprotect,
} = {}) {
  validateCredentialPath(credentialPath);
  validateManifestFingerprint(expectedManifestFingerprint);
  try {
    await assertPrivateFile(credentialPath, platform);
    const text = await fs.readFile(credentialPath, "utf8");
    if (platform === "win32") {
      const unprotectValue = unprotect ?? defaultUnprotect;
      if (typeof unprotectValue !== "function") throw credentialError();
      const metadata = parseWindowsMetadata(text);
      if (metadata.manifestFingerprint !== expectedManifestFingerprint) throw credentialError();
      const credential = await unprotectValue(metadata.ciphertext);
      return validateCredential(credential);
    }
    const metadata = parsePosixMetadata(text);
    if (metadata.manifestFingerprint !== expectedManifestFingerprint) throw credentialError();
    return validateCredential(metadata.credential);
  } catch (error) {
    if (error?.code === CREDENTIAL_ERROR_CODE) throw error;
    throw credentialError();
  }
}
