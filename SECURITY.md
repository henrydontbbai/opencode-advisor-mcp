# Security Policy

## Supported Versions

Security fixes are best-effort for the latest published release and `main`.

## Reporting

Please do not open public issues for suspected vulnerabilities that could expose secrets, private repositories, authentication material, or unsafe disclosure paths.

Instead, report privately to the maintainer through GitHub security reporting if enabled, or through a private GitHub contact path.

## Responsible Use

This tool can send Git status, Git diff context, user prompts, and working-directory context to the configured OpenCode runtime. Depending on local configuration, that runtime may use a remote model provider.

Only use this tool on repositories and diffs you are authorized to inspect and disclose.

The bundled advisor template denies writes and blocks `.env` reads, but that is not a complete data-loss-prevention system.
