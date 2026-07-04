# Git Workflow

This repository is the source-controlled copy for the public OpenCode Advisor MCP project.

## Branches

- `main` stays deployable
- use short task branches with the `codex/` prefix
- keep public-release work isolated from local runtime sync work

Example:

```text
codex/public-oss-release
```

## Before Commit

Run:

```powershell
npm test
git status --short
```

Expected:

- tests pass
- only intended source, docs, workflow, or config files changed
- no local runtime copies, caches, logs, tarballs, or credentials are tracked

## Public Release Hygiene

Before the first public push:

- scan the current tree
- scan full history
- scan local tags
- remove personal machine paths and internal-only wording
- confirm `.env`, `.npmrc`, logs, tarballs, and worktrees are ignored

Do not publish early local-only tags or history that you would not want attached to a public open-source project.

## Commit Style

Use concise commits:

```text
docs: clarify public install flow
fix: sanitize advisor responses
chore: add release automation
```

Prefer one coherent change per commit.
