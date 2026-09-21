#!/bin/sh
# The one place the fnm release is pinned FOR LINUX. macOS gets fnm from Homebrew
# (unversioned) and Windows from winget, so this is not the only fnm in CI — what
# is single-sourced everywhere is the NODE version, in .nvmrc.
#
# Our two CI images bake fnm by running this at build time, which makes the job
# time call a no-op. Jobs on the shared base image never hit that path: it belongs
# to another team and will not ship fnm, so those jobs download here every run.
# That is why the fetch retries.
#
# Checksummed rather than piped into a shell: the Linux release jobs that call
# this hold the production updater key.
set -eu

FNM_VERSION=v1.39.0
FNM_SHA256_X86_64=7807664f39d39fc518da1c35ba0181e4b3267603c4b1dedeb4b5fc6ae440a224
FNM_SHA256_AARCH64=4eaff58b2c5bf30d0934027572dd0b5bbb60d2a1af309230b53662d4b1d45599

INSTALL_DIR=${FNM_INSTALL_DIR:-/usr/local/bin}

if command -v fnm >/dev/null 2>&1; then
  fnm --version
  exit 0
fi

case "$(uname -m)" in
  x86_64 | amd64)
    asset=fnm-linux.zip
    sha=$FNM_SHA256_X86_64
    ;;
  aarch64 | arm64)
    asset=fnm-arm64.zip
    sha=$FNM_SHA256_AARCH64
    ;;
  *)
    echo "install-fnm: no fnm release for $(uname -m)" >&2
    exit 1
    ;;
esac

for tool in curl unzip sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "install-fnm: $tool is required but missing" >&2
    exit 1
  }
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Retried: this now runs on the job that gates every merge request, where a
# transient GitHub 5xx or a shared-runner rate limit would otherwise fail an MR
# that has nothing to do with CI.
curl -fsSL --retry 3 --retry-connrefused --retry-delay 2 -o "$tmp/fnm.zip" \
  "https://github.com/Schniz/fnm/releases/download/${FNM_VERSION}/${asset}"
echo "$sha  $tmp/fnm.zip" | sha256sum -c -
unzip -q -o "$tmp/fnm.zip" -d "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/fnm"

# Asserted rather than assumed: an install that lands outside PATH is useless,
# and every caller's next line is `fnm env`.
"$INSTALL_DIR/fnm" --version
