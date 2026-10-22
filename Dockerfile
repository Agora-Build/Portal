# syntax=docker/dockerfile:1
# node:22-bookworm-slim (Node 22.23.4) pinned by its multi-arch index digest, in both stages. To update, take the
# Digest line from `docker buildx imagetools inspect node:22-bookworm-slim`.

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3002
WORKDIR /app
COPY --from=build /src/dist/package.json /src/dist/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist/ ./
RUN mkdir -p .data && chown node:node .data
USER node
VOLUME ["/app/.data"]
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
