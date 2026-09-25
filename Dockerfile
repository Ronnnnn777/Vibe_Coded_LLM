# syntax=docker/dockerfile:1
#
# Aaron AI Chat — production image
#
# Multi-stage so the runtime layer carries no lockfile, no dev tooling and
# no build cache. There is no frontend build step (vanilla JS served as-is),
# so "build" here means "resolve production dependencies".
#
#   docker build -t aaron-ai-chat .
#   docker run --rm -p 3000:3000 --env-file .env aaron-ai-chat

# ── Stage 1: production dependencies ──────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy manifests only — this layer is cached until dependencies change.
COPY package.json package-lock.json .npmrc ./

# --omit=dev is requested HERE rather than in .npmrc, so CI keeps its lint
# and test tooling while the runtime image stays lean.
# --ignore-scripts blocks third-party postinstall hooks during the build.
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

# Drop root. The `node` user ships with the base image.
USER node

EXPOSE 3000

# LIVENESS, deliberately — /api/health is always 200 while the process is up.
# Not /api/ready: readiness is 503 without credentials, which would mark a
# running-but-unconfigured container unhealthy and make the platform restart
# it in a loop instead of letting you read the logs. Point the PLATFORM's
# deploy gate at /api/ready (see README → Health vs readiness).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node runs as PID 1 and registers its own SIGTERM/SIGINT handlers
# (see shutdown() in server.js), which exit within SHUTDOWN_TIMEOUT_MS even
# with SSE streams still open — so no tini/dumb-init shim is required.
CMD ["node", "server.js"]
