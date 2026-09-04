# Past Perfect
#
# The image carries the application *and* the collection: a database built at
# release time and ~165 MB of image derivatives. That is deliberate. Building
# them inside the container would mean re-downloading a thousand pictures from
# four free museum APIs on every deploy, which is slow, fragile and rude.
#
# Build the collection locally first, then deploy:
#   npm run pp -- import-seed && npm run pp -- images && npm run build
#
# Node 24 runs the TypeScript directly, so there is no compile step here.

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

# The collection. Both are gitignored, so this needs a local build first.
COPY --chown=node:node data/pastperfect.db ./data/pastperfect.db
COPY --chown=node:node data/media ./data/media

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
