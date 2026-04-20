/**
 * Request statistics collector — CLIProxyAPI-compatible schema v2.
 *
 * Upgrades over the v1 layout:
 *   - Per-request token breakdown (input / output / reasoning / cached / total)
 *   - Per-day buckets (YYYY-MM-DD, indefinite retention)
 *   - Per-hour-of-day buckets (00-23, aggregated across all days)
 *   - Per-(api-path, model) aggregation with a bounded details[] ring buffer
 *   - Export / import with dedup so long-running history survives restarts
 *   - Windsurf-specific credit spend tracking (credit multiplier × requests)
 *
 * Migration: if stats.json on disk is v1 (old flat modelCounts / hourlyBuckets),
 * we seed the aggregate totals from it on first load and move on — per-request
 * detail granularity isn't available retroactively.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

// Lazy-resolved reference to auth.js (avoids circular-import at parse time).
let _getAccountList = null;
function resolveAccountEmail(apiKey) {
  if (!apiKey) return '';
  try {
    if (!_getAccountList) {
      // auth.js is guaranteed to be fully loaded by the time any HTTP
      // request triggers recordRequest(), so a sync property read on the
      // already-cached module is safe.
      _getAccountList = globalThis.__windsurf_getAccountList;
    }
    if (_getAccountList) {
      const match = _getAccountList().find(a => a.apiKey === apiKey);
      if (match) return match.email;
    }
  } catch {}
  return String(apiKey).slice(0, 16);
}

const STATS_FILE = join(process.cwd(), 'stats.json');
const SCHEMA_VERSION = 2;

// Cap per-(api,model) Details[] to avoid unbounded memory / file growth.
// 500 entries × ~250 bytes each ≈ 125 KB per model. With 30 models that's
// still only ~4 MB in stats.json.
const MAX_DETAILS_PER_MODEL = 500;

// Day buckets are indefinite; hourly is 24 folded. Neither is pruned here —
// the dashboard exposes explicit pruneDays() / pruneDetails() endpoints.

const _state = freshState();

function freshState() {
  return {
    version: SCHEMA_VERSION,
    startedAt: Date.now(),
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    totalTokens: 0,
    totalCredits: 0,
    apis: {},              // { "POST /v1/chat/completions": { totalRequests, totalTokens, totalCredits, models: {} } }
    requestsByDay: {},     // { "2026-04-20": 12 }
    requestsByHour: {},    // { "09": 4 }  aggregated across all days (0-23 bucket)
    tokensByDay: {},       // { "2026-04-20": 9876 }
    tokensByHour: {},      // { "09": 1234 }
    creditsByDay: {},      // Windsurf-specific: sum of credit multipliers spent per day
    creditsByHour: {},
  };
}

// ─── Persistence ──────────────────────────────────────────────

function atomicWrite(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function loadFromDisk() {
  try {
    if (!existsSync(STATS_FILE)) return;
    const raw = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object') return;

    // v1 migration: old layout had { totalRequests, successCount, errorCount,
    // modelCounts, accountCounts, hourlyBuckets }. We keep only aggregate
    // counters and day buckets derived from the hourlyBuckets so the charts
    // aren't suddenly empty after upgrade.
    if (!raw.version || raw.version < 2) {
      _state.totalRequests  = raw.totalRequests  || 0;
      _state.successCount   = raw.successCount   || 0;
      _state.failureCount   = raw.errorCount     || 0;
      _state.startedAt      = raw.startedAt      || Date.now();
      // Replay hourlyBuckets into requestsByDay / requestsByHour
      for (const b of (raw.hourlyBuckets || [])) {
        if (!b?.hour) continue;
        const d = new Date(b.hour);
        if (isNaN(d.getTime())) continue;
        const dayKey = d.toISOString().slice(0, 10);
        const hourKey = String(d.getUTCHours()).padStart(2, '0');
        _state.requestsByDay[dayKey] = (_state.requestsByDay[dayKey] || 0) + (b.requests || 0);
        _state.requestsByHour[hourKey] = (_state.requestsByHour[hourKey] || 0) + (b.requests || 0);
      }
      // Replay modelCounts into apis as a single pseudo-api so the UI still
      // has something to render.
      const migratedApi = {
        totalRequests: raw.totalRequests || 0,
        totalTokens: 0,
        totalCredits: 0,
        models: {},
      };
      for (const [model, mc] of Object.entries(raw.modelCounts || {})) {
        migratedApi.models[model] = {
          totalRequests: mc.requests || 0,
          totalTokens: 0,
          totalCredits: 0,
          details: [],
        };
      }
      if (raw.totalRequests > 0) {
        _state.apis['(legacy v1)'] = migratedApi;
      }
      // Persist the migrated state back immediately so the next restart is clean
      scheduleSave();
      return;
    }

    // v2 load — trust the structure but defensively fill missing keys
    Object.assign(_state, freshState(), raw);
    _state.apis = raw.apis || {};
    _state.requestsByDay   = raw.requestsByDay   || {};
    _state.requestsByHour  = raw.requestsByHour  || {};
    _state.tokensByDay     = raw.tokensByDay     || {};
    _state.tokensByHour    = raw.tokensByHour    || {};
    _state.creditsByDay    = raw.creditsByDay    || {};
    _state.creditsByHour   = raw.creditsByHour   || {};
  } catch (e) {
    // Corrupt stats.json — start fresh, but don't crash boot
    // (original file is left on disk for forensic inspection)
  }
}

let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      atomicWrite(STATS_FILE, JSON.stringify(_state, null, 2));
    } catch {}
  }, 5000);
}

loadFromDisk();

// ─── Helpers ──────────────────────────────────────────────────

function dayKeyFor(ts) {
  return new Date(ts).toISOString().slice(0, 10); // "YYYY-MM-DD"
}
function hourKeyFor(ts) {
  return String(new Date(ts).getUTCHours()).padStart(2, '0'); // "00".."23"
}

function normaliseTokens(t) {
  const input   = Math.max(0, Number(t?.input   ?? t?.input_tokens   ?? 0));
  const output  = Math.max(0, Number(t?.output  ?? t?.output_tokens  ?? 0));
  const reason  = Math.max(0, Number(t?.reasoning ?? t?.reasoning_tokens ?? 0));
  const cached  = Math.max(0, Number(t?.cached  ?? t?.cached_tokens  ?? 0));
  const total   = Math.max(0, Number(t?.total   ?? t?.total_tokens   ?? 0)) ||
                  (input + output + reason + cached);
  return { input, output, reasoning: reason, cached, total };
}

function getOrMakeApi(apiPath) {
  if (!_state.apis[apiPath]) {
    _state.apis[apiPath] = { totalRequests: 0, totalTokens: 0, totalCredits: 0, models: {} };
  }
  return _state.apis[apiPath];
}
function getOrMakeModel(apiEntry, model) {
  if (!apiEntry.models[model]) {
    apiEntry.models[model] = { totalRequests: 0, totalTokens: 0, totalCredits: 0, details: [] };
  }
  return apiEntry.models[model];
}

function pushDetail(modelEntry, detail) {
  modelEntry.details.push(detail);
  if (modelEntry.details.length > MAX_DETAILS_PER_MODEL) {
    modelEntry.details.shift();
  }
}

// ─── Record API ───────────────────────────────────────────────

/**
 * Record a completed request.
 *
 * Supports two call shapes for backward compatibility:
 *   recordRequest(model, success, durationMs, accountId)      — legacy
 *   recordRequest({model, success, durationMs, accountId,
 *                  tokens, source, credit, timestamp})         — new
 *
 * `tokens` is {input, output, reasoning, cached, total} (all optional).
 * `source` is the incoming API path ("POST /v1/chat/completions" etc.).
 * `credit` is the Windsurf credit multiplier charged for this request.
 */
