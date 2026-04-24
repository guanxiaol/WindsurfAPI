![1777011035104](image/CHANGELOG/1777011035104.png)![1777011056904](image/CHANGELOG/1777011056904.png)![1777011067074](image/CHANGELOG/1777011067074.png)![1777011067984](image/CHANGELOG/1777011067984.png)![1777011068191](image/CHANGELOG/1777011068191.png)![1777011068374](image/CHANGELOG/1777011068374.png)![1777011068574](image/CHANGELOG/1777011068574.png)![1777011068692](image/CHANGELOG/1777011068692.png)# Changelog

## v2.0.4 (2026-04-23)

### Security & Stability

- **Identity neutralization** — Rewrite "You are X" → "The assistant is X" in Cascade system prompts to prevent Claude 4.7 prompt-injection detection (#41)
- **Prototype pollution defense** — `deepMerge` in runtime-config skips `__proto__` / `constructor` / `prototype` keys
- **Path sanitize hardening** — Dynamic repo-root detection with length guard; sandbox workspace paths redacted; `sanitizeToolCall` covers `input` object (#38)

### New Features

- **Language-following hints** (`handlers/chat.js`) — Auto-detect CJK/JP/KR in user messages and inject a language reminder so the model responds in the user's language. Detection order: JP (kana) → KR (hangul) → CJK to avoid false Chinese detection on Japanese text.
- **Identity prompt management** (`runtime-config.js`, `dashboard/api.js`) — Per-provider identity prompt templates with dashboard CRUD via `GET/PUT/DELETE /dashboard/api/identity-prompts`. 10 providers supported (Anthropic, OpenAI, Google, DeepSeek, xAI, Alibaba, Moonshot, Zhipu, MiniMax, Windsurf).
- **Cascade history budget** (`client.js`) — Byte budget now includes system prompt length; 1M-context models get 900KB budget (env `CASCADE_1M_HISTORY_BYTES`). History rendered with `<human>`/`<assistant>` XML tags.
- **Workspace scaffold** (`client.js`) — Per-account workspace directories with `package.json`, `.gitignore`, and `git init` for realistic Cascade context.

### Performance

- **HTTP/2 session pool** (`grpc.js`) — Reuses HTTP/2 connections per LS port instead of per-call. GOAWAY handler for proactive eviction. `user-agent: grpc-node/1.108.2` header added to unary calls.
- **Conversation pool upgrade** (`conversation-pool.js`) — `stripMetaTags` removes dynamic Claude Code meta tags before fingerprinting; stable turns (user + tool only) for fingerprint; 30min TTL (env `CASCADE_POOL_TTL_MS`); background prune interval. Enabled by default.

### Bug Fixes

- **Warm stall timing** (`client.js`) — Moved after status fetch so it uses current-poll status, preventing false warm-stall when cascade just went IDLE.
- **Cold stall threshold** (`client.js`) — Uses final assembled prompt length instead of raw message chars.
- **Idle break guard** (`client.js`) — `growthSettled` condition prevents premature termination during thinking phases.
- **Double-settle guards** (`grpc.js`, `client.js`) — `done` flag in Raw and gRPC callbacks prevents promise double-resolve.
- **Session cleanup** (`langserver.js`) — `closeSessionForPort` called on LS restart/stop to prevent HTTP/2 session pool leaks.
- **Per-LS sessionId** (`client.js`, `windsurf.js`) — Legacy Raw path reuses stable per-LS session ID matching real Windsurf IDE behavior.

---

## v2.0.3 (2026-04-22)

### New Features

- **Image upload support** (`src/image.js`, `client.js`, `windsurf.js`)
  Multimodal requests with `image_url` content blocks are now supported. Images are extracted from OpenAI and Anthropic format content arrays, validated (SSRF protection, 5MB size limit, redirect depth limit), and passed as proto field 6 to Cascade. Vision pipeline is automatically enabled via DEFAULT planner mode when images are present.

- **80+ model name aliases** (`models.js`)
  - Anthropic official dated names (`claude-3-5-sonnet-20241022`, `claude-sonnet-4-20250514`, etc.)
  - OpenAI official dated names (`gpt-4o-2024-11-20`, `gpt-4.1-2025-04-14`, etc.)
  - Cursor-friendly aliases without "claude" keyword (`ws-opus`, `sonnet-4.6`, `opus-4.7-max`, etc.)
  - Clients like Claude Code, Cursor, and Anthropic SDK can now talk to this API without custom name translation.

- **New models**: `gpt-5.4-none`, `gpt-5.4-high`
- **`getModelKeysByEnum()`** reverse lookup function for model enum → catalog key resolution

### Bug Fixes

- **Dynamic `maxAttempts`** (`handlers/chat.js`)
  Retry count now scales with active account pool size (min 3, max 10) instead of a hardcoded 3. Fixes issue where healthy accounts in large pools were never reached because the first 3 accounts were all rate-limited.

- **`kimi-k2` enumValue** corrected from 0 → 323 (enables legacy RawGetChatMessage fallback)
- **Removed broken `qwen-3-coder`** — cascade server has no routing registered for it; requests would always fail with 'model not found'
- **`MODEL_TIER_ACCESS.pro`** changed to dynamic getter so models merged from cloud catalog are automatically included in Pro tier entitlements

### Server Improvements

- **`/favicon.ico` → 204** — silences browser console noise when accessing dashboard
- **Empty messages validation** — both `/v1/chat/completions` and `/v1/messages` now return proper 400 errors for empty message arrays instead of passing them to handlers

---

## v2.0.2 (2026-04-21)

### Bug Fixes — CC / SSE Streaming

Fixes the "Claude Code feels stuck / some content not showing" issue reported on thinking-heavy models.

- **Immediate `message_start` + `ping` on stream entry** (`handlers/messages.js`)
  Anthropic SSE now emits the initial message envelope and a ping *before* awaiting upstream's first token. CC's UI exits the "connecting" state within milliseconds instead of sitting silent for the full LS cold-start + Windsurf first-token window (previously 8-15s on Opus thinking models).
- **`thinking` content block `signature` field** (`handlers/messages.js`)
  `content_block_start` for thinking blocks now includes `signature: ''`. Some CC builds silently dropped thinking blocks without this field.
- **Heartbeat 15s → 5s** (`handlers/chat.js`)
  Keeps CC's idle-watchdog happy through long reasoning pauses. Negligible network cost (SSE comment, ~6 bytes).
- **Initial `:ping` on `/v1/chat/completions`** (`handlers/chat.js`)
  OpenAI-protocol clients also benefit from immediate byte-flow instead of silent warmup.
- **TCP NoDelay + flushHeaders + keepalive** (`server.js`)
  Disables Nagle on streaming endpoints so rapid small deltas aren't coalesced into 40ms batches. `flushHeaders()` pushes response headers to the client immediately after `writeHead`.

### Verification

Measured time-to-first-byte on `/v1/messages`: **4ms** (previously seconds on cold LS).

---

## v2.0.1 (2026-04-21)

### Features from upstream dwgx/WindsurfAPI integration

- Dynamic cold-stall threshold (30s–90s based on input length)
- OAuth login endpoint (`POST /oauth-login`) for Google/GitHub Firebase auth
- Token persistence via `setAccountTokens` — refresh + id tokens survive restarts
- Firebase manual token refresh persists fresh credentials to disk

### Rebranding

- Project renamed to **WindsurfPoolAPI**
- Professional bilingual README (EN/CN) with dashboard screenshots
- GitHub repository renamed + updated topics

---

## v2.0.0 (2026-04-20)

### New Features

- **Batch Account Operations** — Select multiple accounts and enable/disable them in one action via the dashboard. All changes persist to `accounts.json` immediately.
- **Per-Account Quota Display** — Dashboard now shows separate daily/weekly/prompt quota bars per account with color-coded progress indicators and reset-time tooltips.
- **Statistics Account Label** — Request detail table now displays account email instead of opaque API key prefix.
- **Persistent Error States** — Account error/recovery state changes (`reportError`/`reportSuccess`) are now written to disk, surviving restarts.
- **macOS LaunchAgent** — Example plist for auto-start on boot with crash recovery.

### Improvements

- **Model Catalog** — Added Claude Opus 4.7 effort-tiered family, GPT-5.4, Gemini 3.1 Pro, GLM-5.1, Kimi K2.5, MiniMax M2.5, and many more models (87+ total).
- **Trial Tier Support** — Trial accounts are now correctly recognized as pro-tier, granting access to all models.
- **Batch Status API** — New `POST /accounts/batch-status` endpoint accepts `{ids[], status}` for bulk operations.
- **Dashboard UX** — Checkbox column with select-all/invert/clear, batch action bar with confirmation dialogs.

### Bug Fixes

- Fixed `reportError` and `reportSuccess` not persisting status changes to disk.
- Fixed stats detail showing raw API key prefix instead of human-readable account name.

---

## v1.2.0 (2026-04-19)

- Initial public release.
- Multi-account pool with RPM-based load balancing.
- OpenAI + Anthropic dual-protocol proxy.
- Dashboard SPA with account management, real-time logs, usage charts.
- Tool call emulation for Cascade flow.
- Streaming SSE with heartbeat and usage chunks.
- Zero npm dependencies.
