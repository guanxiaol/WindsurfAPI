"""
WindsurfAPI - Python 客户端示例
=================================

三种用法：
  1. 原生 OpenAI SDK（推荐） - 把 base_url 指向 WindsurfAPI 即可
  2. Anthropic SDK         - 走 /v1/messages 端点
  3. 纯 urllib / requests  - 不依赖任何 SDK

运行:
  pip install openai           # 对应示例 1
  pip install anthropic        # 对应示例 2
  python python_client.py
"""

import os
import urllib.request
import urllib.error
import json

BASE = os.getenv("WINDSURF_BASE", "http://localhost:3003")
API_KEY = os.getenv("WINDSURF_API_KEY", "sk-dummy")


# ─────────────────────────────────────────────────────────
# 示例 1: OpenAI SDK
# ─────────────────────────────────────────────────────────
def example_openai_sdk():
    try:
        from openai import OpenAI
    except ImportError:
        print("[skip] pip install openai 后再跑示例 1")
        return

    client = OpenAI(api_key=API_KEY, base_url=f"{BASE}/v1")

    # 非流式
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "用一句话介绍 WindsurfAPI"}],
    )
    print("[openai] reply:", resp.choices[0].message.content)
    print("[openai] usage:", resp.usage)

    # 流式
    print("[openai] streaming:", end=" ", flush=True)
    stream = client.chat.completions.create(
        model="claude-4.5-sonnet",
        messages=[{"role": "user", "content": "数到五"}],
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        print(delta, end="", flush=True)
    print()


# ─────────────────────────────────────────────────────────
# 示例 2: Anthropic SDK（/v1/messages 端点）
# ─────────────────────────────────────────────────────────
def example_anthropic_sdk():
    try:
        from anthropic import Anthropic
    except ImportError:
        print("[skip] pip install anthropic 后再跑示例 2")
        return

    client = Anthropic(api_key=API_KEY, base_url=BASE)
    msg = client.messages.create(
        model="claude-4.5-sonnet",
        max_tokens=256,
        messages=[{"role": "user", "content": "Hello from Python!"}],
    )
    print("[anthropic] reply:", msg.content[0].text)


# ─────────────────────────────────────────────────────────
# 示例 3: 纯 urllib（零依赖）
# ─────────────────────────────────────────────────────────
def example_urllib():
    payload = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "写一行 Python"}],
        "stream": False,
    }
    req = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            print("[urllib] reply:", data["choices"][0]["message"]["content"])
    except urllib.error.HTTPError as e:
        print(f"[urllib] HTTP {e.code}: {e.read().decode()}")


# ─────────────────────────────────────────────────────────
# Dashboard API 示例 - 拉取使用统计
# ─────────────────────────────────────────────────────────
def example_usage_stats():
    pw = os.getenv("DASHBOARD_PASSWORD", "")
    req = urllib.request.Request(
        f"{BASE}/dashboard/api/usage",
        headers={"X-Dashboard-Password": pw},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            u = data["usage"]
            print(f"[usage] 总请求: {u['total_requests']}")
            print(f"[usage] 成功/失败: {u['success_count']} / {u['failure_count']}")
            print(f"[usage] Token 总量: {u['total_tokens']:,}")
            print(f"[usage] Credits: {u['total_credits']:.1f}")
            for api, stats in u["apis"].items():
                print(f"[usage]   {api}: req={stats['total_requests']} tok={stats['total_tokens']:,}")
    except urllib.error.HTTPError as e:
        print(f"[usage] HTTP {e.code}: {e.read().decode()}")


if __name__ == "__main__":
    print("=" * 60)
    print(f"  WindsurfAPI @ {BASE}")
    print("=" * 60)
    example_urllib()
    print()
    example_openai_sdk()
    print()
    example_anthropic_sdk()
    print()
    example_usage_stats()
