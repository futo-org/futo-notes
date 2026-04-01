# Build context must be monorepo root so Cargo workspace resolves.
# Usage: docker build -f crates/stonefruit-server/Dockerfile .
FROM rust:1.94-slim-trixie AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY . .

# Trim workspace to only the crates needed for the server
RUN sed -i '/apps\//d' Cargo.toml

RUN cargo build --release -p stonefruit-server

# Production stage
FROM debian:trixie-slim
WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="Stonefruit Server"
LABEL org.opencontainers.image.description="Self-hosted sync server for Stonefruit"
LABEL org.opencontainers.image.source="https://gitlab.futo.org/stonefruit/stonefruit"

COPY --from=builder /app/target/release/stonefruit-server /usr/local/bin/stonefruit-server

ENV DATA_DIR=/app/data
ENV PORT=3005

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3005/health || exit 1

CMD ["stonefruit-server"]
