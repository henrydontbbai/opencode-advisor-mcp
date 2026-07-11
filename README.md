# OpenCode Advisor MCP

OpenCode Advisor MCP is an unofficial local MCP server that lets Codex ask OpenCode for either a read-only review pass or a read-only planning pass without giving that helper write access.

This project is for people who already use Codex and OpenCode locally and want a second review tool in the loop without giving that reviewer write access.

## Prerequisites

- Node.js `>=20`
- a working local `opencode` CLI on `PATH`
- OpenCode agent support with the bundled `codex-advisor` and `codex-planning-partner` templates installed
- a local Codex setup that can load stdio MCP servers

Current docs and tests are validated against OpenCode CLI `1.17.13`.

## Project Status

- Latest tagged GitHub release: `v0.2.0`
- `main` includes unreleased stabilization changes after `v0.2.0`
- Current scope: one MCP server with `ask_opencode_advisor`, `ask_opencode_planner`, and `get_opencode_task`
- Supported mode: source/GitHub install with local OpenCode agent templates
- npm package publication is planned for a future release and is not available yet

## Unofficial Compatibility Notice

This is an unofficial community project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Codex, OpenCode, or the maintainers of those products. "Codex" and "OpenCode" are referenced only for compatibility and integration context.

## Responsible Use

Use this tool only on repositories and diffs you are authorized to inspect and disclose.

Important boundaries:

- The server sends Git status, optional Git diff context, your question, plan text, constraints, and working-directory context to your configured OpenCode runtime.
- Depending on your OpenCode configuration, that runtime may use a remote model provider. Do not assume this means "nothing ever leaves the machine."
- Public responses stay sanitized, but review context can still include repository content. This build now applies a conservative best-effort secret redaction pass to diff context before sending it to OpenCode; treat that as a safety net, not as a guarantee.
- The included advisor template blocks writes and denies `.env` reads, but that is not a complete confidentiality guarantee.
- Keep `OPENCODE_ADVISOR_ALLOWED_ROOTS` narrow. Do not point it at broad parent directories unless you deliberately want that scope.

## Who It Is For

- People already running Codex locally
- People already running OpenCode locally
- Repositories where a second review pass is useful
- Teams that want a read-only reviewer template with explicit install steps

## What It Is Not For

- Reviewing code you are not allowed to disclose
- Handling secrets or sensitive repositories by default
- Acting as an autonomous coding agent
- Replacing your normal review process or judgment

## Install From Source

Clone the repository, then install and verify dependencies:

```powershell
git clone https://github.com/henrydontbbai/opencode-advisor-mcp.git
cd opencode-advisor-mcp
npm install
npm run smoke
npm test
npm run test:doctor
```

```bash
git clone https://github.com/henrydontbbai/opencode-advisor-mcp.git
cd opencode-advisor-mcp
npm install
npm run smoke
npm test
npm run test:doctor
```

Copy the bundled agent templates into your OpenCode agents directory:

```powershell
New-Item -ItemType Directory -Force -Path <agent-dir>
Copy-Item -LiteralPath ".\agents\codex-advisor.md" -Destination "<agent-dir>\codex-advisor.md" -Force
Copy-Item -LiteralPath ".\agents\codex-planning-partner.md" -Destination "<agent-dir>\codex-planning-partner.md" -Force
```

```bash
mkdir -p <agent-dir>
cp ./agents/codex-advisor.md <agent-dir>/codex-advisor.md
cp ./agents/codex-planning-partner.md <agent-dir>/codex-planning-partner.md
```

Add this MCP config to Codex:

```toml
[mcp_servers.opencode_advisor]
command = "node"
args = ["<repo-root>\\src\\server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 420

[mcp_servers.opencode_advisor.env]
OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root-or-semicolon-list>"
OPENCODE_ADVISOR_OPENCODE_DATA_HOME = "<dedicated-opencode-data-home>"
OPENCODE_ADVISOR_TIMEOUT_MS = "300000"
OPENCODE_ADVISOR_MAX_DIFF_CHARS = "60000"
```

Replace `<repo-root>` with the absolute path to this source checkout.

`OPENCODE_ADVISOR_ALLOWED_ROOTS` accepts a semicolon-separated list. If a Windows path itself contains a semicolon, wrap that one path in double quotes, for example `"C:\workspace\team;alpha";C:\workspace\other`.

