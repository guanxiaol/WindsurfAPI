/**
 * OpenAI-compatible HTTP server with multi-account management.
 *
 *   POST /v1/chat/completions       — chat completions
 *   GET  /v1/models                 — list models
 *   POST /auth/login                — add account (email+password / token / api_key)
 *   GET  /auth/accounts             — list all accounts
 *   DELETE /auth/accounts/:id       — remove account
 *   GET  /auth/status               — pool status summary
 *   GET  /health                    — health check
 */

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByToken, addAccountByKey, addAccountByRefreshToken, removeAccount,
} from './auth.js';
import { handleChatCompletions } from './handlers/chat.js';
import { handleModels } from './handlers/models.js';
import { handleMessages } from './handlers/messages.js';
import { handleDashboardApi } from './dashboard/api.js';
import { config, log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function extractToken(req) {
  // Support both OpenAI-style `Authorization: Bearer <key>` and Anthropic-style
  // `x-api-key: <key>` header. Claude Code sends the latter when ANTHROPIC_BASE_URL
  // is set, so /v1/messages MUST accept it for the drop-in UX to work.
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string') return xApiKey;
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : h;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(data);
}

async function route(req, res) {
  const { method } = req;
  const path = req.url.split('?')[0];

  if (method === 'OPTIONS') return json(res, 204, '');
  if (path === '/health') {
    const counts = getAccountCount();
    return json(res, 200, {
      status: 'ok',
      provider: 'WindsurfPoolAPI',
      version: '2.0.2',
      uptime: Math.round(process.uptime()),
      accounts: counts,
    });
  }

  // ─── Dashboard ─────────────────────────────────────────
  if (path === '/dashboard' || path === '/dashboard/') {
    try {
      const html = readFileSync(join(__dirname, 'dashboard', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return json(res, 500, { error: 'Dashboard not found' });
    }
  }

  if (path.startsWith('/dashboard/api/')) {
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try { body = JSON.parse(await readBody(req)); } catch {}
    }
    const subpath = path.slice('/dashboard/api'.length);
    return handleDashboardApi(method, subpath, body, req, res);
  }

  // ─── Auth management (no API key required) ─────────────

  if (path === '/auth/status') {
    return json(res, 200, { authenticated: isAuthenticated(), ...getAccountCount() });
  }

  if (path === '/auth/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  // DELETE /auth/accounts/:id
  if (path.startsWith('/auth/accounts/') && method === 'DELETE') {
    const id = path.split('/')[3];
    const ok = removeAccount(id);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  if (path === '/auth/login' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }

    try {
      // Support batch: { accounts: [{email,password}, ...] }
      if (Array.isArray(body.accounts)) {
        const results = [];
        for (const acct of body.accounts) {
          try {
            let result;
            if (acct.api_key) {
              result = addAccountByKey(acct.api_key, acct.label);
            } else if (acct.token) {
              result = await addAccountByToken(acct.token, acct.label);
            } else if (acct.refresh_token) {
              result = await addAccountByRefreshToken(acct.refresh_token, acct.label);
            } else if (acct.email && acct.password) {
              result = await addAccountByEmail(acct.email, acct.password);
            } else {
              results.push({ error: 'Missing credentials' });
              continue;
            }
            results.push({ id: result.id, email: result.email, status: result.status });
          } catch (err) {
            results.push({ email: acct.email, error: err.message });
          }
        }
        return json(res, 200, { results, ...getAccountCount() });
      }

      // Single account
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else if (body.refresh_token) {
        account = await addAccountByRefreshToken(body.refresh_token, body.label);
      } else if (body.email && body.password) {
        account = await addAccountByEmail(body.email, body.password);
      } else {
        return json(res, 400, { error: 'Provide api_key, token, refresh_token, or email+password' });
      }

      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      log.error('Login failed:', err.message);
      return json(res, 401, { error: err.message });
    }
  }

  // ─── API endpoints (require API key) ────────────────────

  if (!validateApiKey(extractToken(req))) {
    return json(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
  }

  if (path === '/v1/models' && method === 'GET') {
    return json(res, 200, handleModels());
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request' } });
    }

    body._source = 'POST /v1/chat/completions';
    const result = await handleChatCompletions(body);
    if (result.stream) {
      // Streaming tuning: keep the socket hot and unblock the first byte.
      //   setNoDelay — disable Nagle so small SSE deltas aren't coalesced (40ms win)
      //   setKeepAlive + setTimeout(0) — survive long thinking pauses w/o RST
      //   flushHeaders — push HTTP response line + headers to the client NOW,
      //     so SSE clients (esp. CC) exit their "connecting" state immediately
      req.socket?.setKeepAlive(true);
      req.setTimeout(0);
      res.socket?.setNoDelay(true);
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      res.flushHeaders?.();
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  // Anthropic Messages API — /v1/messages. Lets Claude Code and any Anthropic
  // SDK point ANTHROPIC_BASE_URL at us directly, no protocol translator required.
  if (path === '/v1/messages' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, { type: 'error', error: { type: 'authentication_error', message: 'No active accounts. POST /auth/login to add accounts.' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    const result = await handleMessages(body);
    if (result.stream) {
      // Same streaming tuning as /v1/chat/completions — see comment above.
      req.socket?.setKeepAlive(true);
      req.setTimeout(0);
      res.socket?.setNoDelay(true);
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      res.flushHeaders?.();
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  json(res, 404, { error: { message: `${method} ${path} not found`, type: 'not_found' } });
}

export function startServer() {
  const activeRequests = new Set();

  const server = http.createServer(async (req, res) => {
    activeRequests.add(res);
    res.on('close', () => activeRequests.delete(res));
    try {
      await route(req, res);
    } catch (err) {
      log.error('Handler error:', err);
      if (!res.headersSent) json(res, 500, { error: { message: 'Internal error', type: 'server_error' } });
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let retryCount = 0;
  const maxRetries = 10;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > maxRetries) {
        log.error(`Port ${config.port} still in use after ${maxRetries} retries. Exiting.`);
        process.exit(1);
      }
      log.warn(`Port ${config.port} in use, retry ${retryCount}/${maxRetries} in 3s...`);
      setTimeout(() => server.listen(config.port, '0.0.0.0'), 3000);
    } else {
      log.error('Server error:', err);
    }
  });

  server.getActiveRequests = () => activeRequests.size;

  server.listen({ port: config.port, host: '0.0.0.0' }, () => {
    log.info(`Server on http://0.0.0.0:${config.port}`);
    log.info('  POST /v1/chat/completions  (OpenAI format)');
    log.info('  POST /v1/messages          (Anthropic format — Claude Code native)');
    log.info('  GET  /v1/models');
    log.info('  POST /auth/login           (add account)');
    log.info('  GET  /auth/accounts        (list accounts)');
    log.info('  DELETE /auth/accounts/:id  (remove account)');
  });
  return server;
}
