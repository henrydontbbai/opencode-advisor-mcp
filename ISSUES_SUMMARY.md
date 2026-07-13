# Issue Governance Summary

This file tracks the current triage state of the public backlog on `main`.

Status meanings:

- `covered`: already addressed on `main`; close the issue
- `duplicate`: overlaps another open or merged-tracked issue; close in favor of the canonical one
- `next`: keep for the next focused maintenance batch
- `deferred`: real idea or concern, but intentionally out of the current maintenance lane

## Release Closeout Evidence

The release baseline documented below is `24e86a3` (the `#102` merge); `#100` and `#101` are governance-only metadata updates in this sequence. The rows were checked against the GitHub merge commit, required Ubuntu/Windows x Node 20/22 CI checks, and GitHub closing references on 2026-07-13. A blank closing-reference cell means the PR did not declare an issue for automatic closure; it is not evidence that a separately tracked issue was skipped.

| PR | Merge commit on `main` | CI evidence | GitHub closing references |
|---|---|---|---|
| #89 | `06c198e` | required Ubuntu/Windows x Node 20/22 checks succeeded | none; governance-only PR |
| #91 | `8b994d6` | required Ubuntu/Windows x Node 20/22 checks succeeded | #20, #90 |
| #92 | `bcbb581` | required Ubuntu/Windows x Node 20/22 checks succeeded | #21, #27, #44 |
| #93 | `fd84cd8` | required Ubuntu/Windows x Node 20/22 checks succeeded | #36, #50 |
| #94 | `4e8262c` | required Ubuntu/Windows x Node 20/22 checks succeeded | #13, #14, #32, #40, #55 |
| #95 | `34e8547` | required Ubuntu/Windows x Node 20/22 checks succeeded | #29, #37, #38, #48, #52, #74 |
| #96 | `3307c19` | required Ubuntu/Windows x Node 20/22 checks succeeded | none; independent provider bootstrap |
| #99 | `925b6b4` | required Ubuntu/Windows x Node 20/22 checks succeeded | #16 |
| #97 | `fea2d2b` | required Ubuntu/Windows x Node 20/22 checks succeeded | #34 |
| #98 | `262e7bc` | required Ubuntu/Windows x Node 20/22 checks succeeded | none; #43 remains an umbrella |
| #102 | `24e86a3` | required Ubuntu/Windows x Node 20/22 checks succeeded | none; part of #45, which remains an umbrella |

## Dependency Decision Evidence

`#3` merged at `eb541b8` after clean-worktree release checks, four required GitHub CI checks, a real six-step provider doctor pass, and a blocker-only OpenCode review of `BLOCKER: none`. It upgrades `zod` from `3.25.76` to `4.4.3` without changing `@modelcontextprotocol/sdk@1.29.0`. `#42` was then closed as completed.

## Covered / Close

| Issue | Status | Reason | Evidence |
|---|---|---|---|
| #16 | covered | runtime and prompt-boundary stability coverage completed without a public-contract change | `#99` merged at `925b6b4`; issue automatically closed |
| #34 | covered | queue recovery, heartbeat, polling, startup-reservation, and shared-runtime edge coverage completed | `#97` merged at `fea2d2b`; issue automatically closed |
| #42 | covered | `zod` v4 dependency decision accepted and merged | `#3` merged at `eb541b8`; issue closed as completed |
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
| #18 | covered | requested working directories containing NUL bytes are rejected before filesystem or process work begins | `src/opencode-core.mjs`, regression tests merged in `#85` |
| #19 | covered | configured roots and request cwd values are canonicalized before containment checks, blocking symlink and junction escapes | `src/opencode-core.mjs`, regression tests merged in `#85` |
| #22 | covered | runner ownership now uses runner ids, PIDs, leases, and atomic stale-owner takeover | `src/task-queue.mjs`, regression tests merged in `#84` |
| #25 | covered | queue runner isolates bounded iteration failures and releases its owned lease before a clean restart | `src/task-queue.mjs`, regression tests merged in `#84` |
| #35 | covered | queue tests use managed temporary directories and deterministic gates for concurrent runner behavior | `test/queue.test.mjs`, regression tests merged in `#84` |
| #56 | covered | stale runner lock recovery now verifies ownership and lease state before takeover | `src/task-queue.mjs`, regression tests merged in `#84` |
| #58 | covered | heartbeat ownership prevents stale or ghost runners from deleting a live runner state | `src/task-queue.mjs`, regression tests merged in `#84` |

## Next

The dedicated `#16` and `#34` stability lanes are complete. Keep follow-up work under the existing umbrellas so it remains separately scoped from release, dependency, and MCP-contract changes.

| Issue | Focus | Required evidence before closure or merge |
|---|---|---|
| #43 | Keep the deep-audit umbrella open for newly substantiated input, runtime, or UX risks. | Start from a focused reproduction and preserve the three-tool public contract; do not reopen the delivered task-id or drive-relative-path work. |
| #45 | Keep the queue-lifecycle umbrella open for operational concurrency evidence beyond the completed test lane. `#102` fenced stale recovery snapshots so a public poll cannot overwrite a terminal runner result. | Reproduce a remaining lifecycle risk under a focused fault or multi-process test before changing queue behavior; retain token fencing and existing top-level error codes. |

