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

## Source Install

From `<repo-root>`:

```powershell
npm install
npm run smoke
npm test
```

Create the agent file:

```powershell
New-Item -ItemType Directory -Force -Path <agent-dir>
Copy-Item -LiteralPath ".\agents\codex-advisor.md" -Destination "<agent-dir>\codex-advisor.md" -Force
```

Add this MCP block to `<codex-config>`:

```toml
[mcp_servers.opencode_advisor]
command = "node"
args = ["<repo-root>\\src\\server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 180

[mcp_servers.opencode_advisor.env]
OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root-or-semicolon-list>"
OPENCODE_ADVISOR_TIMEOUT_MS = "120000"
OPENCODE_ADVISOR_MAX_DIFF_CHARS = "60000"
```

## npm Package Status

The package metadata and CLI entrypoints are present so package shape can be tested locally, but `opencode-advisor-mcp` has not been published to npm yet. Use the source install path above until a future npm release is announced.

## Runtime Sync For Development

If you keep a separate local runtime copy, sync these files:

```powershell
Copy-Item -LiteralPath "<repo-root>\src\server.mjs" -Destination "<runtime-dir>\server.mjs" -Force
Copy-Item -LiteralPath "<repo-root>\package.json" -Destination "<runtime-dir>\package.json" -Force
Copy-Item -LiteralPath "<repo-root>\package-lock.json" -Destination "<runtime-dir>\package-lock.json" -Force
Copy-Item -LiteralPath "<repo-root>\agents\codex-advisor.md" -Destination "<agent-dir>\codex-advisor.md" -Force
npm install --prefix <runtime-dir>
```

## Privacy And Scope Notes

- Only set `OPENCODE_ADVISOR_ALLOWED_ROOTS` to directories you are willing to expose to the configured OpenCode runtime.
- Do not point it at broad parent directories by default.
- The bundled advisor blocks writes and denies `.env` reads, but that does not replace repository-level access control.

## Common Failures

- `invalid_cwd`: the requested repo is outside `OPENCODE_ADVISOR_ALLOWED_ROOTS`
- `opencode_not_found`: `opencode` is missing from PATH or `OPENCODE_ADVISOR_OPENCODE_CMD` is wrong
- `opencode_failed`: the `codex-advisor` agent is missing or the OpenCode run failed
- MCP tool missing in Codex: reload or restart Codex after config changes
