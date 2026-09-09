# Web console + Universal Link association files for app.ompctl.ai.
# Deploys run in CI only, never from a workstation.
# Use glibc debian variant for build stage: bun on musl alpine crashes with a
# segmentation fault in JavaScriptCore DFG JIT during vite build on linux/amd64.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
# See hub/deploy/Dockerfile for why the full repo is copied: bun's workspace
# resolution needs every package.json the root manifest's `workspaces` globs
# match, not just this package's own.
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /app/packages/app
RUN bun run build:web

FROM oven/bun:1.3.14-alpine
WORKDIR /srv
COPY --from=build /app/packages/app/dist ./dist
COPY packages/app/deploy/server.ts ./server.ts
ENV NODE_ENV=production
EXPOSE 8080
USER bun
CMD ["bun", "server.ts"]
