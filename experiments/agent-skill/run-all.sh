#!/bin/bash
# One scenario at a time. Each keeps its own target/ (an APFS clone of this checkout's):
# `qa-target` only accepts an app built inside the checkout it is asked from, so a shared
# target made every `just puppet` call answer "no debug desktop app of this worktree".
# The clone is deleted after grading, which is what keeps the disk inside its budget.
cd "$(dirname "$0")"
ARM="${ARM:-drive}"
free_gb() { df -g /System/Volumes/Data | tail -1 | awk '{print $4}'; }
for id in "$@"; do
  if [ "$(free_gb)" -lt 3 ]; then echo "STOP: $(free_gb) GB free before $id"; exit 1; fi
  # The builder may have suffixed the directory (-2, -3…) to move it off a busy port slot.
  dir=$(ls -d work/$id--$ARM work/$id--$ARM-* 2>/dev/null | head -1)
  [ -n "$dir" ] || { echo "SKIP: $id not built for $ARM"; continue; }
  echo "=== $id $(date +%T) run · free $(free_gb) GB"
  node run-scenario.mjs "$id" --arm "$ARM" --model sonnet > "$dir/run.log" 2>&1
  echo "=== $id $(date +%T) grade"
  node grade-scenario.mjs "$id" --arm "$ARM" > "$dir/grade.log" 2>&1
  rm -rf "$dir/repo/target"
  echo "=== $id $(date +%T) done · free $(free_gb) GB"
done
echo "ALL DONE"
