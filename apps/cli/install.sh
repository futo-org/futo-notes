#!/bin/sh
# Stonefruit CLI installer
# Usage: curl -fsSL https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/cli/install.sh | sh
#
# Environment variables:
#   VERSION  - specific version to install (default: "latest")

set -eu

PROJECT_ID="stonefruit%2Fstonefruit"

check_docker_access() {
  if ! command -v docker >/dev/null 2>&1; then
    echo ""
    echo "Docker was not detected."
    echo "Install Docker before running Stonefruit setup: https://docs.docker.com/get-docker/"
    return 1
  fi

  if docker version >/dev/null 2>&1; then
    return 0
  fi

  DOCKER_ERROR="$(docker version 2>&1 || true)"

  echo ""
  if [ "$OS" = "linux" ] && printf '%s' "$DOCKER_ERROR" | grep -qi 'permission denied'; then
    echo "Docker is installed, but this shell cannot access it yet."
    echo "If you just installed Docker, finish the post-install step and start a new shell:"
    echo "  sudo usermod -aG docker $USER"
    echo "  newgrp docker"
    echo "Then run 'stonefruit setup'."
    return 1
  fi

  echo "Docker is installed, but it is not currently accessible."
  echo "$DOCKER_ERROR"
  return 1
}

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)
      echo "Error: unsupported operating system '$(uname -s)'" >&2
      exit 1
      ;;
  esac
}

# Detect architecture
detect_arch() {
  case "$(uname -m)" in
    x86_64)          echo "amd64" ;;
    aarch64|arm64)   echo "arm64" ;;
    *)
      echo "Error: unsupported architecture '$(uname -m)'" >&2
      exit 1
      ;;
  esac
}

resolve_version() {
  if [ "$VERSION" != "latest" ]; then
    echo "$VERSION"
    return 0
  fi

  API_URL="https://gitlab.futo.org/api/v4/projects/${PROJECT_ID}/packages?package_name=stonefruit-cli&package_type=generic&per_page=1&order_by=created_at&sort=desc"
  RESPONSE="$(curl -fsSL "$API_URL")" || {
    echo "Error: failed to resolve the latest Stonefruit CLI version." >&2
    exit 1
  }

  RESOLVED_VERSION="$(printf '%s' "$RESPONSE" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$RESOLVED_VERSION" ]; then
    echo "Error: failed to resolve the latest Stonefruit CLI version." >&2
    exit 1
  fi

  echo "$RESOLVED_VERSION"
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
VERSION="${VERSION:-latest}"
RESOLVED_VERSION="$(resolve_version)"

DOWNLOAD_URL="https://gitlab.futo.org/api/v4/projects/${PROJECT_ID}/packages/generic/stonefruit-cli/${RESOLVED_VERSION}/stonefruit-${OS}-${ARCH}"

echo "Downloading Stonefruit CLI (${OS}/${ARCH}, version: ${RESOLVED_VERSION})..."

# Create a temporary file for the download
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

if ! curl -fsSL -o "$TMPFILE" "$DOWNLOAD_URL"; then
  echo "Error: failed to download from ${DOWNLOAD_URL}" >&2
  echo "Check that the version '${VERSION}' exists and try again." >&2
  exit 1
fi

chmod +x "$TMPFILE"

# Try /usr/local/bin first (with sudo), fall back to ~/.local/bin
INSTALL_DIR="/usr/local/bin"
INSTALL_PATH="${INSTALL_DIR}/stonefruit"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "$INSTALL_PATH"
elif command -v sudo >/dev/null 2>&1; then
  echo "Installing to ${INSTALL_PATH} (requires sudo)..."
  if sudo mv "$TMPFILE" "$INSTALL_PATH" && sudo chmod +x "$INSTALL_PATH"; then
    : # success
  else
    echo "sudo install failed, falling back to ~/.local/bin" >&2
    INSTALL_DIR="$HOME/.local/bin"
    INSTALL_PATH="${INSTALL_DIR}/stonefruit"
    mkdir -p "$INSTALL_DIR"
    mv "$TMPFILE" "$INSTALL_PATH"
  fi
else
  INSTALL_DIR="$HOME/.local/bin"
  INSTALL_PATH="${INSTALL_DIR}/stonefruit"
  mkdir -p "$INSTALL_DIR"
  mv "$TMPFILE" "$INSTALL_PATH"
fi

chmod +x "$INSTALL_PATH"

echo ""
echo "Stonefruit CLI installed successfully!"
echo "  Installed to: ${INSTALL_PATH}"

# Warn if install dir is not in PATH
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Warning: ${INSTALL_DIR} is not in your PATH."
    echo "Add it with: export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo ""
if check_docker_access; then
  echo "Launching Stonefruit setup..."
  exec "$INSTALL_PATH" setup
fi

echo "Run '$INSTALL_PATH setup' to get started."
