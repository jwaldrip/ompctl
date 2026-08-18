# Marketing site for the ompctl.ai apex. Deploys run in CI only, never from a
# workstation.
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
# See hub/deploy/Dockerfile for why the full repo is copied: bun's workspace
# resolution needs every package.json the root manifest's `workspaces` globs
# match, not just this package's own.
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /app/packages/site
# This build is a gate, not a copy: it fails on a referenced-but-missing asset,
# a shipped-but-unreferenced screenshot, or an anchor pointing at no such id. A
# broken site therefore fails here rather than 404ing in production.
RUN bun run build

FROM oven/bun:1.3.14-alpine
WORKDIR /srv
COPY --from=build /app/packages/site/dist ./dist
COPY packages/site/deploy/server.ts ./server.ts
ENV NODE_ENV=production
EXPOSE 8080
USER bun
CMD ["bun", "server.ts"]
