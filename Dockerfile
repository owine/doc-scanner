# syntax=docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM node:24.16.0-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS deps
WORKDIR /app
# Corepack ships with Node and pins pnpm to the version recorded in
# package.json's `packageManager` field. No network install of pnpm needed.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY server/package.json ./server/
COPY pwa/package.json ./pwa/
# --ignore-scripts is also the .npmrc policy, but pass it explicitly here
# to match the prior posture and document intent at the install site.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY server ./server
COPY pwa ./pwa
RUN pnpm --filter @doc-scanner/server run build
# Compile vendored code to dist/vendor (vendor tsconfig has noEmit: true; override here)
RUN cd server && pnpm exec tsc -p src/vendor/tsconfig.json --noEmit false --outDir dist/vendor --rootDir src/vendor --module commonjs --moduleResolution node10 --ignoreDeprecations 6.0 \
 && echo '{"type":"commonjs"}' > dist/vendor/package.json
RUN pnpm --filter @doc-scanner/pwa run build

FROM node:24.16.0-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Static OCI labels — cached across builds since they never change
LABEL org.opencontainers.image.title="doc-scanner" \
      org.opencontainers.image.description="Self-hosted PWA for scanning paper documents to Proton Drive" \
      org.opencontainers.image.source="https://github.com/owine/doc-scanner" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="owine"

# Alpine apk packages pinned to Alpine 3.23 versions; Renovate tracks them via Repology
RUN apk add --no-cache \
  tini=0.19.0-r3
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/migrations ./server/dist/migrations
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/pwa/dist ./pwa/dist
COPY package.json ./
EXPOSE 3000
VOLUME ["/data"]
ENV DB_PATH=/data/app.db
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]

# Volatile OCI labels — placed last so they don't bust earlier layer cache.
# CI passes real values via --build-arg; standalone builds get the defaults.
ARG GIT_SHA=dev
ARG BUILD_DATE=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}"
