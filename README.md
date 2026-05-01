# jimeng-cli

[![npm version](https://img.shields.io/npm/v/jimeng-cli.svg)](https://www.npmjs.com/package/jimeng-cli)

即梦/CapCut 图像与视频生成 CLI 工具。支持多区域（CN/US/HK/JP/SG）；大部分常规模型可直接配合普通账号使用，部分模型则依赖额外权益。

## 安装

```bash
npm install -g jimeng-cli
```

## 快速开始

```bash
# 登录并添加 token 到池中（交互式，默认 CN 区）
jimeng login

# 登录指定区域
jimeng login --region us

# 生成图片
jimeng image generate --prompt "a red fox in snow"

# 生成视频
jimeng video generate --prompt "ocean wave at sunset" --wait

# 查看可用模型
jimeng models list --verbose

# 查看本地已知但上游未公开枚举的模型
jimeng models list --all-known --region cn --verbose
```

## 多区域

支持 5 个区域，各有不同的模型和端点：

| 区域 | 代码 | 端点 | 额外视频模型 |
|------|------|------|-------------|
| 中国大陆 | `cn` | jimeng.jianying.com | seedance 2.0/2.0-fast, 3.x 全系列 |
| 美国 | `us` | dreamina.capcut.com | seedance 2.0/2.0-fast |
| 香港 | `hk` | dreamina.capcut.com | veo3, veo3.1, sora2, seedance 2.0 |
| 日本 | `jp` | dreamina.capcut.com | veo3, veo3.1, sora2, seedance 2.0 |
| 新加坡 | `sg` | dreamina.capcut.com | veo3, veo3.1, sora2, seedance 2.0 |

### Token 与区域绑定

每个 token 在池中绑定一个区域，API 请求自动路由到对应端点。生成时通过 `--region` 选择目标区域，系统从该区域的 token 中自动选取。

```bash
# 添加 US 区 token
jimeng token add --token <token> --region us

# 添加 JP 区 token
jimeng token add --token <token> --region jp

# 用 US 区 token 生成图片
jimeng image generate --prompt "..." --region us

# 用 JP 区生成 veo3 视频
jimeng video generate --prompt "..." --model jimeng-video-veo3 --region jp --wait
```

### 跨区域查询

```bash
# 查看所有区域 token 的模型列表
jimeng models list --all --verbose

# 查看特定区域的模型
jimeng models list --region hk --verbose

# 查看某个区域的本地已知模型（含 manual/hidden models）
jimeng models list --region cn --all-known --verbose

# 查询所有 token 的积分
jimeng token points --all
```

## Token 管理

Token 池是核心机制，管理多个区域的 token 并自动轮换。

```bash
# 查看池状态
jimeng token pool

# 添加 token
jimeng token add --token <token> --region cn
jimeng token add --token-file tokens.txt --region us

# 验证 token 有效性
jimeng token check
jimeng token check --region us    # 只检查 US 区

# 查询积分
jimeng token points

# 领取每日免费积分
jimeng token receive

# 启用/禁用 token
jimeng token enable --token <token>
jimeng token disable --token <token>

# 移除 token
jimeng token remove --token <token>

# 手动健康检查
jimeng token pool-check
```

所有命令支持 `--json` 输出结构化 JSON。

### Token 池配置

默认配置文件 `configs/token-pool.json`，可通过 `TOKEN_POOL_FILE` 环境变量覆盖。

```json
{
  "updatedAt": 0,
  "tokens": [
    {
      "token": "your_token_here",
      "region": "us",
      "enabled": true
    }
  ]
}
```

环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TOKEN_POOL_ENABLED` | 启用/禁用 token 池 | `true` |
| `TOKEN_POOL_FILE` | 配置文件路径 | `configs/token-pool.json` |
| `TOKEN_POOL_HEALTHCHECK_INTERVAL_MS` | 健康检查间隔 | `300000` (5 min) |
| `TOKEN_POOL_FETCH_CREDIT` | 检查时获取积分 | `true` |
| `TOKEN_POOL_AUTO_DISABLE` | 连续失败后自动禁用 | `true` |
| `TOKEN_POOL_AUTO_DISABLE_FAILURES` | 触发禁用的失败次数 | `2` |
| `TOKEN_POOL_STRATEGY` | 选 token 策略 | `random` (`round_robin`) |

## 模型

### 查看模型

```bash
# 列出模型 ID
jimeng models list

# 显示详细信息（能力、参数范围）
jimeng models list --verbose

# 查看指定区域
jimeng models list --region jp --verbose

# 查看所有 token 的模型（按 token/region 分组）
jimeng models list --all

# 查看本地已知模型（包含上游未公开枚举的 manual models）
jimeng models list --all-known --region cn --verbose

# 刷新模型能力缓存
jimeng models refresh
```

`jimeng models list` 默认只显示上游配置实际返回的 discoverable models。  
`jimeng models list --all-known` 会额外显示本地已知但上游未公开枚举的 manual models。后者可以被手动指定尝试调用，但并不代表当前 token 一定具备对应权益。

### 可用模型

**图像模型**（CN 区全部可用，国际区部分可用）：

| 模型 | CN | US | HK/JP/SG |
|------|:--:|:--:|:--------:|
| jimeng-5.0 | ✓ | ✓ | ✓ |
| jimeng-4.6 | ✓ | ✓ | ✓ |
| jimeng-4.5 | ✓ | ✓ | ✓ |
| jimeng-4.1 | ✓ | ✓ | ✓ |
| jimeng-4.0 | ✓ | ✓ | ✓ |
| jimeng-3.1 | ✓ | - | ✓ |
| jimeng-3.0 | ✓ | ✓ | ✓ |
| nanobanana | - | ✓ | ✓ |

**视频模型**：

| 模型 | CN | US | HK/JP/SG |
|------|:--:|:--:|:--------:|
| jimeng-video-seedance-2.0 | ✓ | ✓ | ✓ |
| jimeng-video-seedance-2.0-fast | ✓ | ✓ | ✓ |
| jimeng-video-seedance-2.0-vip | manual | - | - |
| jimeng-video-seedance-2.0-fast-vip | manual | - | - |
| jimeng-video-veo3 | - | - | ✓ |
| jimeng-video-veo3.1 | - | - | ✓ |
| jimeng-video-sora2 | - | - | ✓ |
| jimeng-video-3.5-pro | ✓ | ✓ | ✓ |

说明：

- `manual` 表示该模型在本地映射表中已知，但默认不会出现在上游 discoverable model 列表里。
- 这类模型需要通过 `jimeng models list --all-known` 查看。
- `jimeng-video-seedance-2.0-vip` 和 `jimeng-video-seedance-2.0-fast-vip` 当前只在 `cn` 区作为 manual model 暴露。
- 即使模型名可见，实际生成仍取决于当前 token 是否具备对应权益，例如 `vip`。

## 图像生成

```bash
# 文生图
jimeng image generate --prompt "a cat sitting on a windowsill"

# 指定模型和比例
jimeng image generate --prompt "..." --model jimeng-5.0 --ratio 16:9

# 指定区域
jimeng image generate --prompt "..." --region us

# 不等待，直接返回 task ID
jimeng image generate --prompt "..." --no-wait

# 高分辨率
jimeng image generate --prompt "..." --resolution 4k

# 图生图编辑（1-10 张图）
jimeng image edit --prompt "blend into poster" --image photo1.jpg --image photo2.jpg

# 图片放大
jimeng image upscale --image photo.jpg --resolution 4k

# 下载到指定目录
jimeng image generate --prompt "..." --output-dir ./output
```

通用选项：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--model` | 模型 | `jimeng-4.5` |
| `--ratio` | 宽高比 | `1:1` |
| `--resolution` | 分辨率 | `2k` |
| `--negative-prompt` | 负面提示词 | - |
| `--region` | 区域 | `cn` |
| `--token` | 指定 token | 自动选取 |
| `--wait` / `--no-wait` | 等待完成 | `--wait` |
| `--json` | JSON 输出 | - |

支持的比例：`1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3`, `21:9`

## 视频生成

```bash
# 文生视频
jimeng video generate --prompt "ocean wave at sunset" --wait

# 图生视频
jimeng video generate --prompt "..." --mode image_to_video --image-file photo.jpg --wait

# 首尾帧
jimeng video generate --prompt "..." --mode first_last_frames --image-file start.jpg --image-file end.jpg --wait

# omni_reference 模式（1-9 图 + 0-3 视频）
jimeng video generate --prompt "..." --mode omni_reference --image-file ref1.jpg --video-file ref1.mp4 --wait

# 指定区域和模型
jimeng video generate --prompt "..." --model jimeng-video-veo3 --region jp --wait

# 手动尝试 CN VIP model（需要 token 具备对应权益）
jimeng video generate --prompt "..." --model jimeng-video-seedance-2.0-vip --region cn --wait

# 指定时长和比例
jimeng video generate --prompt "..." --duration 10 --ratio 16:9 --wait
```

视频模式：

| 模式 | 说明 | 图片输入 | 视频输入 |
|------|------|:--------:|:--------:|
| `text_to_video` | 文生视频 | 0 | 0 |
| `image_to_video` | 图生视频 | 1 | 0 |
| `first_last_frames` | 首尾帧 | 1-2 | 0 |
| `omni_reference` | 多参考 | 1-9 | 0-3 |

通用选项：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--model` | 模型 | 按模式自动选择 |
| `--mode` | 生成模式 | `text_to_video` |
| `--ratio` | 宽高比 | `1:1` |
| `--duration` | 时长（秒） | `5` |
| `--resolution` | 分辨率 | `720p` |
| `--region` | 区域 | `cn` |
| `--token` | 指定 token | 自动选取 |
| `--wait` / `--no-wait` | 等待完成 | `--wait` |
| `--json` | JSON 输出 | - |

## 任务查询

```bash
# 查询任务状态
jimeng task get --task-id <id>
jimeng task get --task-id <id> --type video --json

# 等待任务完成
jimeng task wait --task-id <id>
jimeng task wait --task-id <id> --wait-timeout-seconds 120

# 查看历史任务
jimeng task list
jimeng task list --type video --count 50 --json
```

## MCP Server

`jimeng-mcp` 通过 stdio 启动，供 Claude Desktop / Codex 等 MCP Client 接入。

```bash
npm run build
node dist/mcp/index.js
```

Claude Desktop 配置示例：

```json
{
  "mcpServers": {
    "jimeng": {
      "command": "node",
      "args": ["/path/to/jimeng-cli/dist/mcp/index.js"],
      "env": {
        "JIMENG_API_TOKEN": "your_token"
      }
    }
  }
}
```

环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JIMENG_API_TOKEN` | 默认 API token | - |
| `MCP_HTTP_TIMEOUT_MS` | HTTP 超时 | `120000` |
| `MCP_ENABLE_ADVANCED_TOOLS` | 启用高级工具 | `true` |
| `MCP_REQUIRE_RUN_CONFIRM` | 运行前确认 | `true` |

## 其他环境变量

| 变量 | 说明 |
|------|------|
| `JIMENG_CLI_VERBOSE_LOGS` | 启用详细日志 (`true`/`false`) |

## 开发

```bash
npm install
npm run build
npm run dev          # 开发模式
npm run type-check   # 类型检查
npm run cli:smoke    # CLI 冒烟测试
npm run mcp:dev      # MCP 开发模式
npm run mcp:smoke    # MCP 冒烟测试
```

## 许可证

GPL-3.0
