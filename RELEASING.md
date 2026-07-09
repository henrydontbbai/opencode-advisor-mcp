# Releasing

Use this checklist for public GitHub releases. npm publication is a future optional path and is not part of the current release flow.

## Preconditions

- GitHub account security is in good standing
- private vulnerability reporting is enabled for the repository
- the intended release tag and `package.json` version are aligned

## Verify The Tree

```powershell
npm install
npm run smoke
npm test
npm run test:doctor
npm pack --dry-run
```

Also verify:

- the tarball contains only intended files
- `npm run print-agent` prints the advisor template
- `npm run print-agent -- planner` prints the planner template
- a packed install works in a fresh temp directory
- for source installs, `npm run doctor` passes from the repo root in the same shell where `OPENCODE_ADVISOR_ALLOWED_ROOTS` is set

## Scan For Public Release Problems

Current tree:

```powershell
rg -n "gho_|npm_|C:\\Users\\|/Users/|/home/" .
```

History and tags:

```powershell
git log --all --decorate --stat --oneline
$pattern = "gho_|npm_|C:\\Users\\|/Users/|/home/"
git rev-list --all | ForEach-Object { git grep -n -E $pattern $_ }
```

Expected:

- no secrets
- no personal machine-path leakage intended for public history
- no local runtime artifacts in tracked history

## Review

Run one final OpenCode read-only review focused on:

- privacy and disclosure boundaries
- packaging contents
- queued/running semantics staying explicit and non-destructive
- release readiness

## GitHub Release

1. create or update the public repository
2. add `origin`
3. push `main`
4. create and push the public release tag
5. create the GitHub Release from `CHANGELOG.md`

## Future npm Release

Do not run this section for the current non-npm flow. Before any future npm release, confirm account authentication, 2FA, package ownership or availability, and the exact package version.

Future command shape:

```powershell
npm whoami
npm publish --access public --provenance
```

If provenance is unavailable in the environment, use `npm publish --access public`. Publish from a clean checkout only.
