/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { randomUUID } from 'crypto';
import { WindsurfClient } from '../client.js';
import { getApiKey, acquireAccountByKey, reportError, reportSuccess, markRateLimited, updateCapability } from '../auth.js';
import { resolveModel, getModelInfo } from '../models.js';
import { getLsFor, ensureLs } from '../langserver.js';
import { config, log } from '../config.js';
import { recordRequest } from '../dashboard/stats.js';
import { isModelAllowed } from '../dashboard/model-access.js';
import { cacheKey, cacheGet, cacheSet } from '../cache.js';
import { isExperimentalEnabled } from '../runtime-config.js';
import {
  fingerprintBefore, fingerprintAfter, checkout as poolCheckout, checkin as poolCheckin,
} from '../conversation-pool.js';

const HEARTBEAT_MS = 15_000;
const QUEUE_RETRY_MS = 1_000;
const QUEUE_MAX_WAIT_MS = 30_000;

function genId() {
  return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
}

// Rough token estimate (~4 chars/token). Used only to populate the
// OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` field so
// upstream billing/dashboards (new-api) can recognise our local cache hits.
function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const p of m.content) if (typeof p?.text === 'string') chars += p.text.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function cachedUsage(messages, completionText) {
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil((completionText || '').length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: prompt },
    cached: true,
  };
}

// Wait until getApiKey returns a non-null account, or until maxWaitMs expires.
// Used when every account has momentarily exhausted its RPM budget so the
// client is queued instead of getting a 503.
async function waitForAccount(tried, signal, maxWaitMs = QUEUE_MAX_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  let acct = getApiKey(tried);
  while (!acct) {
    if (signal?.aborted) return null;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, QUEUE_RETRY_MS));
    acct = getApiKey(tried);
  }
  return acct;
}

