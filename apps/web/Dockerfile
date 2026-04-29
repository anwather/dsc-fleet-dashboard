# --- build stage ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install workspace deps. Build context is the repo root so we can
# install all workspaces with the lockfile and link @dsc-fleet/shared-types.
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/
# api package.json copied so npm install resolves the workspace graph cleanly.
COPY apps/api/package.json apps/api/

RUN npm ci --include=dev

# Source.
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web

# Entra build args — baked into the SPA at Vite build time. Both required.
ARG VITE_ENTRA_TENANT_ID
ARG VITE_ENTRA_CLIENT_ID
ENV VITE_ENTRA_TENANT_ID=${VITE_ENTRA_TENANT_ID}
ENV VITE_ENTRA_CLIENT_ID=${VITE_ENTRA_CLIENT_ID}

# Build shared-types first, then the web app.
RUN npm -w @dsc-fleet/shared-types run build \
 && npm -w @dsc-fleet/web run build

# --- runtime stage --------------------------------------------------------
FROM nginx:alpine

# Replace default site config.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Static assets.
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
