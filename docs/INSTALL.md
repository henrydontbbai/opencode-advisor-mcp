# Install

## Prerequisites

- Node.js `>=20`
- A local `opencode` executable on `PATH`, or `OPENCODE_ADVISOR_OPENCODE_CMD` pointing to one
- An MCP client that can start a stdio command

The provider does not need an OpenCode account or a normal-profile login session. On Windows, a custom `OPENCODE_ADVISOR_OPENCODE_CMD` must be an existing absolute `.exe` from a location you trust; it cannot be a `.cmd` / `.bat` wrapper or an executable-plus-arguments string.

## Package Install

Install the verified tarball attached to the [GitHub `v0.3.0` Release](https://github.com/henrydontbbai/opencode-advisor-mcp/releases/tag/v0.3.0). This release process did not publish to npm, and no npm-registry install path is supported for `v0.3.0`.

```powershell
Invoke-WebRequest https://github.com/henrydontbbai/opencode-advisor-mcp/releases/download/v0.3.0/opencode-advisor-mcp-0.3.0.tgz -OutFile opencode-advisor-mcp-0.3.0.tgz
Invoke-WebRequest https://github.com/henrydontbbai/opencode-advisor-mcp/releases/download/v0.3.0/SHA256SUMS.txt -OutFile SHA256SUMS.txt
$expected = "47a4697ad28e99fd85ba2951ac21289a566378948743526f2b1cde5cbd905fa1"
$manifest = (Get-Content .\SHA256SUMS.txt -Raw).Trim()
if ($manifest -ne "$expected  opencode-advisor-mcp-0.3.0.tgz") { throw "Release manifest mismatch" }
$actual = (Get-FileHash .\opencode-advisor-mcp-0.3.0.tgz -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Release checksum mismatch" }
npm install -g .\opencode-advisor-mcp-0.3.0.tgz
opencode-advisor-setup
```

On Bash-compatible systems:

```bash
curl -LO https://github.com/henrydontbbai/opencode-advisor-mcp/releases/download/v0.3.0/opencode-advisor-mcp-0.3.0.tgz
curl -LO https://github.com/henrydontbbai/opencode-advisor-mcp/releases/download/v0.3.0/SHA256SUMS.txt
expected='47a4697ad28e99fd85ba2951ac21289a566378948743526f2b1cde5cbd905fa1  opencode-advisor-mcp-0.3.0.tgz'
test "$(tr -d '\r\n' < SHA256SUMS.txt)" = "$expected" || { echo "Release manifest mismatch" >&2; exit 1; }
printf '%s\n' "$expected" | sha256sum -c -
npm install -g ./opencode-advisor-mcp-0.3.0.tgz
opencode-advisor-setup
```

For another local packed tarball, install that exact file:

```powershell
npm install -g <path-to-opencode-advisor-mcp.tgz>
opencode-advisor-setup
```

For source development or as a fallback, install dependencies and run setup from the checkout:

```powershell
npm ci
npm run setup
```

The setup command is intentionally not the MCP server command. It prompts interactively for the independent third-party provider configuration and hidden API key. It accepts no configuration arguments and no piped key input. It copies `codex-advisor.md` and `codex-planning-partner.md` into the independent profile. It does not read normal OpenCode, Codex, or Cockpit provider configuration or credentials.

During setup, select one transport:

- `responses`: `@ai-sdk/openai`, OpenAI-compatible Responses API with OpenCode-managed streaming SSE support
- `chat_completions`: `@ai-sdk/openai-compatible`, OpenAI-compatible Chat Completions API with streaming support

Select one configured model for `reviewer` and one for `planner`; they may be the same. Setup then asks for an optional reasoning variant for each role. The choices are independent, so reviewer `high` and planner `max` can share one model. Leave either variant empty to use that model's default, and only select a value supported by the chosen provider/model. No other role is configured.

For a compatible `responses` provider/model, a selected role variant becomes an OpenCode model variant and reaches the API request as `reasoning.effort`. The example names `high` and `max` are not guaranteed to be accepted by every provider or model.

If profile writing leaves incomplete artifacts or a binding mismatch, do not repair individual manifest, overlay, or credential files. The next MCP call fails closed with setup guidance until you rerun `opencode-advisor-setup` successfully. If setup ends before profile writing begins, a prior valid profile remains usable.

## Codex MCP Entry

Use [examples/codex-mcp.toml](../examples/codex-mcp.toml) for a globally installed GitHub Release or local tarball:

```toml
[mcp_servers.opencode_advisor]
command = "opencode-advisor-mcp"
startup_timeout_sec = 30
tool_timeout_sec = 420

[mcp_servers.opencode_advisor.env]
OPENCODE_ADVISOR_ALLOWED_ROOTS = "C:\\workspace\\allowed-repositories"
```

For a source checkout, call Node with the absolute server path:

```toml
[mcp_servers.opencode_advisor]
command = "node"
args = ["C:\\absolute\\path\\to\\opencode-advisor-mcp\\src\\server.mjs"]
```

Do not use the setup CLI as the stdio MCP command.

Keep `OPENCODE_ADVISOR_ALLOWED_ROOTS` narrow. It accepts a semicolon-separated list. A Windows path containing a semicolon must be quoted, for example `"C:\workspace\team;alpha";C:\workspace\other`.

The MCP configuration must not contain provider URL, provider key, model, token, or secret settings. Those values only live in the independent profile written by `opencode-advisor-setup`.

## Validate

Run the non-MCP doctor after setup from a shell with the same allowed-root policy:

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
opencode-advisor-doctor
```

From a source checkout, `npm run doctor` runs the same command. A `provider_setup_required` result means setup is absent, damaged, interrupted, has a stale manifest/overlay binding, or the stored credential cannot be decrypted; rerun setup. A `provider_authentication_failed` result means the third-party provider rejected its configured credential.

See [CONFIGURATION.md](CONFIGURATION.md) for profile location and runtime knobs.
