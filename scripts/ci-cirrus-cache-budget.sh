#!/usr/bin/env bash
# Discard a restored Cirrus cache dir that has outgrown its budget.
#
# The cache key is constant (see .cirrus.yml), so cargo never evicts anything:
# every Cargo.lock bump leaves the old dependency versions' artifacts in target/
# next to the new ones, and the blob only grows. Cirrus tars the folder into the
# VM's temp dir, on the same disk, so the upload needs about twice the folder's
# size free; once target/ passed ~6 GB that no longer fit and the upload died
# with "no space left on device" after every test had passed (pipeline 40069).
#
# Dropping an oversized restore costs one cold build, which then uploads a clean
# cache. Nothing is masked: the build and tests still run and still fail loudly.
#
#   scripts/ci-cirrus-cache-budget.sh <max-gb> <dir>...
set -euo pipefail

max_gb="${1:?usage: ci-cirrus-cache-budget.sh <max-gb> <dir>...}"
shift

for dir in "$@"; do
  [ -d "$dir" ] || continue
  kb="$(du -sk "$dir" | cut -f1)"
  echo "cache budget: $dir is $((kb / 1024)) MB (budget $((max_gb * 1024)) MB)"
  if [ "$kb" -gt $((max_gb * 1024 * 1024)) ]; then
    echo "cache budget: $dir is over budget, discarding it for a cold rebuild"
    rm -rf "$dir"
    if [ -e "$dir" ]; then
      echo "cache budget: could not remove $dir" >&2
      exit 1
    fi
  fi
done
