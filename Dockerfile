# Zero-dependency Node 20 runtime. The project has no `npm install` step —
# everything lives in `node:*` builtins — so this image is effectively
# Node + source, nothing else.
FROM node:20-alpine

# Non-root user for the app
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy source. `.dockerignore` keeps runtime artefacts (accounts.json, .env,
# stats.json, data/, logs/) out even if they exist in the build context.
COPY --chown=app:app package.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app docs ./docs

# The Language Server binary is NOT bundled (closed-source Windsurf release);
# mount it at runtime. See docker-compose.yml for the bind-mount example.
ENV LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64
ENV PORT=3003
ENV LS_PORT=42100
ENV LOG_LEVEL=info

# Writable locations for runtime state
RUN mkdir -p /app/logs /tmp/windsurf-workspace \
    && chown -R app:app /app /tmp/windsurf-workspace

USER app

EXPOSE 3003

# Simple healthcheck — /health is served by the HTTP server even when the
# account pool is empty.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/health || exit 1

CMD ["node", "src/index.js"]
