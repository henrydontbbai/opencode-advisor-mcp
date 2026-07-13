# Acceptance Checklist

## Automated Checks

From a source checkout:

```powershell
npm ci
npm run smoke
npm test
npm run test:doctor
npm run print-agent
npm run print-agent -- planner
npm pack --dry-run
git diff --check
```

Expected: all tests pass, both agent templates print, and the dry-run tarball contains setup, doctor, profile modules, and no credentials or local profile artifacts.

## Independent Provider Check

Run `opencode-advisor-setup` in a terminal and configure a disposable or intended third-party provider. Confirm that setup rejects API key arguments and non-interactive input.

Set a narrow root and run doctor:

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
opencode-advisor-doctor
```

Expected:

- both `codex-advisor` and `codex-planning-partner` direct checks use structured JSON
- both runs use the independent profile, `--pure`, explicit configured models, and their configured `--variant` value when present
- reviewer and planner can choose optional variants independently (for example reviewer `high` and planner `max`); a blank value uses the model default, and deployed provider/model support determines which names are valid
- setup does not read normal OpenCode, Codex, or Cockpit provider settings or require a normal OpenCode account-login session
- doctor output contains no provider URL, model selection, or API key
- `provider_setup_required`, `provider_authentication_failed`, timeout, fallback, empty output, and non-JSON output fail the gate

## Profile Recovery And Storage

In a disposable profile, test a stale credential-manifest fingerprint and a manifest that no longer matches its generated OpenCode overlay. A setup cancelled before profile writing begins may leave the prior valid profile usable.

Expected:

- each incomplete or binding-mismatched profile condition is fail-closed before queue submission: MCP returns `opencode_failed` with setup guidance, and doctor reports `provider_setup_required`
- recovery is a fresh interactive `opencode-advisor-setup` run, never a manual edit to manifest, overlay, agent, or credential files
- Windows uses CurrentUser DPAPI for the credential
- POSIX uses the permission fallback: profile directories are private `0700`, the credential file is `0600`, and a group/world-readable artifact is rejected where those checks are enforceable

## MCP Behavior

Call reviewer and planner against a repository inside `OPENCODE_ADVISOR_ALLOWED_ROOTS`.

Expected:

- reviewer success contains `advisor_text`
- planner success contains `planner_text`
- both agent templates retain `permission: "*": deny`; they analyze only the supplied request, Git status/diff, and planner plan/constraints rather than reading repository files or running tools
- success responses do not expose profile details, allowed roots, raw stderr, or credentials
- missing setup returns `opencode_failed` and setup guidance before a queue task is created
- invalid cwd returns `invalid_cwd`; invalid paths return `invalid_paths`

## Queue Behavior

Manual queued-path poll:

```text
If an ask tool returns { ok:false, error:"queued" }, keep the phase pending and poll get_opencode_task with its task_id.
```

Expected:

- completed result should preserve `advisor_text` or `planner_text`
- an expired status rather than timeout identifies stale local queue state
- task JSON and detached runner logs contain no provider URL, model selection, or credential

## Responses API Contract

Run the opt-in local provider fixture outside CI for both transports. With a local OpenCode executable available, use:

```powershell
$env:OPENCODE_ADVISOR_RUN_PROVIDER_CONTRACT = "1"
node --test test/provider-contract.test.mjs
```

Expected:

- `responses` receives `/v1/responses` with streaming enabled, an array `input`, `store: false`, and a positive integer `max_output_tokens`; reasoning-enabled requests include encrypted reasoning state, and OpenCode accepts `response.output_text.delta`, `response.output_text.done`, and `response.completed` text events
- the local fixture observes reviewer `high` and planner `max` as separate `reasoning.effort` values for its compatible Responses model; production setup must use only values supported by its provider/model
- a Responses `error` followed by `response.failed` fails closed without exposing the configured credential
- `chat_completions` receives `/v1/chat/completions` with streaming enabled, standard chunks, and `[DONE]`
- Responses function-call SSE is covered through `response.function_call_arguments.delta`, `response.function_call_arguments.done`, and `response.output_item.done`; the fixture call is never executed because both built-in agents retain `permission: "*": deny`
- that built-in-agent tool-event path ends as the fixture's short configured `timeout`, not a successful tool round-trip or assistant result, and exposes no credential

The fixture is an operator acceptance check, not a no-OpenCode CI dependency.

## Windows Command Override

When setting `OPENCODE_ADVISOR_OPENCODE_CMD` on Windows, use an existing absolute `.exe` from a trusted location. Confirm that a `.cmd`, `.bat`, relative path, or command string with arguments is rejected before any child process starts.

## Final Review Gate

Run a real reviewer and planner. Only explicit `BLOCKER: none` conclusions qualify as release evidence. A 401, timeout, agent fallback, empty conclusion, or generic error does not qualify.
