# Changelog

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