export async function handleChatCompletions(body) {
  const {
    model: reqModel,
    messages,
    stream = false,
    max_tokens,
    tools,
    tool_choice,
  } = body;

  const modelKey = resolveModel(reqModel || config.defaultModel);
  const modelInfo = getModelInfo(modelKey);
  const displayModel = modelInfo?.name || reqModel || config.defaultModel;
  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  // Models with enumValue=0 must use Cascade; others use legacy RawGetChatMessage
  const useCascade = !!(modelUid && modelEnum === 0);

  // Model access control
  const access = isModelAllowed(modelKey);
  if (!access.allowed) {
    return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
  }

  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);
  const ckey = cacheKey(body);

  if (stream) {
    return streamResponse(chatId, created, displayModel, modelKey, messages, modelEnum, modelUid, useCascade, ckey);
  }

  // ── Local response cache (exact body match) ─────────────
  const cached = cacheGet(ckey);
  if (cached) {
    log.info(`Chat: cache HIT model=${displayModel} flow=non-stream`);
    recordRequest(displayModel, true, 0, null);
    const message = { role: 'assistant', content: cached.text || null };
    if (cached.thinking) message.reasoning_content = cached.thinking;
    return {
      status: 200,
      body: {
        id: chatId, object: 'chat.completion', created, model: displayModel,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: cachedUsage(messages, cached.text),
      },
    };
  }

  // ── Cascade conversation pool (experimental) ──
  // If the client is continuing a prior conversation and we still hold the
  // cascade_id from last turn, pin this request to that exact (account, LS)
  // pair so the Windsurf backend serves from its hot per-cascade context
  // instead of replaying the whole history.
  const reuseEnabled = useCascade && isExperimentalEnabled('cascadeConversationReuse');
  const fpBefore = reuseEnabled ? fingerprintBefore(messages) : null;
  let reuseEntry = reuseEnabled ? poolCheckout(fpBefore) : null;
  if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… model=${displayModel}`);

  // Non-stream: retry with a different account on model-not-available errors
  const tried = [];
  let lastErr = null;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let acct = null;
    if (reuseEntry && attempt === 0) {
      // First attempt pins to the account that owns the cached cascade.
      acct = acquireAccountByKey(reuseEntry.apiKey);
      if (!acct) {
        log.info('Chat: cascade reuse skipped — owning account not available, falling back to fresh cascade');
        reuseEntry = null;
      }
    }
    if (!acct) {
      acct = await waitForAccount(tried, null);
      if (!acct) break;
    }
    tried.push(acct.apiKey);
    await ensureLs(acct.proxy);
    const ls = getLsFor(acct.proxy);
    if (!ls) { lastErr = { status: 503, body: { error: { message: 'No LS instance available', type: 'ls_unavailable' } } }; break; }
    // Cascade pins cascade_id to a specific LS port too; if the LS it was
    // born on has been replaced, the cascade_id is dead.
    if (reuseEntry && reuseEntry.lsPort !== ls.port) {
      log.info('Chat: cascade reuse skipped — LS port changed');
      reuseEntry = null;
    }
    log.info(`Chat: model=${displayModel} flow=${useCascade ? 'cascade' : 'legacy'} attempt=${attempt + 1} account=${acct.email} ls=${ls.port}${reuseEntry ? ' reuse=1' : ''}`);
    const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
    const result = await nonStreamResponse(
      client, chatId, created, displayModel, modelKey, messages, modelEnum, modelUid,
      useCascade, acct.apiKey, ckey,
      reuseEnabled ? { reuseEntry, lsPort: ls.port, apiKey: acct.apiKey } : null,
    );
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    lastErr = result;
    if (result.body?.error?.type !== 'model_not_available') break;
    log.warn(`Account ${acct.email} lacks ${displayModel}, trying next account`);
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx) {
  const startTime = Date.now();
  try {
    let allText = '';
    let allThinking = '';
    let cascadeMeta = null;

    if (useCascade) {
      const chunks = await client.cascadeChat(messages, modelEnum, modelUid, { reuseEntry: poolCtx?.reuseEntry || null });
      for (const c of chunks) {
        if (c.text) allText += c.text;
        if (c.thinking) allThinking += c.thinking;
      }
      cascadeMeta = { cascadeId: chunks.cascadeId, sessionId: chunks.sessionId };
    } else {
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    // Check the cascade back into the pool under the *post-turn* fingerprint
    // so the next request in the same conversation can resume it.
    if (poolCtx && cascadeMeta?.cascadeId && allText) {
      const fpAfter = fingerprintAfter(messages, allText);
      poolCheckin(fpAfter, {
        cascadeId: cascadeMeta.cascadeId,
        sessionId: cascadeMeta.sessionId,
        lsPort: poolCtx.lsPort,
        apiKey: poolCtx.apiKey,
        createdAt: poolCtx.reuseEntry?.createdAt,
      });
    }

    reportSuccess(apiKey);
    updateCapability(apiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, apiKey);

    // Store in cache for next identical request
    if (ckey) cacheSet(ckey, { text: allText, thinking: allThinking });

    const message = { role: 'assistant', content: allText || null };
    if (allThinking) message.reasoning_content = allThinking;

    const promptTok = estimateTokens(messages);
    const completionTok = Math.max(1, Math.ceil((allText.length + allThinking.length) / 4));
    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTok,
          completion_tokens: completionTok,
          total_tokens: promptTok + completionTok,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    };
  } catch (err) {
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
    const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
    if (isAuthFail) reportError(apiKey);
    if (isRateLimit) { markRateLimited(apiKey); err.isModelError = true; }
    if (err.isModelError && !isRateLimit) {
      updateCapability(apiKey, modelKey, false, 'model_error');
    }
    recordRequest(model, false, Date.now() - startTime, apiKey);
    log.error('Chat error:', err.message);
    return {
      status: err.isModelError ? 403 : 502,
      body: { error: { message: err.message, type: err.isModelError ? 'model_not_available' : 'upstream_error' } },
    };
  }
}

function streamResponse(id, created, model, modelKey, messages, modelEnum, modelUid, useCascade, ckey) {
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(res) {
      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          log.info('Client disconnected mid-stream, aborting upstream');
          abortController.abort();
        }
      });
      const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // SSE heartbeat: keep the TCP/HTTP connection alive through any silent
      // period (LS warmup, Cascade "thinking", queue wait). `:` prefix is a
      // comment line per the SSE spec — clients ignore it, intermediaries see
      // bytes flowing, idle timers get reset.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      const stopHeartbeat = () => clearInterval(heartbeat);
      res.on('close', stopHeartbeat);

      // ── Cache hit: replay stored response as a fake stream ──
      const cached = cacheGet(ckey);
      if (cached) {
        log.info(`Chat: cache HIT model=${model} flow=stream`);
        recordRequest(model, true, 0, null);
        try {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (cached.thinking) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { reasoning_content: cached.thinking }, finish_reason: null }] });
          }
          if (cached.text) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: cached.text }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: cachedUsage(messages, cached.text) });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        } finally {
          stopHeartbeat();
        }
        return;
      }

      const startTime = Date.now();
      const tried = [];
      let hadSuccess = false;
      let rolePrinted = false;
      let currentApiKey = null;
      let lastErr = null;
      const maxAttempts = 3;

      // Accumulate chunks so we can cache a successful response at the end.
      let accText = '';
      let accThinking = '';

      // Cascade conversation pool (experimental, stream path)
      const reuseEnabled = useCascade && isExperimentalEnabled('cascadeConversationReuse');
      const fpBefore = reuseEnabled ? fingerprintBefore(messages) : null;
      let reuseEntry = reuseEnabled ? poolCheckout(fpBefore) : null;
      if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… stream model=${model}`);

      const onChunk = (chunk) => {
        if (!rolePrinted) {
          rolePrinted = true;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        }
        hadSuccess = true;
        if (chunk.text) {
          accText += chunk.text;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] });
        }
        if (chunk.thinking) {
          accThinking += chunk.thinking;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null }] });
        }
      };

      try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (abortController.signal.aborted) return;
          let acct = null;
          if (reuseEntry && attempt === 0) {
            acct = acquireAccountByKey(reuseEntry.apiKey);
            if (!acct) {
              log.info('Chat: cascade reuse skipped — owning account not available');
              reuseEntry = null;
            }
          }
          if (!acct) {
            acct = await waitForAccount(tried, abortController.signal);
            if (!acct) break;
          }
          tried.push(acct.apiKey);
          currentApiKey = acct.apiKey;
          try { await ensureLs(acct.proxy); } catch (e) { lastErr = e; break; }
          const ls = getLsFor(acct.proxy);
          if (!ls) { lastErr = new Error('No LS instance available'); break; }
          if (reuseEntry && reuseEntry.lsPort !== ls.port) {
            log.info('Chat: cascade reuse skipped — LS port changed');
            reuseEntry = null;
          }
          log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} account=${acct.email} ls=${ls.port}${reuseEntry ? ' reuse=1' : ''}`);
          const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
          let cascadeResult = null;
          try {
            if (useCascade) {
              cascadeResult = await client.cascadeChat(messages, modelEnum, modelUid, {
                onChunk, signal: abortController.signal, reuseEntry,
              });
            } else {
              await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk });
            }
            // Pool check-in on success (cascade only)
            if (reuseEnabled && cascadeResult?.cascadeId && accText) {
              const fpAfter = fingerprintAfter(messages, accText);
              poolCheckin(fpAfter, {
                cascadeId: cascadeResult.cascadeId,
                sessionId: cascadeResult.sessionId,
                lsPort: ls.port,
                apiKey: currentApiKey,
                createdAt: reuseEntry?.createdAt,
              });
            }
            // success
            if (hadSuccess) reportSuccess(currentApiKey);
            updateCapability(currentApiKey, modelKey, true, 'success');
            recordRequest(model, true, Date.now() - startTime, currentApiKey);
            if (!rolePrinted) {
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            }
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            // OpenAI-compat: emit a terminal usage chunk so downstream
            // billing (new-api) sees non-zero completion_tokens for streams.
            // stream_options.include_usage-style chunk: empty choices + usage.
            {
              const promptTok = estimateTokens(messages);
              const completionTok = Math.max(1, Math.ceil((accText.length + accThinking.length) / 4));
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [],
                usage: {
                  prompt_tokens: promptTok,
                  completion_tokens: completionTok,
                  total_tokens: promptTok + completionTok,
                  prompt_tokens_details: { cached_tokens: 0 },
                } });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            if (ckey && (accText || accThinking)) {
              cacheSet(ckey, { text: accText, thinking: accThinking });
            }
            return;
          } catch (err) {
            lastErr = err;
            reuseEntry = null; // don't try to reuse on retry
            const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
            const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
            if (isAuthFail) reportError(currentApiKey);
            if (isRateLimit) { markRateLimited(currentApiKey); err.isModelError = true; }
            if (err.isModelError && !isRateLimit) {
              updateCapability(currentApiKey, modelKey, false, 'model_error');
            }
            // Retry only if nothing has been streamed yet AND it's a model error
            if (!hadSuccess && err.isModelError) {
              log.warn(`Account ${acct.email} failed (${isRateLimit ? 'rate_limit' : 'model_error'}), trying next`);
              continue;
            }
            break;
          }
        }

        // All attempts failed
        log.error('Stream error after retries:', lastErr?.message);
        recordRequest(model, false, Date.now() - startTime, currentApiKey);
        try {
          if (!rolePrinted) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: `\n[Error: ${lastErr?.message || 'no accounts'}]` }, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
        } catch {}
        if (!res.writableEnded) res.end();
      } finally {
        stopHeartbeat();
      }
    },
  };
}
