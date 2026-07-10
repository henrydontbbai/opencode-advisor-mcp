# Issue Governance Summary

This file tracks the current triage state of the public backlog on `main`.

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
| #57 | covered | task files now write through a temporary file and atomic rename | `src/task-queue.mjs`, merged in `#80` |
| #59 | covered | quoted Windows roots can preserve literal semicolons | `src/opencode-core.mjs`, merged in `#83` |
| #63 | covered | diff context truncation preserves complete lines | `src/opencode-core.mjs`, merged in `#83` |
| #64 | covered | Git context now degrades per command instead of failing as a whole | `src/opencode-core.mjs`, merged in `#83` |
| #65 | covered | queue-dir permission failures now degrade to a structured error instead of looking like a dropped connection | `src/task-queue.mjs`, merged in `#82` |
| #66 | covered | stale thresholds no longer shrink below the built-in floor just because timeout is reduced | `src/task-queue.mjs`, merged in `#82` |
| #67 | covered | `get_opencode_task` now has explicit behavior when queue mode is disabled | `src/server.mjs`, merged in `#82` |
| #68 | covered | install docs now include Bash/macOS/Linux-friendly examples alongside PowerShell | `README.md`, merged in `#82` |
| #69 | covered | public docs now state prerequisites and current validated OpenCode CLI version | `README.md`, `docs/INSTALL.md`, `docs/USAGE.md`, merged in `#82` |
| #75 | covered | doctor now checks both bundled agents and both MCP health paths | `scripts/opencode-advisor-doctor.mjs`, `test/doctor.test.mjs` |
| #76 | covered | queue admission already uses a submission lock and atomic maxPending check | `src/task-queue.mjs`, `test/queue.test.mjs` |
| #78 | covered | bug template now requests doctor output, agent status, MCP config, install mode, and redaction guidance | `.github/ISSUE_TEMPLATE/bug_report.yml`, merged in `#82` |
| #79 | covered | package-contract tests now validate the real tarball contents and package-lock root metadata drift | `test/package-contract.test.mjs`, merged in `#82` |
| #30 | covered | `runProcess` handles stdout/stderr failures and keeps settlement exactly once | `src/opencode-core.mjs`, regression tests merged in `#86` |
| #61 | covered | subprocess output preserves CRLF and UTF-8 text across chunk boundaries | `src/opencode-core.mjs`, regression tests merged in `#86` |
| #62 | covered | timeout cleanup targets the Windows process tree and POSIX inherited process group | `src/opencode-core.mjs`, process-tree regressions merged in `#87` |

## Duplicate / Consolidate

| Issue | Status | Canonical issue | Reason |
|---|---|---|---|
| #23 | duplicate | #30 | same `runProcess` stdout/stderr error-handler theme |
| #60 | duplicate | #19 | same allowed-roots canonicalization / symlink bypass family |
| #24 | duplicate | #43 | broad audit follow-up umbrella, less actionable than the later audit issue |
| #11 | duplicate | #43 | older umbrella audit issue with overlapping findings |

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
