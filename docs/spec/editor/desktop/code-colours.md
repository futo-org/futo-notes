### Desktop editor: code colours _(desktop)_

A fenced code block (code-blocks.md) colours its code by the block's language, the engine's
`language` as written (portable-core/fenced-code.md). The colours are the page's own reading of
the code: they change no text, offset or line, and the engine never sees them.

- A block whose language names one of the curated grammars (about 35)
  colours its code; the language is looked up by name or alias, any case (`JS`, `py`, `Rust`). A
  block in any other language, or none, draws as code, uncoloured, and edits and saves alike. →
  src/features/editor/codeFenceLanguages.ts, src/features/editor/desktop/codeGrammars.ts
  `grammarParser`, codeColours.test.ts, tests/desktop-editor-code-colour-stories.mjs
- Each grammar is fetched the first time a block in the open note names it; a note without such a
  block fetches none, nor the parsing code they share. Until its grammar arrives a block draws
  uncoloured, then takes its colours with nothing moving: a colour changes the ink and, for a
  comment, the slant, never the width. A grammar that fails to load leaves its blocks uncoloured. →
  codeColours.ts `parserOf`
- The colours are theme.css's `--syntax-*` palette, light and dark: keywords, strings, numbers and
  literals, variables, types and classes, properties and definitions, regular expressions and
  escapes, operators and punctuation each in theirs; comments in the muted text colour, slanted;
  invalid code in the danger colour with a wavy underline. Keywords are not bold: the code face is
  loaded at one weight, and a drawn bold is wider. → desktopCodeColours.css
- A token is drawn as a span in its line, as an inline format is, so the caret, a click, a
  selection, copy and Puppet's offsets read a coloured line as any other; the selection's
  highlight is drawn behind the text, so coloured text stays readable on it. →
  lineSegments.ts `segmentsOf`, codeColours.test.ts
- Typing parses nothing: the lines an edit changes keep the colours of the lines they replaced (a
  letter typed in a string is a string at once), and after the next paint each block the edit
  touched is read again from where it changed, its lines on screen first, a few milliseconds at a
  time, and only the lines whose colours changed are drawn again, the selection kept as it was.
  An edit that changes how the lines below read (an opened comment, a string over lines) colours
  them so. → carryColours.ts, codeColours.ts, codeColours.test.ts
- A block over 200,000 characters stays uncoloured. → codeColours.ts `MAX_COLOURED_CHARACTERS`
- A block's colours follow its language: a language written in the header colours the block in its
  grammar, and a block whose language is removed loses its colours, the blocks beside it keeping
  theirs. → codeColours.test.ts
- Puppet's `show` names a coloured piece's token classes in `formats` (`tok-keyword`), and `state`
  reports `editor.colouring` while colours are still to come. → src/app/puppet/puppetTextEditor.ts
