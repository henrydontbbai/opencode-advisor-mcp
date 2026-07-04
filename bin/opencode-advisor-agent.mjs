#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(binDir, "..", "agents", "codex-advisor.md");

process.stdout.write(readFileSync(agentPath, "utf8"));
