# syntax=docker/dockerfile:1
#
# Dev / trial image — NOT the supported deployment.
#
# Citadel manages the host (tmux, CLI agents, systemd, git, tunnels, updater,
# doctor). This image exists so someone can build once and try the panel in a
# throwaway container without running install.sh or touching the host. It
# deliberately has no systemd, no host Docker socket and no privileges.
#
# Read docs/installation.md ("Try it without installing") before using it.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# node-pty and better-sqlite3 may compile from source; builder keeps the tools
# out of the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/copy-vendor.js ./scripts/copy-vendor.js
# --omit=dev keeps eslint/jsdom out; postinstall copies the xterm bundles into
# public/vendor, which is then carried to the runtime stage.
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# tmux makes persistent terminals work; git is needed for projects. Neither is
# installed system-wide on the host — they live only in this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/public/vendor ./public/vendor
COPY . .

# HOST must be 0.0.0.0 so the mapped port reaches the container. Expose it on
# the host loopback only (see compose.yaml) unless you intend LAN access.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    DATABASE_PATH=/data/citadel.db \
    PROJECTS_DIR=/data/projects \
    LOGS_DIR=/data/logs \
    CITADEL_MISSIONS_DIR=/data/missions \
    CITADEL_SELF_UPDATE=0

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

# /api/auth/status is unauthenticated and cheap; it answers as soon as the
# server is listening, before the first admin exists.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/auth/status').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
