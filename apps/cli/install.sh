#!/bin/sh
# Stonefruit CLI installer
# Usage: curl -fsSL https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/cli/install.sh | sh
#
# Environment variables:
#   VERSION  - specific version to install (default: "latest")

set -eu

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

OS="$(detect_os)"
ARCH="$(detect_arch)"
VERSION="${VERSION:-latest}"

DOWNLOAD_URL="https://gitlab.futo.org/api/v4/projects/justin%2Ffuto-notes/packages/generic/stonefruit-cli/${VERSION}/stonefruit-${OS}-${ARCH}"

echo "Downloading Stonefruit CLI (${OS}/${ARCH}, version: ${VERSION})..."

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
echo "Run 'stonefruit setup' to get started."
