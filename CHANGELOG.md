# Changelog

## 0.1.4

### Breaking Changes

- Removed local HTTP server runtime (`jimeng serve`).
- Removed server transport mode from CLI (`--transport server`).
- Removed local HTTP endpoints (`/v1/*`, `/token/*`).
- MCP backend switched to direct controller invocation only.
- `JIMENG_API_BASE_URL` is no longer supported.

### Migration Notes

- Use `jimeng <command>` directly for CLI workflows.
- Use `jimeng-mcp` for MCP stdio integration.
- Delete `--transport` usage from scripts and CI jobs.
- Remove any local HTTP integration that depended on `127.0.0.1:5100`.

