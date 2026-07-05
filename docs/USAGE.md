# Usage

Use the advisor when you want a second review pass on the current Git state.

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

## What The MCP Tool Does

The tool:

1. Validates the requested repository and paths
2. Collects Git status and diff context
3. Runs `opencode run --agent codex-advisor`
4. Returns structured JSON

The advisor is a reviewer only. It should not write files, execute shell commands, commit, or take over implementation.

## Privacy And Authorization

Before using this tool:

- Make sure you are allowed to review and disclose the repository content involved
- Assume your configured OpenCode runtime may use a remote model provider
- Avoid sensitive repositories unless that provider path is approved
- Keep `OPENCODE_ADVISOR_ALLOWED_ROOTS` narrow

This tool blocks `.env` reads in the bundled advisor template, but it does not guarantee that every secret in a repository is protected from review context.

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

## Notes

- Each review run creates an OpenCode session record
- The model/provider behavior is controlled by your local OpenCode configuration, not by this repository
- Current implementation is a one-shot review tool, not a persistent OpenCode server

## Local Doctor

For source installs, run the local runtime self-check from the repository root:

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

This doctor check is local-only. It depends on:

- a working `opencode` command
- a registered `codex-advisor` agent
- a valid `OPENCODE_ADVISOR_ALLOWED_ROOTS` setting in the shell for the current repo

It is not part of the GitHub CI gate and it does not imply that an npm package has been published.

## Quick Troubleshooting

Use the doctor bucket as the first triage hint:

- `opencode_not_found`: OpenCode is missing from PATH or `OPENCODE_ADVISOR_OPENCODE_CMD` points to the wrong command
- `agent_missing_or_fallback`: `codex-advisor` is missing or OpenCode fell back to another agent; reinstall `agents/codex-advisor.md` and check `opencode agent list`
- `invalid_cwd_or_allowed_roots`: the current repo is outside `OPENCODE_ADVISOR_ALLOWED_ROOTS`; narrow or correct that env var and rerun doctor from the repo root
- `upstream_unavailable`: the configured OpenCode provider path is temporarily unavailable
- `timeout`: the provider path did not answer before `OPENCODE_ADVISOR_TIMEOUT_MS`
- `generic_opencode_failure`: inspect the failing doctor step, then rerun the direct `opencode run` and local `askOpenCodeAdvisor(...)` acceptance checks
