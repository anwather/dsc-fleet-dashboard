# -----------------------------------------------------------------------------
# Multi-stage build for the dsc-fleet-dashboard API.
# Final image runs `prisma migrate deploy` and then `node dist/server.js`.
# -----------------------------------------------------------------------------

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build

WORKDIR /workspace

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/

# Install all workspace deps (including dev)
RUN npm install --workspaces --include-workspace-root

# Copy source
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types

# Generate Prisma client + build shared-types + build api
RUN npm -w @dsc-fleet/shared-types run build \
 && npx --workspace @dsc-fleet/api prisma generate \
 && npm -w @dsc-fleet/api run build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Copy built workspaces + node_modules. We keep prisma CLI available so the
# entrypoint can run `prisma migrate deploy` before the server starts.
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/prisma ./apps/api/prisma
COPY --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /workspace/packages/shared-types/package.json ./packages/shared-types/package.json

WORKDIR /app/apps/api

EXPOSE 3000

# Apply migrations against the configured DATABASE_URL, then start the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
