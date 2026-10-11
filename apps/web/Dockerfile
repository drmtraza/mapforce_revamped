# Build from the repository root: docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://api:4000 .
# API_ORIGIN is baked into the rewrite table at build time.
FROM node:24.21.0-trixie-slim AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter "@mapforce/web..."
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=${API_ORIGIN} NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @mapforce/web build

FROM node:24.21.0-trixie-slim
# The runtime never needs a package manager; dropping npm/corepack removes their dependency CVEs.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
