# Build from the repository root: docker build -f apps/api/Dockerfile .
# One image serves the API (default) and the control worker + outbox relay:
#   docker run <image> node apps/api/src/temporal/worker-main.ts
# Debian-based because the Temporal core bridge and SWC ship glibc binaries.
FROM node:24.21.0-trixie-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --prod --filter "@mapforce/api..."

FROM node:24.21.0-trixie-slim
# The runtime never needs a package manager; dropping npm/corepack removes their dependency CVEs.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo ./
COPY contracts ./contracts
COPY packages/db ./packages/db
COPY packages/contracts ./packages/contracts
COPY apps/api/src ./apps/api/src
RUN rm -rf packages/db/test packages/contracts/test && chown -R node:node /repo/apps/api
USER node
EXPOSE 4000
CMD ["node", "apps/api/src/server.ts"]
