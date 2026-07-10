# Security Policy

## Supported Versions

Security fixes are best-effort for the latest published release and `main`.

## Reporting

Please do not open public issues for suspected vulnerabilities that could expose secrets, private repositories, authentication material, or unsafe disclosure paths.

Instead, report privately through GitHub private vulnerability reporting:

- https://github.com/henrydontbbai/opencode-advisor-mcp/security/advisories/new

## Responsible Use

This tool can send Git status, Git diff context, user prompts, and working-directory context to the configured OpenCode runtime. Depending on local configuration, that runtime may use a remote model provider.

Only use this tool on repositories and diffs you are authorized to inspect and disclose.

The bundled advisor template denies writes and blocks `.env` reads, but that is not a complete data-loss-prevention system.

## Local Trust Boundary

This server is designed for one local user operating one stdio MCP process. Queue task files can contain submitted prompts and Git context; they are local files, not encrypted multi-tenant storage.

It does not authenticate callers, namespace task IDs by tenant, provide cross-user task ownership, or produce a tamper-resistant audit log. Do not expose the stdio process or its queue directory to untrusted users. The allowed-root checks, read-only agent templates, prompt boundaries, and sensitive-path deny rules are defense-in-depth scope controls, not a complete OS sandbox.
