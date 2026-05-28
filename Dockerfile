# ── dev stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
# src/ and config.json are bind-mounted at runtime via docker-compose.override.yml
CMD ["npm", "run", "dev"]

# ── builder stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── production stage ──────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV CONFIG_PATH=/app/config.json
EXPOSE 8080
CMD ["node", "--import", "./dist/telemetry/instrumentation.js", "dist/index.js"]
