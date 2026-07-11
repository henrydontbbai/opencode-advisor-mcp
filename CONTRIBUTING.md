# Contributing

Thanks for contributing.

## Development Setup

```powershell
npm install
npm run smoke
npm test
npm run test:doctor
```

If you use the local OpenCode advisor flow, also install the bundled `codex-advisor.md` template and keep your allowed roots narrow.

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
