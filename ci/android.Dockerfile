# Pre-baked Android build image for CI.
# Saves ~10 min per pipeline by pre-installing JDK, Android SDK/NDK, and Rust targets.
#
# Build and push:
#   docker build -f ci/android.Dockerfile -t gitlab.futo.org:5050/futo-notes/futo-notes/ci/android:latest .
#   docker push gitlab.futo.org:5050/futo-notes/futo-notes/ci/android:latest
#
# Runs as root by design: this is an ephemeral CI build image (not a deployed
# service). Every layer needs root (apt, sdkmanager, /opt installs) and the
# baked "ci" AVD + SDK live under root's home, so a non-root USER would break
# the pipeline. Accept the "image user should not be root" check accordingly.
#trivy:ignore:DS-0002
FROM gitlab.futo.org:5050/futocore/ci/kitchensink@sha256:2df4951967506d9dc31ad4dea6d7b03eb4ddea21f3bd5e500ef3d3be924e589f

ENV ANDROID_HOME=/opt/android-sdk
ENV JAVA_HOME=/opt/jdk-21
ENV NDK_HOME=/opt/android-sdk/ndk/28.2.13676358
ENV FNM_DIR=/root/.local/share/fnm
# Makes the baked Node the image default, for jobs that never run `fnm use`.
ENV PATH=$FNM_DIR/aliases/default/bin:$PATH

# JDK 21: Eclipse Temurin, pinned with its checksum. Oracle's floating
# jdk/21/latest URL started answering 404 (job 275631), and an unverified
# `curl | tar` turned that into "gzip: stdin: not in gzip format".
RUN curl -fsSL -o /tmp/jdk.tar.gz \
      https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz && \
    echo "d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c  /tmp/jdk.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/jdk.tar.gz -C /opt && rm /tmp/jdk.tar.gz && \
    mv /opt/jdk-21* /opt/jdk-21

# Android SDK command-line tools + platform + build tools + NDK
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" && \
    curl -sL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdtools.zip && \
    unzip -q /tmp/cmdtools.zip -d "$ANDROID_HOME/cmdline-tools" && \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" && \
    rm /tmp/cmdtools.zip && \
    yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null 2>&1 && \
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
      "platform-tools" "platforms;android-37.0" "build-tools;36.0.0" "ndk;28.2.13676358"

# Rust Android targets
RUN . "$HOME/.cargo/env" 2>/dev/null || true && \
    rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android

# ─────────────────────────────────────────────────────────────
# Emulator + desktop-client layers (for the cross-platform sync
# test job; release APK builds don't use them but still pull the
# image).
#
# Keep these layers LAST so `build:android` stays cache-hot: when
# the base layers (JDK/SDK/NDK/Rust) are unchanged, the Docker
# daemon pulls only the deltas it needs and release builds don't
# pay for emulator-specific churn. Bumping the SDK platform
# version up top will invalidate everything below, which is fine
# because you'd want to rebuild the test layers in that case too.
# ─────────────────────────────────────────────────────────────

ENV ANDROID_SDK_ROOT=/opt/android-sdk

# Emulator + x86_64 system image (no Play Services — the app doesn't need them).
RUN "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
      "emulator" \
      "system-images;android-34;default;x86_64"

# Baked AVD named "ci" — the harness picks it up via SF_ANDROID_AVD=ci.
# --force so the image rebuild is idempotent.
RUN echo "no" | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
      --name ci \
      --package "system-images;android-34;default;x86_64" \
      --device "pixel_6" \
      --force

# Desktop Tauri deps — the sync test harness runs a Linux debug build
# alongside the emulator, which needs xvfb + WebKitGTK 4.1.
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
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/*

# Docker CLI + compose v2 — tests/lib/sync-test-server.mjs runs
# `docker compose up -d postgres` inside the futo-notes-server repo.
# The Docker socket must be mounted into the job container at runtime
# (configured on the GitLab runner, not here).
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    . /etc/os-release && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# Baked so every job's `fnm use` is an offline no-op. fnm is installed rather
# than inherited, because the base image belongs to another team. COPY rather
# than a literal keeps .nvmrc the only place the version is written.
COPY .nvmrc /tmp/.nvmrc
COPY ci/install-fnm.sh /tmp/install-fnm.sh
RUN sh /tmp/install-fnm.sh && \
    cd /tmp && fnm install && fnm alias "$(cat /tmp/.nvmrc)" default && \
    rm /tmp/.nvmrc /tmp/install-fnm.sh && \
    node --version
