### Desktop editor: code blocks _(desktop)_

A fenced code block (portable-core/fenced-code.md) is drawn from the engine's description of
its lines and its block; the editor holds no fence rule of its own. Its syntax colours are
[code-colours.md](code-colours.md). The engine owns the fence
text: the header's fields write it only through the engine, and the page never rewrites a
fence line.

- A fenced code block draws as one card around its lines: a flat well, a fill a tint of the
  text colour inside a hairline border, with no shadow, its text in Martian Mono. Its lines
  stay one element each: every line paints the fill and the side hairlines, the first the top
  edge and corners, the last the bottom edge and corners, so a block shows no seam between its
  lines and a soft-wrapped code line wraps inside the card. Its 27px header and its 10px skirt
  (the card's bottom inset) are all it adds to the note's rows: no page is reserved above or
  below the card, and two blocks back to back are two cards 4px apart. →
  src/features/editor/desktop/desktopCodeBlocks.css,
  lineElements.ts `drawLine`, tests/desktop-editor-code-block-stories.mjs
- Every code line is one line unit tall and starts with its number, 1-based in its block, in a
  gutter left of a hairline rule; the numbers are drawn by CSS, never text, so they are not
  selected, copied or a caret stop, and the number of every line below an edit is right at
  once. The gutter is as wide as the block's line count has digits, at least two, on every line
  of the block alike: a block reaching 100 lines widens it on all its lines. →
  desktopCodeBlocks.css, lineModel.ts `fitGutters`, applyViewChanges.test.ts
- In a code line the caret is as tall as in a paragraph (the body text's box, not the code
  font's), centred on its row, an empty line and a wrapped line's later rows alike. →
  src/features/editor/desktop/caret.ts `measureCaret`, tests/desktop-editor-code-block-stories.mjs

#### The header

- Above the first code line, inside the card, a 27px header holds the block's name field on
  the left, its "add a line above" label where it has one (below), and its language field and
  copy button on the right, each field showing its value
  as written (case kept, never prettified); a block with neither keeps the empty header, so
  every card has the same top. The header holds no text node (its fields are inputs, the
  button draws its glyph): it is not selected by a text selection, copied with the note or a
  caret stop, and the page's offsets skip it. It and the gap above a block are outside the
  first line's box, so the caret, the highlight and a click measure code rows as any line; Up
  and Down cross them to the next line's row, Up from the line under a block over its skirt to
  its last code row at the caret's column. → src/features/editor/desktop/codeBlockChrome.ts,
  lineElements.ts `pointInLine`, hitTest.ts `verticalStop`, codeBlockChrome.test.ts,
  tests/desktop-editor-code-block-stories.mjs
- Each field is as wide as its value (its placeholder while empty) plus one collar on every
  side, its ink one corner from the card's edge; room for the caret comes out of the trailing
  collar. The name is capped at 30 characters or 45% of the header, whichever is less, the
  language at 14 characters or 30% of it; over its cap a field shows an ellipsis while read
  and scrolls while typed in, and the note keeps every character. The language and the copy
  button after it keep to the header's right edge. → desktopCodeBlocks.css `.code-field`
- Each field and the copy button fill a box one field tall that stands as far from the card's
  top as from its side (2px). → desktopCodeBlocks.css `.code-header`,
  tests/desktop-editor-code-block-header-stories.mjs
- An empty field shows its placeholder ("name", "language") while the caret is in the block
  (a selected block too), the field has focus or the pointer is over the header. A field or
  the copy button is filled only while it has focus or the pointer is over it. →
  codeBlockHeader.ts `markActive`, desktopCodeBlocks.css
- The pointer is an I-beam over a field, a hand over the copy button and the arrow elsewhere
  on the header. A click on a field edits it, wherever the caret was: its caret lands where the
  click did, and a drag selects in it. → desktopCodeBlocks.css
- Only the copy button copies: every click puts the block's code on the clipboard, its lines
  without its fences (a double click copies twice), turns its glyph into a check for about a
  second and shows "Copied to clipboard"; a failed copy says so in a toast. It copies in a
  read-only note too. → codeBlockHeader.ts, codeBlockCopy.ts, copyCodeToClipboard.ts,
  tests/desktop-editor-code-block-header-stories.mjs
- While a field has focus the note draws no caret and no highlight: a text selection or a
  selected block ends at its start when a field takes focus (from the focus, so the press
  still places the field's caret). → codeBlockHeader.ts `focusIn`, selection.ts
  `collapseToStart`, overlays.ts `caretRect`
- A field is an editing buffer: the block's header is written once, through the engine
  (`set_code_block_header`, one Undo step), when focus leaves the header (Enter, Tab or an
  arrow out of it, a press elsewhere), the note is switched away from or the editor is torn
  down; moving between its two fields writes nothing. A
  field keeps of typed or pasted text what the engine says it may hold
  (`typed_code_block_language`, `typed_code_block_name`, portable-core/fenced-code.md): no
  backtick in either, and in the language a space becomes a hyphen and a leading one is
  dropped; the name is written without its outer spaces. Text still being composed (a dead
  key's accent) stays until the composition ends. A value
  the engine refuses (a name holding a key such as ` hl:2`) leaves the block as it was and the
  field showing the block's own value. → codeBlockHeader.ts `write`,
  tests/desktop-editor-code-block-header-stories.mjs
- In a field, Enter and Down put the caret at the start of the block's first code line, and Up
  at the end of the line above the block (on a block that opens the note it stays). Tab walks
  name, language, code; Shift+Tab goes from the language to the name, and from the start of
  the block's first code line, where it has nothing to outdent, to the language. Escape puts
  back the value the field had when it took focus and leaves: the language to the code's
  start, the name to where the caret was. Leaving a field never scrolls the pane, wherever
  the caret was. With nothing typed in it, Mod+Z and Shift+Mod+Z in a
  field are the note's Undo and Redo. → codeBlockHeader.ts `keyDown`, keys.ts
- Whenever the engine says the caret writes a block's language (`writes_language`: after the
  third backtick that makes a block, or an Undo or Redo back to that caret), the block's
  language field takes focus, empty, instead of a caret drawn in the code. Letters typed are
  the field's; Enter writes the language and leaves an ordinary caret at the start of the
  block's code, so the next letter is code. Escape writes nothing and goes to the code, a press
  in the code or elsewhere writes what was typed, and Backspace in the empty field removes
  nothing and stays. → view.ts `show`, codeBlockHeader.ts `followLanguageCaret`,
  tests/desktop-editor-code-block-header-stories.mjs
- Puppet's `state` names the header field that has focus and its value as
  `editor.headerField`. → src/app/puppet/puppetTextEditor.ts `textEditorState`

#### Add a line above and below

- A block that opens the note, or sits right under another block, has an "add a line above"
  label; one that ends the note, or sits right over another block, has "add a line below".
  Against a paragraph or any other line there is none: that line's end and Enter reach the
  edge already. Two blocks that touch carry both, each with its own wording. Read from the
  lines around the block, so an edit beside it adds or drops its labels at once. Not in a
  read-only note. → src/features/editor/desktop/codeBlockEdges.ts, desktopCodeBlocks.css,
  blockNeighbours.ts `fitBlockNeighbours`, tests/desktop-editor-code-block-edge-stories.mjs
- A label is muted 10px text inside the card, hidden until the pointer is on the edge that
  holds it, its whole row: "above" anywhere on the header row, its fields included; "below"
  anywhere from the skirt down to the next block's header, or two lines under a block that
  ends the note (as far as a press below the last line still lands on it). Moving onto a label
  keeps it; only one label shows at a time, so the two at a seam never show together.
  → codeBlockEdgeReveal.ts, codeBlockEdgeReveal.test.ts
- "Above" sits centred in the header's free room between the name and the language, so a long
  name squeezes it, never covers it. "Below" sits centred in the skirt, its box from 2px above
  the skirt to 2px above the card's edge, its ink inside the card. Neither takes room: the note's lines stand where they stand without them.
  → desktopCodeBlocks.css
- A label's words come from the catalog (`editor.codeBlock.addLineAbove`, `addLineBelow`),
  drawn by CSS from an attribute: it is not in the note's text, a copy, the page's offsets, a
  caret stop or Puppet's `doc`. → codeBlockEdges.ts `buildEdgeLabel`
- A click on a label opens a line at that edge (`OpenLineBeforeCodeBlock` or
  `OpenLineAfterCodeBlock`), the caret on it, one Undo step. Below a block, a press from the
  label down opens the line after it too: in the gap between two touching blocks, a line
  between them, and that region shows the I-beam. A press in the skirt beside the label puts
  the caret on the last code line at the column pressed, as a press on that line would. On
  the header only the label opens a line; the rest of the row still selects the block and the
  fields still edit. → codeBlockPress.ts `pressEdge`, hitTest.ts `hitAt`,
  tests/desktop-editor-code-block-edge-stories.mjs
- A press in the editor's strip above a block that opens the note lands in the block's first
  code line at the column pressed, as a press in any space above a line; never on the header.
  → hitTest.ts

#### A block as one object

- A selection inside one block's code is highlighted in the code's column only, on an empty
  code line too: never over the gutter or its rule, and inside the card's right padding, the
  selection colour seen through the well. → highlight.ts, codeBlockSelection.ts `codeColumnOf`,
  highlight.test.ts
- A block selected as one object (portable-core/fenced-code.md) fills its whole card with the
  selection colour, header and line numbers included, and draws no caret, an empty block's
  too. A selection the engine takes a block whole for (one from outside the block reaching
  into its code, Select All included, or one the engine restores, as Undo does, from its code
  out past the start of the line after it) fills that block's card the same way; lines
  outside blocks draw as before. The engine reports no such reach, so the page reads it from
  the selection's ends. → codeBlockSelection.ts `isBlockTakenWhole`, codeBlockSelection.test.ts,
  overlays.ts `caretRect`
- A filled card's corner is square where the highlight runs on right beyond it, across that
  corner (the row above for a top corner, below for a bottom one), so no notch of page shows
  there; a corner with nothing highlighted beyond it stays rounded. A block selected alone keeps
  all four rounded, and two touching blocks taken whole keep their facing corners rounded: the
  4px gap between them is page, not block, and stays unpainted; a selected picture 4px from
  the card fills that gap and squares the corners over its width (images.md). → highlight.ts `Highlight`,
  joinRoundedBands.ts, joinRoundedBands.test.ts
- A selection the user anchors in a block's code (a press, a drag, a double or triple click,
  Shift+click, Shift with an arrow or Cmd+arrow, Puppet's `Select`) stays in that code: its
  focus stops at the code's first or last position, so it never reaches the prose, the header
  or another block, and the engine never takes the block whole for it. Shift+Down and Shift+Up
  stop there like a wall; the caret leaves the block first. → codeBlockSelection.ts
  `fitSelectionToCodeBlocks`, selection.ts `sync`, tests/desktop-editor-code-block-stories.mjs
- A selection the user makes from below a block whose focus stops at the end of the block's
  code holds only the line break after the block, which reaches no part of it: it starts past
  that break, at the next line's start, so no band is drawn on the code's last row, and is a
  caret there when the break was all it held. From under two touching blocks to the end of the
  upper one's code, it starts at the start of the lower one's. One from above that ends at the start of a block's code holds the line break
  before the block, drawn as any line's selected break, and reaches nothing either. →
  codeBlockSelection.ts `fitSelectionToCodeBlocks`, codeBlockSelection.test.ts,
  tests/desktop-editor-code-block-stories.mjs
- A drag off a code row's side leaves the focus at that row's start or end, never the code's.
  An anchor on the code's edge whose focus runs out past that edge selects nothing, a caret
  there. An empty block has no code to anchor in, and the whole note (Select All, anchored at
  its start) is not anchored in a block that opens it; one anchored in a block's code keeps to
  it even when its focus reaches the note's start. A selection the engine makes (Undo) is shown
  as it is.
  → codeBlockSelection.test.ts
- The selection toolbar does not show for a selected block or a selection wholly in code
  lines. → overlays.ts `paint`, tests/desktop-editor-code-block-stories.mjs
- The page keeps the engine's selected block from every view change and selection change, and
  after an input that changes no text reads it from the session. Puppet's `state` marks it on
  `editor.selection` as `block: true`. → selection.ts, view.ts `show`,
  src/app/puppet/puppetTextEditor.ts `textEditorState`
- A press on a block's header, off its fields, copy button and label, selects the block. A
  press in the empty space below a block that ends the note opens a line after it
  (`OpenLineAfterCodeBlock`), the caret on it. A press in code places a caret, which ends the
  selected block, on a selected empty block's own line too: every selection the user places
  goes to the engine as placed (`place_selection`), never the page's echo of the engine's. →
  codeBlockPress.ts, selection.ts `sync`, tests/desktop-editor-code-block-stories.mjs,
  tests/desktop-editor-code-block-header-stories.mjs
- On a selected block Up puts the caret at the end of the line above (at the note's start it
  stays), Down at the start of the line below, or past a block that ends the note on a line it
  opens after it; Left at the start of its code and Right at its end, on an empty block as Up
  and Down. Shift with an arrow extends from the start of its code, a selection anchored in the
  code, so it stays in the code (Shift+Down selects all of it, as text). Down from
  a caret on the last row of a block that ends the note opens a line after it too. →
  codeBlockKeys.ts, tests/desktop-editor-code-block-stories.mjs
- Mod+Enter on a selected block opens a line after it, Shift+Mod+Enter one before it
  (`OpenLineAfterCodeBlock`, `OpenLineBeforeCodeBlock`), the caret on it. → keys.ts `openLine`
- A code line's place in its block (first, last, its block's header and gutter width) is the
  engine's description, never guessed; Puppet's `doc` and `state` refuse when the page and the
  engine differ, a header compared by the name and language it draws. → lineModel.ts
  `applyBlocks`, lineDrift.ts, applyViewChanges.test.ts
