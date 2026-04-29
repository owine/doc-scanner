# syntax=docker/dockerfile:1.23.0@sha256:2780b5c3bab67f1f76c781860de469442999ed1a0d7992a5efdf2cffc0e3d769

FROM node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY pwa/package.json ./pwa/
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json ./
COPY server ./server
COPY pwa ./pwa
RUN npm --workspace @doc-scanner/server run build
# Compile vendored code to dist/vendor (vendor tsconfig has noEmit: true; override here)
RUN cd server && npx tsc -p src/vendor/tsconfig.json --noEmit false --outDir dist/vendor --rootDir src/vendor --module commonjs --moduleResolution node10 --ignoreDeprecations 6.0 \
 && echo '{"type":"commonjs"}' > dist/vendor/package.json
RUN npm --workspace @doc-scanner/pwa run build

FROM node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
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