## Stability Completion Matrix

### #16: Runtime and prompt coverage (closed)

| Original concern | Covered on `main` | Closure evidence |
|---|---|---|
| Exact OpenCode role/CLI construction | `test/provider-runtime.test.mjs` asserts reviewer/planner agent, model, variant, `--pure`, directory, and JSON format arguments. | Existing role-isolation regressions retained in `#99`. |
| Prompt construction and input boundaries | Planner `CURRENT_PLAN`, `CONSTRAINTS`, goal, and question are bounded as untrusted content; delimiter-like input is neutralized. | `#99` added focused runtime regressions. |
| Empty, malformed, and fallback-like output | Successful plain-text or empty OpenCode output fails closed; structured diagnostics retain fallback handling. | `#99` added the non-JSON/empty-output regressions. |

### #34: Queue and shared-runtime coverage (closed)

| Original concern | Covered on `main` | Closure evidence |
|---|---|---|
| Terminal states and heartbeat recovery | `test/queue.test.mjs` covers missing terminal results plus missing or malformed runner heartbeats. | `#97` added public-entry regressions. |
| Polling and detached runner startup | Queue tests cover fresh leases, shared pending-poll suppression, stale startup retry, failed startup retry, and cross-process reservation recovery. | `#97` adds multi-process and token-fencing coverage. |
| Lease-acquisition failure cleanup | A child that cannot acquire a fresh lease releases only its matching startup reservation; a delayed child cannot remove a replacement reservation. | `f6484d2` in `#97`, with integration regressions. |
| Numeric and public success-shape helpers | `positiveNumber` rejects non-positive/non-finite values and reviewer/planner success factories have matching contracts. | `test/runtime-shared.test.mjs` coverage included in `#97`. |

## Umbrella Scope

| Umbrella | Covered by merged work | Remaining scoped work |
|---|---|---|
| #43 | Real-path containment (`#85`), process-tree timeout cleanup (`#87`), queue/session isolation (`#91`), runtime command and prompt hardening (`#92`), release gates (`#93`), independent provider isolation (`#96`), and the task-id/Windows drive-relative-path boundary (`#98`) cover the delivered audit findings. | Keep the umbrella for newly substantiated audit risks. Diagnostic response expansion remains deferred under #71; diff caching and broader observability remain outside this lane. |
| #45 | Queue runner leases, atomic stale-owner takeover, exact-once claims, heartbeat ownership, signal cleanup, stale-task recovery, terminal-state/heartbeat polling evidence, fenced startup reservations, and recovery snapshot fencing are covered by `#84`, `#91`, `#94`, `#96`, `#97`, and `#102`. | Keep the umbrella for remaining operational lifecycle evidence, especially fault or multi-process reproductions not covered by the closed `#34` test lane. Do not introduce new top-level error codes or queue-control MCP tools here. |

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
| #17 | deferred | debug mode expands diagnostics scope and should be considered separately |
| #26 | deferred | `test:doctor` is already in CI; the remaining decision is a non-blocking `npm audit` policy, not a new release-gate change |
| #41 | deferred | future feature bucket, intentionally out of the stability-first path |
| #12 | deferred | formatter and lint adoption is a separate tooling decision; reconsider after the release-readiness lane |
| #15 | deferred | OpenCode permission precedence needs upstream-confirmed behavior before changing agent policy |
| #28 | deferred | diff caching changes cost and freshness behavior; revisit with production usage evidence |
| #31 | deferred | prompt de-duplication is a later agent-template design change, not a reliability fix |
| #33 | deferred | broader feature work remains outside the stability-first lane |
| #39 / #77 | deferred | more precise public failure codes require a deliberate compatibility/versioning decision |
| #70 | deferred | Codex outer timeout is not reliably observable from this server; keep current documentation guidance |
| #71 | deferred | opening more diagnostic fields risks public response-surface expansion |
| #72 | deferred | new queue/task-control tools would expand the MCP contract |
| #73 | deferred | `test:doctor` is already in CI; only `doctor --json` remains, as a separately designed CLI-output feature |

## Operating Rules

- Keep `main` as the source of truth for whether an issue is still real.
- Do not mix `zod` v4, release automation, npm publication, or new MCP tools into the shortlist above.
- Keep the public MCP contract frozen for future `#43` and `#45` maintenance: exactly three tools, existing success fields, and existing top-level error codes.
- If a new issue duplicates one already listed here, prefer updating the canonical issue instead of growing parallel threads.
- Keep `#43` open as the audit umbrella and `#45` open as the queue-lifecycle umbrella until their remaining scoped work has evidence.
- Close only issues with a merged implementation and a focused regression or acceptance test; record the merged PR in this table.
