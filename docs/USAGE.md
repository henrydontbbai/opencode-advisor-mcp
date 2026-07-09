# Usage

Use the reviewer when you want a second pass on the current Git state. Use the planner when you already have a direction and want OpenCode to tighten it without taking over implementation.

## Typical Prompts

```text
Ask opencode_advisor to review the current changes.
```

```text
Let OpenCode review this diff. Focus on risks, missing tests, privacy issues, and release readiness.
```

```text
Call ask_opencode_advisor for this repository and summarize the actionable findings.
```

```text
Ask opencode_planner to improve this plan. Focus on missing checks, better ordering, and scope control.
```

## What The MCP Tool Does

The reviewer/planner flow:

1. Validates the requested repository and paths
2. Collects Git status and optional diff context
3. Runs either `opencode run --agent codex-advisor` or `opencode run --agent codex-planning-partner`
4. Returns structured JSON immediately if the task finishes inline, or returns a queued/running pending state plus `task_id`
5. Lets you poll `get_opencode_task` until a final result is ready

Role boundaries:

- `ask_opencode_advisor`: reviewer only; it should not write files, execute shell commands, commit, or take over implementation
- `ask_opencode_planner`: planning partner only; it should not decide the final plan, implement code, or expand scope on its own
- `get_opencode_task`: task lookup for queued or running planner/reviewer jobs

## Privacy And Authorization

Before using this tool:

- Make sure you are allowed to review and disclose the repository content involved
- Assume your configured OpenCode runtime may use a remote model provider
- Avoid sensitive repositories unless that provider path is approved
- Keep `OPENCODE_ADVISOR_ALLOWED_ROOTS` narrow

This tool blocks `.env` reads in the bundled advisor template, but it does not guarantee that every secret in a repository is protected from review context.
Current builds apply a conservative best-effort secret redaction pass to diff context before it is sent to OpenCode. Treat that as a fallback safety layer, not as proof that every sensitive value is caught.

## Response Shape

Success responses contain stable summary fields only:

- `ok`
- `base_ref`
- `status`
- `diff_truncated`
- `advisor_text`
- `opencode_exit_code`

Failure responses contain:

- `ok`
- `error`
- `message`
- `details`

Known error codes:

- `invalid_cwd`
- `invalid_paths`
- `git_failed`
- `opencode_not_found`
- `opencode_failed`
- `timeout`

Public builds intentionally avoid echoing local absolute paths, allowed roots, resolved command paths, or raw process output in structured responses.

## Queued And Running Results

If the queue is busy, the ask tool may return:

- `ok: false`
- `error: "queued"`
- `details.phase_pending: true`
- `details.task_id`
- `details.status` (`queued` or `running`)

queued/running is pending, not failed. Keep that phase open and call `get_opencode_task` later with the returned `task_id`.

When the task is finished, `get_opencode_task` returns the same public result shape you would have received inline:

- reviewer results keep `advisor_text`
- planner results keep `planner_text`
- expired tasks stay distinct from `timeout` and generic failures

Default queue policy:

- global concurrency `4`
- planner concurrency `2`
- reviewer concurrency `2`
- inline wait `60000ms`
- retry hint `30000ms`
- pending-task TTL `86400000ms`

Queue files live under `%USERPROFILE%\.codex\opencode-advisor\queue` on Windows or `$HOME/.codex/opencode-advisor/queue` on other platforms.

If you set `OPENCODE_ADVISOR_QUEUE_DIR`, that value is used as the queue directory directly.
If you set `OPENCODE_ADVISOR_QUEUE_LOG_DIR`, detached runner stdout/stderr is captured there for local diagnosis.

## Notes

- Each review run creates an OpenCode session record
- The model/provider behavior is controlled by your local OpenCode configuration, not by this repository
- Current implementation is a one-shot review tool, not a persistent OpenCode server
- Inner review timeout is controlled by `OPENCODE_ADVISOR_TIMEOUT_MS`; keep outer MCP `tool_timeout_sec` larger so Codex does not truncate the run first

## Local Doctor

For source installs, run the local runtime self-check from the repository root:

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

This doctor check is local-only. It depends on:

- a working `opencode` command
- registered `codex-advisor` and `codex-planning-partner` agents
- a valid `OPENCODE_ADVISOR_ALLOWED_ROOTS` setting in the shell for the current repo

Run it from the repository root in the same shell where `OPENCODE_ADVISOR_ALLOWED_ROOTS` is set. Doctor uses the same fallback and upstream diagnostic rules as the server, so quoted assistant text alone should not trip a fallback bucket.

It is not part of the GitHub CI gate and it does not imply that an npm package has been published.

## Quick Troubleshooting

Use the doctor bucket as the first triage hint:

- `opencode_not_found`: OpenCode is missing from PATH or `OPENCODE_ADVISOR_OPENCODE_CMD` points to the wrong command
- `agent_missing_or_fallback`: one of the bundled agents is missing or OpenCode fell back to another agent; reinstall both bundled agent files and check `opencode agent list`
- `invalid_cwd_or_allowed_roots`: the current repo is outside `OPENCODE_ADVISOR_ALLOWED_ROOTS`; narrow or correct that env var and rerun doctor from the repo root
- `upstream_unavailable`: the configured OpenCode provider path is temporarily unavailable
- `timeout`: the provider path did not answer before `OPENCODE_ADVISOR_TIMEOUT_MS`; if you raise the inner timeout, also raise outer MCP `tool_timeout_sec`
- `generic_opencode_failure`: inspect the failing doctor step, then rerun the direct `opencode run` and local `askOpenCodeAdvisor(...)` acceptance checks
