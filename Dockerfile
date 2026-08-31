# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS deps
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
RUN pnpm --filter @doc-scanner/server run typecheck
RUN pnpm --filter @doc-scanner/pwa run build

FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
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
# pnpm's workspace layout symlinks tsx (now a server runtime dep) into
# server/node_modules, not the root node_modules copied above — needed for
# `node --import tsx` to resolve it at container start.
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/pwa/dist ./pwa/dist
COPY package.json ./
EXPOSE 3000
VOLUME ["/data"]
ENV DB_PATH=/data/app.db
ENTRYPOINT ["/sbin/tini", "--"]
# `--import tsx` resolves the bare "tsx" specifier relative to process.cwd(),
# and pnpm's workspace layout only symlinks tsx into server/node_modules (not
# an ancestor of /app) — so the process must start with cwd server/. DB_PATH
# and PWA_DIST_PATH are absolute (see compose.yml), so this cwd change is safe.
CMD ["sh", "-c", "cd server && exec node --import tsx src/index.ts"]

# Volatile OCI labels — placed last so they don't bust earlier layer cache.
# CI passes real values via --build-arg; standalone builds get the defaults.
ARG GIT_SHA=dev
ARG BUILD_DATE=unknown
ARG VERSION=dev
LABEL org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}"
