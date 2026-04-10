/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { randomUUID } from 'crypto';
import { WindsurfClient } from '../client.js';
import { getApiKey, reportError, reportSuccess, markRateLimited, updateCapability } from '../auth.js';
import { resolveModel, getModelInfo } from '../models.js';
import { getLsFor, ensureLs } from '../langserver.js';
import { config, log } from '../config.js';
import { recordRequest } from '../dashboard/stats.js';
import { isModelAllowed } from '../dashboard/model-access.js';

function genId() {
  return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
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

  if (stream) {
    return streamResponse(chatId, created, displayModel, modelKey, messages, modelEnum, modelUid, useCascade);
  }

  // Non-stream: retry with a different account on model-not-available errors
  const tried = [];
  let lastErr = null;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const acct = getApiKey(tried);
    if (!acct) break;
    tried.push(acct.apiKey);
    await ensureLs(acct.proxy);
    const ls = getLsFor(acct.proxy);
    if (!ls) { lastErr = { status: 503, body: { error: { message: 'No LS instance available', type: 'ls_unavailable' } } }; break; }
    log.info(`Chat: model=${displayModel} flow=${useCascade ? 'cascade' : 'legacy'} attempt=${attempt + 1} account=${acct.email} ls=${ls.port}`);
    const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
    const result = await nonStreamResponse(client, chatId, created, displayModel, modelKey, messages, modelEnum, modelUid, useCascade, acct.apiKey);
    if (result.status === 200) return result;
    lastErr = result;
    if (result.body?.error?.type !== 'model_not_available') break;
    log.warn(`Account ${acct.email} lacks ${displayModel}, trying next account`);
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, modelEnum, modelUid, useCascade, apiKey) {
  const startTime = Date.now();
  try {
    let allText = '';
    let allThinking = '';

    if (useCascade) {
      const chunks = await client.cascadeChat(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
        if (c.thinking) allThinking += c.thinking;
      }
    } else {
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    reportSuccess(apiKey);
    updateCapability(apiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, apiKey);

    const message = { role: 'assistant', content: allText || null };
    if (allThinking) message.reasoning_content = allThinking;

    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    };
  } catch (err) {
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
    const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
    if (isAuthFail) reportError(apiKey);
    if (isRateLimit) { markRateLimited(apiKey); err.isModelError = true; }
    // Record capability: only mark as incapable if it's a model-level denial,
    // not transient or rate-limit.
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

function streamResponse(id, created, model, modelKey, messages, modelEnum, modelUid, useCascade) {
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

      const startTime = Date.now();
      const tried = [];
      let hadSuccess = false;
      let rolePrinted = false;
      let currentApiKey = null;
      let lastErr = null;
      const maxAttempts = 3;

      const onChunk = (chunk) => {
        if (!rolePrinted) {
          rolePrinted = true;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        }
        hadSuccess = true;
        if (chunk.text) send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] });
        if (chunk.thinking) send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null }] });
      };

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (abortController.signal.aborted) return;
        const acct = getApiKey(tried);
        if (!acct) break;
        tried.push(acct.apiKey);
        currentApiKey = acct.apiKey;
        try { await ensureLs(acct.proxy); } catch (e) { lastErr = e; break; }
        const ls = getLsFor(acct.proxy);
        if (!ls) { lastErr = new Error('No LS instance available'); break; }
        log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} account=${acct.email} ls=${ls.port}`);
        const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
        try {
          if (useCascade) {
            await client.cascadeChat(messages, modelEnum, modelUid, { onChunk, signal: abortController.signal });
          } else {
            await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk });
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
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          return;
        } catch (err) {
          lastErr = err;
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
    },
  };
}
