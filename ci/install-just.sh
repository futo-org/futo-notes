#!/bin/sh
# The unit and desktop-sync test jobs call repo recipes, but their pinned
# images do not include just. Download the same verified binary for each job.
set -eu

JUST_VERSION=1.42.4
JUST_SHA256=678efc1cfbd5fa5a88375daa7e2f3864a049d6d63a0296df925a2ae5f516cb56
just_install_dir=${JUST_INSTALL_DIR:-/usr/local/bin}

if [ -x "$just_install_dir/just" ] && [ "$("$just_install_dir/just" --version)" = "just $JUST_VERSION" ]; then
  "$just_install_dir/just" --version
  exit 0
fi

[ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] || {
  echo 'install-just: this CI installer supports Linux x86_64' >&2
  exit 1
}
for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "install-just: $tool is required but missing" >&2
    exit 1
  }
done

just_scratch=$(mktemp -d)
trap 'rm -rf "$just_scratch"' EXIT
curl -fsSL --retry 3 --retry-connrefused --retry-delay 2 -o "$just_scratch/just.tar.gz" \
  "https://github.com/casey/just/releases/download/$JUST_VERSION/just-$JUST_VERSION-x86_64-unknown-linux-musl.tar.gz"
echo "$JUST_SHA256  $just_scratch/just.tar.gz" | sha256sum -c -
tar -xzf "$just_scratch/just.tar.gz" -C "$just_scratch" just
[ "$("$just_scratch/just" --version)" = "just $JUST_VERSION" ]
mkdir -p "$just_install_dir"
install -m 755 "$just_scratch/just" "$just_install_dir/just"
"$just_install_dir/just" --version
