### Typing and IME

- The editable asks the on-screen keyboard for autocorrect and sentence
  capitalisation, and turns off red spellcheck squiggles and Apple's inline
  writing suggestions (`autocorrect="on"`, `autocapitalize="sentences"`,
  `spellcheck="false"`, `writingsuggestions="false"`). A keyboard is not an
  implementation detail of the engine: the editor first shipped with autocorrect
  off alongside the squiggle fix, and every note typed in the native shells lost
  autocorrect and predictive text until 2026-09-01. →
  src/features/editor/milkdown/editorPlugins.ts,
  tests/editor-embed-ime.spec.ts
