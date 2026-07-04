# Acceptance Checklist

Run these checks before public release, before npm publish, and after changes to server, package, agent, or install docs.

## Source Checks

From the repository:

```powershell
npm install
npm run smoke
npm test
```

Expected: all tests pass.

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
```

Expected: prints the bundled `codex-advisor.md` template.

## Packed Install Check

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
```

Expected:

- `codex-advisor (primary)` appears
- the direct run completes
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

Before pushing public history or publishing npm:

- run `npm run smoke`
- run `npm test`
- inspect `npm pack --dry-run`
- run one final OpenCode `codex-advisor` read-only review
- verify GitHub repo URL, package version, and release tag all match the intended public release
