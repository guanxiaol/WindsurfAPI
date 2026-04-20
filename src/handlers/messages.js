/**
 * POST /v1/messages — Anthropic Messages API compatible endpoint.
 *
 * Thin adapter on top of handleChatCompletions:
 *   Request:  Anthropic Messages body → OpenAI chat/completions body
 *   Response: OpenAI chat.completion ↔ Anthropic Message
 *             OpenAI SSE (chat.completion.chunk) ↔ Anthropic SSE
 *             (message_start / content_block_* / message_delta / message_stop)
 *
 * This lets Anthropic-SDK clients point ANTHROPIC_BASE_URL
 * at WindsurfAPI directly, no protocol-translation middlebox required.
 *
 * Spec refs:
 *   https://docs.claude.com/en/api/messages
 *   https://docs.claude.com/en/api/messages-streaming
 */

import { randomUUID } from 'crypto';
import { handleChatCompletions } from './chat.js';
import { resolveModel } from '../models.js';
import { config, log } from '../config.js';

// ── Model name aliasing ────────────────────────────────────
// Anthropic clients sends names like "claude-opus-4-5-20250929" or the bare alias
// "opus"/"sonnet"/"haiku". Map them onto Windsurf's catalog before handing
// the body to handleChatCompletions.
const ALIAS_MAP = {
  // Bare client aliases → latest Windsurf equivalent
  'opus':   'claude-opus-4.6-thinking',
  'sonnet': 'claude-sonnet-4.6',
  'haiku':  'claude-4.5-haiku',
};

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Map a CC-sent model name to a Windsurf catalog entry.
 *
 * Anthropic clients internally ship the model family name as `model`
 * (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`)
 * and passes the chosen effort tier separately in `output_config.effort`.
 * Our catalog stores Opus 4.7 as five separate entries keyed by effort
 * (claude-opus-4.7-{low,medium,high,xhigh,max}), so we have to fuse the two
 * fields back together here.
 *
 * `effort` may also come through as a `-low`/`-medium`/… suffix on the model
 * name itself (older clients, or curl tests); we handle that too.
 *
 * @param {string} name    Model name exactly as the caller sent it
 * @param {string} [effort] Optional effort tier ('low'|'medium'|'high'|'xhigh'|'max')
 */
function mapModel(name, effort) {
  if (!name) return config.defaultModel;
  const eff = VALID_EFFORTS.has((effort || '').toLowerCase()) ? effort.toLowerCase() : null;

  // Client appends "[1m]" to the model string to request the 1M-token context
  // variant of Sonnet 4.6 (opus-4-7 / opus-4-6 / sonnet-4-6 use this
  // suffix when long-context mode triggers).
  // Strip the suffix for catalog matching and remember the flag for routing.
  const wants1m = /\[1m\]$/.test(name);
  const bareName = wants1m ? name.replace(/\[1m\]$/, '') : name;

  // Exact catalog match first (post-suffix-strip)
  const resolved = resolveModel(bareName);
  if (resolved && resolved !== bareName) {
    // If caller asked for 1M but catalog entry isn't a -1m variant, try to upgrade
    if (wants1m && !/-1m$/.test(resolved)) {
      if (/^claude-sonnet-4\.6-thinking$/.test(resolved)) return 'claude-sonnet-4.6-thinking-1m';
      if (/^claude-sonnet-4\.6$/.test(resolved))          return 'claude-sonnet-4.6-1m';
    }
    return resolved;
  }

  // Client bare aliases (haiku/sonnet/opus without version)
  const lower = bareName.toLowerCase();
  if (ALIAS_MAP[lower]) return ALIAS_MAP[lower];

  // Claude Opus 4.7 family — redirected to opus 4.6 thinking per user config.
  if (/claude.*opus.*4[-_.]7/i.test(bareName))         return 'claude-opus-4.6-thinking';

  // Older Opus families — effort heuristic (high/xhigh/max → thinking variant)
  if (/claude.*opus.*4[-_.]6/i.test(bareName)) {
    return (eff && ['high','xhigh','max'].includes(eff)) ? 'claude-opus-4.6-thinking' : 'claude-opus-4.6';
  }

  // Fallback bare opus → opus 4.6 thinking
  if (/claude.*opus/i.test(bareName)) return 'claude-opus-4.6-thinking';

  // Sonnet — 4.6 family. Honour [1m] to pick the 1M-context variant.
  const sonnetThinking = /claude.*sonnet.*thinking/i.test(bareName);
  const sonnet46       = /claude.*sonnet.*4[-_.]6/i.test(bareName);
  const sonnetGeneric  = /claude.*sonnet/i.test(bareName);
  if (sonnetThinking) return wants1m ? 'claude-sonnet-4.6-thinking-1m' : 'claude-sonnet-4.6-thinking';
  if (sonnet46) {
    const thinking = (eff && ['high','xhigh','max'].includes(eff));
    if (wants1m && thinking) return 'claude-sonnet-4.6-thinking-1m';
    if (wants1m)             return 'claude-sonnet-4.6-1m';
    if (thinking)            return 'claude-sonnet-4.6-thinking';
    return 'claude-sonnet-4.6';
  }
  if (sonnetGeneric) return wants1m ? 'claude-sonnet-4.6-1m' : 'claude-sonnet-4.6';

  // Haiku
  if (/claude.*haiku/i.test(bareName)) return 'claude-4.5-haiku';

  // Unknown — let resolveModel's fallthrough try, chat.js will 403 if really bogus
  return resolved || bareName;
}

function genMsgId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genToolUseId() {
  return 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 22);
}

// ── Request conversion: Anthropic → OpenAI ────────────────

/**
 * Flatten an Anthropic content block array into either a plain string (for the
 * text-only case, which maximises downstream cache hit rate) or an array of
 * OpenAI content parts. Tool-use / tool-result blocks get hoisted into OpenAI
 * tool_calls / tool messages; image blocks are preserved as OpenAI image_url
 * parts.
 */
function anthropicContentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  const textParts = [];
  const toolUses = [];
  const toolResults = [];
  const imageParts = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (block.text) textParts.push(block.text);
        break;
      case 'thinking':
        // Assistant-side reasoning. Keep it visible as <thinking> so that if
        // the model reads prior turns it can see its own reasoning.
        if (block.thinking) textParts.push(`<thinking>${block.thinking}</thinking>`);
        break;
      case 'tool_use':
        toolUses.push({
          id: block.id || genToolUseId(),
          type: 'function',
          function: {
            name: block.name || 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case 'tool_result':
        toolResults.push({
          tool_call_id: block.tool_use_id || '',
          // Anthropic tool_result content may itself be a string or an array
          // of content blocks. Collapse to a string for OpenAI's tool message
          // shape (OpenAI only accepts string content for role=tool).
          content: flattenToolResultContent(block.content),
          is_error: !!block.is_error,
        });
        break;
      case 'image':
        if (block.source?.type === 'base64') {
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        } else if (block.source?.type === 'url') {
          imageParts.push({ type: 'image_url', image_url: { url: block.source.url } });
        }
        break;
      case 'document':
        // Drop. Windsurf backend doesn't expose document inputs.
        log.warn('messages: document content block dropped (not supported)');
        break;
      default:
        log.debug(`messages: unknown content block type="${block.type}" dropped`);
    }
  }

  return { textParts, toolUses, toolResults, imageParts };
}

function flattenToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  const parts = [];
  for (const blk of content) {
    if (blk?.type === 'text' && blk.text) parts.push(blk.text);
    else if (blk?.type === 'image') parts.push('[image]'); // Windsurf tool-results are text-only
    else if (typeof blk === 'string') parts.push(blk);
  }
  return parts.join('\n');
}

/**
 * Map one Anthropic message → one or more OpenAI messages.
 * Splits assistant turns with tool_use into {assistant content + tool_calls}.
 * Splits user turns with tool_result into one or more role:tool messages.
 */
function anthropicMessageToOpenAI(msg) {
  const role = msg.role;
  const parsed = anthropicContentToOpenAI(msg.content);

  // Simple string passthrough
  if (typeof parsed === 'string') {
    return [{ role, content: parsed }];
  }

  const { textParts, toolUses, toolResults, imageParts } = parsed;
  const out = [];

  // User turns: emit role:tool messages first for any tool_results, then any
  // remaining text/images as a single role:user message. Anthropic clients
  // interleaves tool_result + user text within the same user message (per
  // Anthropic's protocol), OpenAI requires them as separate role=tool msgs.
  if (role === 'user') {
    for (const r of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: r.tool_call_id,
        content: r.is_error ? `[error] ${r.content}` : r.content,
      });
    }
    if (textParts.length || imageParts.length) {
      if (imageParts.length) {
        out.push({
          role: 'user',
          content: [
            ...(textParts.length ? [{ type: 'text', text: textParts.join('\n') }] : []),
            ...imageParts,
          ],
        });
      } else {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
    }
    return out;
  }

  // Assistant turns: merge text + tool_calls onto a single assistant message
  if (role === 'assistant') {
    const message = { role: 'assistant', content: textParts.join('\n') || null };
    if (toolUses.length) message.tool_calls = toolUses;
    out.push(message);
    return out;
  }

  // Fallback for unknown roles
  out.push({ role, content: textParts.join('\n') });
  return out;
}

/** Anthropic system prompt (string | ContentBlock[]) → OpenAI system message content */
function anthropicSystemToOpenAI(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(b => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n');
  }
  return String(system);
}

/** Anthropic tools → OpenAI tools */
function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object' || !t.name) continue;
    // Skip Anthropic's server-side tools (web_search, computer_20241022, etc.)
    // that we have no way to fulfil — keep only function-style tool definitions.
    if (t.type && t.type !== 'custom' && !t.input_schema) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

/** Anthropic tool_choice → OpenAI tool_choice */
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } };
  }
  return undefined;
}

/**
 * Build an OpenAI chat.completions body from an Anthropic Messages body.
 */
function buildOpenAIBody(anthropicBody) {
  const messages = [];

  const sysText = anthropicSystemToOpenAI(anthropicBody.system);
  if (sysText) messages.push({ role: 'system', content: sysText });

  for (const m of anthropicBody.messages || []) {
    for (const conv of anthropicMessageToOpenAI(m)) {
      messages.push(conv);
    }
  }

  // Anthropic clients place the effort tier in output_config.effort;
  // older Anthropic clients use top-level `effort`. Honour both.
  const effort = anthropicBody.output_config?.effort || anthropicBody.effort;
  const openaiBody = {
    model: mapModel(anthropicBody.model, effort),
    messages,
    stream: !!anthropicBody.stream,
  };
  if (typeof anthropicBody.max_tokens === 'number') openaiBody.max_tokens = anthropicBody.max_tokens;
  if (typeof anthropicBody.temperature === 'number') openaiBody.temperature = anthropicBody.temperature;
  if (typeof anthropicBody.top_p === 'number') openaiBody.top_p = anthropicBody.top_p;
  if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length) {
    openaiBody.stop = anthropicBody.stop_sequences;
  }
  const oaiTools = anthropicToolsToOpenAI(anthropicBody.tools);
  if (oaiTools) openaiBody.tools = oaiTools;
  const oaiToolChoice = anthropicToolChoiceToOpenAI(anthropicBody.tool_choice);
  if (oaiToolChoice) openaiBody.tool_choice = oaiToolChoice;

  return openaiBody;
}

// ── Response conversion: OpenAI → Anthropic (non-stream) ──

const FINISH_TO_STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

function openaiUsageToAnthropic(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  return {
    input_tokens: (u.prompt_tokens || 0) - (u.prompt_tokens_details?.cached_tokens || 0) - (u.cache_creation_input_tokens || 0),
    output_tokens: u.completion_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens || 0,
  };
}

function openaiResponseToAnthropic(openaiResp, requestedModel) {
  const choice = openaiResp.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
  }
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { _raw: tc.function?.arguments || '' }; }
      content.push({
        type: 'tool_use',
        id: tc.id || genToolUseId(),
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  }
  // Anthropic requires content to be a non-empty array — if all blocks were
  // empty (rare upstream oddity) emit a single empty text block.
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: genMsgId(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestedModel,
    stop_reason: FINISH_TO_STOP_REASON[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: openaiUsageToAnthropic(openaiResp.usage),
  };
}

// ── Response conversion: OpenAI SSE → Anthropic SSE (stream) ──

/**
 * Stream transformer that pretends to be an http.ServerResponse to
 * handleChatCompletions' streaming handler, captures every OpenAI SSE event
 * written to it, and forwards Anthropic SSE events to the real client response.
 *
 * OpenAI chunk events we translate:
 *   data: {"choices":[{"delta":{"role":"assistant","content":""}}]}       → message_start
 *   data: {"choices":[{"delta":{"reasoning_content":"..."}}]}             → thinking block
 *   data: {"choices":[{"delta":{"content":"..."}}]}                       → text block
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":N,"id":...}]}}]}   → tool_use block
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}], "usage":...}  → message_delta / stop
 *   data: [DONE]                                                          → message_stop
 *   : ping                                                                → ping
 */
class AnthropicStreamTransform {
  constructor(realRes, requestedModel) {
    this.real = realRes;
    this.model = requestedModel;
    this.msgId = genMsgId();
    this.messageStarted = false;
    this.messageStopped = false;
    // Track the active content block per "kind". Anthropic requires opening
    // and closing each block in order; we assign sequential indices.
    this.nextBlockIdx = 0;
    this.textBlockIdx = null;
    this.thinkingBlockIdx = null;
    this.toolBlockByOaiIdx = new Map(); // OpenAI tool_calls[i].index → Anthropic block idx
    // Accumulators for final message_delta usage
    this.stopReason = 'end_turn';
    this.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    // Forward write-path events so chat.js's abort listener still fires on
    // client disconnect.
    this.on = (ev, cb) => this.real.on(ev, cb);
    // Buffer across write() boundaries so a single SSE event split across
    // multiple writes still parses cleanly.
    this._buf = '';
  }

  get writableEnded() { return this.real.writableEnded || this.messageStopped; }

  _sendEvent(type, data) {
    if (this.real.writableEnded) return;
    const payload = { type, ...data };
    this.real.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  _startMessage() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this._sendEvent('message_start', {
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  _openTextBlock() {
    if (this.textBlockIdx != null) return;
    this._closeThinkingBlock();
    this.textBlockIdx = this.nextBlockIdx++;
    this._sendEvent('content_block_start', {
      index: this.textBlockIdx,
      content_block: { type: 'text', text: '' },
    });
  }

  _closeTextBlock() {
    if (this.textBlockIdx == null) return;
    this._sendEvent('content_block_stop', { index: this.textBlockIdx });
    this.textBlockIdx = null;
  }

  _openThinkingBlock() {
    if (this.thinkingBlockIdx != null) return;
    this.thinkingBlockIdx = this.nextBlockIdx++;
    this._sendEvent('content_block_start', {
      index: this.thinkingBlockIdx,
      content_block: { type: 'thinking', thinking: '' },
    });
  }

  _closeThinkingBlock() {
    if (this.thinkingBlockIdx == null) return;
    this._sendEvent('content_block_stop', { index: this.thinkingBlockIdx });
    this.thinkingBlockIdx = null;
  }

  _openToolBlock(oaiIdx, toolCall) {
    if (this.toolBlockByOaiIdx.has(oaiIdx)) return this.toolBlockByOaiIdx.get(oaiIdx);
    this._closeThinkingBlock();
    this._closeTextBlock();
    const idx = this.nextBlockIdx++;
    this.toolBlockByOaiIdx.set(oaiIdx, idx);
    this._sendEvent('content_block_start', {
      index: idx,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || genToolUseId(),
        name: toolCall.function?.name || 'unknown',
        input: {},
      },
    });
    return idx;
  }

  _closeAllToolBlocks() {
    for (const idx of this.toolBlockByOaiIdx.values()) {
      this._sendEvent('content_block_stop', { index: idx });
    }
    this.toolBlockByOaiIdx.clear();
  }

  _handleOpenAIChunk(chunk) {
    const delta = chunk.choices?.[0]?.delta || {};
    const finish = chunk.choices?.[0]?.finish_reason;

    // Pass-through reasoning (thinking) deltas
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      this._openThinkingBlock();
      this._sendEvent('content_block_delta', {
        index: this.thinkingBlockIdx,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }

    // Pass-through text deltas
    if (typeof delta.content === 'string' && delta.content.length) {
      this._openTextBlock();
      this._sendEvent('content_block_delta', {
        index: this.textBlockIdx,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // Tool call deltas — OpenAI chunks them as {index, id, function:{name, arguments}}
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaiIdx = tc.index ?? 0;
        const blockIdx = this._openToolBlock(oaiIdx, tc);
        if (tc.function?.arguments) {
          this._sendEvent('content_block_delta', {
            index: blockIdx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          });
        }
      }
    }

    // Absorb usage if the chunk carries it (chat.js emits it with the final chunk)
    if (chunk.usage) this.usage = openaiUsageToAnthropic(chunk.usage);

    if (finish) {
      this.stopReason = FINISH_TO_STOP_REASON[finish] || 'end_turn';
    }
  }

  _finishMessage() {
    if (this.messageStopped) return;
    this.messageStopped = true;
    // Close any open content blocks in reverse order
    this._closeAllToolBlocks();
    this._closeTextBlock();
    this._closeThinkingBlock();
    this._sendEvent('message_delta', {
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens || 0 },
    });
    this._sendEvent('message_stop', {});
    if (!this.real.writableEnded) this.real.end();
  }

  /**
   * handleChatCompletions' handler calls res.write(...) with either SSE data
   * frames or heartbeat comments. We parse frames out of the byte stream.
   */
  write(chunk) {
    if (this.real.writableEnded) return true;
    // First call — open the message envelope so the client sees metadata ASAP
    this._startMessage();

    this._buf += chunk.toString();
    // SSE events are terminated by '\n\n'
    let nlIdx;
    while ((nlIdx = this._buf.indexOf('\n\n')) !== -1) {
      const rawEvent = this._buf.slice(0, nlIdx);
      this._buf = this._buf.slice(nlIdx + 2);
      this._parseSseEvent(rawEvent);
    }
    return true;
  }

  _parseSseEvent(raw) {
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(': ')) {
        // SSE comment — upstream heartbeat. Forward as Anthropic ping so our
        // clients' keepalives fire too.
        this._sendEvent('ping', {});
        continue;
      }
      if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!dataLines.length) return;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') {
      this._finishMessage();
      return;
    }
    try {
      const parsed = JSON.parse(dataStr);
      this._handleOpenAIChunk(parsed);
    } catch (e) {
      log.debug(`messages: unparseable upstream SSE chunk: ${dataStr.slice(0, 120)}`);
    }
  }

  end() {
    // If chat.js ends without a [DONE] (shouldn't normally happen) still
    // produce a clean message_stop so clients don't hang.
    if (!this.messageStopped) this._finishMessage();
  }

  // handleChatCompletions calls res.setHeader/writeHead before `handler(res)`
  // in server.js — but we wrap AFTER writeHead has already run on the real
  // response, so these are typically no-ops. Keep them defensive:
  setHeader() {}
  writeHead() {}
}

// ── Public entry ───────────────────────────────────────────

export async function handleMessages(anthropicBody) {
  // Validate minimum contract
  if (!anthropicBody || !Array.isArray(anthropicBody.messages) || !anthropicBody.messages.length) {
    return {
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages: array is required and non-empty' },
      },
    };
  }
  const openaiBody = buildOpenAIBody(anthropicBody);
  const requestedModel = anthropicBody.model || openaiBody.model;

  const inEffort = anthropicBody.output_config?.effort || anthropicBody.effort || null;
  log.info(`Messages: anthropic→openai model=${anthropicBody.model}${inEffort ? ` effort=${inEffort}` : ''} → ${openaiBody.model} stream=${openaiBody.stream} msgs=${openaiBody.messages.length} tools=${openaiBody.tools?.length || 0}`);

  // Tag source for the stats recorder so /v1/messages traffic shows up as its
  // own API bucket instead of being merged with /v1/chat/completions.
  openaiBody._source = 'POST /v1/messages';

  // Non-stream path: delegate and re-shape the body.
  if (!openaiBody.stream) {
    const result = await handleChatCompletions(openaiBody);
    if (result.status !== 200) {
      // Re-shape the error envelope to Anthropic's shape
      const msg = result.body?.error?.message || 'Unknown error';
      const type = result.body?.error?.type || 'api_error';
      const anthType = {
        auth_error: 'authentication_error',
        rate_limit_exceeded: 'rate_limit_error',
        model_not_available: 'permission_error',
        model_blocked: 'permission_error',
        model_not_entitled: 'permission_error',
        pool_exhausted: 'api_error',
        upstream_error: 'api_error',
        ls_unavailable: 'api_error',
        invalid_request: 'invalid_request_error',
        not_found: 'not_found_error',
        server_error: 'api_error',
      }[type] || 'api_error';
      return {
        status: result.status,
        body: { type: 'error', error: { type: anthType, message: msg } },
      };
    }
    return {
      status: 200,
      body: openaiResponseToAnthropic(result.body, requestedModel),
    };
  }

  // Stream path: delegate and wrap the response with our transform.
  const result = await handleChatCompletions(openaiBody);
  if (result.status !== 200 || !result.stream) {
    // Upstream returned a synchronous error before streaming started — re-shape
    const msg = result.body?.error?.message || 'Upstream failed to start stream';
    const type = result.body?.error?.type || 'api_error';
    return {
      status: result.status,
      body: { type: 'error', error: { type, message: msg } },
    };
  }
  return {
    status: 200,
    stream: true,
    headers: {
      ...result.headers,
      // Anthropic SSE uses text/event-stream too, but some clients check the
      // anthropic-prefixed header so we mirror it for safety.
    },
    async handler(realRes) {
      const wrapper = new AnthropicStreamTransform(realRes, requestedModel);
      try {
        await result.handler(wrapper);
      } catch (err) {
        log.error(`messages: stream handler error: ${err.message}`);
        if (!realRes.writableEnded) {
          realRes.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } })}\n\n`);
          realRes.end();
        }
      }
    },
  };
}
