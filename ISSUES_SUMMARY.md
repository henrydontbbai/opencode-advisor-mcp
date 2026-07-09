# Comprehensive Code Review Findings - Issue Summary

This document consolidates all findings from a deep multi-perspective code review of `opencode-advisor-mcp`. Each section maps to one or more GitHub issues that should be created.

---

## 🔴 Critical Issues (Security & Stability)

### Issue 1: Missing Startup Validation for `OPENCODE_ADVISOR_ALLOWED_ROOTS`
**File**: `src/server.mjs:69-126`  
**Severity**: Critical  
**Description**: The server starts successfully even when `OPENCODE_ADVISOR_ALLOWED_ROOTS` is unset or empty, defaulting to an empty allowed-roots array which permits any working directory via `parseAllowedRoots()` returning `[]`.  
**Impact**: Users can accidentally expose arbitrary filesystem paths to OpenCode.  
**Fix**: Fail fast in `createServer()` if allowed roots are not configured.

```mjs
// In createServer(), add:
const allowedRoots = parseAllowedRoots(undefined, deps.env ?? process.env, deps.path ?? path);
if (allowedRoots.length === 0) {
  throw new Error("OPENCODE_ADVISOR_ALLOWED_ROOTS must be set to at least one allowed root directory");
}
```

---

### Issue 2: Git Diff Sent to OpenCode May Contain Secrets
**File**: `src/opencode-core.mjs:187-205`  
**Severity**: Critical  
**Description**: `collectGitContext()` sends raw git diff (including staged/unstaged changes) to OpenCode without any secret detection/redaction.  
**Impact**: API keys, tokens, passwords in diffs are transmitted to the configured OpenCode provider (potentially remote).  
**Fix**: Add optional secret redaction via `OPENCODE_ADVISOR_REDACT_SECRETS=true` env var. Use regex patterns for common secret formats (AWS, GitHub, npm, generic API keys) before sending to OpenCode.

---

### Issue 3: Mutable Shared Schema Object Bug
**File**: `src/server.mjs:72-104`  
**Severity**: High  
**Description**: `commonInput` object is spread into planner tool schema, mutating the shared object:
```mjs
const commonInput = { cwd: z.string().optional(), ... };  // line 72-81
server.registerTool("ask_opencode_advisor", { inputSchema: commonInput }, ...);  // line 83-93
server.registerTool("ask_opencode_planner", { 
  inputSchema: { ...commonInput, current_plan: ..., constraints: ... }  // line 100-104 MUTATES commonInput!
}, ...);
```
**Impact**: Advisor tool schema unexpectedly gains `current_plan` and `constraints` fields.  
**Fix**: Use `Object.freeze(commonInput)` or create fresh objects per registration.

---

## 🟠 High Priority (Architecture & Reliability)

### Issue 4: Duplicated `runProcess` Implementation (3 copies)
**Files**: 
- `src/opencode-core.mjs:100-137`
- `src/server.mjs` (imports from core)
- `scripts/opencode-advisor-doctor.mjs:24-58`

**Description**: Identical process spawning logic with timeout, stdin/stdout/stderr handling, Windows shell detection duplicated in three places.  
**Fix**: Export `runProcess` from `src/runtime-shared.mjs` and import everywhere.

---

### Issue 5: Queue Runner Lacks Graceful Shutdown
**File**: `src/queue-runner.mjs:1-16`  
**Severity**: High  
**Description**: Runner process ignores `SIGTERM`/`SIGINT`. If the runner is killed mid-task, the task stays in `running` state until `runningStaleMs` expires (default: timeout + 120s).  
**Fix**: Add signal handlers to finish current task, update status, release lock, then exit.

```mjs
// In runQueueRunner():
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { shuttingDown = true; });
}
// In main loop, check shuttingDown and break after current task
```

---

### Issue 6: No Observability / Metrics for Queue System
**File**: `src/task-queue.mjs`  
**Severity**: High  
**Description**: No visibility into queue depth, processing latency, error rates, or runner health. Operators cannot monitor if queue is stuck.  
**Fix**: Add optional structured logging (JSON lines) for:
- Task submitted/completed/failed/expired
- Queue depth per role
- Runner start/stop/heartbeat
- Configurable via `OPENCODE_ADVISOR_QUEUE_LOG_LEVEL=info|debug`

---

### Issue 7: Runner Stdout/Stderr Discarded (Debugging Blindness)
**File**: `src/task-queue.mjs:472-478`  
```mjs
const child = spawnProcess(nodeExec, [RUNNER_SCRIPT_PATH], {
  cwd: config.queueDir,
  env: runnerEnv,
  detached: true,
  windowsHide: true,
  stdio: "ignore",  // <-- All output lost
});
```
**Severity**: High  
**Fix**: Redirect runner output to log files in queue dir (e.g., `runner-<pid>.log`) when `OPENCODE_ADVISOR_QUEUE_LOG_DIR` is set.

---

