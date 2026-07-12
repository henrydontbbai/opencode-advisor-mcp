# Contributing

Thanks for contributing.

## Development Setup

```powershell
npm install
npm run smoke
npm test
npm run test:doctor
```

For a local advisor flow, run `npm run setup` to create an independent Advisor profile, set a narrow `OPENCODE_ADVISOR_ALLOWED_ROOTS`, and run `npm run doctor`. Do not copy templates, credentials, or configuration from a normal OpenCode, Codex, or Cockpit profile.

## Ground Rules

- Keep changes focused
- Add or update tests for behavior changes
- Do not commit local runtime copies, credentials, or temp artifacts
- Do not widen privacy exposure without updating docs and acceptance checks
- Treat OpenCode as a reviewer, not the implementation owner

## Pull Requests

Before opening a pull request:

- run `npm test`
- run `npm run test:doctor`
- run `npm run smoke`
- explain the user-visible behavior change
- note any privacy, disclosure, or packaging impact
