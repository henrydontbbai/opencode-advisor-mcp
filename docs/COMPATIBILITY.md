# Compatibility

| Component               | Supported baseline | Notes                                                                                                                                                 |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                 | `>=20`             | CI covers Node 20 and 22.                                                                                                                             |
| Codex-compatible client | stdio MCP          | The client must be able to start a Node stdio MCP server.                                                                                             |
| OpenCode CLI            | local executable   | Resolve `opencode` from `PATH`, or set `OPENCODE_ADVISOR_OPENCODE_CMD` to an approved absolute executable. Run doctor against the local installation. |
| Windows                 | supported          | Provider credentials use CurrentUser DPAPI. A custom OpenCode command must be an existing absolute `.exe`.                                            |
| macOS and Linux         | supported          | The private profile uses POSIX permission fallback: directories use `0700` and the credential file uses `0600` where those checks are enforceable.    |

Setup creates and uses one independent Advisor profile. It does not migrate a normal OpenCode profile, copy provider credentials, or depend on an OpenCode account-login session.

This is a local single-user boundary. It does not provide multi-tenant queue isolation, remote shared queue storage, or direct database cleanup/compaction guarantees.

Use this page as a starting point, then run `npm run doctor` and the local acceptance checks with the intended provider.
