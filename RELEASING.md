# Releasing

Use this checklist for public GitHub and npm releases.

## Preconditions

- GitHub account security is in good standing
- npm account is authenticated
- npm 2FA is enabled
- package name availability is confirmed immediately before publish

## Verify The Tree

```powershell
npm install
npm run smoke
npm test
npm pack --dry-run
```

Also verify:

- the tarball contains only intended files
- `npm run print-agent` prints the bundled template
- a packed install works in a fresh temp directory

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
- release readiness

## GitHub Release

1. create or update the public repository
2. add `origin`
3. push `main`
4. create and push the public release tag
5. create the GitHub Release from `CHANGELOG.md`

## npm Release

```powershell
npm whoami
npm publish --access public
```

If your npm environment supports provenance, prefer:

```powershell
npm publish --access public --provenance
```

Publish from a clean checkout only.
