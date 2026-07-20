# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

FROM node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS deps
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
# Compile vendored code to dist/vendor (vendor tsconfig has noEmit: true; override here).
# --module commonjs is required because server/package.json is "type":"module".
# moduleResolution is left as the base config's "bundler": TypeScript 7 removed the
# legacy "node10" mode (TS5108) and now permits bundler resolution alongside
# --module commonjs, so no override (and no --ignoreDeprecations) is needed.
RUN cd server && pnpm exec tsc -p src/vendor/tsconfig.json --noEmit false --outDir dist/vendor --rootDir src/vendor --module commonjs \
 && echo '{"type":"commonjs"}' > dist/vendor/package.json
RUN pnpm --filter @doc-scanner/pwa run build

FROM node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Static OCI labels — cached across builds since they never change
LABEL org.opencontainers.image.title="doc-scanner" \
      org.opencontainers.image.description="Self-hosted PWA for scanning paper documents to Proton Drive" \
      org.opencontainers.image.source="https://github.com/owine/doc-scanner" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="owine"

# tini pinned to its Alpine 3.24 repo version for deterministic builds; Renovate
# tracks it via the Repology customManager (alpine_3_24/tini in renovate.json).
# NOTE: the node base tag floats its Alpine version (node:24.18.0-alpine), so
# when node's default Alpine moves to 3.25 both this pin and the alpine_3_24
# depNameTemplate must be hand-updated — the build fails loudly until then.
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
