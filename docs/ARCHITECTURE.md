# Architecture

## Components

`opencode-advisor-setup` is a non-MCP bootstrap CLI. It validates non-secret provider metadata, copies the two bundled agent templates, writes the manifest atomically, and stores the provider key through the platform credential layer. It is the sole source of the independent third-party provider ID, base URL, transport, models, optional per-role variants, role mapping, and key.

`opencode-advisor-mcp` remains a stdio MCP server with three tools. It exposes only `reviewer`, `planner`, and task lookup. The internal role registry is static: no provider manifest can add an implementation role or change the MCP tool surface.

`opencode-advisor-doctor` is a non-MCP diagnostic CLI packaged with the runtime. It uses the same profile loader and OpenCode child environment as reviewer and planner calls.

## Provider Execution

For every reviewer or planner task:

1. The server validates allowed roots and input.
2. It loads the independent profile, validates private profile entries, verifies the manifest and generated overlay agree, checks the credential's manifest fingerprint, and only then decrypts the credential in memory.
3. It builds an isolated child environment with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and `OPENCODE_DISABLE_PROJECT_CONFIG=1`. The target repository's `opencode.json` is not merged.
4. It generates `OPENCODE_CONFIG_CONTENT` with exactly one provider, `{env:OPENCODE_ADVISOR_PROVIDER_KEY}` as its key reference, and any configured role model variants.
5. It removes inherited `OPENCODE_*`, `XDG_*`, provider key, token, secret, and password variables.
6. It runs `opencode run --pure --agent <role> --model <provider/model> [--variant <role-variant>] --format json`.

The decrypted `OPENCODE_ADVISOR_PROVIDER_KEY` exists only in the OpenCode child environment. The key, provider URL, model selection, and role variant are not persisted in queue tasks, runner logs, doctor reports, or MCP responses. Setup and the child process do not read normal OpenCode, Codex, or Cockpit provider configuration, credentials, or account-login state.

`responses` uses `@ai-sdk/openai`; `chat_completions` uses `@ai-sdk/openai-compatible`. OpenCode owns the HTTP streaming and SSE handling. For a compatible `responses` provider/model, an optional role variant becomes an OpenCode model variant and sends matching `reasoning.effort` in the Responses request. Variant names such as `high` and `max` remain provider/model-dependent. The local provider contract exercises `POST /v1/responses` with streaming Responses output-text events (`response.output_text.delta`, `response.output_text.done`, and `response.completed`) and treats `error` / `response.failed` as a failed run. The Chat Completions contract exercises `POST /v1/chat/completions` with standard chunk SSE and `[DONE]`.

## Agent And Tool Boundary

The bundled `codex-advisor` and `codex-planning-partner` templates both set `permission: "*": deny`. They receive a prompt assembled from the caller request, collected Git status, optional diff, and, for the planner, an explicitly supplied current plan and constraints. They have no file, shell, web, subagent, or write tools, so they cannot inspect any repository state beyond that prompt.

The Responses provider contract also covers function-call SSE (`response.function_call_arguments.delta`, `response.function_call_arguments.done`, and `response.output_item.done`). Internal provider or OpenCode tool events do not grant a capability, are not surfaced as MCP output, and do not count as assistant text. Because both built-in agents deny tools, the fixture call remains unexecuted and fails closed at the configured OpenCode timeout; the contract fixture uses a short timeout. It is not a completed tool round-trip.

## Queue Boundary

The server performs profile validation before `createTaskFile` is called. Therefore an unconfigured, incomplete, tampered, or binding-mismatched profile cannot create a task record. Detached queue runners receive only a reduced non-secret runtime environment and reload the profile themselves when executing a task. Queue, direct, and doctor calls persist minimal session ownership records under the private queue directory. Maintenance deletes only exact recorded session IDs through the isolated profile environment, never injects the provider credential, and never scans or mutates ordinary OpenCode sessions. The profile and queue form a local single-user boundary, not a multi-tenant storage system.

Queue task JSON retains input, task state, and result metadata only. It never stores profile contents, provider model data, provider URL, or a credential.

## Credential Boundary

On Windows, a fixed `powershell.exe` helper below `SystemRoot` uses `ProtectedData` with `CurrentUser`; plaintext and ciphertext cross the helper boundary through stdin/stdout only. On POSIX, credential storage falls back to filesystem protection: private profile directories use mode `0700`, the credential file uses mode `0600`, and the credential envelope is Base64-encoded rather than DPAPI-equivalent encryption. Where POSIX permission checks can be enforced, loading rejects unsafe modes, ownership, symlinks, and wrong file types.

The credential metadata carries a fingerprint of the validated manifest. If setup is interrupted, the manifest/overlay is stale, or the credential binding fails, profile loading returns setup-required guidance before queuing or provider execution. The supported recovery is to rerun `opencode-advisor-setup`, not to edit profile artifacts. The setup flow does not copy credentials from other applications and does not support API key arguments or non-interactive API key input.

## Command Boundary

The default OpenCode command is `opencode`. A non-default `OPENCODE_ADVISOR_OPENCODE_CMD` must be an existing absolute executable path. On Windows it must be an absolute `.exe`; `.cmd`, `.bat`, and executable-plus-arguments strings are rejected. The implementation does not establish publisher trust itself, so the operator must select the `.exe` from a trusted location.
