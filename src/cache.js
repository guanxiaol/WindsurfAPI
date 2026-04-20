/**
 * Local response cache for chat completions.
 *
 * Cascade/Windsurf upstream does not expose Anthropic-style prompt caching,
 * so we add an in-memory, exact-match cache keyed on the normalized request
 * body. This only helps with duplicate requests (Claude Code retries, parallel
 * identical calls), not prefix-caching.
 */

import { createHash } from 'crypto';
import { log } from './config.js';

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

// Map preserves insertion order → we evict the oldest when over capacity.
const _store = new Map();
const _stats = { hits: 0, misses: 0, stores: 0, evictions: 0 };

function normalize(body) {
  // Only the semantically meaningful fields — ignore stream flag, user id, etc.
  return {
    model: body.model || '',
    messages: body.messages || [],
    tools: body.tools || null,
    tool_choice: body.tool_choice || null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    max_tokens: body.max_tokens ?? null,
  };
}

export function cacheKey(body) {
  const json = JSON.stringify(normalize(body));
  return createHash('sha256').update(json).digest('hex');
}

export function cacheGet(key) {
  const entry = _store.get(key);
  if (!entry) { _stats.misses++; return null; }
  if (entry.expiresAt < Date.now()) {
    _store.delete(key);
    _stats.misses++;
    return null;
  }
  // Refresh LRU position
  _store.delete(key);
  _store.set(key, entry);
  _stats.hits++;
  return entry.value;
}

export function cacheSet(key, value) {
  // Don't cache empty or partial results
  if (!value || (!value.text && !(value.chunks && value.chunks.length))) return;
  _store.set(key, { value, expiresAt: Date.now() + TTL_MS });
  _stats.stores++;
  while (_store.size > MAX_ENTRIES) {
    const oldest = _store.keys().next().value;
    _store.delete(oldest);
    _stats.evictions++;
  }
}

export function cacheStats() {
  const total = _stats.hits + _stats.misses;
  return {
    size: _store.size,
    maxSize: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits: _stats.hits,
    misses: _stats.misses,
    stores: _stats.stores,
    evictions: _stats.evictions,
    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

export function cacheClear() {
  _store.clear();
  _stats.hits = 0; _stats.misses = 0; _stats.stores = 0; _stats.evictions = 0;
  log.info('Response cache cleared');
}
