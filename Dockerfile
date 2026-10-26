# Base image is pinned to an exact patch release so rebuilds never reuse a stale
# cached node:22-alpine. Bump this on each Node.js security release.
ARG NODE_IMAGE=node:22.23.4-alpine

# ── dev stage ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
# src/ and config.json are bind-mounted at runtime via docker-compose.override.yml
CMD ["npm", "run", "dev"]

# ── builder stage ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── production stage ──────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV CONFIG_PATH=/app/config.json
EXPOSE 8080
CMD ["node", "--import", "./dist/telemetry/instrumentation.js", "dist/index.js"]
