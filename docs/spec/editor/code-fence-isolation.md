## Code / fence isolation

- Wikilinks and tags inside inline code or fenced blocks are NOT decorated and
  NOT extracted. → src/features/editor/milkdown/tagDecorations.ts,
  src/features/editor/milkdown/wikilink/inputRule.ts,
  tests/editor-embed-milkdown.spec.ts
