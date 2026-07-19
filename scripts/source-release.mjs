#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

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
  const bundledNpmCli = path.join(path.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js");
  for (const candidate of [bundledNpmCli, npmExecPath]) {
    if (typeof candidate === "string" && path.basename(candidate) === "npm-cli.js" && isFile(candidate)) {
      return { command: nodeExecPath, args: [candidate] };
    }
  }
  throw new Error("Unable to locate a verified npm CLI.");
}

export function validateReleaseIdentity({ tag, packageMetadata, packageLock }) {
  const version = packageMetadata?.version;
  if (typeof version !== "string" || !version) throw new Error("package.json has no valid version.");
  if (tag !== `v${version}`) throw new Error(`Release tag ${tag} must equal v${version}.`);
  if (packageLock?.version !== version) throw new Error("package-lock.json version does not match package.json.");
  if (packageLock?.packages?.[""]?.version !== version) {
    throw new Error('package-lock.json packages[""] version does not match package.json.');
  }
  if (packageLock?.name !== packageMetadata?.name || packageLock?.packages?.[""]?.name !== packageMetadata?.name) {
    throw new Error("package-lock.json package name does not match package.json.");
  }
  return version;
}

export function extractChangelogSection(changelog, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no dated section for ${version}.`);

  const contentStart = match.index + match[0].length;
  const remainder = changelog.slice(contentStart);
  const nextHeading = /^##\s+/m.exec(remainder);
  const content = remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
  if (!content) throw new Error(`CHANGELOG.md section for ${version} is empty.`);
  return content;
}

function runNpm(args, options = {}) {
  const invocation = resolveNpmInvocation();
  return execFileSync(invocation.command, [...invocation.args, ...args], {
    encoding: "utf8",
    ...options,
  });
}

export function buildSourceRelease({ cwd = process.cwd(), tag, outputDir }) {
  if (!tag || !outputDir) throw new Error("build requires a tag and output directory.");
  const packageMetadata = readJson(path.join(cwd, "package.json"));
  const packageLock = readJson(path.join(cwd, "package-lock.json"));
  const version = validateReleaseIdentity({ tag, packageMetadata, packageLock });
  const changes = extractChangelogSection(readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8"), version);

  mkdirSync(outputDir, { recursive: true });
  const existingFiles = ["RELEASE_NOTES.md", "SHA256SUMS.txt"].filter((name) => existsSync(path.join(outputDir, name)));
  if (existingFiles.length > 0) throw new Error(`Release output already exists: ${existingFiles.join(", ")}.`);

  const packResult = JSON.parse(runNpm(["pack", "--json", "--pack-destination", outputDir], { cwd }));
  const packed = Array.isArray(packResult) ? packResult[0] : packResult;
  if (!packed?.filename || (Array.isArray(packResult) && packResult.length !== 1)) {
    throw new Error("npm pack did not produce exactly one tarball.");
  }

  const tarballPath = path.resolve(outputDir, packed.filename);
  if (!isRegularFile(tarballPath)) throw new Error("npm pack reported a missing tarball.");
  const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  const notes = [
    `# ${packageMetadata.name} ${tag}`,
    "",
    "> Source-only GitHub Release. This package was not published to npm.",
    "",
    "## Changes",
    "",
    changes,
    "",
  ].join("\n");

  writeFileSync(path.join(outputDir, "SHA256SUMS.txt"), `${sha256}  ${packed.filename}\n`, "utf8");
  writeFileSync(path.join(outputDir, "RELEASE_NOTES.md"), notes, "utf8");

  return {
    tag,
    version,
    tarball: packed.filename,
    sha256,
    integrity: packed.integrity,
  };
}

function runInstalledBin(binPath, args = [], options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
}

function requireSuccessfulBin(result, label, pattern) {
  if (result.error || result.status !== 0 || !pattern.test(result.stdout ?? "")) {
    throw new Error(`${label} smoke failed.`);
  }
}

