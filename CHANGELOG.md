# Changelog

## Unreleased

### Added

- Added `opencode-advisor-doctor --json` for a single sanitized, machine-readable report with the same checks and exit status as the default text output.
- Added a tag-triggered `Source Release Draft` workflow and `scripts/source-release.mjs` that pack one verified source tarball, write `SHA256SUMS.txt`, smoke the installed bins and MCP surface, and open a Draft GitHub Release without npm publication.

## 0.3.0 - 2026-07-13

- added a shared queued planner/reviewer flow with one MCP server, three tools, and conservative default concurrency limits
- added the read-only `codex-planning-partner` template plus source-local task polling through `get_opencode_task`
- expanded doctor, docs, and print-agent support to cover both bundled OpenCode agents
- centralized shared runtime helpers for command resolution, numeric env parsing, success-response shape, and structured diagnostics
- stabilized GitHub Actions across Ubuntu/Windows and Node 20/22 by using an explicit test entry and adding `print-agent` plus `pack --dry-run` gates
- made Windows-path tests deterministic with injected `win32` path/platform behavior
- fixed OpenCode fallback and upstream detection drift so assistant text and tool output do not trigger false failures in either server or doctor
- aligned public security-reporting docs with GitHub private vulnerability reporting
- clarified source/GitHub install as the current path while npm publication remains future work
- hardened queued task polling so completed/expired/queue-full results stay stable without unnecessary runner restarts, and changed `OPENCODE_ADVISOR_QUEUE_DIR` to act as a direct queue directory override
- added issue-governance triage tracking in `ISSUES_SUMMARY.md` and closed obvious covered/duplicate backlog items
- made queue-directory setup failures return structured errors instead of looking like MCP disconnects
- prevented stale queue thresholds from shrinking below the built-in floor when only the OpenCode timeout is reduced
- aligned `get_opencode_task` with disabled-queue semantics, expanded doctor to validate planner MCP health, and upgraded package-contract tests to inspect the real tarball plus root lockfile metadata
- added Bash/macOS/Linux-oriented install examples and explicit OpenCode CLI prerequisite/version notes

## 0.2.0

First public release.

- sanitized structured responses to avoid leaking local absolute paths and command-resolution details
- replaced personal path fixtures with neutral test fixtures
- added npm-ready package metadata, CLI entrypoints, and packed-install flow
- added public-facing docs, governance files, GitHub templates, CI, and Dependabot

## 0.1.0

Local-only pre-release tag used before public repository publication. Not part of the public release line.
