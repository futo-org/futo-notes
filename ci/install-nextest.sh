#!/bin/sh
# Install the pinned, checksum-verified nextest binary without changing Rust's
# toolchain. Latest nextest needs a newer compiler to build than this repo pins.
# Like install-just.sh, only a complete verified binary is installed.
set -eu
nextest_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
nextest_pin="$nextest_root/scripts/cargo-nextest-pin.json"
nextest_install_dir=${NEXTEST_INSTALL_DIR:-${CARGO_HOME:-$HOME/.cargo}/bin}
for tool in node curl tar install; do
  command -v "$tool" >/dev/null 2>&1 || { echo "install-nextest: missing $tool" >&2; exit 1; }
done
nextest_version=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$nextest_pin")
if [ -x "$nextest_install_dir/cargo-nextest" ] && nextest_current=$("$nextest_install_dir/cargo-nextest" --version); then
  case "$nextest_current" in
    "cargo-nextest $nextest_version ("*) printf '%s\n' "$nextest_current"; exit 0 ;;
  esac
fi
nextest_platform="$(uname -s)/$(uname -m)"
case "$nextest_platform" in Darwin/*) nextest_platform=Darwin ;; esac
nextest_asset=$(node -e 'const p=require(process.argv[1]);const a=p.archives[process.argv[2]];if(!a)throw new Error("unsupported nextest platform: "+process.argv[2]+"; install the pinned version from https://nexte.st/docs/installation/pre-built-binaries/");process.stdout.write(a.asset)' "$nextest_pin" "$nextest_platform")
nextest_sha=$(node -e 'process.stdout.write(require(process.argv[1]).archives[process.argv[2]].sha256)' "$nextest_pin" "$nextest_platform")
nextest_scratch=$(mktemp -d)
trap 'rm -rf "$nextest_scratch"' EXIT
curl -fsSL --retry 3 --retry-connrefused --retry-delay 2 --connect-timeout 15 --max-time 180 \
  -o "$nextest_scratch/nextest.tar.gz" "https://get.nexte.st/$nextest_version/$nextest_asset"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$nextest_sha" "$nextest_scratch/nextest.tar.gz" | sha256sum -c -
else
  printf '%s  %s\n' "$nextest_sha" "$nextest_scratch/nextest.tar.gz" | shasum -a 256 -c -
fi
tar -xzf "$nextest_scratch/nextest.tar.gz" -C "$nextest_scratch" cargo-nextest
nextest_downloaded=$("$nextest_scratch/cargo-nextest" --version)
case "$nextest_downloaded" in
  "cargo-nextest $nextest_version ("*) ;;
  *) echo "install-nextest: verified archive has wrong version" >&2; exit 1 ;;
esac
mkdir -p "$nextest_install_dir"
install -m 755 "$nextest_scratch/cargo-nextest" "$nextest_install_dir/cargo-nextest"
"$nextest_install_dir/cargo-nextest" --version