export function recordRequest(modelOrOpts, success, durationMs, accountId) {
  let opts;
  if (typeof modelOrOpts === 'object' && modelOrOpts !== null) {
    opts = modelOrOpts;
  } else {
    opts = { model: modelOrOpts, success, durationMs, accountId };
  }
  recordRequestFull(opts);
}

export function recordRequestFull(opts) {
  const {
    model = 'unknown',
    success = true,
    durationMs = 0,
    accountId = null,
    tokens = null,
    source = 'unknown',
    credit = 0,
    timestamp = Date.now(),
  } = opts || {};

  const t = normaliseTokens(tokens);
  const totalTokens = t.total;
  const creditSpent = Math.max(0, Number(credit) || 0);
  const failed = !success;

  const authIndex = resolveAccountEmail(accountId);
  const detail = {
    timestamp: new Date(timestamp).toISOString(),
    latencyMs: Math.max(0, Math.round(durationMs || 0)),
    source,
    authIndex,
    tokens: t,
    failed,
    credit: creditSpent,
  };

  // Global counters
  _state.totalRequests++;
  if (failed) _state.failureCount++;
  else _state.successCount++;
  _state.totalTokens   += totalTokens;
  _state.totalCredits  += creditSpent;

  // Per-api, per-model aggregation
  const apiEntry = getOrMakeApi(source);
  apiEntry.totalRequests++;
  apiEntry.totalTokens  += totalTokens;
  apiEntry.totalCredits += creditSpent;

  const modelEntry = getOrMakeModel(apiEntry, model);
  modelEntry.totalRequests++;
  modelEntry.totalTokens  += totalTokens;
  modelEntry.totalCredits += creditSpent;
  pushDetail(modelEntry, detail);

  // Time buckets (day + hour-of-day fold)
  const dk = dayKeyFor(timestamp);
  const hk = hourKeyFor(timestamp);
  _state.requestsByDay[dk]  = (_state.requestsByDay[dk]  || 0) + 1;
  _state.requestsByHour[hk] = (_state.requestsByHour[hk] || 0) + 1;
  _state.tokensByDay[dk]    = (_state.tokensByDay[dk]    || 0) + totalTokens;
  _state.tokensByHour[hk]   = (_state.tokensByHour[hk]   || 0) + totalTokens;
  _state.creditsByDay[dk]   = (_state.creditsByDay[dk]   || 0) + creditSpent;
  _state.creditsByHour[hk]  = (_state.creditsByHour[hk]  || 0) + creditSpent;

  scheduleSave();
}

