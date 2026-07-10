# Install And Sync

This project currently supports one public install mode:

1. source checkout from GitHub

Use placeholders consistently:

- `<agent-dir>`: OpenCode agents directory
- `<allowed-root>`: repo or small parent directory you explicitly allow
- `<codex-config>`: Codex config file
- `<repo-root>`: this source checkout
- `<runtime-dir>`: optional local runtime directory for source installs

## Prerequisites

From a terminal:

```powershell
node --version
npm --version
opencode --version
codex --version
```

Each command should print a version or help output.

Current docs and tests are validated against OpenCode CLI `1.17.13`.

## Source Install

From `<repo-root>`:

```powershell
npm install
npm run smoke
npm test
npm run test:doctor
```

```bash
npm install
npm run smoke
npm test
npm run test:doctor
```

Create the agent files:

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

Add this MCP block to `<codex-config>`:

```toml
[mcp_servers.opencode_advisor]
command = "node"
args = ["<repo-root>\\src\\server.mjs"]
# macOS/Linux: args = ["/absolute/path/to/opencode-advisor-mcp/src/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 420

[mcp_servers.opencode_advisor.env]
OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root-or-semicolon-list>"
OPENCODE_ADVISOR_OPENCODE_DATA_HOME = "<dedicated-advisor-profile-data-dir>"
OPENCODE_ADVISOR_TIMEOUT_MS = "300000"
OPENCODE_ADVISOR_MAX_DIFF_CHARS = "60000"
# Optional: only an absolute executable path is accepted.
# OPENCODE_ADVISOR_OPENCODE_CMD = "C:\\Program Files\\OpenCode\\opencode.exe"
```

`OPENCODE_ADVISOR_ALLOWED_ROOTS` is required. The MCP server now fails fast at startup if it is missing or empty.

`OPENCODE_ADVISOR_ALLOWED_ROOTS` accepts a semicolon-separated list. If a Windows path itself contains a semicolon, wrap that one path in double quotes, for example `"C:\workspace\team;alpha";C:\workspace\other`.

`startup_timeout_sec` only controls MCP connection establishment. Keep `tool_timeout_sec` larger than `OPENCODE_ADVISOR_TIMEOUT_MS / 1000`, or the outer MCP tool will time out before the inner OpenCode run finishes.

`OPENCODE_ADVISOR_OPENCODE_DATA_HOME` is a required, dedicated advisor profile. Before serving requests, authenticate that profile yourself with `opencode auth login`. Do not copy the normal OpenCode database, credentials, or WAL files into it.

Queue files are stored locally under `%USERPROFILE%\.codex\opencode-advisor\queue` on Windows or `$HOME/.codex/opencode-advisor/queue` on other platforms.
If the queue directory cannot be created or written, the MCP tool now returns a structured failure instead of looking like a dropped connection.

From `<repo-root>`, set allowed roots in the same shell and then run the local doctor check. This terminal command does not inherit MCP env from your Codex config file.

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

```bash
export OPENCODE_ADVISOR_ALLOWED_ROOTS="<allowed-root>"
npm run doctor
```

Expected:

- the direct `codex-advisor` agent check passes
- the direct `codex-planning-partner` agent check passes
- the local `askOpenCodeAdvisor({ include_diff:false, include_status:false })` health check passes
- the summary does not report forbidden fields such as `cwd` or stderr tails

## npm Package Status

The package metadata and CLI entrypoints are present so package shape can be tested locally, but `opencode-advisor-mcp` has not been published to npm yet. Use the source install path above until a future npm release is announced.

## Runtime Sync For Development

If you keep a separate local runtime copy, sync these files:

```powershell
Copy-Item -LiteralPath "<repo-root>\src\server.mjs" -Destination "<runtime-dir>\server.mjs" -Force
Copy-Item -LiteralPath "<repo-root>\package.json" -Destination "<runtime-dir>\package.json" -Force
Copy-Item -LiteralPath "<repo-root>\package-lock.json" -Destination "<runtime-dir>\package-lock.json" -Force
Copy-Item -LiteralPath "<repo-root>\agents\codex-advisor.md" -Destination "<agent-dir>\codex-advisor.md" -Force
Copy-Item -LiteralPath "<repo-root>\agents\codex-planning-partner.md" -Destination "<agent-dir>\codex-planning-partner.md" -Force
npm install --prefix <runtime-dir>
```

## Privacy And Scope Notes

- Only set `OPENCODE_ADVISOR_ALLOWED_ROOTS` to directories you are willing to expose to the configured OpenCode runtime.
- Do not point it at broad parent directories by default.
- Diff context now goes through a conservative best-effort secret redaction pass before it is sent to OpenCode, but that does not replace your own repository hygiene or disclosure judgment.
- The bundled advisor blocks writes and denies `.env` reads, but that does not replace repository-level access control.

For every variable, default, unit, and adjustment guideline, see [CONFIGURATION.md](CONFIGURATION.md). For supported platforms, see [COMPATIBILITY.md](COMPATIBILITY.md).

## Common Failures

- `invalid_cwd`: the requested repo is outside `OPENCODE_ADVISOR_ALLOWED_ROOTS`
- `opencode_not_found`: `opencode` is missing from PATH or `OPENCODE_ADVISOR_OPENCODE_CMD` is wrong
- `opencode_failed`: the required OpenCode agent is missing or the OpenCode run failed
- MCP tool missing in Codex: reload or restart Codex after config changes

If `npm run doctor` fails, use its bucket as the first triage hint:

- `agent_missing_or_fallback`: reinstall `agents/codex-advisor.md` and `agents/codex-planning-partner.md`, then confirm `opencode agent list`
- `invalid_cwd_or_allowed_roots`: narrow or correct `OPENCODE_ADVISOR_ALLOWED_ROOTS`, then rerun doctor from `<repo-root>`
- `upstream_unavailable`: your configured OpenCode provider path is temporarily unavailable
- `timeout`: rerun or increase `OPENCODE_ADVISOR_TIMEOUT_MS`, and keep `tool_timeout_sec` higher than the inner timeout
