# Pre-baked Linux test image for JavaScript, Playwright, Rust/Tauri, and sync CI.
# Runtime jobs should install project packages, but not operating-system tools,
# browsers, Rust toolchains, or helper CLIs on every pipeline.
#trivy:ignore:DS-0002
FROM gitlab.futo.org:5050/futocore/ci/kitchensink@sha256:2df4951967506d9dc31ad4dea6d7b03eb4ddea21f3bd5e500ef3d3be924e589f

ENV BUN_INSTALL=/opt/bun
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PATH=/opt/bun/bin:/root/.cargo/bin:$PATH

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libfuse2 \
      libssl-dev \
      patchelf \
      xdg-utils \
      xvfb \
      postgresql-client \
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/*

# Match rust-toolchain.toml and keep the tools shared by all Rust/Tauri jobs in
# the immutable image instead of the GitLab target archive.
RUN rustup toolchain install 1.89.0 --component rustfmt --component clippy && \
    rustup default 1.89.0 && \
    curl -L --proto '=https' --tlsv1.2 -sSf \
      https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash && \
    cargo binstall tauri-cli sccache --no-confirm --locked

# Pin Bun and Playwright to the versions exercised by the current lockfiles.
RUN mkdir -p "$BUN_INSTALL" && \
    curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" && \
    . "$HOME/.nvm/nvm.sh" && \
    npx --yes playwright@1.58.2 install --only-shell chromium
