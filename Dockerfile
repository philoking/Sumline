# syntax=docker/dockerfile:1

# Node 22 is pinned deliberately: WebCalc stores data through the built-in
# `node:sqlite` module, so the image needs no native modules and no C++
# toolchain. On Node 22 that module lives behind --experimental-sqlite, which
# the start command passes.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install against the manifests alone so the dependency layer is cached until
# a package.json actually changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY engine/package.json engine/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY engine engine
COPY server server
COPY web web
RUN npm run build


# Not part of the default build: CI targets this stage explicitly. Running the
# suite here means the deploy host needs no Node of its own, and the tests run
# against exactly the Node that ships in the image.
FROM build AS test
RUN npm test


FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_ROOT=/app/web/dist
WORKDIR /app

COPY package.json package-lock.json ./
COPY engine/package.json engine/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
