# Issue Governance Summary

This file tracks the current triage state of the public backlog on `main`.

Status meanings:

- `covered`: already addressed on `main`; close the issue
- `duplicate`: overlaps another open or merged-tracked issue; close in favor of the canonical one
- `consolidate`: close an over-broad bucket after preserving its focused work in narrower issues
- `next`: keep for the next focused maintenance batch
- `deferred`: real idea or concern, but intentionally out of the current maintenance lane
- `wontfix`: deliberately rejected because the proposed behavior weakens a product or security boundary

## Release Closeout Evidence

The release commit is `f441977` (the `#106` merge). The current post-release baseline is `5ccc59f` (the `#109` merge); `#100`, `#101`, `#103`, and `#107` are governance-only metadata updates in this sequence. The rows were checked against the GitHub merge commit, required Ubuntu/Windows x Node 20/22 CI checks, and GitHub closing references on 2026-07-13. A blank closing-reference cell means the PR did not declare an issue for automatic closure; it is not evidence that a separately tracked issue was skipped.

| PR   | Merge commit on `main` | CI evidence                                                           | GitHub closing references                    |
| ---- | ---------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| #89  | `06c198e`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | none; governance-only PR                     |
| #91  | `8b994d6`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #20, #90                                     |
| #92  | `bcbb581`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #21, #27, #44                                |
| #93  | `fd84cd8`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #36, #50                                     |
| #94  | `4e8262c`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #13, #14, #32, #40, #55                      |
| #95  | `34e8547`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #29, #37, #38, #48, #52, #74                 |
| #96  | `3307c19`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | none; independent provider bootstrap         |
| #99  | `925b6b4`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #16                                          |
| #97  | `fea2d2b`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | #34                                          |
| #98  | `262e7bc`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | none; #43 remains an umbrella                |
| #102 | `24e86a3`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | none; part of #45, which remains an umbrella |
| #104 | `06122dc`              | main push CI run `29256376659`: Ubuntu/Windows x Node 20/22 succeeded | none; CI timing-flake test fix               |
| #105 | `e4164b7`              | main push CI run `29258169856`: Ubuntu/Windows x Node 20/22 succeeded | none; managed-session retention, part of #45 |
| #106 | `f441977`              | main push CI run `29259255830`: Ubuntu/Windows x Node 20/22 succeeded | none; `0.3.0` release preparation            |
| #107 | `73f7e8b`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | none; release-governance evidence            |
| #108 | `1d7e972`              | required Ubuntu/Windows x Node 20/22 checks succeeded                 | none; Responses request-contract evidence    |
| #109 | `5ccc59f`              | main push CI run `29266814136`: Ubuntu/Windows x Node 20/22 succeeded | #73                                          |

`v0.3.0` was published as source-only GitHub Release `353319523` from `f441977` on 2026-07-13. Asset `475724780` (`opencode-advisor-mcp-0.3.0.tgz`) has size `49496` and GitHub API digest `sha256:47a4697ad28e99fd85ba2951ac21289a566378948743526f2b1cde5cbd905fa1`; asset `475724781` is the matching `SHA256SUMS.txt`. GitHub reports `immutable:false`, so installation docs and this protected branch history independently pin the expected digest instead of trusting the mutable checksum asset alone. The tag dereferences to `f441977`, and the downloaded tarball passed a fresh-prefix install, all four bin smokes, the MCP `0.3.0` handshake, the exact three-tool list, a real provider doctor, and blocker-only OpenCode planner/reviewer gates. This release process performed no npm publication or registry identity operation. Later `#108/#109` changes remain post-release `Unreleased` work.

## Dependency Decision Evidence

`#3` merged at `eb541b8` after clean-worktree release checks, four required GitHub CI checks, a real six-step provider doctor pass, and a blocker-only OpenCode review of `BLOCKER: none`. It upgrades `zod` from `3.25.76` to `4.4.3` without changing `@modelcontextprotocol/sdk@1.29.0`. `#42` was then closed as completed.

## Covered / Close

