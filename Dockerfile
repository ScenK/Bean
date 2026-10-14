# Headless household Bean: the Discord bot server running scheduled routines, no desktop app.
# Setup checklist: docs/headless.md. Build from the repo root:
#   docker build -t bean-household .

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
# Only the discord server and what it depends on (@bean/core) — never the Electron app.
RUN pnpm install --frozen-lockfile --filter "@bean/discord..." \
 && pnpm --filter "@bean/discord..." run build

FROM node:24-bookworm-slim
# tini as PID 1 reaps the delegate CLIs' grandchildren and forwards SIGTERM to node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force \
 && mkdir -p /data && chown node:node /data

# server.js is self-contained (esbuild bundles @bean/core and discord.js); .bean holds the
# built-in skills/persona/clis.json that ~/.bean layers over.
COPY --from=build /src/packages/discord/dist /app/packages/discord/dist
COPY --from=build /src/.bean /app/.bean

# HOME is the volume: ~/.bean (config, bean.db, routines, runs/), the claude/codex logins and
# their MCP config all live there. PATH is fixed — the bot finds CLIs on PATH only, no
# login-shell probe. One scheduler per ~/.bean: never point the desktop app at this volume.
ENV HOME=/data \
    CODEX_HOME=/data/.codex \
    PATH=/usr/local/bin:/usr/bin:/bin \
    BEAN_BUILTIN_DIR=/app/.bean \
    BEAN_HEADLESS_ROUTINES=1 \
    NODE_ENV=production
USER node
WORKDIR /data
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/packages/discord/dist/server.js"]
