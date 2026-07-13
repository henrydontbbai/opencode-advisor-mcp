# Usage

Run `opencode-advisor-setup` once before asking either role. If setup is absent or unreadable, the MCP tools return `opencode_failed` with setup guidance and do not queue work.

## Roles And Tools

- `ask_opencode_advisor`: invokes the bundled read-only `codex-advisor` reviewer.
- `ask_opencode_planner`: invokes the bundled read-only `codex-planning-partner` planner.
- `get_opencode_task`: reads a queued, running, completed, or expired task.

The role set is fixed to `reviewer` and `planner`. The tool surface remains three MCP tools.

Each OpenCode run uses `--pure`, the configured role agent, an explicit `provider/model`, and, when configured, `--variant <role-variant>`. The selected provider is the one configured by `opencode-advisor-setup`, not a normal OpenCode profile.

Variants are optional and role-specific: reviewer and planner can use the same model with different choices, such as reviewer `high` and planner `max`. A blank setup answer leaves the model default in place. For a compatible `responses` provider/model, OpenCode passes the selected model variant to the Responses request as `reasoning.effort`; use only values that provider/model supports. The configured variant is profile-local and is not part of queue task JSON or MCP result fields.

## Analysis Boundary

The reviewer receives only the request plus the Git status and optional diff context collected for that request. The planner receives that same supplied context plus `current_plan` and `constraints` when provided. Neither role can inspect repository files, call file tools, run shell commands, launch subagents, or change project state. Their advice is therefore limited to the supplied diff, status, and plan context; add the needed paths or plan detail when context is incomplete.

## Request Context

Both ask tools accept optional `question` and `goal` text, a `cwd`, and repository-relative `paths`. `include_status`, `include_diff`, `base_ref`, and `max_diff_chars` control the supplied Git context; `base_ref` defaults to `HEAD`. The planner also accepts `current_plan` and `constraints`.

## Typical Requests

```text
Ask opencode_advisor to review the current changes.
Focus on bugs, release risks, and missing tests.
```

```text
Ask opencode_planner to improve this plan.
Focus on sequencing, validation points, and scope control.
```

## Results

Reviewer success fields remain:

- `ok`
- `base_ref`
- `status`
- `diff_truncated`
- `advisor_text`
- `opencode_exit_code`

Planner success has the same fields with `planner_text`. Failure fields remain `ok`, `error`, `message`, and `details`. Provider profile state is not exposed in these responses.

An incomplete, interrupted, tampered, or manifest-binding-mismatched setup is treated exactly like missing setup: `opencode_failed` with setup guidance and no queued task. Rerun `opencode-advisor-setup`; do not manually patch the profile.

When a task does not finish during the inline wait interval, the ask tool returns `error: "queued"` with `details.phase_pending: true` and a `task_id`. Queued/running is pending, not failed. Poll `get_opencode_task` until it returns the same public result shape. An expired queue status is not timeout; it identifies stale local queue state rather than an in-flight provider request.

## Queue Controls

Default queue limits are global `4`, planner `2`, reviewer `2`, inline wait `60000ms`, and retry hint `30000ms`.

Available non-secret queue controls:

- `OPENCODE_ADVISOR_CONCURRENCY_GLOBAL`
- `OPENCODE_ADVISOR_CONCURRENCY_PLANNER`
- `OPENCODE_ADVISOR_CONCURRENCY_REVIEWER`
- `OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS`
- `OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS`
- `OPENCODE_ADVISOR_QUEUE_MAX_PENDING`
- `OPENCODE_ADVISOR_TASK_TTL_MS`
- `OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS`
- `OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS`
- `OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS`
- `OPENCODE_ADVISOR_QUEUE_POLL_MS`
- `OPENCODE_ADVISOR_SESSION_RETENTION_MS`
- `OPENCODE_ADVISOR_QUEUE_TASK_RETENTION_MS`
- `OPENCODE_ADVISOR_MAINTENANCE_INTERVAL_MS`

`OPENCODE_ADVISOR_QUEUE_DIR` uses its value as the queue directory. `OPENCODE_ADVISOR_QUEUE_LOG_DIR` enables local detached-runner logs for local diagnosis. Neither location contains provider credentials or profile data.

Maintenance removes expired terminal task files and sessions with durable Advisor ownership records. Session cleanup uses the independent profile's isolated OpenCode environment without the provider credential, deletes exact recorded IDs instead of scanning OpenCode session listings, and retains failed deletions for retry. Legacy sessions without an ownership record are not deleted automatically.

## Doctor

After `opencode-advisor-setup`, run:

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
opencode-advisor-doctor
```

For automation, request the same sanitized report as JSON:

```powershell
opencode-advisor-doctor --json
```

From a source checkout, use `npm run --silent doctor -- --json` so npm does not add its command banner to stdout. Both output modes exit with `0` only when every doctor step passes and with `1` otherwise. JSON mode writes one object containing `ok`, `bucket`, `steps`, and `summary`; it does not expose the provider URL, model selection, role variant, or API key.

Doctor treats a 401, timeout, agent fallback, empty output, or non-JSON OpenCode response as a failed verification. A real reviewer or planner result is usable for a release gate only when it contains the expected explicit conclusion; a fallback, timeout, 401, or empty response is not a pass.
