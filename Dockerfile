# Headless Bean: bean-core (@bean/host) — the sprout scheduler and reminders, plus the Discord and
# Teams bots whose config files exist in the volume. Neither bot is required.
# Setup checklist: docs/headless.md. Build from the repo root:
#   docker build -t bean-household .

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
# bean-core and the two bot servers (and @bean/core under them) — never the Electron app.
RUN pnpm install --frozen-lockfile --filter "@bean/host..." --filter "@bean/discord..." --filter "@bean/teams..." \
 && pnpm --filter "@bean/host..." --filter "@bean/discord..." --filter "@bean/teams..." run build

FROM node:24-bookworm-slim
# tini as PID 1 reaps the delegate CLIs' grandchildren and forwards SIGTERM to node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force \
 && mkdir -p /data/.codex && chown -R node:node /data

# Each bundle is self-contained (esbuild bundles @bean/core and the SDKs). bean-core spawns the bots
# from packages/<bot>/dist beside its own; .bean holds the built-in skills/persona/clis.json that
# ~/.bean layers over.
COPY --from=build /src/packages/host/dist/bean-core.js /app/packages/host/dist/bean-core.js
COPY --from=build /src/packages/discord/dist /app/packages/discord/dist
COPY --from=build /src/packages/teams/dist /app/packages/teams/dist
COPY --from=build /src/.bean /app/.bean
# `bean-core` on PATH for a remote shell: `ssh <host> docker exec -i bean bean-core attach` (#809).
RUN chmod +x /app/packages/host/dist/bean-core.js \
 && ln -s /app/packages/host/dist/bean-core.js /usr/local/bin/bean-core

# HOME is the volume: ~/.bean (config, bean.db, routines, runs/), the claude/codex logins and
# their MCP config all live there. One scheduler per ~/.bean: never point the desktop app at this volume.
ENV HOME=/data \
    CODEX_HOME=/data/.codex \
    PATH=/usr/local/bin:/usr/bin:/bin \
    BEAN_BUILTIN_DIR=/app/.bean \
    NODE_ENV=production
USER node
WORKDIR /data
VOLUME /data
# The Teams bot's messaging endpoint (teams.json `port`, default 3978). Discord needs no inbound port.
EXPOSE 3978
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/packages/host/dist/bean-core.js"]
