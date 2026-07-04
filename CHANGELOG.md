# Changelog

## Unreleased

- stabilized GitHub Actions across Ubuntu/Windows and Node 20/22 by using an explicit test entry and adding `print-agent` plus `pack --dry-run` gates
- made Windows-path tests deterministic with injected `win32` path/platform behavior
- fixed OpenCode fallback detection so assistant text and tool output do not trigger false fallback failures
- aligned public security-reporting docs with GitHub private vulnerability reporting
- clarified source/GitHub install as the current path while npm publication remains future work

## 0.2.0

First public release.

- sanitized structured responses to avoid leaking local absolute paths and command-resolution details
- replaced personal path fixtures with neutral test fixtures
- added npm-ready package metadata, CLI entrypoints, and packed-install flow
- added public-facing docs, governance files, GitHub templates, CI, and Dependabot

## 0.1.0

Local-only pre-release tag used before public repository publication. Not part of the public release line.