## 🟡 Medium Priority (Quality & Developer Experience)

### Issue 8: No End-to-End MCP Protocol Tests
**Gap**: Tests mock `runProcess` but never exercise the actual MCP server (`McpServer` + `StdioServerTransport`) with real JSON-RPC messages.  
**Impact**: Protocol-level bugs (tool registration, response formatting, error mapping) not caught.  
**Fix**: Add integration test that spawns `node src/server.mjs`, speaks MCP over stdio, verifies tool calls/results.

---

### Issue 9: Queue Runner Crash Recovery Not Tested
**Gap**: `runQueueRunner` tested only indirectly. No test for: runner process crash mid-task, lock file stale detection, task requeue on runner death.  
**Fix**: Add integration test that spawns real runner, kills it, verifies task requeued.

---

### Issue 10: All Queue Config Env Vars Undocumented
**File**: `src/task-queue.mjs:363-384` defines 13 queue-specific env vars.  
**Doc**: `docs/USAGE.md` documents only 5.  
**Missing**: `OPENCODE_ADVISOR_QUEUE_MAX_PENDING`, `OPENCODE_ADVISOR_TASK_TTL_MS`, `OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS`, `OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS`, `OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS`, `OPENCODE_ADVISOR_QUEUE_POLL_MS`.  
**Fix**: Document all in `USAGE.md` with defaults and tuning guidance.

---

### Issue 11: Windows-Centric Documentation
**Files**: `README.md`, `INSTALL.md`, `USAGE.md`, `ACCEPTANCE.md`  
**Gap**: All examples use PowerShell syntax (`$env:VAR`, `Copy-Item`, backslash paths). No equivalent Bash/zsh examples for Linux/macOS users.  
**Fix**: Add dual-shell examples or separate Unix install section.

---

### Issue 12: No Architecture Diagram
**Gap**: Complex system (MCP server → queue → runner → OpenCode) with no visual documentation.  
**Fix**: Add `docs/ARCHITECTURE.md` with Mermaid diagram showing components, data flow, and failure modes.

---

### Issue 13: No Secret Scanning in CI
**Gap**: GitHub Actions workflow (`.github/workflows/ci.yml`) has no secret detection step.  
**Fix**: Add `gitleaks` or `trufflehog` job to CI pipeline.

---

## 🟢 Low Priority (Nice-to-Have)

### Issue 14: Adaptive Queue Polling
**File**: `src/task-queue.mjs:381` - fixed 1000ms poll interval  
**Improvement**: Exponential backoff when queue empty (e.g., 1s → 2s → 5s → 10s max), reset on new task.

---

### Issue 15: Per-Project Queue Directories
**File**: `src/task-queue.mjs:74-86` - single global queue dir  
**Improvement**: Hash `cwd` to create project-specific subdirectories, avoiding cross-project contention.

---

### Issue 16: Priority Queue Support
**Current**: FIFO only  
**Improvement**: Add `priority` field to task schema; interactive reviews get higher priority than batch.

---

### Issue 17: Automated Release Workflow
**Gap**: Manual release process per `RELEASING.md`  
**Improvement**: Add `.github/workflows/release.yml`:
- Trigger on tag push (`v*`)
- Run full test suite
- `npm pack` + verify tarball contents
- Create GitHub Release from `CHANGELOG.md`
- (Future) `npm publish --provenance --access public`

---

### Issue 18: Coverage Threshold in CI
**Gap**: No coverage enforcement  
**Improvement**: Add `c8` with `--lines 80 --branches 70 --functions 80 --statements 80` to CI.

---

### Issue 19: MCP Client Config Examples
**Gap**: No `.vscode/mcp.json` or Claude Desktop config examples  
**Improvement**: Add to `docs/USAGE.md`.

---

### Issue 20: Troubleshooting Guide
**Gap**: No `docs/TROUBLESHOOTING.md`  
**Improvement**: Document common errors:
- Queue stuck (stale lock file)
- Agent fallback detection
- Timeout tuning (`OPENCODE_ADVISOR_TIMEOUT_MS` vs MCP `tool_timeout_sec`)
- Windows `opencode.exe` path resolution

---

## 📋 Suggested Issue Creation Order

| Phase | Issues | Rationale |
|-------|--------|-----------|
| **Sprint 1** | #1, #2, #3, #4 | Critical security + core bug fixes |
| **Sprint 2** | #5, #6, #7 | Queue reliability & observability |
| **Sprint 3** | #8, #9, #10 | Test gaps + documentation |
| **Sprint 4** | #11, #12, #13 | DX improvements + CI hardening |
| **Backlog** | #14-#20 | Nice-to-have enhancements |

---

## Labels to Use

- `security` — #1, #2
- `bug` — #3, #4
- `reliability` — #5, #6, #7
- `testing` — #8, #9
- `documentation` — #10, #11, #12, #19, #20
- `ci` — #13, #17, #18
- `enhancement` — #14, #15, #16

---

*Generated from comprehensive code review on 2026-07-09*