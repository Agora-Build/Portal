# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
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
