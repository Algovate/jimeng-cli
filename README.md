# jimeng-cli

即梦/CapCut 图像与视频生成 API 服务，提供 OpenAI 风格接口，并内置 CLI 与 MCP Server。

## 功能

- OpenAI 风格图像接口：`/v1/images/generations`
- 多图合成接口：`/v1/images/compositions`
- 视频生成接口：`/v1/videos/generations`
- 任务查询与等待：`/v1/tasks/:task_id`、`/v1/tasks/:task_id/wait`
- 动态模型列表：`/v1/models`
- Token 池管理与健康检查：`/token/*`
- CLI 工具：`jimeng`
- MCP 工具服务：`jimeng-mcp`（stdio）

## 要求

- Node.js 18+
- npm

## 快速开始

```bash
npm install
npm run build
npm run start
```

默认监听 `http://0.0.0.0:5100`。

健康检查：

```bash
curl http://127.0.0.1:5100/ping
# pong
```

## 配置

### 1) 服务配置

默认读取：`configs/dev/service.yml`

```yml
name: jimeng-cli
host: 0.0.0.0
port: 5100
```

可通过环境变量或启动参数覆盖：

- `SERVER_ENV` / `--env`（默认 `dev`）
- `SERVER_NAME` / `--name`
- `SERVER_HOST` / `--host`
- `SERVER_PORT` / `--port`

示例：

```bash
SERVER_ENV=dev SERVER_PORT=5100 npm run start
```

### 2) Token Pool（推荐）

默认文件：`configs/token-pool.json`（可通过 `TOKEN_POOL_FILE` 覆盖）

先复制示例：

```bash
cp configs/token-pool.example.json configs/token-pool.json
```

可用环境变量：

- `TOKEN_POOL_ENABLED`：是否启用（默认启用）
- `TOKEN_POOL_FILE`：token 文件路径
- `TOKEN_POOL_HEALTHCHECK_INTERVAL_MS`：自动健康检查间隔（默认 10 分钟）
- `TOKEN_POOL_FETCH_CREDIT=true`：健康检查时附带积分查询
- `TOKEN_POOL_AUTO_DISABLE`：失败后自动禁用（默认启用）
- `TOKEN_POOL_AUTO_DISABLE_FAILURES`：连续失败阈值（默认 2）
- `TOKEN_POOL_STRATEGY`：`random` 或 `round_robin`

说明：

- 建议 token 使用对象格式并显式带 `region`（`cn/us/hk/jp/sg`）。
- 若请求未走 token-pool（即直接传 `Authorization`），通常还需要传 `X-Region`。

## API 速览

服务根路径：`GET /`

```bash
curl http://127.0.0.1:5100/
```

### 1) 列出模型

```bash
curl -X GET 'http://127.0.0.1:5100/v1/models' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Region: us'
```

### 2) 文生图

```bash
curl -X POST 'http://127.0.0.1:5100/v1/images/generations' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Region: us' \
  -d '{
    "model": "jimeng-4.5",
    "prompt": "a cinematic cyberpunk street at night",
    "ratio": "1:1",
    "resolution": "2k",
    "wait": true
  }'
```

### 3) 多图合成（JSON URL 输入）

```bash
curl -X POST 'http://127.0.0.1:5100/v1/images/compositions' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Region: us' \
  -d '{
    "prompt": "blend these references into one poster",
    "images": [
      "https://example.com/a.jpg",
      "https://example.com/b.jpg"
    ],
    "wait": true
  }'
```

### 4) 视频生成

```bash
curl -X POST 'http://127.0.0.1:5100/v1/videos/generations' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Region: us' \
  -d '{
    "model": "jimeng-video-3.5-pro",
    "prompt": "drone shot over a futuristic city",
    "ratio": "16:9",
    "resolution": "720p",
    "duration": 5,
    "wait": true
  }'
```

### 5) 任务查询与等待

```bash
curl -X GET 'http://127.0.0.1:5100/v1/tasks/<task_id>?type=image&response_format=url' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Region: us'

curl -X POST 'http://127.0.0.1:5100/v1/tasks/<task_id>/wait' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'X-Region: us' \
  -d '{"type":"image","response_format":"url","wait_timeout_seconds":180}'
```

### 6) Token Pool 管理

```bash
curl -X GET  'http://127.0.0.1:5100/token/pool'
curl -X POST 'http://127.0.0.1:5100/token/pool/check'

curl -X POST 'http://127.0.0.1:5100/token/pool/add' \
  -H 'Content-Type: application/json' \
  -d '{"tokens":[{"token":"<TOKEN>","region":"us"}]}'
```

## CLI

先构建：

```bash
npm run build
```

查看帮助：

```bash
node dist/cli/index.js --help
# 或安装为全局后使用 jimeng
```

常用示例：

```bash
node dist/cli/index.js serve
node dist/cli/index.js models list --region us --json
node dist/cli/index.js image generate --prompt "a red fox in snow" --wait
node dist/cli/index.js video generate --prompt "ocean wave at sunset" --wait
node dist/cli/index.js task wait --task-id <task_id> --type video --json
```

## MCP Server

`jimeng-mcp` 通过 stdio 启动，供 MCP Client（如 Codex / Claude Desktop 等）接入。

环境变量：

- `JIMENG_API_BASE_URL`（默认 `http://127.0.0.1:5100`）
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