| Issue | Status  | Reason                                                                                                                                   | Evidence                                                                |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| #16   | covered | runtime and prompt-boundary stability coverage completed without a public-contract change                                                | `#99` merged at `925b6b4`; issue automatically closed                   |
| #34   | covered | queue recovery, heartbeat, polling, startup-reservation, and shared-runtime edge coverage completed                                      | `#97` merged at `fea2d2b`; issue automatically closed                   |
| #42   | covered | `zod` v4 dependency decision accepted and merged                                                                                         | `#3` merged at `eb541b8`; issue closed as completed                     |
| #15   | covered | both bundled agents now deny every tool, so the old `glob`/`grep` precedence ambiguity no longer exists                                  | agent templates and bin regression coverage on `main`                   |
| #26   | covered | `test:doctor` runs in the four-platform CI matrix; `npm audit` remains an explicit non-blocking maintenance policy                       | `.github/workflows/ci.yml`, release gates, and this governance decision |
| #70   | covered | the MCP cannot observe a host Codex timeout reliably; public docs already require the outer timeout to exceed the inner OpenCode timeout | `README.md` and `docs/CONFIGURATION.md`                                 |
| #73   | covered | doctor tests run in CI and the CLI now supports one sanitized machine-readable JSON report                                               | `#109` merged at `5ccc59f`; issue automatically closed                  |
| #46   | covered | allowed-roots now fail fast at server startup                                                                                            | `src/server.mjs`, merged in `#80`                                       |
| #47   | covered | diff context now goes through best-effort secret redaction                                                                               | `src/opencode-core.mjs`, docs/tests on `main`                           |
| #49   | covered | tool schemas are no longer shared/mutated across registrations                                                                           | `src/server.mjs`, merged in `#80`                                       |
| #51   | covered | runner now handles shutdown and exits cleanly after the current task                                                                     | `src/task-queue.mjs`, tests on `main`                                   |
| #53   | covered | queue runner stdout/stderr can now be captured via log dir                                                                               | `src/task-queue.mjs`, docs on `main`                                    |
| #54   | covered | MCP stdio integration tests now exist                                                                                                    | `test/mcp-integration.test.mjs`, merged in `#81`                        |
| #57   | covered | task files now write through a temporary file and atomic rename                                                                          | `src/task-queue.mjs`, merged in `#80`                                   |
| #59   | covered | quoted Windows roots can preserve literal semicolons                                                                                     | `src/opencode-core.mjs`, merged in `#83`                                |
| #63   | covered | diff context truncation preserves complete lines                                                                                         | `src/opencode-core.mjs`, merged in `#83`                                |
| #64   | covered | Git context now degrades per command instead of failing as a whole                                                                       | `src/opencode-core.mjs`, merged in `#83`                                |
| #65   | covered | queue-dir permission failures now degrade to a structured error instead of looking like a dropped connection                             | `src/task-queue.mjs`, merged in `#82`                                   |
| #66   | covered | stale thresholds no longer shrink below the built-in floor just because timeout is reduced                                               | `src/task-queue.mjs`, merged in `#82`                                   |
| #67   | covered | `get_opencode_task` now has explicit behavior when queue mode is disabled                                                                | `src/server.mjs`, merged in `#82`                                       |
| #68   | covered | install docs now include Bash/macOS/Linux-friendly examples alongside PowerShell                                                         | `README.md`, merged in `#82`                                            |
| #69   | covered | public docs now state prerequisites and current validated OpenCode CLI version                                                           | `README.md`, `docs/INSTALL.md`, `docs/USAGE.md`, merged in `#82`        |
| #75   | covered | doctor now checks both bundled agents and both MCP health paths                                                                          | `scripts/opencode-advisor-doctor.mjs`, `test/doctor.test.mjs`           |
| #76   | covered | queue admission already uses a submission lock and atomic maxPending check                                                               | `src/task-queue.mjs`, `test/queue.test.mjs`                             |
| #78   | covered | bug template now requests doctor output, agent status, MCP config, install mode, and redaction guidance                                  | `.github/ISSUE_TEMPLATE/bug_report.yml`, merged in `#82`                |
| #79   | covered | package-contract tests now validate the real tarball contents and package-lock root metadata drift                                       | `test/package-contract.test.mjs`, merged in `#82`                       |
| #30   | covered | `runProcess` handles stdout/stderr failures and keeps settlement exactly once                                                            | `src/opencode-core.mjs`, regression tests merged in `#86`               |
| #61   | covered | subprocess output preserves CRLF and UTF-8 text across chunk boundaries                                                                  | `src/opencode-core.mjs`, regression tests merged in `#86`               |
| #62   | covered | timeout cleanup targets the Windows process tree and POSIX inherited process group                                                       | `src/opencode-core.mjs`, process-tree regressions merged in `#87`       |
| #18   | covered | requested working directories containing NUL bytes are rejected before filesystem or process work begins                                 | `src/opencode-core.mjs`, regression tests merged in `#85`               |
| #19   | covered | configured roots and request cwd values are canonicalized before containment checks, blocking symlink and junction escapes               | `src/opencode-core.mjs`, regression tests merged in `#85`               |
| #22   | covered | runner ownership now uses runner ids, PIDs, leases, and atomic stale-owner takeover                                                      | `src/task-queue.mjs`, regression tests merged in `#84`                  |
| #25   | covered | queue runner isolates bounded iteration failures and releases its owned lease before a clean restart                                     | `src/task-queue.mjs`, regression tests merged in `#84`                  |
| #35   | covered | queue tests use managed temporary directories and deterministic gates for concurrent runner behavior                                     | `test/queue.test.mjs`, regression tests merged in `#84`                 |
| #56   | covered | stale runner lock recovery now verifies ownership and lease state before takeover                                                        | `src/task-queue.mjs`, regression tests merged in `#84`                  |
| #58   | covered | heartbeat ownership prevents stale or ghost runners from deleting a live runner state                                                    | `src/task-queue.mjs`, regression tests merged in `#84`                  |

