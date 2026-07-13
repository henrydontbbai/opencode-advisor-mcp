# Releasing

## Verify The Package

From a clean source checkout:

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

The tarball must include `opencode-advisor-setup`, `opencode-advisor-doctor`, the two agent templates, profile modules, and no profile or credential files.

## Local Provider Gate

Use a disposable or intended local profile and configure it with `opencode-advisor-setup`. Do not reuse a normal OpenCode, Codex, or Cockpit provider profile.

```powershell
$env:OPENCODE_ADVISOR_ALLOWED_ROOTS = "<allowed-root>"
npm run doctor
```

Then run one real reviewer and planner request. Each release-gate conclusion must explicitly say `BLOCKER: none`. A 401, timeout, fallback, empty result, non-JSON result, or generic doctor failure is not a pass.

Also exercise the independent-profile recovery boundary: alter a disposable manifest so its credential-manifest binding no longer matches, then alter a generated overlay so its manifest-overlay binding no longer matches. Both conditions must be rejected before a queue task is created; recover only by rerunning `opencode-advisor-setup`. A setup cancelled before profile writing may leave the prior valid profile usable. On POSIX, verify the profile remains private (`0700` directories and `0600` credential file). On Windows, a custom `OPENCODE_ADVISOR_OPENCODE_CMD` must be an existing trusted absolute `.exe`, never a shell wrapper or command string with arguments.

When a local OpenCode executable is available, run the opt-in provider fixture described in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md). It is the release evidence for Responses text/error/tool-event SSE handling and Chat Completions streaming. Do not enable agent tools merely to make a tool-call event pass: the two bundled agents must retain `permission: "*": deny`, leave the streamed call unexecuted, and fail closed with the expected timeout.

## Package Scan

Verify package contents do not include:

- `.env` files, API keys, credential files, profile directories, queue logs, or worktrees
- `test/`, `scripts/`, `node_modules/`, or local tarballs
- private absolute paths or machine-specific runtime artifacts

## Source-Only GitHub Release

The current release path does not use the npm registry. Never rebuild the tarball after it has been verified, and never move a published tag.

1. Record the fully verified release commit and require a clean checkout:

   ```powershell
   $releaseCommit = git rev-parse HEAD
   git status --short
   ```

2. Pack that exact checkout once and retain the generated filename and integrity output:

   ```powershell
   npm pack --json
   ```

3. Compute `SHA256SUMS.txt`, install the exact `.tgz` into a fresh temporary prefix, and smoke all four bins plus the MCP version and three-tool handshake.

4. Create and push annotated tag `v0.3.0` at `$releaseCommit`, then verify the remote annotated tag dereferences to the same commit. Do not tag later documentation or cleanup commits.

5. Create one Draft GitHub Release from `v0.3.0`. Attach the exact `.tgz` and `SHA256SUMS.txt`, and state prominently that the package is source-only and not available from npm.

6. Download both Draft assets into a new temporary directory. Verify the SHA-256 manifest, install the downloaded tarball into another fresh prefix, and repeat all four bin smokes plus the MCP handshake and doctor.

7. Publish that same Draft. Verify the public release remains attached to the intended tag and exposes the same asset IDs, sizes, and API digests. Record whether GitHub reports `immutable:true`.

8. If GitHub reports `immutable:false`, immediately anchor the exact release ID, asset IDs, filename, size, and SHA-256 in protected repository history and pin the expected digest in installation docs. A checksum downloaded beside the tarball is not an independent trust anchor.

## Failure And Recovery Rules

- Before tag push, stop on any failed check or hash mismatch; do not create external release state.
- After tag push, never move, delete, or recreate the tag to conceal a failure. Retry the GitHub Release against the same tag.
- Do not silently replace a published tarball or checksum asset. If released content is defective, document the problem and ship a new patch version.
- When GitHub immutable releases are unavailable or disabled, treat the protected-history digest as authoritative and reject any later asset whose API digest, size, or ID no longer matches the recorded evidence.
- A notes-only typo may be corrected without changing the tag or assets.

## Future npm Publication

npm publication is a separate optional release path and is not implied by a GitHub Release. Before using it, obtain explicit authorization and verify account identity, 2FA, package ownership, and exact tarball provenance.

Future command shape:

```powershell
npm whoami
npm publish .\opencode-advisor-mcp-<version>.tgz --access public --provenance
```

After publication, verify registry integrity and install the registry artifact into a new prefix before creating a release tag for that version.

## Authorization Boundaries

Commit, push, merge pull requests, edit or close issues, perform npm identity/package-permission checks, publish to npm, push a tag, and create or publish a GitHub Release only after explicit authorization. This document grants none of those permissions.
