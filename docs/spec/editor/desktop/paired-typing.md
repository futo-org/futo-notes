### Desktop editor: paired typing _(desktop)_

What a typed `` ` ``, `*`, `~`, `[` or `]`, and Backspace in an empty pair, do is the engine's
([portable-core/paired-typing.md](../portable-core/paired-typing.md)); the page sends the keys
and draws what the engine answers.

- A typed key (`beforeinput` `insertText`) is sent as the engine's `PairedTyping`, so the
  backtick, `*`, `~`, `[` and `]` pair, grow, step over and step out as the core says, and over
  a selection take it to the character's next format level; a backtick after a line's lone pair
  makes a code block, whose language field then takes the letters (code-blocks.md). Composed
  text (dead keys, input methods), replacements and paste never pair. →
  src/features/editor/desktop/input.ts `beforeInput`, tests/desktop-editor-pairing-stories.mjs, tests/desktop-editor-code-block-stories.mjs
- Every Backspace is sent as `PairedBackspace` (after a wikilink, the wikilink whole first:
  links.md). → wikilinkUnit.ts `deleteBeside`
- A key that only moves the caret (a step over, a step out of a format) returns no edit: the
  page reads the selection and the caret's side from the session afterwards, so the caret's
  flag loses the format stepped out of. → view.ts `show`
- A code block's header fields and the title field are inputs of their own: typing there is
  plain and never reaches the engine's paired typing. → codeBlockHeader.ts
- A wikilink being typed draws as typed: from when the engine's `[[` completion run is open in
  it (`[[` pairs to `[[|]]`, and after a letter `[[R|]]` reads as a wikilink) until neither end
  of the selection is inside it, it shows its source with its brackets and no label, and the
  caret stops at every character in it; accepting a note from the list or moving out of it
  makes it one unit again (links.md). A finished wikilink is edited by deleting it (Backspace
  after it takes it whole) and typing it again. → typedWikilink.ts,
  wikilinkCompletion.ts `run`
