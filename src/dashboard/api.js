/**
 * Dashboard API route handlers.
 * All routes are under /dashboard/api/*.
 */

import { config, log } from '../config.js';
import {
  getAccountList, getAccountCount, addAccountByKey, addAccountByToken,
  removeAccount, setAccountStatus, resetAccountErrors, updateAccountLabel,
  isAuthenticated, probeAccount, ensureLsForAccount,
  refreshCredits, refreshAllCredits,
  setAccountBlockedModels, fetchAndMergeModelCatalog,
} from '../auth.js';
import { restartLsForProxy } from '../langserver.js';
import { getLsStatus, stopLanguageServer, startLanguageServer, isLanguageServerRunning } from '../langserver.js';
import { getStats, resetStats, recordRequest, getUsageSnapshot, exportUsage, importUsage, pruneDetails, pruneDays } from './stats.js';
import { cacheStats, cacheClear } from '../cache.js';
import { getExperimental, setExperimental } from '../runtime-config.js';
import { poolStats as convPoolStats, poolClear as convPoolClear } from '../conversation-pool.js';
import { getLogs, subscribeToLogs, unsubscribeFromLogs } from './logger.js';
import { getProxyConfig, setGlobalProxy, setAccountProxy, removeProxy, getEffectiveProxy } from './proxy-config.js';
import { MODELS, MODEL_TIER_ACCESS as _TIER_TABLE, getTierModels as _getTierModels } from '../models.js';
import { windsurfLogin, refreshFirebaseToken, reRegisterWithCodeium } from './windsurf-login.js';
import { getModelAccessConfig, setModelAccessMode, setModelAccessList, addModelToList, removeModelFromList } from './model-access.js';
import { checkMessageRateLimit } from '../windsurf-api.js';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
  });
  res.end(data);
}

function checkAuth(req) {
  const pw = req.headers['x-dashboard-password'] || '';
  // If dashboard password is set, use it
  if (config.dashboardPassword) return pw === config.dashboardPassword;
  // Otherwise fall back to API key (if set)
  if (config.apiKey) return pw === config.apiKey;
  // No password and no API key = open access
  return true;
}

/**
 * Handle all /dashboard/api/* requests.
 */
