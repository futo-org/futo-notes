#!/usr/bin/env bash
# Bundle all meaningful source files into a single text file for LLM context.
# Usage: ./scripts/bundle-source.sh [output-file]
#
# Excludes: binaries, lock files, .claude/ skills,
# docs/ planning docs, CI configs (low signal-to-noise), test fixtures.

set -euo pipefail

# Files to skip (patterns matched against git paths)
EXCLUDE_PATTERNS=(
  'pnpm-lock\.yaml$'
  'Cargo\.lock$'
  '\.pbxproj$'
  '\.png$'
  '\.ico$'
  '\.icns$'
  '\.ttf$'
  '\.woff2$'
  '\.jar$'
  '\.svg$'
  '\.claude/skills/'
  '\.claude/local-plugins/'
  'docs/V2-MASTERPLAN\.md'    # 33K planning doc, not current code
  'markdown-spec/cases/'       # test fixture YAML files
)

# Build a single grep -v pattern
EXCLUDE_RE=$(IFS='|'; echo "${EXCLUDE_PATTERNS[*]}")

# Collect matching files
FILES=$(git ls-files -z \
  | tr '\0' '\n' \
  | grep -vE "$EXCLUDE_RE" \
  | while read -r f; do
      # Skip binary files
      mime=$(file --brief --mime-type "$f" 2>/dev/null || echo "unknown")
      case "$mime" in
        text/*|application/json|application/toml|application/xml|application/javascript) echo "$f" ;;
      esac
    done
)

FILE_COUNT=$(echo "$FILES" | wc -l)

# Output bundle to stdout
echo "# FUTO Notes Source Bundle"
echo "# Generated: $(date -Iseconds)"
echo "# Files: $FILE_COUNT (estimated)"
echo ""

echo "$FILES" | while read -r f; do
  [ -z "$f" ] && continue
  echo "════════════════════════════════════════════════════════════════"
  echo "FILE: $f"
  echo "════════════════════════════════════════════════════════════════"
  cat "$f"
  echo ""
done
