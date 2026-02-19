# Build context must be monorepo root so npm can resolve workspaces.
# Usage: docker build -f apps/server/Dockerfile .
FROM node:22-slim AS builder
WORKDIR /app

# Install build tools for native modules (argon2, better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy workspace root files
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/

RUN npm ci --workspace=apps/server --workspace=packages/shared

# Copy source
COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/

RUN cd apps/server && npm run build

# Production stage
FROM node:22-slim
WORKDIR /app

LABEL org.opencontainers.image.title="FUTO Notes Server"
LABEL org.opencontainers.image.description="Self-hosted sync server for FUTO Notes"
LABEL org.opencontainers.image.source="https://gitlab.futo.org/justin/futo-notes"

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
