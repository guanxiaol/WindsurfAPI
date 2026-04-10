/**
 * WindsurfClient — talks to the local language server binary via gRPC (HTTP/2).
 *
 * Two flows:
 *   Legacy  → RawGetChatMessage (streaming, for enum-only models)
 *   Cascade → StartCascade → SendUserCascadeMessage → poll (for modelUid models)
 */

import https from 'https';
import { randomUUID } from 'crypto';
import { log } from './config.js';
import { grpcFrame, grpcUnary, grpcStream } from './grpc.js';
import { getLsEntryByPort } from './langserver.js';
import {
  buildRawGetChatMessageRequest, parseRawResponse,
  buildInitializePanelStateRequest,
  buildAddTrackedWorkspaceRequest,
  buildUpdateWorkspaceTrustRequest,
  buildStartCascadeRequest, parseStartCascadeResponse,
  buildSendCascadeMessageRequest,
  buildGetTrajectoryRequest, parseTrajectoryStatus,
  buildGetTrajectoryStepsRequest, parseTrajectorySteps,
} from './windsurf.js';

const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// ─── WindsurfClient ────────────────────────────────────────

export class WindsurfClient {
  /**
   * @param {string} apiKey - Codeium API key
   * @param {number} port - Language server gRPC port
   * @param {string} csrfToken - CSRF token for auth
   */
  constructor(apiKey, port, csrfToken) {
    this.apiKey = apiKey;
    this.port = port;
    this.csrfToken = csrfToken;
  }

  // ─── Legacy: RawGetChatMessage (streaming) ───────────────

  /**
   * Stream chat via RawGetChatMessage.
   * Used for models without a string UID (enum < 280 generally).
   *
   * @param {Array} messages - OpenAI-format messages
   * @param {number} modelEnum - Model enum value
   * @param {string} [modelName] - Optional model name
   * @param {object} opts - { onChunk, onEnd, onError }
   */
  rawGetChatMessage(messages, modelEnum, modelName, opts = {}) {
    const { onChunk, onEnd, onError } = opts;
    const proto = buildRawGetChatMessageRequest(this.apiKey, messages, modelEnum, modelName);
    const body = grpcFrame(proto);

    log.debug(`RawGetChatMessage: enum=${modelEnum} msgs=${messages.length}`);

    return new Promise((resolve, reject) => {
      const chunks = [];

      grpcStream(this.port, this.csrfToken, `${LS_SERVICE}/RawGetChatMessage`, body, {
        onData: (payload) => {
          try {
            const parsed = parseRawResponse(payload);
            if (parsed.text) {
              // Detect server-side errors returned as text
              const errMatch = /^(permission_denied|failed_precondition|not_found|unauthenticated):/.test(parsed.text.trim());
              if (parsed.isError || errMatch) {
                const err = new Error(parsed.text.trim());
                // Mark model-level errors so they don't count against the account
                err.isModelError = /permission_denied|failed_precondition/.test(parsed.text);
                reject(err);
                return;
              }
              chunks.push(parsed);
              onChunk?.(parsed);
            }
          } catch (e) {
            log.error('RawGetChatMessage parse error:', e.message);
          }
        },
        onEnd: () => {
          onEnd?.(chunks);
          resolve(chunks);
        },
        onError: (err) => {
          onError?.(err);
          reject(err);
        },
      });
    });
  }

