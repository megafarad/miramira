# syntax=docker/dockerfile:1.7

# ─── Stage 1: install full deps (build needs devDependencies) ────────────────
# Uses `npm install` rather than `npm ci`: vitest 4 and drizzle-kit pin
# different esbuild peer ranges, which npm 10's `ci` refuses to reconcile but
# `install` resolves the same way the local dev env does. The lockfile still
# pins exact versions for everything else.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# ─── Stage 2: compile TypeScript to dist/ ────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ─── Stage 3: runtime — prod deps only, non-root, healthcheck ────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production deps only. node_modules is pruned to runtime essentials.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Compiled JS + migration SQL files. db:migrate:apply reads from
# ./src/db/migrations (overridable via MIGRATIONS_FOLDER env var).
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./src/db/migrations

# Run as non-root. The `node` user (uid 1000) ships with the base image.
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