// ─── Read API ─────────────────────────────────────────────────

/**
 * Legacy snapshot — preserves the v1 shape the existing dashboard UI
 * renders (totalRequests/successCount/errorCount/modelCounts/accountCounts
 * /hourlyBuckets). Augmented with the new v2 fields so the upgraded UI
 * doesn't need two round-trips.
 */
export function getStats() {
  // Rebuild legacy-flat modelCounts from apis[*].models
  const modelCounts = {};
  for (const apiEntry of Object.values(_state.apis)) {
    for (const [modelName, mc] of Object.entries(apiEntry.models)) {
      if (!modelCounts[modelName]) {
        modelCounts[modelName] = { requests: 0, success: 0, errors: 0, totalMs: 0, totalTokens: 0, totalCredits: 0 };
      }
      const m = modelCounts[modelName];
      m.requests     += mc.totalRequests;
      m.totalTokens  += mc.totalTokens;
      m.totalCredits += mc.totalCredits;
      // details carry failure + latency info — aggregate them
      for (const d of mc.details) {
        if (d.failed) m.errors++; else m.success++;
        m.totalMs += d.latencyMs || 0;
      }
    }
  }

  // Rebuild legacy hourlyBuckets from requestsByDay + requestsByHour.
  // The legacy UI expects { hour: "ISO", requests, errors }. We'll emit the
  // last 72 hours using day × hour combos — empty hours dropped.
  const hourlyBuckets = [];
  const now = new Date();
  for (let i = 71; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    const dk = d.toISOString().slice(0, 10);
    const hk = String(d.getUTCHours()).padStart(2, '0');
    const isoHour = new Date(`${dk}T${hk}:00:00Z`).toISOString();
    // This is fold-aware: we don't know per-(day,hour) exactly (hour bucket is
    // folded), so we synthesise using day total × (hourShare = hourBucket / sumHourBuckets).
    // For the UI's rolling 72h chart this is a reasonable projection.
    const dayTotal = _state.requestsByDay[dk] || 0;
    const hourShare = (_state.requestsByHour[hk] || 0) /
                      Math.max(1, Object.values(_state.requestsByHour).reduce((a, b) => a + b, 0));
    hourlyBuckets.push({
      hour: isoHour,
      requests: Math.round(dayTotal * hourShare),
      errors: 0, // per-hour errors aren't stored; 0 keeps the legacy chart happy
    });
  }

  return {
    // Legacy v1 fields (existing UI keeps working untouched)
    startedAt: _state.startedAt,
    totalRequests: _state.totalRequests,
    successCount: _state.successCount,
    errorCount: _state.failureCount,
    modelCounts,
    accountCounts: {}, // unchanged; legacy UI doesn't render this anyway
    hourlyBuckets,

    // New v2 fields
    version: SCHEMA_VERSION,
    totalTokens: _state.totalTokens,
    totalCredits: _state.totalCredits,
    apis: _state.apis,
    requestsByDay: _state.requestsByDay,
    requestsByHour: _state.requestsByHour,
    tokensByDay: _state.tokensByDay,
    tokensByHour: _state.tokensByHour,
    creditsByDay: _state.creditsByDay,
    creditsByHour: _state.creditsByHour,
  };
}

