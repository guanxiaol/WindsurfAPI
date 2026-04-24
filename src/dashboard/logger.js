/**
 * Structured logging with ring buffer, SSE, and on-disk JSONL persistence.
 *
 * Patches the primitive `log` object from config.js so every log call also:
 *   1. lands in an in-memory ring buffer (dashboard "recent logs")
 *   2. fans out to live SSE subscribers
 *   3. appends a structured JSONL line to logs/app.jsonl (daily-rotated)
 *   4. errors/warns also go to logs/error.jsonl
 *
 * Structured context: the last argument to log.*() may be a plain object.
 * It is stripped from the message and attached as `ctx`, so callers can do:
 *     log.info('Chat request', { requestId, model, account: acct.email });
 * and the dashboard can filter/group by ctx fields.
 */

import { mkdirSync, createWriteStream, accessSync, constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { log } from '../config.js';

const MAX_BUFFER = 1000;
const _buffer = [];
const _subscribers = new Set();

// LOG_DIR override lets containers redirect logs to a mount they can write to.
// Default: ./logs under the process cwd. If that's unwritable (common when a
// Docker volume is mounted with host ownership), we fall back to the system
// temp dir and, failing that, disable file logging entirely — never crash.
function resolveLogDir() {
  const candidates = [];
  if (process.env.LOG_DIR) candidates.push(process.env.LOG_DIR);
  candidates.push(join(process.cwd(), 'logs'));
  candidates.push(join(tmpdir(), 'windsurfpoolapi-logs'));
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return dir;
    } catch { /* try next candidate */ }
  }
  return null; // signals "disk logging disabled"
}

const LOG_DIR = resolveLogDir();
let _diskLoggingDisabled = LOG_DIR === null;
if (_diskLoggingDisabled) {
  console.warn('[WARN] Log directory is not writable; disk logging disabled. Set LOG_DIR to a writable path to re-enable.');
}

// Rotate by UTC date. One stream per day, lazily recreated at midnight.
let _appStream = null;
let _errStream = null;
let _streamDate = '';

function today() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function makeStream(path) {
  const s = createWriteStream(path, { flags: 'a' });
  // Async stream errors (e.g. EACCES on first write, EIO on full disk) are
  // emitted on the next tick and will crash Node if unhandled. Catch them
  // here, disable disk logging, and fall back to console-only.
  s.on('error', (e) => {
    if (!_diskLoggingDisabled) {
      _diskLoggingDisabled = true;
      console.warn(`[WARN] Log write failed (${e.code || e.message}); disk logging disabled.`);
    }
  });
  return s;
}

function getStreams() {
  if (_diskLoggingDisabled) return null;
  const date = today();
  if (date !== _streamDate) {
    try { _appStream?.end(); } catch {}
    try { _errStream?.end(); } catch {}
    _appStream = makeStream(join(LOG_DIR, `app-${date}.jsonl`));
    _errStream = makeStream(join(LOG_DIR, `error-${date}.jsonl`));
    _streamDate = date;
  }
  return { app: _appStream, err: _errStream };
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Detect "context object": plain object, not array, not Error, reasonable size.
function isCtx(x) {
  return x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Error)
    && Object.getPrototypeOf(x) === Object.prototype;
}

// Save originals before patching
const _orig = {
  debug: log.debug,
  info: log.info,
  warn: log.warn,
  error: log.error,
};

for (const level of ['debug', 'info', 'warn', 'error']) {
  log[level] = (...args) => {
    // Pull trailing context object out of args.
    let ctx = null;
    if (args.length > 1 && isCtx(args[args.length - 1])) {
      ctx = args[args.length - 1];
      args = args.slice(0, -1);
    }
    const msg = args.map(formatArg).join(' ');

    const entry = { ts: Date.now(), level, msg };
    if (ctx) entry.ctx = ctx;

    _buffer.push(entry);
    if (_buffer.length > MAX_BUFFER) _buffer.shift();

    for (const fn of _subscribers) {
      try { fn(entry); } catch {}
    }

    // Persist to disk (no-op if disk logging disabled after a stream error)
    try {
      const streams = getStreams();
      if (streams) {
        const line = JSON.stringify(entry) + '\n';
        streams.app.write(line);
        if (level === 'error' || level === 'warn') streams.err.write(line);
      }
    } catch {}

    // Also print to console so pm2 logs still work
    if (ctx) {
      const ctxStr = Object.entries(ctx)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      _orig[level](...args, ctxStr ? `{${ctxStr}}` : '');
    } else {
      _orig[level](...args);
    }
  };
}

/**
 * Return a logger bound to a fixed context (e.g. { requestId }).
 * Later args to .info/.warn/.error can still add more context fields.
 */
export function withCtx(baseCtx) {
  const bind = (level) => (...args) => {
    let extra = null;
    if (args.length > 1 && isCtx(args[args.length - 1])) {
      extra = args[args.length - 1];
      args = args.slice(0, -1);
    }
    log[level](...args, { ...baseCtx, ...(extra || {}) });
  };
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    requestId: baseCtx.requestId,
  };
}

/** Generate a short request id for tracing a single chat call end-to-end. */
export function newRequestId() {
  return 'r_' + randomUUID().replace(/-/g, '').slice(0, 10);
}

/** Get recent logs, optionally filtered by since/level/ctx. */
export function getLogs(since = 0, level = null, ctxFilter = null) {
  let result = _buffer;
  if (since > 0) result = result.filter(e => e.ts > since);
  if (level) result = result.filter(e => e.level === level);
  if (ctxFilter && typeof ctxFilter === 'object') {
    result = result.filter(e => {
      if (!e.ctx) return false;
      for (const [k, v] of Object.entries(ctxFilter)) {
        if (e.ctx[k] !== v) return false;
      }
      return true;
    });
  }
  return result;
}

export function subscribeToLogs(callback) { _subscribers.add(callback); }
export function unsubscribeFromLogs(callback) { _subscribers.delete(callback); }

/** Get current log directory (for dashboard to display). */
export function getLogDir() { return LOG_DIR || '(disk logging disabled)'; }
