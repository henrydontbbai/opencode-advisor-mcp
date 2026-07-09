# Issue Governance Summary

This file tracks the current triage state of the public backlog for the active maintenance line.

Status meanings:

- `covered`: already addressed on `main`; close the issue
- `duplicate`: overlaps another open or merged-tracked issue; close in favor of the canonical one
- `next`: keep for the next focused maintenance batch
- `deferred`: real idea or concern, but intentionally out of the current maintenance lane

## Covered / Close

| Issue | Status | Reason | Evidence |
|---|---|---|---|
| #46 | covered | allowed-roots now fail fast at server startup | `src/server.mjs`, merged in `#80` |
| #47 | covered | diff context now goes through best-effort secret redaction | `src/opencode-core.mjs`, docs/tests on `main` |
| #49 | covered | tool schemas are no longer shared/mutated across registrations | `src/server.mjs`, merged in `#80` |
| #51 | covered | runner now handles shutdown and exits cleanly after the current task | `src/task-queue.mjs`, tests on `main` |
| #53 | covered | queue runner stdout/stderr can now be captured via log dir | `src/task-queue.mjs`, docs on `main` |
| #54 | covered | MCP stdio integration tests now exist | `test/mcp-integration.test.mjs`, merged in `#81` |
| #75 | covered | doctor now checks both bundled agents and both MCP health paths | `scripts/opencode-advisor-doctor.mjs`, `test/doctor.test.mjs` |
| #76 | covered | queue admission already uses a submission lock and atomic maxPending check | `src/task-queue.mjs`, `test/queue.test.mjs` |

## Duplicate / Consolidate

| Issue | Status | Canonical issue | Reason |
|---|---|---|---|
| #23 | duplicate | #30 | same `runProcess` stdout/stderr error-handler theme |
| #60 | duplicate | #19 | same allowed-roots canonicalization / symlink bypass family |
| #24 | duplicate | #43 | broad audit follow-up umbrella, less actionable than the later audit issue |
| #11 | duplicate | #43 | older umbrella audit issue with overlapping findings |

## Covered In This Maintenance Branch

These are implemented in `codex/issue-governance-maintenance` and should close on merge.

| Issue | Status | Reason | Evidence |
|---|---|---|---|
| #65 | covered | queue-dir permission failures now degrade to a structured error instead of looking like a dropped connection | `src/task-queue.mjs`, `test/queue.test.mjs` |
| #66 | covered | stale thresholds no longer shrink below the built-in floor just because timeout is reduced | `src/task-queue.mjs`, `test/queue.test.mjs` |
| #67 | covered | `get_opencode_task` now has explicit behavior when queue mode is disabled | `src/server.mjs`, `test/server.test.mjs` |
| #68 | covered | install docs now include Bash/macOS/Linux-friendly examples alongside PowerShell | `README.md`, `docs/INSTALL.md` |
| #69 | covered | public docs now state prerequisites and current validated OpenCode CLI version | `README.md`, `docs/INSTALL.md`, `docs/USAGE.md` |
| #78 | covered | bug template now requests doctor output, agent status, MCP config, install mode, and redaction guidance | `.github/ISSUE_TEMPLATE/bug_report.yml` |
| #79 | covered | package-contract tests now validate the real tarball contents and package-lock root metadata drift | `test/package-contract.test.mjs` |

## Deferred

| Issue | Status | Reason |
|---|---|---|
| #3 / #42 | deferred | `zod` v4 remains a separate dependency-upgrade track |
| #17 | deferred | debug mode expands diagnostics scope and should be considered separately |
| #26 | deferred | larger security/release hardening lane, not part of current maintenance scope |
| #41 | deferred | future feature bucket, intentionally out of the stability-first path |
| #71 | deferred | opening more diagnostic fields risks public response-surface expansion |
| #72 | deferred | new queue/task-control tools would expand the MCP contract |
| #73 | deferred | doctor-in-CI / JSON output remains out of scope for this round |

## Operating Rules

- Keep `main` as the source of truth for whether an issue is still real.
- Do not mix `zod` v4, release automation, npm publication, or new MCP tools into the shortlist above.
- If a new issue duplicates one already listed here, prefer updating the canonical issue instead of growing parallel threads.
