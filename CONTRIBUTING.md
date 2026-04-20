# 贡献指南

感谢有兴趣为 **WindsurfAPI** 贡献代码。本文档说明环境准备、代码规范与 PR 流程。

## 环境准备

- **Node.js ≥ 20**
- **Windsurf Language Server 二进制文件** (`language_server_linux_x64`)，默认放在 `/opt/windsurf/`
- 不需要 `npm install` —— 项目**零 npm 依赖**，只用 `node:*` 内置模块

```bash
git clone https://github.com/<your-fork>/WindsurfAPI.git
cd WindsurfAPI

# 快速启动（前台）
node src/index.js

# 开发模式（文件变更自动重启）
node --watch src/index.js
```

服务默认监听 `http://0.0.0.0:3003`，Dashboard 在 `/dashboard`。

## 代码规范

### 零 npm 依赖原则

- **不要**添加任何 `npm install <xxx>`。需要 HTTP/protobuf/crypto 功能？用 `node:https` / 手写 varint / `node:crypto`
- 这是项目的设计取舍：安全面小、启动快、部署简单
- `package.json` 里的 `dependencies` 字段必须保持为空（CI 会校验）

### 代码风格

- ES modules (`import`/`export`)，不用 CommonJS
- 注释使用**英文**，Dashboard UI 用**简体中文**
- 变量命名用 camelCase，类用 PascalCase
- 错误日志一律走 `log.info/warn/error/debug`（来自 `src/config.js`）

### 文件组织

参考 `ARCHITECTURE.md` 的模块划分。新增功能建议：

- HTTP 路由入口 → `src/server.js`
- 请求处理逻辑 → `src/handlers/*.js`
- Dashboard 后端 API → `src/dashboard/api.js`
- Dashboard 前端 → `src/dashboard/index.html`
- 持久化状态 → 写单独的 `*.json` 文件（加入 `.gitignore`）

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```text
feat: 新功能
fix:  修 bug
docs: 文档
refactor: 重构（不影响功能）
perf: 性能优化
test: 测试
chore: 构建/脚手架
```

示例：

```text
feat(dashboard): add token usage export/import endpoints
fix(cascade): handle panel-state-not-found on Send retry
```

## PR 检查清单

提交 PR 前请确认：

- [ ] `find src -name '*.js' -exec node --check {} \;` 全部通过
- [ ] 没有引入 npm 依赖
- [ ] 没有硬编码路径、IP、凭证
- [ ] 新增功能在 README 和/或 ARCHITECTURE.md 中有说明
- [ ] 敏感文件（`accounts.json` / `stats.json` / `.env` / `logs/` / `data/`）没有被提交

## 测试

目前项目没有正式的单元测试套件，但关键路径的验证办法：

### 本地冒烟

```bash
# 启动服务
node src/index.js &

# 基本可用性
curl -fsS http://localhost:3003/health
curl -fsS http://localhost:3003/v1/models | head -20

# Dashboard 登录
curl -H "X-Dashboard-Password: $DASHBOARD_PASSWORD" \
  http://localhost:3003/dashboard/api/stats
```

### Chat 端到端（需要已添加账号）

```bash
curl -sS http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"say hi"}],"stream":false}'
```

## 问题反馈

- **Bug**：[GitHub Issues](https://github.com/<org>/WindsurfAPI/issues)，请附上 `logs/error-*.jsonl` 的最近几行
- **功能建议**：Issues 里贴上使用场景
- **安全漏洞**：请**私下**邮件联系维护者，不要公开在 Issues

## 许可

贡献代码等同同意以 MIT 许可证发布。
