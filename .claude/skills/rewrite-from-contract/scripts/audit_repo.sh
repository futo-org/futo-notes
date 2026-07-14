#!/usr/bin/env bash
# Read-only repo inventory for Phase 2 (find the rewrite boundary).
# Usage: audit_repo.sh [repo-dir] [git-since]
#   repo-dir  defaults to .
#   git-since defaults to "6 months ago"
#
# Emits the raw evidence for the candidate-scoring rubric: size, churn,
# fix-density, and test proximity. It ranks nothing — scoring stays a
# judgment call made by reading the leading candidates.
set -euo pipefail

REPO="${1:-.}"
SINCE="${2:-6 months ago}"
cd "$REPO"
git rev-parse --is-inside-work-tree >/dev/null

# Production source only: exclude tests, generated output, vendored deps.
EXCLUDES='node_modules/|target/|dist/|build/|\.build|Generated/|uniffi/|jniLibs/|vendor/|\.min\.|lock$'
TESTY='(^|/)tests?/|\.test\.|\.spec\.|_test\.|conftest|fixtures?/'
SRC_EXT='\.(rs|ts|tsx|js|mjs|svelte|swift|kt|java|py|go|rb|c|cc|cpp|h|hpp|cs|php)$'

files() {
  git ls-files | grep -Ev "$EXCLUDES" | grep -E "$SRC_EXT"
}

echo "== Largest production files (lines) =="
files | grep -Ev "$TESTY" | xargs -d '\n' wc -l 2>/dev/null \
  | sort -rn | grep -v ' total$' | sed -n '1,25p'

echo
echo "== Churn since '$SINCE' (commits touching each file) =="
git log --since="$SINCE" --name-only --pretty=format: -- . \
  | grep -Ev "^$|$EXCLUDES" | grep -E "$SRC_EXT" | grep -Ev "$TESTY" \
  | sort | uniq -c | sort -rn | sed -n '1,25p'

echo
echo "== Fix-density since '$SINCE' (fix/revert commits touching each file) =="
git log --since="$SINCE" --name-only --pretty=format: \
  --grep='fix' --grep='revert' --grep='hotfix' -i -- . \
  | grep -Ev "^$|$EXCLUDES" | grep -E "$SRC_EXT" | grep -Ev "$TESTY" \
  | sort | uniq -c | sort -rn | sed -n '1,25p'

echo
echo "== Test inventory by top-level directory =="
files | grep -E "$TESTY" | cut -d/ -f1-2 | sort | uniq -c | sort -rn | sed -n '1,20p'

echo
echo "== Giant-owner smell: files > 800 production lines =="
files | grep -Ev "$TESTY" | xargs -d '\n' wc -l 2>/dev/null \
  | awk '$1 > 800 && $2 != "total" {print}' | sort -rn

echo
echo "== Deferred-work markers per file (TODO/FIXME/HACK/XXX) =="
files | grep -Ev "$TESTY" \
  | { xargs -d '\n' grep -cE 'TODO|FIXME|HACK|XXX' 2>/dev/null || true; } \
  | awk -F: '$2 > 3 {print $2 "\t" $1}' | sort -rn | sed -n '1,15p'

echo
echo "Done. Cross-reference: a file that is large AND high-churn AND"
echo "high fix-density is a candidate; whether it has a strong external"
echo "contract (integration/E2E/fixture coverage) decides rewrite vs"
echo "test-creation project. Inspect the top candidates by hand."
