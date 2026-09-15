# syntax=docker/dockerfile:1

# ---------- build ----------------------------------------------------------
# Compiles the server (tsc) and the web client (vite). better-sqlite3 is a
# native module: on x64/arm64 glibc it downloads a prebuilt binary, and the
# build tools below are only a fallback for a platform without one.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install first so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY schema.sql ./
COPY server/ server/
COPY web/ web/
RUN npm run build \
 && node server/scripts/check-sqlite.mjs \
 && npm prune --omit=dev

# ---------- runtime --------------------------------------------------------
# The paths matter: server/dist walks up to find schema.sql and web/dist, so
# the image keeps the repository's shape.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    MTG_DATA_DIR=/data \
    MTG_PORT=8080 \
    MTG_HOST=0.0.0.0

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/schema.sql ./schema.sql
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# The CLI tools (sync, check-sqlite, repair-claims) import the TypeScript
# source directly, so it ships too — it is small.
COPY --from=build /app/server/scripts ./server/scripts
COPY --from=build /app/server/src ./server/src

# Database, card images and scheduled backups all live here. Owned by the
# unprivileged user so a fresh named volume inherits writable permissions.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.MTG_PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so the process is PID 1 and receives SIGTERM directly; the server
# installs its own handler and shuts the sync worker down cleanly.
CMD ["node", "server/dist/index.js"]
