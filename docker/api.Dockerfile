# syntax=docker/dockerfile:1
# One image, three jobs (same code, different command):
#   API:        node dist/index.js        (default)
#   worker:     node dist/worker.js
#   migrations: node dist/scripts/migrate.js
# Fixes case study S12: multi-stage, no dev dependencies, no .env, runs as a non-root user.

# ---- 1. Compile TypeScript ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build -w apps/api

# ---- 2. Production dependencies only ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# tRPC declares TypeScript as a peer dependency (it's all about types), but nothing loads it at runtime: drop ~23 MB.
RUN npm ci --omit=dev --workspace apps/api --no-audit --no-fund \
 && rm -rf node_modules/typescript \
 && mkdir -p apps/api/node_modules

# ---- 3. Small runtime image ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/migrations ./apps/api/migrations
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
