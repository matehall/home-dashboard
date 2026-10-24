# syntax=docker/dockerfile:1

# Klienten är ren JS – bygg på byggmaskinens arkitektur (snabbt, ingen QEMU)
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --no-fund --no-audit
COPY client/ ./
RUN npm run build

# Serverns beroenden byggs för målarkitekturen (sqlite3 är native)
FROM node:20-bookworm-slim AS server-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node
EXPOSE 3000
VOLUME /app/server/data
CMD ["node", "server/index.js"]
