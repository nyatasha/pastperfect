# Past Perfect
#
# The image carries the application *and* the collection. Building the
# collection in here instead would mean re-downloading a thousand pictures from
# four free museum APIs on every deploy: slow, fragile, and rude.
#
# The collection arrives from its own image (see Dockerfile.collection) rather
# than from the build context, so this builds identically on a laptop that holds
# data/ and on a CI runner that does not.
#
#   npm run collection:build   # once, from a machine with data/
#   npm run image:build        # the app
#
# Node 24 runs the TypeScript directly, so there is no compile step here.

ARG COLLECTION=pastperfect-collection:local
FROM ${COLLECTION} AS collection

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# sharp ships prebuilt binaries; --omit=dev keeps typescript out of the image.
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Ownership is set as each layer is copied. A later 'chown -R' would rewrite
# every file it touches into a second layer, doubling the 174 MB of pictures.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node static ./static
COPY --chown=node:node data/seed ./data/seed

# The collection, out of its own image rather than the build context.
COPY --from=collection --chown=node:node /collection/pastperfect.db ./data/pastperfect.db
COPY --from=collection --chown=node:node /collection/media ./data/media

# The database on the volume is the one that gets written to; the one in the
# image is only ever the seed for a volume that does not exist yet.
ENV PASTPERFECT_BAKED_DB=/app/data/pastperfect.db \
    PASTPERFECT_DB=/data/pastperfect.db \
    PASTPERFECT_OG=/data/og \
    PASTPERFECT_MEDIA=/app/data/media \
    PASTPERFECT_HOST=0.0.0.0 \
    PASTPERFECT_PORT=8080

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.json()).then(h=>process.exit(h.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node src/cli.ts prepare && node src/server.ts"]
