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

## Publish In Exact Order

Each numbered step is a separate external action and requires explicit authorization. Never rebuild the tarball after approval or move the tag ahead of registry verification.

1. Record the fully verified release commit and require a clean checkout:

   ```powershell
   $releaseCommit = git rev-parse HEAD
   git status --short
   ```

2. Pack that exact checkout once and retain the generated filename and integrity output:

   ```powershell
   npm pack --json
   ```

3. Publish the exact generated `.tgz`, not the working directory:

   ```powershell
   npm publish .\opencode-advisor-mcp-0.3.0.tgz --access public
   ```

4. Verify npm registry metadata before creating any Git tag:

   ```powershell
   npm view opencode-advisor-mcp@0.3.0 version dist.integrity dist.tarball --json
   ```

   Install `opencode-advisor-mcp@0.3.0` into a fresh temporary prefix and smoke all four published bins. The registry version and integrity must match the approved tarball evidence.

5. Create and push annotated tag `v0.3.0` at `$releaseCommit`, then verify the remote tag resolves to the same commit. Do not tag any later documentation or cleanup commit.

6. Create the GitHub Release from `v0.3.0` using the matching changelog section. The release must reference the already verified registry package and the same source commit.

## Authorization Boundaries

Commit, push, merge pull requests, edit or close issues, perform npm identity/package-permission checks, publish, push a tag, and create a GitHub Release only after separate explicit authorization. Authorization for one step does not authorize a later step, and this document grants none of them.