  /**
   * Run (or wait for) the one-shot Cascade workspace init for this LS.
   * Idempotent — the LS entry caches the in-flight Promise so concurrent
   * callers share one init round. Safe to call from a startup warmup path
   * so the first real chat request skips these 3 gRPC round-trips.
   */
  warmupCascade() {
    const lsEntry = getLsEntryByPort(this.port);
    if (!lsEntry) return Promise.resolve();
    if (!lsEntry.sessionId) lsEntry.sessionId = randomUUID();
    if (lsEntry.workspaceInit) return lsEntry.workspaceInit;

    const sessionId = lsEntry.sessionId;
    const workspacePath = '/tmp/windsurf-workspace';
    const workspaceUri = 'file:///tmp/windsurf-workspace';

    lsEntry.workspaceInit = (async () => {
      try {
        const initProto = buildInitializePanelStateRequest(this.apiKey, sessionId);
        await grpcUnary(this.port, this.csrfToken,
          `${LS_SERVICE}/InitializeCascadePanelState`, grpcFrame(initProto), 5000);
      } catch (e) { log.warn(`InitializeCascadePanelState: ${e.message}`); }
      try {
        const addWsProto = buildAddTrackedWorkspaceRequest(this.apiKey, workspacePath, sessionId);
        await grpcUnary(this.port, this.csrfToken,
          `${LS_SERVICE}/AddTrackedWorkspace`, grpcFrame(addWsProto), 5000);
      } catch (e) { log.warn(`AddTrackedWorkspace: ${e.message}`); }
      try {
        const trustProto = buildUpdateWorkspaceTrustRequest(this.apiKey, workspaceUri, true, sessionId);
        await grpcUnary(this.port, this.csrfToken,
          `${LS_SERVICE}/UpdateWorkspaceTrust`, grpcFrame(trustProto), 5000);
      } catch (e) { log.warn(`UpdateWorkspaceTrust: ${e.message}`); }
      log.info(`Cascade workspace init complete for LS port=${this.port}`);
    })().catch(e => {
      lsEntry.workspaceInit = null;
      throw e;
    });
    return lsEntry.workspaceInit;
  }

  // ─── Cascade flow ────────────────────────────────────────

