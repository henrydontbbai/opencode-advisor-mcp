#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const requested = String(process.argv[2] || "advisor").toLowerCase();
const agentName =
  requested === "planner" || requested === "codex-planning-partner" ? "codex-planning-partner.md" : "codex-advisor.md";
const agentPath = path.join(binDir, "..", "agents", agentName);

process.stdout.write(readFileSync(agentPath, "utf8"));