`OPENCODE_ADVISOR_OPENCODE_DATA_HOME` is required and must be an absolute, dedicated directory for advisor-managed OpenCode sessions. For example, use `%USERPROFILE%\.codex\opencode-advisor\opencode-data` on Windows or `$HOME/.codex/opencode-advisor/opencode-data` on macOS/Linux. Authenticate that isolated profile yourself with `opencode auth login` while `XDG_DATA_HOME` points at the same directory. The server never copies your normal OpenCode database, credentials, or WAL files into this profile.
`OPENCODE_ADVISOR_OPENCODE_CMD` is optional. Leave it unset to use `opencode` from PATH; on Windows, the server falls back to a small set of known global-install locations only if PATH launch fails. If you override it, it must be an existing absolute OpenCode executable path (an `.exe` on Windows), not a command line or shell alias.

Keep `tool_timeout_sec` larger than `OPENCODE_ADVISOR_TIMEOUT_MS / 1000`, or Codex may cut off the MCP tool before the inner OpenCode timeout is reached.

After the agent template is installed, set allowed roots in the same shell that will run doctor. The terminal check does not inherit MCP env from the Codex config block above.

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
$env:OPENCODE_ADVISOR_OPENCODE_DATA_HOME = "<dedicated-opencode-data-home>"
npm run doctor
```

```bash
export OPENCODE_ADVISOR_ALLOWED_ROOTS="<allowed-root>"
export OPENCODE_ADVISOR_OPENCODE_DATA_HOME="<dedicated-opencode-data-home>"
npm run doctor
```

`npm run doctor` is a local source-install health check. It depends on your local OpenCode runtime, both bundled agents (`codex-advisor` and `codex-planning-partner`), and a valid `OPENCODE_ADVISOR_ALLOWED_ROOTS` value in the shell that launches it. It is not proof of npm publication.

## npm Package Status

The package metadata and CLI entrypoints are present for packaging checks, but `opencode-advisor-mcp` has not been published to npm yet. Use the source install path above for now.

## Usage

Codex gets three MCP tools:

```text
ask_opencode_advisor
ask_opencode_planner
get_opencode_task
```

Typical prompt:

```text
Ask opencode_advisor to review the current changes.
Focus on risks, missing tests, privacy issues, and release readiness.
```

```text
Ask opencode_planner to tighten this implementation plan.
Focus on gaps, ordering, scope creep, and validation points.
```

If planner or reviewer work does not finish inside the inline wait window, the ask tool returns a structured `queued` response. That means the OpenCode phase is still pending, not failed. Keep the stage open and call `get_opencode_task` with the returned `task_id`.

The server returns structured JSON with stable error codes such as `invalid_cwd`, `invalid_paths`, `git_failed`, `opencode_not_found`, `opencode_failed`, and `timeout`.

`OPENCODE_ADVISOR_ALLOWED_ROOTS` is enforced against canonical filesystem paths for the requested working directory and configured roots, so directory links that escape an allowed root are rejected. This is a read-only scope guard, not a complete OS sandbox.

Queue defaults are conservative:

- global concurrency: `4`
- planner concurrency: `2`
- reviewer concurrency: `2`
- inline wait: `60000ms`
- retry hint: `30000ms`

Queue config env knobs currently supported:

- `OPENCODE_ADVISOR_QUEUE_MAX_PENDING`
- `OPENCODE_ADVISOR_TASK_TTL_MS`
- `OPENCODE_ADVISOR_QUEUE_RUNNER_IDLE_MS`
- `OPENCODE_ADVISOR_QUEUE_RUNNER_STALE_MS`
- `OPENCODE_ADVISOR_QUEUE_RUNNING_STALE_MS`
- `OPENCODE_ADVISOR_QUEUE_POLL_MS`

If queue setup fails because the queue directory cannot be created or written, the tool now returns a structured failure instead of behaving like a silent disconnect.

Queue state is stored locally under `%USERPROFILE%\.codex\opencode-advisor\queue` on Windows or `$HOME/.codex/opencode-advisor/queue` on other platforms.

If you set `OPENCODE_ADVISOR_QUEUE_LOG_DIR`, detached runner stdout/stderr is written there for local diagnosis instead of being discarded.

If you override `OPENCODE_ADVISOR_QUEUE_DIR`, it is treated as the queue directory itself rather than as a parent folder.

Each advisor task has its own titled OpenCode session in the dedicated profile. Managed sessions are retained for 3 days by default, and terminal queue task files are retained for 7 days. Cleanup runs at most once every 6 hours in the dedicated profile; it never reads, modifies, compacts, or deletes the user's normal OpenCode database.

## Local Verification

From the repository:

```powershell
npm install
npm run smoke
npm test
npm run test:doctor
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

`npm run doctor` is an extra local runtime check for source installs. It is not part of the GitHub CI gate and it does not replace `npm run print-agent`, `npm run print-agent -- planner`, or `npm pack --dry-run`.

Release and acceptance steps live in:

- [docs/INSTALL.md](docs/INSTALL.md)
- [docs/USAGE.md](docs/USAGE.md)
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
- [RELEASING.md](RELEASING.md)
