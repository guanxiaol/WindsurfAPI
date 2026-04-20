# WindsurfAPI

> **Windsurf 后端 → OpenAI / Anthropic 双兼容的无头 API 代理。** 零 npm 依赖，Node 20 纯内置模块实现。

把 [Windsurf](https://windsurf.com)（原 Codeium）账号的 80+ 个 AI 模型以标准 OpenAI / Anthropic 接口对外暴露。支持多账号负载均衡、token/credit 精细统计、Dashboard 管理后台、工具调用、流式输出。

---

## 严正声明

未经作者书面授权，**禁止**将本项目用于任何商业用途、付费代部署、中转转售或包装成服务对外销售。违者保留追责权利。个人学习/研究/自用不受限。

---

## 特性

- **双协议兼容** — `/v1/chat/completions`（OpenAI）+ `/v1/messages`（Anthropic，Claude Code 原生端点）
- **80+ 模型** — Claude / GPT / Gemini / DeepSeek / Grok / Qwen / Kimi / Windsurf SWE，启动自动拉取最新 catalog
- **多账号池** — 按剩余容量均衡，自动故障转移，per-model rate-limit 隔离
- **Token + Credit 精细统计** — 按 API 路径 × 模型分层聚合，细到每次请求的 `input/output/cached` token、延迟、花销
- **统计数据导出/导入** — CLIProxyAPI 兼容 schema，JSON 可备份迁移，幂等去重合并
- **Dashboard 管理后台** — 单页 SPA（简体中文），覆盖账号管理、代理配置、实时日志、使用图表、封禁侦测
- **工具调用** — Prompt-level `<tool_call>` 协议兼容，Claude Code / Cursor / Aider 直接可用
- **流式 SSE** — OpenAI 格式，支持 `stream_options.include_usage` 终端 usage chunk
- **Cascade 对话复用**（实验）— 多轮会话复用 `cascade_id`，减少重复传输
- **零 npm 依赖** — 纯 Node.js 内置模块，安装即启动

---

## 快速开始

### 前置条件

- **Node.js ≥ 20**
- **Windsurf Language Server 二进制** `language_server_linux_x64`（从已安装的 Windsurf 客户端里取）
- 至少一个 Windsurf 账号（免费版也可，支持的模型会减少）

### 本地启动

```bash
git clone https://github.com/guanxiaol/WindsurfAPI.git
cd WindsurfAPI

# 放置 Language Server 二进制
sudo mkdir -p /opt/windsurf
sudo cp /path/to/language_server_linux_x64 /opt/windsurf/
sudo chmod +x /opt/windsurf/language_server_linux_x64

# 可选：创建 .env 覆盖默认配置
cp .env.example .env
# 编辑 .env 设置 DASHBOARD_PASSWORD 等

# 启动
node src/index.js
```

服务监听 `http://0.0.0.0:3003`，Dashboard 在 `http://localhost:3003/dashboard`。

### Docker 启动

```bash
docker compose up -d --build
```

注意 `docker-compose.yml` 会把 `/opt/windsurf` 只读挂载进容器，请先把 Language Server 二进制放在宿主机的 `/opt/windsurf/` 下。

---

## 环境变量

全部可选，留空走默认值。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3003` | HTTP 服务器端口 |
| `API_KEY` | _（空）_ | `/v1/*` 端点的鉴权 key，空则开放访问 |
| `DASHBOARD_PASSWORD` | _（空）_ | Dashboard 后台密码，空则无需鉴权 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | 未指定 model 时的默认值 |
| `MAX_TOKENS` | `8192` | 默认最大输出 token 数 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | Language Server 路径 |
| `LS_PORT` | `42100` | Language Server gRPC 端口 |
| `CODEIUM_API_URL` | `https://server.self-serve.windsurf.com` | Windsurf 后端 URL，一般不改 |

---

## API 端点

### OpenAI 兼容

```bash
# 聊天补全（非流式）
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'

# 流式
curl -N http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-4.5-sonnet","messages":[{"role":"user","content":"写首诗"}],"stream":true}'

# 模型列表
curl http://localhost:3003/v1/models
```

### Anthropic 兼容（Claude Code 原生）

```bash
curl http://localhost:3003/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-4.5-sonnet",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Claude Code 可以这样用：

```bash
export ANTHROPIC_BASE_URL=http://localhost:3003
export ANTHROPIC_AUTH_TOKEN=sk-your-dashboard-password
claude
```

### 账号管理

```bash
# 用 Token 添加账号（推荐，访问 windsurf.com/show-auth-token 获取）
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"token": "your-windsurf-token"}'

# 用 API Key 添加
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"api_key": "sk-ws-..."}'

# 批量添加
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"accounts": [{"token": "t1"}, {"token": "t2"}]}'

# 列出已添加账号
curl http://localhost:3003/auth/accounts

# 删除
curl -X DELETE http://localhost:3003/auth/accounts/{id}
```

### Dashboard API（需 `X-Dashboard-Password` 头）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/dashboard/api/stats` | 旧版统计快照（保留兼容） |
| `DELETE` | `/dashboard/api/stats` | 重置所有统计 |
| `GET`  | `/dashboard/api/usage` | **新：** CLIProxyAPI 格式完整使用统计 |
| `GET`  | `/dashboard/api/usage/export` | **新：** 下载备份 JSON 文件 |
| `POST` | `/dashboard/api/usage/import` | **新：** 导入备份（自动去重合并） |
| `POST` | `/dashboard/api/usage/reset` | **新：** 重置使用数据 |
| `DELETE` | `/dashboard/api/usage/details?days=30` | **新：** 裁剪明细（保留最近 N 天） |
| `DELETE` | `/dashboard/api/usage/days?days=90` | **新：** 裁剪日统计桶 |
| `GET`  | `/dashboard/api/logs` | 日志拉取 |
| `GET`  | `/dashboard/api/logs/stream` | SSE 日志流 |
| `GET`  | `/dashboard/api/experimental` | 实验功能开关 |
| `PATCH` | `/dashboard/api/experimental` | 切换实验功能 |

完整示例见 `examples/curl.sh`、`examples/python_client.py`、`examples/typescript_client.ts`。

### 使用数据 Schema（`GET /dashboard/api/usage`）

```json
{
  "usage": {
    "total_requests": 29,
    "success_count": 28,
    "failure_count": 1,
    "total_tokens": 33604,
    "total_credits": 30,
    "requests_by_day":  { "2026-04-19": 28, "2026-04-20": 1 },
    "requests_by_hour": { "10": 5, "11": 24 },
    "tokens_by_day":    { "2026-04-20": 33604 },
    "tokens_by_hour":   { "11": 33604 },
    "credits_by_day":   { "2026-04-20": 30 },
    "credits_by_hour":  { "11": 30 },
    "apis": {
      "POST /v1/messages": {
        "total_requests": 1,
        "total_tokens": 33604,
        "total_credits": 30,
        "models": {
          "claude-opus-4.7-max": {
            "total_requests": 1,
            "total_tokens": 33604,
            "total_credits": 30,
            "details": [
              {
                "timestamp": "2026-04-20T02:23:48.123Z",
                "latency_ms": 5440,
                "source": "POST /v1/messages",
                "auth_index": "0000abcd",
                "failed": false,
                "credit": 30,
                "tokens": {
                  "input_tokens": 33598,
                  "output_tokens": 6,
                  "reasoning_tokens": 0,
                  "cached_tokens": 0,
                  "total_tokens": 33604
                }
              }
            ]
          }
        }
      }
    }
  }
}
```

---

## Dashboard 管理后台

访问 `http://localhost:3003/dashboard`，9 个面板：

| 面板 | 功能 |
|---|---|
| **总览** | 运行时间、账号池、LS 健康、请求成功率 |
| **登录取号** | 从 Windsurf 邮箱/密码或扫码获取 token |
| **账号管理** | 增删改/停用/重置错误计数/编辑标签/每账号代理 |
| **模型控制** | 全局模型白/黑名单、按账号屏蔽模型 |
| **代理配置** | 全局 + 每账号 HTTP / SOCKS5 代理 |
| **日志** | 实时 SSE 日志流，级别筛选 |
| **统计分析** | **新：** Token/Credit 图表、14 天走势、24 小时分布、请求明细表、导出/导入按钮 |
| **封禁侦测** | 错误模式监控 + 账号健康 |
| **实验功能** | Cascade 对话复用、模型身份伪装、Preflight rate-limit 等 |

---

## 支持的模型（摘录）

<details><summary><b>Claude</b></summary>

`claude-3.5-sonnet` / `claude-3.7-sonnet[-thinking]` / `claude-4-sonnet[-thinking]` / `claude-4-opus[-thinking]` /
`claude-4.1-opus[-thinking]` / `claude-4.5-sonnet[-thinking]` / `claude-4.5-haiku` / `claude-4.5-opus[-thinking]` /
`claude-sonnet-4.6[-thinking]` / `claude-opus-4.6[-thinking]` / `claude-opus-4.7-max` 等

</details>

<details><summary><b>GPT / OpenAI</b></summary>

`gpt-4o` / `gpt-4o-mini` / `gpt-4.1[-mini/nano]` / `gpt-5[-mini]` / `gpt-5.2[-low/medium/high]` /
`gpt-5.4[-low/medium/high/xhigh]` / `gpt-5.3-codex` / `o3[-mini/high/pro]` / `o4-mini`

</details>

<details><summary><b>Gemini / Google</b></summary>

`gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-3.0-pro` / `gemini-3.0-flash` / `gemini-3.1-pro[-low/high]`

</details>

<details><summary><b>其他</b></summary>

`deepseek-v3` / `deepseek-r1` / `grok-3[-mini]` / `grok-code-fast-1` / `qwen-3` / `qwen-3-coder` /
`kimi-k2` / `kimi-k2.5` / `swe-1.5[-thinking]` / `swe-1.6-fast` / `arena-fast` / `arena-smart`

</details>

启动时会自动从 Windsurf 后端拉取 live catalog 并与本地硬编码列表合并，`GET /v1/models` 返回实时可用列表。

免费账号仅可用 `gpt-4o-mini` 和 `gemini-2.5-flash`。Claude / GPT-5 等 premium 模型需要 Windsurf Pro 订阅。

---

## 部署

### PM2 常驻（推荐）

```bash
npm install -g pm2
pm2 start src/index.js --name windsurf-api --cwd /path/to/WindsurfAPI
pm2 save
pm2 startup
```

> **重要：** 不要用 `pm2 restart windsurf-api`，某些 PM2/Node 组合会留下僵尸进程占住 3003 端口。正确做法：
>
> ```bash
> pm2 stop windsurf-api && pm2 delete windsurf-api
> fuser -k 3003/tcp 2>/dev/null
> sleep 2
> pm2 start src/index.js --name windsurf-api --cwd /path/to/WindsurfAPI
> ```

### systemd（Linux 服务器推荐）

```ini
# /etc/systemd/system/windsurfapi.service
[Unit]
Description=WindsurfAPI
After=network.target

[Service]
Type=simple
User=windsurf
WorkingDirectory=/opt/WindsurfAPI
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
Environment=PORT=3003
Environment=LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now windsurfapi
sudo journalctl -u windsurfapi -f
```

### 防火墙

```bash
# Ubuntu (ufw)
sudo ufw allow 3003/tcp

# CentOS (firewalld)
sudo firewall-cmd --add-port=3003/tcp --permanent && sudo firewall-cmd --reload
```

云服务器记得在控制台安全组里开放 3003 端口。

---

## 架构

```text
客户端 (OpenAI SDK / Anthropic SDK / curl / CC / Cursor)
   │
   ▼
WindsurfAPI  (Node.js HTTP, :3003)
   │  ── /v1/chat/completions  (OpenAI 格式)
   │  ── /v1/messages          (Anthropic 格式)
   │  ── /dashboard/api/*      (管理 API)
   ▼
Language Server  (gRPC-over-HTTP/2, :42100)
   │
   ▼
Windsurf Cloud  (server.self-serve.windsurf.com)
```

详细模块划分见 `ARCHITECTURE.md`。

```text
src/
  index.js              入口：启动 LS + HTTP Server
  server.js             HTTP 路由分发 + 流式
  config.js             .env + 默认值
  auth.js               账号池 / RPM 追踪 / credit 刷新
  client.js             WindsurfClient：StartCascade / Send / 轮询 trajectory
  windsurf.js           protobuf builder / parser（exa.language_server_pb）
  proto.js              varint / length-prefixed 编解码
  grpc.js               gRPC-over-HTTP2 unary 助手
  langserver.js         LS 进程池（每个唯一代理一个 LS）
  conversation-pool.js  Cascade 对话复用池（实验）
  cache.js              内存响应缓存
  sanitize.js           输出路径脱敏
  runtime-config.js     实验功能开关持久化
  models.js             模型 catalog + tier 访问表
  handlers/
    chat.js             /v1/chat/completions 处理
    messages.js         /v1/messages 处理 (Anthropic → OpenAI 转换)
    models.js           /v1/models
    tool-emulation.js   <tool_call> prompt 协议
  dashboard/
    api.js              /dashboard/api/* 路由
    index.html          单页 SPA
    stats.js            v2 统计（CLIProxyAPI schema）
    logger.js           日志环形缓冲 + SSE 流
    proxy-config.js     代理持久化
    model-access.js     模型黑/白名单
    windsurf-login.js   直接邮箱+密码登录
```

---

## 常见问题

**Q: 启动时提示 `LS binary not found`？**
A: 确认 `/opt/windsurf/language_server_linux_x64` 存在且可执行，或设置 `LS_BINARY_PATH` 环境变量指向正确位置。

**Q: 请求一直返回 `No accounts available`？**
A: Dashboard 添加至少一个账号，或通过 `POST /auth/login` API 加号。

**Q: 所有账号报 `permission_denied`？**
A: 免费账号只能用 `gpt-4o-mini` 和 `gemini-2.5-flash`。其他模型需要 Windsurf Pro 订阅。

**Q: 如何把旧的统计数据从一台机器迁移到另一台？**
A: 旧机 `GET /dashboard/api/usage/export` → 下载 JSON；新机 `POST /dashboard/api/usage/import` 上传，自动去重合并。

**Q: Cascade 对话复用要不要开？**
A: 如果主要用 Claude Code 这类重度工具调用客户端，开了效果不大（`emulateTools` 模式绕过复用）。如果是纯聊天多轮场景，开了能省一点延迟。

**Q: 模型列表怎么更新？**
A: 启动时自动从 Windsurf 后端拉取最新 catalog 并与本地合并。如需手动刷新，重启服务即可。

---

## 贡献

见 `CONTRIBUTING.md`。欢迎提 Issue 和 PR。

---

## 许可

[MIT](LICENSE)