## Next

The dedicated `#16` and `#34` stability lanes are complete. The queue-maintenance timing flake and managed-session retention correctness are covered by `#104` and `#105`, and the source-only `v0.3.0` release is complete. Finish the already separated formatter/lint lane, then accept only evidence-backed work under the remaining umbrellas.

| Issue | Focus                                                                                                                                                                                                                                                                                                                      | Required evidence before closure or merge                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #12   | Land the full-repository Prettier baseline and the separate ESLint correctness gate.                                                                                                                                                                                                                                       | Keep mechanical formatting separate from lint fixes; require both new CI checks and the existing full matrix before closure.                                                                   |
| #43   | Keep the deep-audit umbrella open for newly substantiated input, runtime, or UX risks.                                                                                                                                                                                                                                     | Start from a focused reproduction and preserve the three-tool public contract; do not reopen the delivered task-id or drive-relative-path work.                                                |
| #45   | Keep the queue-lifecycle umbrella open for operational concurrency evidence beyond the completed test lane. `#102` fenced stale recovery snapshots, `#104` stabilized the maintenance shutdown test without changing production timing, and `#105` added explicit ownership and retry-safe retention for managed sessions. | Reproduce a remaining lifecycle risk under a focused fault or multi-process test before changing queue behavior; retain token fencing, ownership evidence, and existing top-level error codes. |

## Stability Completion Matrix

### #16: Runtime and prompt coverage (closed)

| Original concern                           | Covered on `main`                                                                                                                | Closure evidence                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Exact OpenCode role/CLI construction       | `test/provider-runtime.test.mjs` asserts reviewer/planner agent, model, variant, `--pure`, directory, and JSON format arguments. | Existing role-isolation regressions retained in `#99`. |
| Prompt construction and input boundaries   | Planner `CURRENT_PLAN`, `CONSTRAINTS`, goal, and question are bounded as untrusted content; delimiter-like input is neutralized. | `#99` added focused runtime regressions.               |
| Empty, malformed, and fallback-like output | Successful plain-text or empty OpenCode output fails closed; structured diagnostics retain fallback handling.                    | `#99` added the non-JSON/empty-output regressions.     |

### #34: Queue and shared-runtime coverage (closed)

| Original concern                         | Covered on `main`                                                                                                                                   | Closure evidence                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Terminal states and heartbeat recovery   | `test/queue.test.mjs` covers missing terminal results plus missing or malformed runner heartbeats.                                                  | `#97` added public-entry regressions.                      |
| Polling and detached runner startup      | Queue tests cover fresh leases, shared pending-poll suppression, stale startup retry, failed startup retry, and cross-process reservation recovery. | `#97` adds multi-process and token-fencing coverage.       |
| Lease-acquisition failure cleanup        | A child that cannot acquire a fresh lease releases only its matching startup reservation; a delayed child cannot remove a replacement reservation.  | `f6484d2` in `#97`, with integration regressions.          |
| Numeric and public success-shape helpers | `positiveNumber` rejects non-positive/non-finite values and reviewer/planner success factories have matching contracts.                             | `test/runtime-shared.test.mjs` coverage included in `#97`. |

