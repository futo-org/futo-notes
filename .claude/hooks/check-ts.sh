#!/bin/bash
# PostToolUse hook: run tsc --noEmit on .ts/.svelte edits, return errors as additionalContext
FILE=$(jq -r '.tool_input.file_path // .tool_response.filePath')
echo "$FILE" | grep -qE '\.(ts|svelte)$' || exit 0

OUT=$(cd /home/justin/Developer/stonefruit && npx tsc --noEmit 2>&1 | head -20)
if [ -n "$OUT" ]; then
  jq -n --arg ctx "TypeScript errors:
$OUT" '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
fi