export async function handleDashboardApi(method, subpath, body, req, res) {
  if (method === 'OPTIONS') return json(res, 204, '');

  // Auth check (except for auth verification endpoint)
  if (subpath !== '/auth' && !checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized. Set X-Dashboard-Password header.' });
  }

  // ─── Auth ─────────────────────────────────────────────
  if (subpath === '/auth') {
    const needsAuth = !!(config.dashboardPassword || config.apiKey);
    if (!needsAuth) return json(res, 200, { required: false });
    return json(res, 200, { required: true, valid: checkAuth(req) });
  }

  // ─── Overview ─────────────────────────────────────────
  if (subpath === '/overview' && method === 'GET') {
    const stats = getStats();
    return json(res, 200, {
      uptime: process.uptime(),
      startedAt: stats.startedAt,
      accounts: getAccountCount(),
      authenticated: isAuthenticated(),
      langServer: getLsStatus(),
      totalRequests: stats.totalRequests,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      successRate: stats.totalRequests > 0
        ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1)
        : '0.0',
      cache: cacheStats(),
    });
  }

  // ─── Experimental features ────────────────────────────
  if (subpath === '/experimental' && method === 'GET') {
    return json(res, 200, { flags: getExperimental(), conversationPool: convPoolStats() });
  }
  if (subpath === '/experimental' && method === 'PUT') {
    const flags = setExperimental(body || {});
    // Dropping the toggle should also drop any live entries so nothing
    // resumes against a disabled feature on the next request.
    if (!flags.cascadeConversationReuse) convPoolClear();
    return json(res, 200, { success: true, flags });
  }
  if (subpath === '/experimental/conversation-pool' && method === 'DELETE') {
    const n = convPoolClear();
    return json(res, 200, { success: true, cleared: n });
  }

  // ─── Cache ────────────────────────────────────────────
  if (subpath === '/cache' && method === 'GET') {
    return json(res, 200, cacheStats());
  }
  if (subpath === '/cache' && method === 'DELETE') {
    cacheClear();
    return json(res, 200, { success: true });
  }

  // ─── Accounts ─────────────────────────────────────────
  if (subpath === '/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  if (subpath === '/accounts' && method === 'POST') {
    try {
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else {
        return json(res, 400, { error: 'Provide api_key or token' });
      }
      // Fire-and-forget probe so the UI gets tier info shortly after add
      probeAccount(account.id).catch(e => log.warn(`Auto-probe failed: ${e.message}`));
      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /accounts/probe-all — probe every active account
  if (subpath === '/accounts/probe-all' && method === 'POST') {
    const list = getAccountList().filter(a => a.status === 'active');
    const results = [];
    for (const a of list) {
      try {
        const r = await probeAccount(a.id);
        results.push({ id: a.id, email: a.email, tier: r?.tier || 'unknown' });
      } catch (err) {
        results.push({ id: a.id, email: a.email, error: err.message });
      }
    }
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/probe — manually trigger capability probe
  const accountProbe = subpath.match(/^\/accounts\/([^/]+)\/probe$/);
  if (accountProbe && method === 'POST') {
    try {
      const result = await probeAccount(accountProbe[1]);
      if (!result) return json(res, 404, { error: 'Account not found' });
      return json(res, 200, { success: true, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /accounts/refresh-credits — refresh every active account's balance
  if (subpath === '/accounts/refresh-credits' && method === 'POST') {
    const results = await refreshAllCredits();
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/refresh-credits — single-account refresh
  const creditRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-credits$/);
  if (creditRefresh && method === 'POST') {
    const r = await refreshCredits(creditRefresh[1]);
    return json(res, r.ok ? 200 : 400, r);
  }

  // PATCH /accounts/:id
  const accountPatch = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountPatch && method === 'PATCH') {
    const id = accountPatch[1];
    if (body.status) setAccountStatus(id, body.status);
    if (body.label) updateAccountLabel(id, body.label);
    if (body.resetErrors) resetAccountErrors(id);
    if (Array.isArray(body.blockedModels)) setAccountBlockedModels(id, body.blockedModels);
    return json(res, 200, { success: true });
  }

  // GET /tier-access — hardcoded FREE/PRO model entitlement tables.
  // The dashboard uses this to render the full per-account model grid
  // (every row in the tier's list is shown, blocked models are dimmed).
  if (subpath === '/tier-access' && method === 'GET') {
    return json(res, 200, {
      free: _TIER_TABLE.free,
      pro: _TIER_TABLE.pro,
      unknown: _TIER_TABLE.unknown,
      expired: _TIER_TABLE.expired,
      allModels: Object.keys(MODELS),
    });
  }

  // DELETE /accounts/:id
  const accountDel = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountDel && method === 'DELETE') {
    const ok = removeAccount(accountDel[1]);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  // ─── Stats ────────────────────────────────────────────
  if (subpath === '/stats' && method === 'GET') {
    return json(res, 200, getStats());
  }

  if (subpath === '/stats' && method === 'DELETE') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // ─── Usage (CLIProxyAPI-compatible schema) ───────────
  // GET /usage — aggregated snapshot
  if (subpath === '/usage' && method === 'GET') {
    const snap = getUsageSnapshot();
    return json(res, 200, { usage: snap, failed_requests: snap.failure_count });
  }

  // GET /usage/export — downloadable backup blob (version + exported_at + usage)
  if (subpath === '/usage/export' && method === 'GET') {
    const payload = exportUsage();
    const filename = `windsurfapi-usage-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // POST /usage/import — merge a snapshot with dedup; body is the full
  // { version, exported_at, usage } envelope OR a bare snapshot object.
  if (subpath === '/usage/import' && method === 'POST') {
    const result = importUsage(body);
    log.info(`Usage import: added=${result.added} skipped=${result.skipped} total=${result.total_requests}`);
    return json(res, 200, result);
  }

  // POST /usage/reset — alias of DELETE /stats for parity with CLIProxyAPI
  if (subpath === '/usage/reset' && method === 'POST') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // DELETE /usage/details?days=30 — drop per-request details older than N days
  if (subpath === '/usage/details' && method === 'DELETE') {
    const url = new URL(req.url, 'http://localhost');
    const days = Math.max(1, parseInt(url.searchParams.get('days') || '30', 10));
    const r = pruneDetails(days * 24 * 3600 * 1000);
    return json(res, 200, { success: true, removed: r.removed, olderThanDays: days });
  }

  // DELETE /usage/days?days=90 — drop day aggregate buckets older than N days
  if (subpath === '/usage/days' && method === 'DELETE') {
    const url = new URL(req.url, 'http://localhost');
    const days = Math.max(1, parseInt(url.searchParams.get('days') || '90', 10));
    const r = pruneDays(days * 24 * 3600 * 1000);
    return json(res, 200, { success: true, removed: r.removed, olderThanDays: days });
  }

  // ─── Logs ─────────────────────────────────────────────
  if (subpath === '/logs' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const level = url.searchParams.get('level') || null;
    return json(res, 200, { logs: getLogs(since, level) });
  }

  if (subpath === '/logs/stream' && method === 'GET') {
    req.socket.setKeepAlive(true);
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Send existing logs first
    const existing = getLogs();
    for (const entry of existing.slice(-50)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    const cb = (entry) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    subscribeToLogs(cb);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeFromLogs(cb);
    });
    return;
  }

  // ─── Proxy ────────────────────────────────────────────
  if (subpath === '/proxy' && method === 'GET') {
    return json(res, 200, getProxyConfig());
  }

  if (subpath === '/proxy/global' && method === 'PUT') {
    setGlobalProxy(body);
    return json(res, 200, { success: true, config: getProxyConfig() });
  }

  if (subpath === '/proxy/global' && method === 'DELETE') {
    removeProxy('global');
    return json(res, 200, { success: true });
  }

  const proxyAccount = subpath.match(/^\/proxy\/accounts\/([^/]+)$/);
  if (proxyAccount && method === 'PUT') {
    setAccountProxy(proxyAccount[1], body);
    // Spawn (or adopt) the LS instance for this proxy so chat routes immediately
    ensureLsForAccount(proxyAccount[1]).catch(e => log.warn(`LS ensure failed: ${e.message}`));
    return json(res, 200, { success: true });
  }
  if (proxyAccount && method === 'DELETE') {
    removeProxy('account', proxyAccount[1]);
    return json(res, 200, { success: true });
  }

  // ─── Config ───────────────────────────────────────────
  if (subpath === '/config' && method === 'GET') {
    return json(res, 200, {
      port: config.port,
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      logLevel: config.logLevel,
      lsBinaryPath: config.lsBinaryPath,
      lsPort: config.lsPort,
      codeiumApiUrl: config.codeiumApiUrl,
      hasApiKey: !!config.apiKey,
      hasDashboardPassword: !!config.dashboardPassword,
    });
  }

  // ─── Language Server ──────────────────────────────────
  if (subpath === '/langserver/restart' && method === 'POST') {
    if (!body.confirm) {
      return json(res, 400, { error: 'Send { confirm: true } to restart language server' });
    }
    stopLanguageServer();
    setTimeout(async () => {
      await startLanguageServer({
        binaryPath: config.lsBinaryPath,
        port: config.lsPort,
        apiServerUrl: config.codeiumApiUrl,
      });
    }, 2000);
    return json(res, 200, { success: true, message: 'Restarting language server...' });
  }

  // ─── Models list ──────────────────────────────────────
  if (subpath === '/models' && method === 'GET') {
    const models = Object.entries(MODELS).map(([id, info]) => ({
      id, name: info.name, provider: info.provider,
    }));
    return json(res, 200, { models });
  }

  // ─── Manual cloud model-catalog refresh ───────────────
  // Re-fetches GetCascadeModelConfigs via the first active account and merges
  // any new modelUids into the local catalog. Idempotent; safe to spam.
  if (subpath === '/models/refresh-catalog' && method === 'POST') {
    try {
      const sizeBefore = Object.keys(MODELS).length;
      await fetchAndMergeModelCatalog();
      const sizeAfter = Object.keys(MODELS).length;
      return json(res, 200, { success: true, before: sizeBefore, after: sizeAfter, added: sizeAfter - sizeBefore });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ─── Model Access Control ──────────────────────────────
  if (subpath === '/model-access' && method === 'GET') {
    return json(res, 200, getModelAccessConfig());
  }

  if (subpath === '/model-access' && method === 'PUT') {
    if (body.mode) setModelAccessMode(body.mode);
    if (body.list) setModelAccessList(body.list);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/add' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    addModelToList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/remove' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    removeModelFromList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  // ─── Windsurf Login ────────────────────────────────────
  if (subpath === '/windsurf-login' && method === 'POST') {
    try {
      const { email, password, proxy: loginProxy, autoAdd } = body;
      if (!email || !password) return json(res, 400, { error: 'email 和 password 為必填' });

      // Use provided proxy, or global proxy
      const proxy = loginProxy?.host ? loginProxy : getProxyConfig().global;

      const result = await windsurfLogin(email, password, proxy);

      // Auto-add to account pool if requested
      let account = null;
      if (autoAdd !== false) {
        account = addAccountByKey(result.apiKey, result.name || email);
        // Store refresh token for later token refresh
        if (result.refreshToken) {
          account.refreshToken = result.refreshToken;
        }
        // Persist the per-account proxy we used for login so chat requests
        // also egress through the same IP, then warm up a matching LS.
        if (loginProxy?.host) setAccountProxy(account.id, loginProxy);
        ensureLsForAccount(account.id)
          .then(() => probeAccount(account.id))
          .catch(e => log.warn(`Auto-probe failed: ${e.message}`));
      }

      return json(res, 200, {
        success: true,
        apiKey: result.apiKey,
        name: result.name,
        email: result.email,
        apiServerUrl: result.apiServerUrl,
        account: account ? { id: account.id, email: account.email, status: account.status } : null,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── Rate Limit Check ──────────────────────────────────
  // POST /accounts/:id/rate-limit — check capacity for a single account
  const rateLimitCheck = subpath.match(/^\/accounts\/([^/]+)\/rate-limit$/);
  if (rateLimitCheck && method === 'POST') {
    const list = getAccountList();
    const acct = list.find(a => a.id === rateLimitCheck[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const result = await checkMessageRateLimit(acct.apiKey, proxy);
      return json(res, 200, { success: true, account: acct.email, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ─── Firebase Token Refresh ───────────────────────────────
  // POST /accounts/:id/refresh-token — manually refresh Firebase token
  const tokenRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-token$/);
  if (tokenRefresh && method === 'POST') {
    const list = getAccountList();
    const acct = list.find(a => a.id === tokenRefresh[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    if (!acct.refreshToken) return json(res, 400, { error: 'Account has no refresh token' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(acct.refreshToken, proxy);
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      const keyChanged = apiKey && apiKey !== acct.apiKey;
      // Update is handled by the auth module's internal reference
      return json(res, 200, { success: true, keyChanged, email: acct.email });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  json(res, 404, { error: `Dashboard API: ${method} ${subpath} not found` });
}