  /**
   * Chat via Cascade flow (for premium models with string UIDs).
   *
   * 1. StartCascade → cascade_id
   * 2. SendUserCascadeMessage (with model config)
   * 3. Poll GetCascadeTrajectorySteps until IDLE
   *
   * @param {Array} messages
   * @param {number} modelEnum
   * @param {string} modelUid
   * @param {object} opts - { onChunk, onEnd, onError }
   */
  async cascadeChat(messages, modelEnum, modelUid, opts = {}) {
    const { onChunk, onEnd, onError, signal, reuseEntry } = opts;
    const aborted = () => signal?.aborted;

    log.debug(`CascadeChat: uid=${modelUid} enum=${modelEnum} msgs=${messages.length} reuse=${!!reuseEntry}`);

    // One-shot per-LS workspace init (idempotent; typically pre-warmed at
    // LS startup). Falls back to a local session id if the LS entry is gone.
    const lsEntry = getLsEntryByPort(this.port);
    await this.warmupCascade().catch(() => {});
    const sessionId = reuseEntry?.sessionId || lsEntry?.sessionId || randomUUID();

    try {
      // Step 1: Start cascade — unless the caller handed us a live cascadeId
      // from the conversation pool, in which case we skip StartCascade and
      // just SendUserCascadeMessage onto the existing cascade so the backend
      // keeps its per-cascade context hot.
      let cascadeId;
      if (reuseEntry?.cascadeId) {
        cascadeId = reuseEntry.cascadeId;
        log.debug(`Cascade resumed: ${cascadeId}`);
      } else {
        const startProto = buildStartCascadeRequest(this.apiKey, sessionId);
        const startResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/StartCascade`, grpcFrame(startProto)
        );
        cascadeId = parseStartCascadeResponse(startResp);
        if (!cascadeId) throw new Error('StartCascade returned empty cascade_id');
        log.debug(`Cascade started: ${cascadeId}`);
      }

      // Build the text payload. Two cases:
      //   - Resuming an existing cascade: the backend already has the prior
      //     turns cached, so we only send the newest user message.
      //   - Fresh cascade: we have to pack the entire history into one shot
      //     (Cascade doesn't accept a messages array). System blocks go on
      //     top, then we render u/a turns as a labeled transcript so the
      //     model can see its own prior replies — previously we dropped
      //     assistant turns entirely and multi-turn context was broken.
      let text;
      if (reuseEntry?.cascadeId) {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        text = lastUser ? contentToString(lastUser.content) : '';
      } else {
        const systemMsgs = messages.filter(m => m.role === 'system');
        const convo = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const sysText = systemMsgs.map(m => contentToString(m.content)).join('\n').trim();

        if (convo.length <= 1) {
          const last = convo[convo.length - 1];
          text = last ? contentToString(last.content) : '';
        } else {
          const lines = [];
          for (let i = 0; i < convo.length - 1; i++) {
            const m = convo[i];
            const label = m.role === 'user' ? 'User' : 'Assistant';
            lines.push(`${label}: ${contentToString(m.content)}`);
          }
          const latest = convo[convo.length - 1];
          const latestText = latest ? contentToString(latest.content) : '';
          text = `[Conversation so far]\n${lines.join('\n\n')}\n\n[Current user message]\n${latestText}`;
        }
        if (sysText) text = sysText + '\n\n' + text;
      }

      // Step 2: Send message
      const sendProto = buildSendCascadeMessageRequest(this.apiKey, cascadeId, text, modelEnum, modelUid, sessionId);
      await grpcUnary(
        this.port, this.csrfToken, `${LS_SERVICE}/SendUserCascadeMessage`, grpcFrame(sendProto)
      );

      // Step 3: Poll for response
      const chunks = [];
      let lastYielded = '';
      let idleCount = 0;
      const maxWait = 120_000;
      const pollInterval = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        if (aborted()) { log.debug('Cascade polling aborted by client'); break; }
        await new Promise(r => setTimeout(r, pollInterval));
        if (aborted()) { log.debug('Cascade polling aborted by client'); break; }

        // Get steps
        const stepsProto = buildGetTrajectoryStepsRequest(cascadeId, 0);
        const stepsResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto)
        );
        const steps = parseTrajectorySteps(stepsResp);

        // CORTEX_STEP_TYPE_ERROR_MESSAGE = 17. An error step means the cascade
        // refused the request (permission denied, model unavailable, etc.) —
        // raise it as a model-level error so the account isn't blamed.
        for (const step of steps) {
          if (step.type === 17 && step.errorText) {
            const err = new Error(step.errorText.trim());
            err.isModelError = true;
            throw err;
          }
        }

        for (const step of steps) {
          if (step.text && step.text.length > lastYielded.length) {
            const delta = step.text.slice(lastYielded.length);
            lastYielded = step.text;
            const chunk = { text: delta, thinking: '', isError: false };
            if (step.thinking) chunk.thinking = step.thinking;
            chunks.push(chunk);
            onChunk?.(chunk);
          }
        }

        // Check status
        const statusProto = buildGetTrajectoryRequest(cascadeId);
        const statusResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectory`, grpcFrame(statusProto)
        );
        const status = parseTrajectoryStatus(statusResp);

        if (status === 1) { // IDLE
          idleCount++;
          if (idleCount >= 2) {
            // Final sweep
            const finalResp = await grpcUnary(
              this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto)
            );
            const finalSteps = parseTrajectorySteps(finalResp);
            for (const step of finalSteps) {
              if (step.text && step.text.length > lastYielded.length) {
                const delta = step.text.slice(lastYielded.length);
                lastYielded = step.text;
                chunks.push({ text: delta, thinking: '', isError: false });
                onChunk?.({ text: delta, thinking: '', isError: false });
              }
            }
            break;
          }
        } else {
          idleCount = 0;
        }
      }

      onEnd?.(chunks);
      // Attach cascade metadata so the caller can check it back into the
      // conversation pool. We still return the array so existing callers
      // that iterate over it keep working.
      chunks.cascadeId = cascadeId;
      chunks.sessionId = sessionId;
      return chunks;

    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  // ─── Register user (JSON REST, unchanged) ────────────────

  async registerUser(firebaseToken) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ firebase_id_token: firebaseToken });
      const req = https.request({
        hostname: 'api.codeium.com',
        port: 443,
        path: '/register_user/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(`RegisterUser failed (${res.statusCode}): ${raw}`));
              return;
            }
            if (!json.api_key) {
              reject(new Error(`RegisterUser response missing api_key: ${raw}`));
              return;
            }
            resolve({ apiKey: json.api_key, name: json.name, apiServerUrl: json.api_server_url });
          } catch {
            reject(new Error(`RegisterUser parse error: ${raw}`));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}
