#!/bin/bash
# PostToolUse hook: run cargo clippy on .rs edits, return errors as additionalContext
FILE=$(jq -r '.tool_input.file_path // .tool_response.filePath')
echo "$FILE" | grep -qE '\.rs$' || exit 0

OUT=$(cd /home/justin/Developer/stonefruit/apps/tauri/src-tauri && cargo clippy 2>&1 | tail -20)
if [ -n "$OUT" ]; then
  jq -n --arg ctx "Cargo clippy output:
$OUT" '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
fi
