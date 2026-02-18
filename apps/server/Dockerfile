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

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/shared/ packages/shared/
COPY --from=builder /app/apps/server/package.json apps/server/
COPY --from=builder /app/apps/server/dist/ apps/server/dist/

RUN npm ci --workspace=apps/server --workspace=packages/shared --omit=dev

EXPOSE 3000
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
