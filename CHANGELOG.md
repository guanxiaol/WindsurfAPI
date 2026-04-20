# Changelog

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
