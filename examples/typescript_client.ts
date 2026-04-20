/**
 * WindsurfAPI — TypeScript 客户端示例
 * ====================================
 *
 * 三种用法：
 *   1. 原生 OpenAI SDK（npm i openai）
 *   2. Anthropic SDK（npm i @anthropic-ai/sdk）
 *   3. 纯 fetch —— 零依赖，Node 20+ / Bun / Deno / 浏览器都能跑
 *
 * 跑起来：
 *   npx tsx examples/typescript_client.ts
 */

const BASE = process.env.WINDSURF_BASE ?? 'http://localhost:3003';
const API_KEY = process.env.WINDSURF_API_KEY ?? 'sk-dummy';

// ─────────────────────────────────────────────────────────
// 示例 1: 纯 fetch —— 零依赖流式消费
// ─────────────────────────────────────────────────────────
async function fetchStreaming() {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'claude-4.5-sonnet',
      messages: [{ role: 'user', content: '写一行 TypeScript 代码' }],
      stream: true,
    }),
  });

  if (!resp.ok || !resp.body) {
    console.error('[fetch] HTTP', resp.status, await resp.text());
    return;
  }

  process.stdout.write('[fetch] streaming: ');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 消息以 "\n\n" 分隔；每个消息以 "data: " 开头
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') return process.stdout.write('\n');
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? '';
        if (delta) process.stdout.write(delta);
      } catch {
        /* ignore partial frames */
      }
    }
  }
  process.stdout.write('\n');
}

// ─────────────────────────────────────────────────────────
// 示例 2: OpenAI SDK
// ─────────────────────────────────────────────────────────
async function openaiSdk() {
  let OpenAI: any;
  try {
    // @ts-ignore — optional peer dep; may not be installed
    OpenAI = (await import('openai')).default;
  } catch {
    console.log('[skip] npm i openai 后再跑示例 2');
    return;
  }

  const client = new OpenAI({ apiKey: API_KEY, baseURL: `${BASE}/v1` });
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'WindsurfAPI 是什么？一句话。' }],
  });
  console.log('[openai]', res.choices[0].message.content);
  console.log('[openai] usage:', res.usage);
}

// ─────────────────────────────────────────────────────────
// 示例 3: Anthropic SDK（/v1/messages）
// ─────────────────────────────────────────────────────────
async function anthropicSdk() {
  let Anthropic: any;
  try {
    // @ts-ignore — optional peer dep; may not be installed
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    console.log('[skip] npm i @anthropic-ai/sdk 后再跑示例 3');
    return;
  }

  const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE });
  const msg = await client.messages.create({
    model: 'claude-4.5-sonnet',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hello from TypeScript!' }],
  });
  console.log('[anthropic]', (msg.content[0] as any).text);
}

// ─────────────────────────────────────────────────────────
// Dashboard API 示例 —— 拉统计快照
// ─────────────────────────────────────────────────────────
async function usageStats() {
  const pw = process.env.DASHBOARD_PASSWORD ?? '';
  const resp = await fetch(`${BASE}/dashboard/api/usage`, {
    headers: { 'X-Dashboard-Password': pw },
  });
  if (!resp.ok) {
    console.error('[usage] HTTP', resp.status);
    return;
  }
  const { usage: u } = await resp.json();
  console.log(`[usage] 总请求: ${u.total_requests}`);
  console.log(`[usage] Token 总量: ${u.total_tokens.toLocaleString()}`);
  console.log(`[usage] Credits: ${u.total_credits.toFixed(1)}`);
}

// ─────────────────────────────────────────────────────────
(async () => {
  console.log('='.repeat(60));
  console.log(`  WindsurfAPI @ ${BASE}`);
  console.log('='.repeat(60));
  await fetchStreaming();
  console.log();
  await openaiSdk();
  console.log();
  await anthropicSdk();
  console.log();
  await usageStats();
})();
