# Acceptance Checklist

Run these checks before public GitHub release and after changes to server, package shape, agent, or install docs.

## Source Checks

From the repository:

```powershell
npm install
npm run smoke
npm test
npm run test:doctor
```

Expected: all tests pass.

## Local Doctor Check

This is an extra local runtime check for source installs. It is not part of the GitHub CI gate and it does not prove that an npm package has been published.

From the repository root after the agent template is installed, set allowed roots in the same shell and then run doctor. This terminal check does not inherit MCP env from your Codex config.

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

Expected:

- the direct `codex-advisor` agent check passes
- the direct `codex-planning-partner` agent check passes
- the local `askOpenCodeAdvisor({ include_diff:false, include_status:false })` health check passes
- the summary does not report forbidden fields such as `cwd`, `stderr_tail`, `stdout_tail`, or `allowed_roots`

If doctor fails, use the bucket as first triage:

- `opencode_not_found`
- `agent_missing_or_fallback`
- `invalid_cwd_or_allowed_roots`
- `upstream_unavailable`
- `timeout`
- `generic_opencode_failure`

## Packaging Checks

Dry-run the package:

```powershell
npm pack --dry-run
```

Expected:

- tarball is generated virtually without errors
- only intended files are included
- no `node_modules`, `.env`, logs, worktrees, temp files, or test fixtures ship in the tarball

Check the installed CLI behavior:

```powershell
npm run print-agent
npm run print-agent -- planner
```

Expected:

- default print command prints the bundled `codex-advisor.md` template
- planner print command prints the bundled `codex-planning-partner.md` template

## Local Tarball Install Check

This checks local package shape only. It does not prove that a public npm package has been published.

From a disposable directory:

```powershell
npm pack
npm install .\opencode-advisor-mcp-*.tgz
npx opencode-advisor-agent
```

Expected:

- install succeeds
- `opencode-advisor-agent` prints the bundled template

## OpenCode Agent Checks

```powershell
opencode agent list
opencode run --agent codex-advisor --format json "Say OK only."
opencode run --agent codex-planning-partner --format json "Say OK only."
```

Expected:

- both bundled agents appear
- each direct run completes
- output does not include a fallback such as `agent "codex-advisor" not found`

## Read-Only Negative Test

Run from a disposable directory:

```powershell
opencode run --agent codex-advisor --format json "Use any available tools to create file SHOULD_NOT_EXIST.txt with text hello."
Test-Path .\SHOULD_NOT_EXIST.txt
```

Expected:

```text
False
```

## MCP Behavior Checks

Set a narrow allowed root first:

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
```

Valid repo:

```powershell
node -e "import('./src/server.mjs').then(async ({ askOpenCodeAdvisor }) => { const r = await askOpenCodeAdvisor({ cwd: process.cwd(), include_diff: false, include_status: false }); console.log(JSON.stringify(r, null, 2)); })"
```

Expected:

- `ok: true`
- success response does not expose an absolute local `cwd`
- success response does not expose raw stderr tail

Planner path:

```powershell
node -e "import('./src/server.mjs').then(async ({ askOpenCodePlanner }) => { const r = await askOpenCodePlanner({ cwd: process.cwd(), current_plan: '1. Validate config\\n2. Run doctor' }, { useQueue: false }); console.log(JSON.stringify(r, null, 2)); })"
```

Expected:

- `ok: true`
- response contains `planner_text`
- response does not expose an absolute local `cwd`

Queued path:

```text
If an ask tool returns { ok:false, error:"queued" }, keep the phase pending and call get_opencode_task with the returned task_id.
```

Invalid cwd:

```powershell
node -e "import('./src/server.mjs').then(async ({ askOpenCodeAdvisor }) => { const r = await askOpenCodeAdvisor({ cwd: 'C:\\Windows', include_diff: false, include_status: false }); console.log(JSON.stringify(r, null, 2)); })"
```

Expected:

- `ok: false`
- `error: "invalid_cwd"`
- response does not expose `allowed_roots`
- response does not echo the rejected absolute path

Invalid path:

```powershell
node -e "import('./src/server.mjs').then(async ({ askOpenCodeAdvisor }) => { const r = await askOpenCodeAdvisor({ cwd: process.cwd(), paths: ['C:\\Windows\\not-allowed.txt'], include_diff: false, include_status: false }); console.log(JSON.stringify(r, null, 2)); })"
```

Expected:

- `ok: false`
- `error: "invalid_paths"`

Invalid base ref:

```powershell
node -e "import('./src/server.mjs').then(async ({ askOpenCodeAdvisor }) => { const r = await askOpenCodeAdvisor({ cwd: process.cwd(), base_ref: '--output=SHOULD_NOT_EXIST.txt' }); console.log(JSON.stringify(r, null, 2)); })"
```

Expected:

- `ok: false`
- `error: "invalid_paths"`

## History And Release Checks

Before creating a public remote or public tag:

```powershell
git log --all --decorate --stat --oneline
$pattern = "gho_|npm_|C:\\Users\\|/Users/|/home/"
git rev-list --all | ForEach-Object { git grep -n -E $pattern $_ }
```

Expected:

- no secrets or tokens
- no personal path leakage intended for public history
- no `node_modules` or runtime-only files in tracked history

## Final Review Gate

Before pushing public history or creating a GitHub release:

- run `npm run smoke`
- run `npm test`
- run `npm run test:doctor`
- run `npm run doctor` for source installs
- inspect `npm pack --dry-run`
- run one final OpenCode `codex-advisor` read-only review
- verify GitHub repo URL, package version, and release tag all match the intended public release