async function verifyMcpHandshake({ serverPath, installRoot, version }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: installRoot,
    env: { OPENCODE_ADVISOR_ALLOWED_ROOTS: installRoot },
    stderr: "pipe",
  });
  const client = new Client({ name: "source-release-verifier", version: "1.0.0" });
  try {
    await client.connect(transport);
    if (client.getServerVersion()?.version !== version) throw new Error("Installed MCP version mismatch.");
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const expected = ["ask_opencode_advisor", "ask_opencode_planner", "get_opencode_task"];
    if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error("Installed MCP tool surface mismatch.");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    // Stdio transport may leave a live child handle on Windows after close races.
    const pid = transport.pid;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // already exited
      }
    }
  }
}

export async function verifySourceRelease({ tarballPath }) {
  if (!isRegularFile(tarballPath)) throw new Error("verify requires an existing tarball.");
  const installRoot = mkdtempSync(path.join(tmpdir(), "opencode-advisor-release-"));
  try {
    runNpm(["install", "--no-audit", "--no-fund", "--prefix", installRoot, path.resolve(tarballPath)], {
      cwd: installRoot,
      stdio: "pipe",
    });
    const packageRoot = path.join(installRoot, "node_modules", "opencode-advisor-mcp");
    const installedPackage = readJson(path.join(packageRoot, "package.json"));
    const resolveBin = (name) => path.join(packageRoot, installedPackage.bin[name]);

    requireSuccessfulBin(
      runInstalledBin(resolveBin("opencode-advisor-agent")),
      "advisor agent",
      /You are codex-advisor/i,
    );
    requireSuccessfulBin(
      runInstalledBin(resolveBin("opencode-advisor-agent"), ["planner"]),
      "planner agent",
      /You are codex-planning-partner/i,
    );

    const setupResult = runInstalledBin(resolveBin("opencode-advisor-setup"));
    if (setupResult.status !== 1 || !/requires an interactive terminal/i.test(setupResult.stderr ?? "")) {
      throw new Error(
        `setup CLI non-interactive smoke failed (status=${setupResult.status}, stderr=${JSON.stringify(setupResult.stderr)}).`,
      );
    }

    const missingProfileHome = path.join(installRoot, `missing-profile-${randomUUID()}`);
    const doctorResult = runInstalledBin(resolveBin("opencode-advisor-doctor"), ["--json"], {
      cwd: installRoot,
      env: {
        ...process.env,
        OPENCODE_ADVISOR_ALLOWED_ROOTS: installRoot,
        OPENCODE_ADVISOR_HOME: missingProfileHome,
      },
    });
    const doctorReport = JSON.parse(doctorResult.stdout || "null");
    if (doctorResult.status !== 1 || doctorReport?.bucket !== "provider_setup_required") {
      throw new Error(
        `doctor CLI fail-closed smoke failed (status=${doctorResult.status}, stdout=${JSON.stringify(doctorResult.stdout)}, stderr=${JSON.stringify(doctorResult.stderr)}, error=${JSON.stringify(doctorResult.error?.message)}).`,
      );
    }

    await verifyMcpHandshake({
      serverPath: resolveBin("opencode-advisor-mcp"),
      installRoot,
      version: installedPackage.version,
    });
    return { ok: true, version: installedPackage.version };
  } finally {
    rmSync(installRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, first, second] = argv;
  if (command === "build") {
    if (!first || !second) throw new Error("build requires a tag and output directory.");
    const result = buildSourceRelease({ tag: first, outputDir: path.resolve(second) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify") {
    if (!first) throw new Error("verify requires a tarball path.");
    const result = await verifySourceRelease({ tarballPath: path.resolve(first) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("Usage: source-release.mjs build <tag> <output-dir> | verify <tarball>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Force process exit so MCP stdio children cannot keep the release CLI alive.
  main()
    .then(() => {
      process.exit(process.exitCode ?? 0);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
