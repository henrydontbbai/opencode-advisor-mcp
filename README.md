# OpenCode Advisor MCP

OpenCode Advisor MCP gives Codex three local MCP tools:

- `ask_opencode_advisor` for a read-only reviewer pass
- `ask_opencode_planner` for a read-only planning pass
- `get_opencode_task` for queued or running work

The MCP server has exactly two built-in roles: `reviewer` and `planner`. It does not reuse normal OpenCode, Codex, or Cockpit provider settings. The bundled agents can reason only over the request plus supplied Git status/diff context and, for the planner, the supplied plan; they have no file or shell tools.

## Install And Configure

The setup command is separate from the MCP stdio server. For this source checkout:

```powershell
npm ci
npm run setup
```

Before publication, install a local packed tarball instead of a registry package:

```powershell
npm install -g <path-to-opencode-advisor-mcp.tgz>
opencode-advisor-setup
```

After publication, the registry package can use:

```powershell
npm install -g opencode-advisor-mcp
opencode-advisor-setup
```

`opencode-advisor-setup` requires an interactive terminal. It asks for a third-party provider ID, display name, API base URL, transport (`responses` or `chat_completions`), model list, reviewer model and optional reasoning variant, planner model and optional reasoning variant, and API key. The key is hidden at entry and is never accepted from command arguments, MCP TOML, or a pipe. Setup does not inspect normal OpenCode, Codex, or Cockpit configuration, credentials, or account-login state; no OpenCode account login is required.

The setup command creates an independent profile under `%USERPROFILE%\.codex\opencode-advisor` on Windows or `$HOME/.codex/opencode-advisor` on POSIX. Windows credentials use CurrentUser DPAPI. POSIX uses a filesystem-permission fallback: private `0700` profile directories and a `0600` Base64-encoded credential envelope, rather than DPAPI-equivalent encryption. The profile contains the bundled `codex-advisor` and `codex-planning-partner` agent templates plus a non-secret provider manifest.

The credential is bound to the exact manifest fingerprint, and the generated OpenCode overlay must also match that manifest. An incomplete profile written during setup, stale overlay, or binding mismatch is fail-closed: MCP calls return setup guidance without queuing work. If setup ends before it writes profile artifacts, a previously valid profile remains usable. Rerun `opencode-advisor-setup` instead of editing profile artifacts by hand.

## MCP Configuration

For a source checkout, use Node and the absolute server path. The only required environment setting is `OPENCODE_ADVISOR_ALLOWED_ROOTS`:

```toml
[mcp_servers.opencode_advisor]
command = "node"
args = ["C:\\absolute\\path\\to\\opencode-advisor-mcp\\src\\server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 420

[mcp_servers.opencode_advisor.env]
OPENCODE_ADVISOR_ALLOWED_ROOTS = "C:\\workspace\\allowed-repositories"
```

For a local tarball or published package installed globally, use `command = "opencode-advisor-mcp"`; [examples/codex-mcp.toml](examples/codex-mcp.toml) shows that installed-package form.

Do not put provider URLs, model IDs, API keys, tokens, or `OPENCODE_CONFIG_CONTENT` in the MCP configuration. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for non-secret runtime settings.

## Provider Compatibility

The setup transport is explicit:

- `responses` generates an `@ai-sdk/openai` provider. OpenCode owns the Responses streaming SSE exchange, including output-text events such as `response.output_text.delta` / `response.output_text.done`, error events (`error`, `response.failed`), and function-call events.
- `chat_completions` generates an `@ai-sdk/openai-compatible` provider and uses standard `/v1/chat/completions` stream chunks followed by `[DONE]`.

Each role can optionally select an OpenCode model `variant`. The choices are independent even when reviewer and planner use the same model; a common setup is reviewer `high` and planner `max`. Leave a variant empty to use the model default. For a `responses` provider/model that supports the selected variant, the generated OpenCode model variant reaches the Responses request as `reasoning.effort`. `high` and `max` are examples, not values guaranteed by every provider or model.

The built-in agents deny all tool execution. A streamed function call is covered only as a fail-closed condition: it is not executed, does not complete a tool round-trip, and the built-in-agent fixture expects a timeout rather than a reviewer or planner result. Raw provider tool events are not MCP output; only structured assistant text can become a reviewer or planner result. The provider key belongs only to the independent Advisor profile.

## Verify

From a source checkout:

```powershell
npm run smoke
npm test
npm run test:doctor
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

`opencode-advisor-doctor` checks the independent profile, both roles, structured JSON output, and sanitized MCP response shape. A missing or unreadable profile remains an `opencode_failed` MCP result with setup guidance; it never creates a queued task.

## Security Boundaries

- Reviewer and planner child processes run with `--pure` and an explicit `provider/model`.
- OpenCode receives isolated XDG and OpenCode configuration paths plus a generated `OPENCODE_CONFIG_CONTENT` overlay.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevents the reviewed repository's OpenCode configuration from being merged.
- Inherited OpenCode, XDG, provider-key, token, secret, and password environment variables are removed before OpenCode starts.
- Queue files, runner logs, doctor reports, and MCP responses do not include provider URLs, model selections, role variants, or API keys.
- A custom `OPENCODE_ADVISOR_OPENCODE_CMD` on Windows must name an existing, operator-trusted absolute `.exe`; command strings with arguments and `.cmd` / `.bat` wrappers are rejected.
- Keep `OPENCODE_ADVISOR_ALLOWED_ROOTS` narrow and use this only for repositories you are authorized to disclose to the configured provider.

Further details:

- [Install](docs/INSTALL.md)
- [Configuration](docs/CONFIGURATION.md)
- [Usage](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Acceptance](docs/ACCEPTANCE.md)