/** CLIProxyAPI-compatible snapshot (subset of getStats). */
export function getUsageSnapshot() {
  return {
    total_requests: _state.totalRequests,
    success_count:  _state.successCount,
    failure_count:  _state.failureCount,
    total_tokens:   _state.totalTokens,
    total_credits:  _state.totalCredits,
    requests_by_day:  { ..._state.requestsByDay  },
    requests_by_hour: { ..._state.requestsByHour },
    tokens_by_day:    { ..._state.tokensByDay    },
    tokens_by_hour:   { ..._state.tokensByHour   },
    credits_by_day:   { ..._state.creditsByDay   },
    credits_by_hour:  { ..._state.creditsByHour  },
    apis: Object.fromEntries(
      Object.entries(_state.apis).map(([apiPath, a]) => [apiPath, {
        total_requests: a.totalRequests,
        total_tokens:   a.totalTokens,
        total_credits:  a.totalCredits,
        models: Object.fromEntries(
          Object.entries(a.models).map(([m, mc]) => [m, {
            total_requests: mc.totalRequests,
            total_tokens:   mc.totalTokens,
            total_credits:  mc.totalCredits,
            details: mc.details.map(d => ({
              timestamp: d.timestamp,
              latency_ms: d.latencyMs,
              source: d.source,
              auth_index: d.authIndex,
              tokens: {
                input_tokens: d.tokens.input,
                output_tokens: d.tokens.output,
                reasoning_tokens: d.tokens.reasoning,
                cached_tokens: d.tokens.cached,
                total_tokens: d.tokens.total,
              },
              failed: d.failed,
              credit: d.credit || 0,
            })),
          }])
        ),
      }])
    ),
  };
}

/** Full exportable blob (for backup / migration). */
export function exportUsage() {
  return {
    version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    usage: getUsageSnapshot(),
  };
}

// ─── Import / Merge ───────────────────────────────────────────

function dedupKey(apiPath, model, detail) {
  const t = detail.tokens || {};
  return [
    apiPath, model, detail.timestamp, detail.source || '', detail.auth_index || '',
    detail.failed ? 1 : 0,
    t.input_tokens || 0, t.output_tokens || 0, t.reasoning_tokens || 0,
    t.cached_tokens || 0, t.total_tokens || 0,
  ].join('|');
}

/**
 * Merge an exported snapshot (from exportUsage or CLIProxyAPI's /usage/export)
 * into our in-memory state. Duplicates are skipped.
 *
 * Returns { added, skipped, total_requests, failed_requests }.
 */
