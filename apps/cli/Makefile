VERSION ?= dev

.PHONY: build build-all clean test

build:
	cargo build --release
	cp target/release/stonefruit stonefruit

build-all:
	mkdir -p dist
	STONEFRUIT_VERSION=$(VERSION) cargo build --release
	cp target/release/stonefruit dist/stonefruit-linux-amd64
	rustup target add aarch64-unknown-linux-gnu
	CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
		STONEFRUIT_VERSION=$(VERSION) cargo build --release --target aarch64-unknown-linux-gnu
	cp target/aarch64-unknown-linux-gnu/release/stonefruit dist/stonefruit-linux-arm64

test:
	cargo test

clean:
	rm -f stonefruit
	rm -rf dist/
	rm -rf target/
