# Compatibility

| Component | Supported baseline | Notes |
| --- | --- | --- |
| Node.js | `>=20` | CI covers Node 20 and 22. |
| Windows | supported | Use an absolute dedicated profile path and normal Windows executable paths. The server can fall back to limited known OpenCode install locations only after a `PATH` launch fails. |
| macOS | supported | Use POSIX paths such as `/Users/name/...`; verify your local OpenCode install with doctor. |
| Linux | supported | Use POSIX paths such as `/home/name/...`; CI covers Ubuntu. |
| Codex | stdio MCP configuration | Requires a Codex environment that can launch a Node stdio MCP server. |
| OpenCode | current docs validated with `1.17.13` | Both bundled agents must be installed in the dedicated profile. |

Not supported as a security guarantee: multi-tenant queue isolation, remote shared queue storage, automatic migration of an existing OpenCode profile, copying provider credentials, or direct database cleanup/compaction.

Use the compatibility matrix as a starting point, not as a substitute for `npm run doctor` and the local acceptance checks.
