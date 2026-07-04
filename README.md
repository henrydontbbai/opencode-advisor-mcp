# OpenCode Advisor MCP

OpenCode Advisor MCP is an unofficial local MCP server that lets Codex ask a read-only OpenCode advisor for a second review pass on Git changes.

This project is for people who already use Codex and OpenCode locally and want a second review tool in the loop without giving that reviewer write access.

## Project Status

- Public first release target: `0.2.0`
- Current scope: one MCP tool, `ask_opencode_advisor`
- Supported mode: local install, local OpenCode agent template, manual GitHub and npm release flow

## Unofficial Compatibility Notice

This is an unofficial community project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Codex, OpenCode, or the maintainers of those products. "Codex" and "OpenCode" are referenced only for compatibility and integration context.

## Responsible Use

Use this tool only on repositories and diffs you are authorized to inspect and disclose.

Important boundaries:

- The tool sends Git status, Git diff context, your question, and working-directory context to your configured OpenCode runtime.
- Depending on your OpenCode configuration, that runtime may use a remote model provider. Do not assume this means "nothing ever leaves the machine."
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

## Install From npm

Install globally:

```powershell
npm install -g opencode-advisor-mcp
```

Write the bundled advisor template into your OpenCode agents directory:

```powershell
opencode-advisor-agent > <agent-dir>\codex-advisor.md
```

Add this MCP config to Codex:

```toml
[mcp_servers.opencode_advisor]
command = "opencode-advisor-mcp"
args = []
startup_timeout_sec = 30
tool_timeout_sec = 180

[mcp_servers.opencode_advisor.env]
OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root-or-semicolon-list>"
OPENCODE_ADVISOR_TIMEOUT_MS = "120000"
OPENCODE_ADVISOR_MAX_DIFF_CHARS = "60000"
```

If the global npm bin directory is not on PATH, use the full installed binary path instead of `opencode-advisor-mcp`.

## Install From Source

If you prefer a source checkout workflow, use the steps in [docs/INSTALL.md](docs/INSTALL.md).

## Usage

Codex gets one MCP tool:

```text
ask_opencode_advisor
```

Typical prompt:

```text
Ask opencode_advisor to review the current changes.
Focus on risks, missing tests, privacy issues, and release readiness.
```

The server returns structured JSON with stable error codes such as `invalid_cwd`, `invalid_paths`, `git_failed`, `opencode_not_found`, `opencode_failed`, and `timeout`.

## Local Verification

From the repository:

```powershell
npm install
npm run smoke
npm test
```

Release and acceptance steps live in:

- [docs/INSTALL.md](docs/INSTALL.md)
- [docs/USAGE.md](docs/USAGE.md)
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
- [RELEASING.md](RELEASING.md)
