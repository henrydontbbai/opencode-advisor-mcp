# Configuration Reference

All runtime configuration uses environment variables. Values ending in `_MS` are milliseconds. Invalid non-positive numeric values fall back to the documented default.

## Required runtime settings

| Variable | Default | Meaning and safety notes |
| --- | --- | --- |
| `OPENCODE_ADVISOR_ALLOWED_ROOTS` | none; required | Semicolon-separated absolute roots that may be reviewed. Keep this narrow. A Windows root containing `;` must be quoted. |
| `OPENCODE_ADVISOR_OPENCODE_DATA_HOME` | none; required | Absolute dedicated OpenCode data directory used as the child process `XDG_DATA_HOME`. Initialize its authentication yourself with `opencode auth login`; never copy the normal OpenCode database, credentials, or WAL files. |

## OpenCode and Git execution

| Variable | Default | Meaning and when to change it |
| --- | --- | --- |
| `OPENCODE_ADVISOR_OPENCODE_CMD` | `opencode` from `PATH` | Optional absolute executable override. On Windows it must be an existing `.exe`; it is not a shell command or argument string. Leave unset unless `PATH` cannot find OpenCode. |
| `OPENCODE_ADVISOR_TIMEOUT_MS` | `300000` | Per-task OpenCode timeout. Increase only for known slow provider runs; keep Codex `tool_timeout_sec` larger. |
| `OPENCODE_ADVISOR_GIT_TIMEOUT_MS` | `30000` | Timeout for Git status/diff collection only. Increase for very large repositories without increasing provider time. |
| `OPENCODE_ADVISOR_MAX_DIFF_CHARS` | `60000` | Maximum diff context passed to OpenCode. Request input cannot exceed `1000000`; smaller limits reduce prompt size. |
| `OPENCODE_ADVISOR_REDACT_SECRETS` | enabled | Best-effort diff redaction. Set only to `0`, `false`, `off`, or `no` to disable it; disabling does not make a repository safer. |

## Queue settings

The queue is local state, not encrypted multi-user storage. Its default directory is `%USERPROFILE%\.codex\opencode-advisor\queue` on Windows and `$HOME/.codex/opencode-advisor/queue` elsewhere.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_ADVISOR_QUEUE_DIR` | platform default | Direct queue directory override. |
| `OPENCODE_ADVISOR_QUEUE_LOG_DIR` | unset | Directory for detached runner stdout/stderr used in local diagnosis. |
| `OPENCODE_ADVISOR_CONCURRENCY_GLOBAL` | `4` | Maximum combined runner concurrency. |
| `OPENCODE_ADVISOR_CONCURRENCY_PLANNER` | `2` | Planner concurrency within the global limit. |
| `OPENCODE_ADVISOR_CONCURRENCY_REVIEWER` | `2` | Reviewer concurrency within the global limit. |
| `OPENCODE_ADVISOR_QUEUE_INLINE_WAIT_MS` | `60000` | How long an ask tool waits before returning a pending `queued` response. |
| `OPENCODE_ADVISOR_QUEUE_RETRY_AFTER_MS` | `30000` | Polling hint returned with a pending result. |
| `OPENCODE_ADVISOR_QUEUE_MAX_PENDING` | `16` | Maximum pending tasks accepted by the local queue. |
| `OPENCODE_ADVISOR_TASK_TTL_MS` | `86400000` | Maximum task lifetime before a non-terminal task becomes expired. |
| `OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS` | `15000` | Idle delay before a detached runner exits. |
| `OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS` | safety floor | Lease age after which an inactive runner can be recovered. Default is at least `420000` and at least `OPENCODE_ADVISOR_TIMEOUT_MS + 120000`. |
| `OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS` | runner stale value | Separate stale threshold for a running task. Override only when its recovery semantics are understood. |
| `OPENCODE_ADVISOR_QUEUE_POLL_MS` | `1000` | Runner loop interval. Lower values add filesystem churn. |

## Session lifecycle and maintenance

These settings apply only to the dedicated profile, never to the user's regular OpenCode data directory.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_ADVISOR_SESSION_RETENTION_MS` | `259200000` (3 days) | Retain advisor-created OpenCode sessions for diagnosis, then delete managed sessions by title and age. |
| `OPENCODE_ADVISOR_QUEUE_TASK_RETENTION_MS` | `604800000` (7 days) | Retain terminal `completed`, `failed`, `expired`, and `timeout` task records. |
| `OPENCODE_ADVISOR_MAINTENANCE_INTERVAL_MS` | `21600000` (6 hours) | Minimum interval between runner maintenance passes. Failed cleanup is retried later. |

Maintenance does not delete the user's normal OpenCode sessions, access the normal SQLite database, or run automatic `VACUUM`.

## Developer-only setting

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_ADVISOR_TEST_FILE_TIMEOUT_MS` | `120000` | Per-file timeout used by the repository test runner. Do not place it in production MCP configuration. |

## Input limits

The service rejects oversized request input before it writes a queue task or launches Git/OpenCode. Limits are UTF-8 bytes unless stated otherwise: `cwd` 4 KiB; `question` and `goal` 16 KiB each; `current_plan` 64 KiB; each constraint 2 KiB with at most 32; each path 1 KiB with at most 128; `base_ref` 256 bytes; `max_diff_chars` at most 1,000,000 characters.
