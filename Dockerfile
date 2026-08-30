# syntax=docker/dockerfile:1

# Dogpark is one process and a SQLite file (ADR-0008), so this is one image
# with a volume, and nothing else.

FROM node:22-bookworm AS build
WORKDIR /app

# Dependencies before sources, so editing a source file does not reinstall.
# `npm ci` and not `npm install`: the lockfile is the input, and a build that
# resolves a different tree than the one that was tested is not a build of
# this commit.
COPY package.json package-lock.json ./
RUN npm ci

# Named rather than `COPY . .`: the build needs exactly these, and a wildcard
# copy takes whatever else is sitting untracked in a working tree -- an
# `.npmrc` with a registry token, an editor directory, a tool's scratch notes
# -- into a build layer. A new top-level source directory has to be added
# here, which is the intended cost.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY ui ./ui
COPY docs ./docs

# The server, then the SPA it serves from `dist/ui`. `npm prune` afterwards
# rather than a second `npm ci --omit=dev` in a fresh stage: it carries through
# exactly the tree that was just built, without resolving a second one.
# better-sqlite3 is native, but it ships prebuilt binaries inside the package,
# so nothing is compiled here and there is no toolchain to keep out of the
# runtime image.
RUN npm run build \
 && npm run build:ui \
 && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DOGPARK_PORT=8080 \
    DOGPARK_DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The SQLite file and `attachments/` (docs/running.md). Owned by `node`
# because the process drops to it: a named volume mounted here inherits this
# ownership, so the first write does not fail on a root-owned mountpoint.
RUN install -d -o node -g node /data
VOLUME /data
USER node
EXPOSE 8080

# `/health` is registered outside the `/api` scope, so it is not subject to
# the X-Forwarded-Proto proof (ADR-0016) and answers over plaintext from
# inside the container even when a proxy is declared.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.DOGPARK_PORT+'/health').then(r=>r.ok?r.json():Promise.reject()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

# Not an ENTRYPOINT: `hash-password` is a subcommand of this same binary, and
# minting a hash is `docker run --rm -it <image> node dist/server.js hash-password`.
CMD ["node", "dist/server.js"]
