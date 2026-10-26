# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps
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
# Browser error reporting is compiled into the bundle, so its DSN is a build
# arg (empty = off). A browser DSN is public by design — it ships in the JS —
# so an ARG is fine here. Declared after typecheck to keep that layer cached.
ARG SENTRY_BROWSER_DSN=
ARG SENTRY_ENVIRONMENT=
ARG GIT_SHA=dev
RUN VITE_SENTRY_DSN="$SENTRY_BROWSER_DSN" \
    VITE_SENTRY_ENVIRONMENT="$SENTRY_ENVIRONMENT" \
    VITE_SENTRY_RELEASE="$GIT_SHA" \
    pnpm --filter @doc-scanner/pwa run build

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Static OCI labels — cached across builds since they never change
LABEL org.opencontainers.image.title="doc-scanner" \
      org.opencontainers.image.description="Self-hosted PWA for scanning paper documents to Proton Drive" \
      org.opencontainers.image.source="https://github.com/owine/doc-scanner" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="owine"

# tini pinned to its Alpine 3.24 repo version for deterministic builds; Renovate
# extracts this `apk add` pin natively (datasource `apk`) and looks it up against
# the registryUrls branch in renovate.json.
# NOTE: the node base tag floats its Alpine version (node:<version>-alpine), so
# when node's default Alpine moves to 3.25 both this pin and that `branch=v3.24`
# must be hand-updated — the build fails loudly until then.
# ocrmypdf, tesseract-ocr-data-eng, py3-img2pdf and ghostscript are slice 3's
# OCR tools (spec §4): searchable PDFs and first-page thumbnails before filing.
# They add about 319 MB (measured 2026-10-12). Their own dependencies
# (Tesseract, Python, qpdf, pikepdf, Pillow, jbig2enc, pngquant, unpaper) are
# pulled in unpinned, so they follow the pinned versions. Renovate's `apk`
# datasource bumps these pins too (renovate.json, `branch=v3.24`, `community`
# merged), and CI's smoke step runs every bump against the real tools.
RUN apk add --no-cache \
  tini=0.19.0-r3 \
  ocrmypdf=16.11.1-r2 \
  tesseract-ocr-data-eng=5.5.2-r0 \
  py3-img2pdf=0.6.3-r1 \
  ghostscript=10.08.0-r0
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
# No version label: a release retags an image CI already built from main, so
# the build can't know its release number. The revision (GIT_SHA) is the
# identity; the GitHub Release maps it to X.Y.Z.
ARG GIT_SHA=dev
ARG BUILD_DATE=unknown
# Server-side Sentry release (observability/sentry.ts ignores the "dev"
# default). Deliberately not exported as SENTRY_RELEASE: the SDK reads that
# name on its own and would tag every local build "dev".
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