## Umbrella Scope

| Umbrella | Covered by merged work                                                                                                                                                                                                                                                                                                                                                                                                                            | Remaining scoped work                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #43      | Real-path containment (`#85`), process-tree timeout cleanup (`#87`), queue/session isolation (`#91`), runtime command and prompt hardening (`#92`), release gates (`#93`), independent provider isolation (`#96`), and the task-id/Windows drive-relative-path boundary (`#98`) cover the delivered audit findings. Managed-session ownership records in `#105` add bounded, credential-free cleanup without scanning ordinary OpenCode sessions. | Keep the umbrella for newly substantiated audit risks. Public diagnostic response expansion was rejected under #71; diff caching and broader observability remain outside this lane.                                                                                                                                    |
| #45      | Queue runner leases, atomic stale-owner takeover, exact-once claims, heartbeat ownership, signal cleanup, stale-task recovery, terminal-state/heartbeat polling evidence, fenced startup reservations, recovery snapshot fencing, maintenance-test stabilization, and retry-safe managed-session retention are covered by `#84`, `#91`, `#94`, `#96`, `#97`, `#102`, `#104`, and `#105`.                                                          | Keep the umbrella for remaining operational lifecycle evidence, especially fault or multi-process reproductions not covered by the closed `#34` test lane. Historical untitled or otherwise unowned sessions remain deliberately unmanaged. Do not introduce new top-level error codes or queue-control MCP tools here. |

## Duplicate / Consolidate

| Issue | Status      | Canonical issue | Reason                                                                                                      |
| ----- | ----------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| #23   | duplicate   | #30             | same `runProcess` stdout/stderr error-handler theme                                                         |
| #60   | duplicate   | #19             | same allowed-roots canonicalization / symlink bypass family                                                 |
| #24   | duplicate   | #43             | broad audit follow-up umbrella, less actionable than the later audit issue                                  |
| #11   | duplicate   | #43             | older umbrella audit issue with overlapping findings                                                        |
| #41   | consolidate | #28 / #72       | the old future-feature bucket mixes unrelated ideas; retain only the focused cache and MCP-expansion issues |

## Won't Fix

| Issue | Status  | Reason                                                                                                                                                                                  |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #71   | wontfix | adding raw roots, stderr, exit details, or provider data to public MCP failures expands the sensitive response surface; sanitized local doctor/debug paths are the appropriate boundary |

## Deferred

| Issue     | Status   | Reason                                                                                                                                       |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| #17       | deferred | debug mode expands diagnostics scope and should be considered separately                                                                     |
| #28       | deferred | diff caching changes cost and freshness behavior; revisit with production usage evidence                                                     |
| #31       | deferred | decomposing `runOpenCodeTaskNow` is a later internal maintainability change, not a demonstrated reliability fix                              |
| #33       | deferred | only the response-factory and queue role-dispatch duplication remains; the role registry and symmetric success contracts are already covered |
| #39 / #77 | deferred | more precise public failure codes require a deliberate breaking-change/versioning decision                                                   |
| #72       | deferred | new queue/task-control tools would expand the MCP contract                                                                                   |

## Operating Rules

- Keep `main` as the source of truth for whether an issue is still real.
- Do not mix release automation, npm publication, or new MCP tools into the shortlist above; the `zod` v4 decision is already complete.
- Keep the public MCP contract frozen for future `#43` and `#45` maintenance: exactly three tools, existing success fields, and existing top-level error codes.
- Keep `npm audit` non-blocking until a separately reviewed dependency policy defines severity, remediation, and outage handling.
- If a new issue duplicates one already listed here, prefer updating the canonical issue instead of growing parallel threads.
- Keep `#43` open as the audit umbrella and `#45` open as the queue-lifecycle umbrella until their remaining scoped work has evidence.
- Close only issues with a merged implementation and a focused regression or acceptance test; record the merged PR in this table.
