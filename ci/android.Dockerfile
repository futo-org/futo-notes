# Pre-baked Android build image for CI.
# Saves ~10 min per pipeline by pre-installing JDK, Android SDK/NDK, and Rust targets.
#
# Build and push:
#   docker build -f ci/android.Dockerfile -t gitlab.futo.org:5050/stonefruit/stonefruit/ci/android:latest .
#   docker push gitlab.futo.org:5050/stonefruit/stonefruit/ci/android:latest
FROM gitlab.futo.org:5050/futocore/ci/kitchensink:latest

ENV ANDROID_HOME=/opt/android-sdk
ENV JAVA_HOME=/opt/jdk-21
ENV NDK_HOME=/opt/android-sdk/ndk/27.0.12077973

# JDK 21
RUN curl -sL https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz | tar xz -C /opt && \
    mv /opt/jdk-21* /opt/jdk-21

# Android SDK command-line tools + platform + build tools + NDK
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" && \
    curl -sL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdtools.zip && \
    unzip -q /tmp/cmdtools.zip -d "$ANDROID_HOME/cmdline-tools" && \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" && \
    rm /tmp/cmdtools.zip && \
    yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null 2>&1 && \
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
      "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;27.0.12077973"

# Rust Android targets
RUN . "$HOME/.cargo/env" 2>/dev/null || true && \
    rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