export function importUsage(payload) {
  let result = { added: 0, skipped: 0 };
  if (!payload || typeof payload !== 'object') return { ...result, ..._resultTotals() };

  // Accept either the full { version, exported_at, usage } envelope or a
  // bare snapshot with { total_requests, apis, ... }.
  const snapshot = payload.usage && typeof payload.usage === 'object' ? payload.usage : payload;
  const apis = snapshot.apis || {};

  // Build the dedup index from existing details
  const seen = new Set();
  for (const [apiPath, a] of Object.entries(_state.apis)) {
    for (const [m, mc] of Object.entries(a.models)) {
      for (const d of mc.details) {
        seen.add(dedupKey(apiPath, m, {
          timestamp: d.timestamp,
          source: d.source,
          auth_index: d.authIndex,
          failed: d.failed,
          tokens: {
            input_tokens: d.tokens.input,
            output_tokens: d.tokens.output,
            reasoning_tokens: d.tokens.reasoning,
            cached_tokens: d.tokens.cached,
            total_tokens: d.tokens.total,
          },
        }));
      }
    }
  }

  for (const [apiPath, apiSnap] of Object.entries(apis)) {
    const apiPathTrim = String(apiPath).trim() || 'unknown';
    for (const [rawModel, modelSnap] of Object.entries(apiSnap.models || {})) {
      const model = String(rawModel).trim() || 'unknown';
      for (const detail of (modelSnap.details || [])) {
        const key = dedupKey(apiPathTrim, model, detail);
        if (seen.has(key)) { result.skipped++; continue; }
        seen.add(key);

        // Replay through recordRequestFull so all aggregates stay consistent
        const t = detail.tokens || {};
        recordRequestFull({
          model,
          success: !detail.failed,
          durationMs: detail.latency_ms || 0,
          accountId: detail.auth_index || null,
          source: apiPathTrim,
          credit: detail.credit || 0,
          timestamp: detail.timestamp ? new Date(detail.timestamp).getTime() : Date.now(),
          tokens: {
            input: t.input_tokens || 0,
            output: t.output_tokens || 0,
            reasoning: t.reasoning_tokens || 0,
            cached: t.cached_tokens || 0,
            total: t.total_tokens || 0,
          },
        });
        result.added++;
      }
    }
  }

  // Force immediate save on import so user sees data in stats.json right away
  try { atomicWrite(STATS_FILE, JSON.stringify(_state, null, 2)); } catch {}

  return { ...result, ..._resultTotals() };
}

function _resultTotals() {
  return {
    total_requests: _state.totalRequests,
    failed_requests: _state.failureCount,
  };
}

// ─── Reset / Prune ────────────────────────────────────────────

export function resetStats() {
  Object.assign(_state, freshState());
  scheduleSave();
}

/**
 * Drop per-request details older than `olderThanMs` (default 30 days).
 * Aggregates (totals, buckets) are preserved.
 */
export function pruneDetails(olderThanMs = 30 * 24 * 3600 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const a of Object.values(_state.apis)) {
    for (const mc of Object.values(a.models)) {
      const before = mc.details.length;
      mc.details = mc.details.filter(d => new Date(d.timestamp).getTime() >= cutoff);
      removed += (before - mc.details.length);
    }
  }
  scheduleSave();
  return { removed };
}

/**
 * Drop day buckets older than `olderThanMs` (default 90 days).
 * Per-request details remain (unless also pruned).
 */
export function pruneDays(olderThanMs = 90 * 24 * 3600 * 1000) {
  const cutoffDay = dayKeyFor(Date.now() - olderThanMs);
  let removed = 0;
  for (const k of Object.keys(_state.requestsByDay)) {
    if (k < cutoffDay) { delete _state.requestsByDay[k]; removed++; }
  }
  for (const k of Object.keys(_state.tokensByDay))   { if (k < cutoffDay) delete _state.tokensByDay[k]; }
  for (const k of Object.keys(_state.creditsByDay))  { if (k < cutoffDay) delete _state.creditsByDay[k]; }
  scheduleSave();
  return { removed };
}
