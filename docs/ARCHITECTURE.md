# Architecture And Trust Boundaries

Core flow: MCP → preflight → Git → Queue → OpenCode → sanitized public result.

```text
Codex MCP client
  → stdio server
  → preflight (allowed roots, input limits, path/ref validation)
  → Git context collection
  → local file queue and runner
  → OpenCode child process in a dedicated profile
  → sanitized public result
```

## Request lifecycle

1. The three public MCP tools are `ask_opencode_advisor`, `ask_opencode_planner`, and `get_opencode_task`.
2. An ask request is preflighted before queue persistence: input limits, the canonical working directory, pathspecs, and Git ref syntax are checked.
3. The queue stores a task locally, starts or reuses a lease-owning runner, and waits up to `OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS`.
4. If work is still active, the caller receives `error: "queued"` with `task_id`, `retry_after_ms`, and `phase_pending: true`.
5. A runner collects Git status/diff, starts `opencode run --agent ... --format json`, and records the internal session ID only in the task file.
6. Final task states are `completed`, `failed`, `timeout`, or `expired`. `get_opencode_task` returns the same compatible public result shape as an inline completion.

## Queue state model

```text
queued → running → completed
                 ↘ failed
                 ↘ timeout
queued/running → expired
```

Runner lock and heartbeat records avoid concurrent execution. A stale owner is recovered only after its lease/pid checks permit it. Transient task-file reads stay pending rather than being reported as expired.

## Dedicated OpenCode profile

Every advisor task uses its own OpenCode session but shares a dedicated advisor data directory through child-process `XDG_DATA_HOME`. This keeps automatic sessions out of the user's normal OpenCode session list. The user must authenticate that profile separately with `opencode auth login`; the server never copies credentials, databases, or WAL files from the normal profile.

Managed sessions are identified by `opencode-advisor:<task_id>`. Maintenance operates only in the dedicated profile and uses OpenCode session commands rather than manipulating SQLite files directly.

## Timeouts

`startup_timeout_sec` is only the time Codex allows the stdio connection to start. It does not control a review. `tool_timeout_sec` is the outer per-tool budget and must be greater than `OPENCODE_ADVISOR_TIMEOUT_MS / 1000`; otherwise Codex can end the request before the inner OpenCode timeout.

Git collection has a separate `OPENCODE_ADVISOR_GIT_TIMEOUT_MS` budget.

## Trust boundary

This is a local, single-user MCP server. It does not provide caller authentication, tenant namespaces, cross-user task ownership, or a tamper-resistant audit log.

Allowed-root validation, agent deny rules, prompt delimiters, response sanitization, queue file permissions, and dedicated-profile isolation are defense-in-depth controls. They are scope controls, not a complete OS sandbox. Git status/diff, questions, plans, constraints, and working-directory context can reach the configured OpenCode provider; use only repositories you are authorized to disclose.
