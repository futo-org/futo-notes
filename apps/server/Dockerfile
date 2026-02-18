# TODO: Make workspace-aware when server is implemented.
# Build context must be monorepo root (context: ../..) so npm can
# resolve the @futo-notes/shared workspace dependency.
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["node", "dist/index.js"]
