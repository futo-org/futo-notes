# Build context must be monorepo root so Cargo workspace resolves.
# Usage: docker build -f crates/stonefruit-server/Dockerfile .
FROM --platform=$BUILDPLATFORM rust:1.94-slim-trixie AS builder
WORKDIR /app

ARG TARGETPLATFORM

RUN apt-get update && apt-get install -y pkg-config libssl-dev python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip install ziglang --break-system-packages && cargo install cargo-zigbuild

# Map Docker platform to Rust target and add it
RUN case "$TARGETPLATFORM" in \
      linux/arm64) echo "aarch64-unknown-linux-gnu" > /tmp/rust-target ;; \
      *)           echo "x86_64-unknown-linux-gnu"  > /tmp/rust-target ;; \
    esac && \
    rustup target add "$(cat /tmp/rust-target)"

COPY . .

# Trim workspace to only the crates needed for the server
RUN sed -i '/apps\//d' Cargo.toml

RUN cargo zigbuild --release -p stonefruit-server --target "$(cat /tmp/rust-target)" && \
    cp "/app/target/$(cat /tmp/rust-target)/release/stonefruit-server" /app/stonefruit-server

# Production stage
FROM debian:trixie-slim
WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="Stonefruit Server"
LABEL org.opencontainers.image.description="Self-hosted sync server for Stonefruit"
LABEL org.opencontainers.image.source="https://gitlab.futo.org/stonefruit/stonefruit"

COPY --from=builder /app/stonefruit-server /usr/local/bin/stonefruit-server

ENV DATA_DIR=/app/data
ENV PORT=3005

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3005/health || exit 1

CMD ["stonefruit-server"]
