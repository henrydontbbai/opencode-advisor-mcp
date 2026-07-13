## Summary

-

## Verification

- [ ] `npm run smoke`
- [ ] `npm test`
- [ ] `npm run print-agent`
- [ ] `npm pack --dry-run`

## Release And Privacy Checks

- [ ] no new local absolute-path leakage in structured responses
- [ ] no secrets, `.env`, `.npmrc`, or runtime-only files added
- [ ] docs updated if install, packaging, or disclosure behavior changed
