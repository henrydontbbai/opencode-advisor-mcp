# Configuration

## Independent Provider Profile

Run `opencode-advisor-setup` in an interactive terminal to create or replace the Advisor profile. It is the only supported place to configure a third-party provider URL, transport, model list, role-model mapping, or API key. Setup does not import normal OpenCode, Codex, or Cockpit configuration, credentials, or account-login state.

The non-secret manifest has this fixed shape:

```json
{
  "version": 1,
  "provider": {
    "id": "third-party",
    "name": "Third Party",
    "base_url": "https://models.example.test/v1",
    "transport": "responses",
    "models": [{ "id": "reasoning-model", "name": "Reasoning Model" }]
  },
  "roles": {
    "reviewer": { "model": "reasoning-model", "variant": "high" },
    "planner": { "model": "reasoning-model", "variant": "max" }
  }
}
```

`base_url` must be an HTTP or HTTPS API root without embedded credentials, query parameters, fragments, or control characters. `transport` is exactly `responses` or `chat_completions`.

`roles.reviewer.variant` and `roles.planner.variant` are optional, independent OpenCode model variants. Omit a `variant` to use the selected model's default. Reviewer `high` and planner `max` are an example even when both roles use the same model; they are not values guaranteed by every provider or model.

Windows uses `%USERPROFILE%\.codex\opencode-advisor` by default. POSIX uses `$HOME/.codex/opencode-advisor`. Set `OPENCODE_ADVISOR_HOME` to an absolute path before setup only when a different private profile location is required. This path is not a provider credential and may be present in a local shell, but it does not belong in shared MCP configuration unless all users intentionally share that same local profile location.

The profile contains isolated `opencode-config`, `opencode-data`, `opencode-cache`, `opencode-state`, agent templates, a non-secret manifest, and a credential file. It never imports normal OpenCode, Codex, or Cockpit provider configuration.

On Windows, the credential uses CurrentUser DPAPI through a fixed PowerShell helper. On POSIX, storage falls back to filesystem permissions: private profile directories use `0700`, the credential file uses `0600`, and the credential envelope is Base64-encoded rather than encrypted with a DPAPI-equivalent keystore. Where POSIX permission enforcement is available, unsafe ownership, modes, symlinks, and file types cause profile loading to fail.

The credential is bound to the exact validated manifest fingerprint, and the generated OpenCode overlay must exactly match the manifest. A missing credential, incomplete profile write, stale overlay, modified manifest, or binding mismatch is setup-required and fails closed before task submission. A setup cancelled before profile writing leaves a prior valid profile intact. Do not hand-edit profile artifacts; rerun `opencode-advisor-setup`.

## Transport Compatibility

`responses` maps to `@ai-sdk/openai` and OpenCode's Responses API streaming path. For a provider/model that supports a selected role variant, the generated OpenCode model variant sets `reasoningEffort` and the Responses request carries the matching `reasoning.effort`. The local compatibility fixture expects `POST /v1/responses` with `stream: true`, output-text SSE events (`response.output_text.delta`, `response.output_text.done`, `response.completed`), and failure SSE (`error`, `response.failed`). Errors fail the request rather than becoming an MCP answer.

`chat_completions` maps to `@ai-sdk/openai-compatible` and expects `POST /v1/chat/completions` with `stream: true`, standard completion chunks, and `[DONE]`. OpenCode owns this HTTP/SSE processing; the MCP server does not proxy or expose raw provider events.

The two built-in agent templates deny all tools. The Responses fixture also covers function-call SSE, but it is not an MCP capability or assistant result: the built-in agent leaves the call unexecuted and the request ends at the configured OpenCode timeout (the fixture uses a short timeout). No configuration may enable agent file, shell, web, or subagent tools, and this path is not a successful tool round-trip.

## MCP Environment

Only non-secret controls belong in the MCP server environment:

- `OPENCODE_ADVISOR_ALLOWED_ROOTS` (required): semicolon-separated allowed repositories
- `OPENCODE_ADVISOR_TIMEOUT_MS`: OpenCode child timeout, default `300000`
- `OPENCODE_ADVISOR_GIT_TIMEOUT_MS`: timeout for each Git context command, default `30000`
- `OPENCODE_ADVISOR_MAX_DIFF_CHARS`: maximum sanitized diff context, default `60000`
- `OPENCODE_ADVISOR_REDACT_SECRETS`: redact common secret-like values from collected Git diff context; enabled by default, with `0`, `false`, `off`, or `no` disabling it. Keep it enabled for normal use.
- `OPENCODE_ADVISOR_OPENCODE_CMD`: optional absolute OpenCode executable override; on Windows it must be an existing trusted `.exe` path, not `.cmd`, `.bat`, or a command string with arguments
- `OPENCODE_ADVISOR_QUEUE_DIR`: optional queue directory override
- `OPENCODE_ADVISOR_QUEUE_LOG_DIR`: optional local runner log directory
- `OPENCODE_ADVISOR_CONCURRENCY_GLOBAL`, `OPENCODE_ADVISOR_CONCURRENCY_PLANNER`, `OPENCODE_ADVISOR_CONCURRENCY_REVIEWER`
- `OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS`, `OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS`, `OPENCODE_ADVISOR_QUEUE_MAX_PENDING`
- `OPENCODE_ADVISOR_TASK_TTL_MS`, `OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS`, `OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS`, `OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS`, `OPENCODE_ADVISOR_QUEUE_POLL_MS`
- `OPENCODE_ADVISOR_SESSION_RETENTION_MS`: retain Advisor-owned OpenCode sessions for this many milliseconds before maintenance deletes them; default `259200000` (3 days)
- `OPENCODE_ADVISOR_QUEUE_TASK_RETENTION_MS`: retain terminal queue tasks for this many milliseconds before maintenance deletes them; default `604800000` (7 days)
- `OPENCODE_ADVISOR_MAINTENANCE_INTERVAL_MS`: minimum interval between queue-maintenance passes, default `21600000` (6 hours)

`OPENCODE_ADVISOR_HOME` is a local profile-location override for setup and the local server process. It must be absolute and is not an MCP provider setting; do not place it in a shared MCP configuration unless every user intentionally uses that same local profile.

`OPENCODE_ADVISOR_TEST_FILE_TIMEOUT_MS` is a test-runner-only timeout for `npm test`; it is not a server configuration setting.

Never set provider URL, model, API key, token, password, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `XDG_*`, or `OPENCODE_ADVISOR_PROVIDER_KEY` in the MCP configuration. The server ignores inherited provider credentials when it starts OpenCode.

## Failure Behavior

When the profile is missing, invalid, incompletely written, binding-mismatched, or cannot decrypt its credential, reviewer and planner calls return the existing public `opencode_failed` error with setup guidance. Validation happens before a task is written to the queue. Rerun setup after any such failure. A setup cancelled before profile writing leaves a prior valid profile intact.

`opencode-advisor-doctor` has more specific local buckets:

- `provider_setup_required`
- `provider_authentication_failed`
- `agent_missing_or_fallback`
- `opencode_not_found`
- `timeout`
- `generic_opencode_failure`
