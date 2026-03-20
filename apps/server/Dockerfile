# Build context must be monorepo root so pnpm can resolve workspaces.
# Usage: docker build -f apps/server/Dockerfile .
FROM node:22-slim AS builder
WORKDIR /app

# Install build tools plus git for plugin repo installs/tests
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile --filter @futo-notes/server --filter @futo-notes/shared

# Copy source
COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/

RUN cd apps/server && pnpm run build

# Test stage — run server tests inside the build environment
FROM builder AS test
WORKDIR /app/apps/server
CMD ["pnpm", "exec", "vitest", "run"]

# Production stage
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="Stonefruit Server"
LABEL org.opencontainers.image.description="Self-hosted sync server for Stonefruit"
LABEL org.opencontainers.image.source="https://gitlab.futo.org/stonefruit/stonefruit"

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/shared/ packages/shared/
COPY --from=builder /app/apps/server/package.json apps/server/
COPY --from=builder /app/apps/server/dist/ apps/server/dist/

EXPOSE 3005
WORKDIR /app/apps/server

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3005/health').then(r=>{if(!r.ok)throw r;process.exit(0)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
