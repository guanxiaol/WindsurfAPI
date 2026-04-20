#!/usr/bin/env bash
# WindsurfAPI — curl 示例集合
#
# 设置 BASE 为你的 WindsurfAPI 地址；若启用了 DASHBOARD_PASSWORD，把它导出为 PW。
#
#   export BASE=http://localhost:3003
#   export PW=your-dashboard-password   # optional
#
# 然后运行：  ./curl.sh chat        (选一条跑)

set -e
BASE="${BASE:-http://localhost:3003}"
PW="${PW:-}"

cmd="${1:-help}"

case "$cmd" in

  # ─── OpenAI 兼容：聊天补全（非流式） ──────────────────
  chat)
    curl -sS "$BASE/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "用一句话介绍你自己"}],
        "stream": false
      }' | head -100
    ;;

  # ─── OpenAI 兼容：流式补全 (SSE) ───────────────────────
  stream)
    curl -N -sS "$BASE/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "claude-4.5-sonnet",
        "messages": [{"role": "user", "content": "写一首四行小诗"}],
        "stream": true
      }'
    ;;

  # ─── Anthropic 兼容：/v1/messages（Claude Code 走这个端点） ─
  messages)
    curl -sS "$BASE/v1/messages" \
      -H "Content-Type: application/json" \
      -H "anthropic-version: 2023-06-01" \
      -d '{
        "model": "claude-4.5-sonnet",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Hello!"}]
      }' | head -100
    ;;

  # ─── 模型列表 ───────────────────────────────────────
  models)
    curl -sS "$BASE/v1/models" | python3 -m json.tool | head -40
    ;;

  # ─── 账号管理：添加账号（token 方式） ────────────────
  login-token)
    TOKEN="${2:-YOUR_WINDSURF_TOKEN_HERE}"
    curl -sS -X POST "$BASE/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"token\": \"$TOKEN\"}"
    ;;

  # ─── 账号管理：列出所有账号 ──────────────────────────
  accounts)
    curl -sS "$BASE/auth/accounts" | python3 -m json.tool | head -40
    ;;

  # ─── Dashboard：使用统计快照 ────────────────────────
  usage)
    curl -sS -H "X-Dashboard-Password: $PW" \
      "$BASE/dashboard/api/usage" | python3 -m json.tool | head -60
    ;;

  # ─── Dashboard：导出使用数据 ────────────────────────
  export)
    curl -sS -H "X-Dashboard-Password: $PW" \
      "$BASE/dashboard/api/usage/export" -o usage-snapshot.json
    echo "saved → usage-snapshot.json ($(wc -c < usage-snapshot.json) bytes)"
    ;;

  # ─── Dashboard：导入使用数据（合并 + 去重） ──────────
  import)
    FILE="${2:-usage-snapshot.json}"
    curl -sS -X POST -H "X-Dashboard-Password: $PW" \
      -H "Content-Type: application/json" \
      --data-binary "@$FILE" \
      "$BASE/dashboard/api/usage/import"
    ;;

  *)
    cat <<EOF
用法: ./curl.sh <command>

可用命令:
  chat          OpenAI 兼容：非流式补全
  stream        OpenAI 兼容：SSE 流式
  messages      Anthropic 兼容：/v1/messages
  models        模型列表
  login-token   添加账号（需传 token 作为第 2 个参数）
  accounts      列出已添加的账号
  usage         查看使用统计
  export        导出使用数据到 usage-snapshot.json
  import [f]    从 JSON 文件导入使用数据（默认 usage-snapshot.json）

环境变量:
  BASE   WindsurfAPI 地址 (默认 http://localhost:3003)
  PW     Dashboard 密码 (仅在启用时需要)
EOF
    ;;
esac
