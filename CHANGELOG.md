# Changelog

## 0.1.4

### Notes

- Provides CLI and MCP tooling for image/video generation workflows.
- Local HTTP server/runtime and local `/v1/*`, `/token/*` endpoints are not provided.
- MCP tools run via local runtime integration.
- Removed unused service runtime config artifacts: `service-config.ts`, `config.service`, and `configs/dev/service.yml`.
- Removed deprecated environment/argv parsing for service binding fields: `SERVER_NAME`, `SERVER_HOST`, `SERVER_PORT`, `--name`, `--host`, `--port`.
