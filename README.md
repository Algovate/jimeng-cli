# jimeng-cli

[![npm version](https://img.shields.io/npm/v/jimeng-cli.svg)](https://www.npmjs.com/package/jimeng-cli)

即梦/CapCut 图像与视频生成工具集，提供 CLI 与 MCP Server（stdio）。

## 要求

- Node.js 18+
- npm

## 快速开始

```bash
npm install
npm run build
node dist/cli/index.js models list --json
```

## 配置

### Token Pool（推荐）

默认文件：`configs/token-pool.json`（可通过 `TOKEN_POOL_FILE` 覆盖）

```bash
cp configs/token-pool.example.json configs/token-pool.json
```

可用环境变量：

- `TOKEN_POOL_ENABLED`
- `TOKEN_POOL_FILE`
- `TOKEN_POOL_HEALTHCHECK_INTERVAL_MS`
- `TOKEN_POOL_FETCH_CREDIT`
- `TOKEN_POOL_AUTO_DISABLE`
- `TOKEN_POOL_AUTO_DISABLE_FAILURES`
- `TOKEN_POOL_STRATEGY`：`random` 或 `round_robin`

## CLI

查看帮助：

```bash
node dist/cli/index.js --help
```

常用示例：

```bash
node dist/cli/index.js models list --region us --json
node dist/cli/index.js image generate --prompt "a red fox in snow" --wait
node dist/cli/index.js image edit --prompt "blend into poster" --image https://example.com/a.jpg --image https://example.com/b.jpg
node dist/cli/index.js video generate --prompt "ocean wave at sunset" --wait
node dist/cli/index.js task wait --task-id <task_id> --type video --json
```

## MCP Server

`jimeng-mcp` 通过 stdio 启动，供 MCP Client（如 Codex / Claude Desktop）接入。

环境变量：

- `JIMENG_API_TOKEN`（可选）
- `MCP_HTTP_TIMEOUT_MS`（默认 `120000`）
- `MCP_ENABLE_ADVANCED_TOOLS`（默认 `true`）
- `MCP_REQUIRE_RUN_CONFIRM`（默认 `true`）

启动：

```bash
npm run build
node dist/mcp/index.js
```

## 开发

```bash
npm run dev
```

其他脚本：

- `npm run type-check`
- `npm run mcp:dev`
- `npm run mcp:smoke`
- `npm run cli:smoke`

## 许可证

GPL-3.0
