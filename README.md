# OpenCode Advisor MCP

OpenCode Advisor MCP is an unofficial local MCP server that lets Codex ask a read-only OpenCode advisor for a second review pass on Git changes.

This project is for people who already use Codex and OpenCode locally and want a second review tool in the loop without giving that reviewer write access.

## Project Status

- Latest tagged GitHub release: `v0.2.0`
- `main` includes unreleased stabilization changes after `v0.2.0`
- Current scope: one MCP tool, `ask_opencode_advisor`
- Supported mode: source/GitHub install with a local OpenCode agent template
- npm package publication is planned for a future release and is not available yet

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

Copy the bundled advisor template into your OpenCode agents directory:

```powershell
New-Item -ItemType Directory -Force -Path <agent-dir>
Copy-Item -LiteralPath ".\agents\codex-advisor.md" -Destination "<agent-dir>\codex-advisor.md" -Force
```

Add this MCP config to Codex:

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

Replace `<repo-root>` with the absolute path to this source checkout.

After the agent template is installed, set allowed roots in the same shell that will run doctor. The terminal check does not inherit MCP env from the Codex config block above.

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

`npm run doctor` is a local source-install health check. It depends on your local OpenCode runtime, the bundled `codex-advisor` agent, and a valid `OPENCODE_ADVISOR_ALLOWED_ROOTS` value in the shell that launches it. It is not proof of npm publication.

## npm Package Status

The package metadata and CLI entrypoints are present for packaging checks, but `opencode-advisor-mcp` has not been published to npm yet. Use the source install path above for now.

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
npm run test:doctor
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

`npm run doctor` is an extra local runtime check for source installs. It is not part of the GitHub CI gate and it does not replace `npm run print-agent` or `npm pack --dry-run`.

Release and acceptance steps live in:

- [docs/INSTALL.md](docs/INSTALL.md)
- [docs/USAGE.md](docs/USAGE.md)
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
- [RELEASING.md](RELEASING.md)
