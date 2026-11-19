### Desktop editor: rendering, input, caret and saving _(desktop)_

The desktop editor draws the engine's display text (crates/futo-notes-editor) in its own
DOM, one element per display line; it holds no Markdown rules of its own.

- The note shows the engine's display text: markers the engine hides (`#`, `**`, a quote's
  `>`, a list's indent) are not drawn, and a list item's marker is one unit of that text;
  lists, tasks, quotes and dividers draw as blocks.md says. Every row is one line unit tall
  (Plus Jakarta Sans 16px on a 24px line), blank lines included, with no margins between
  blocks; anything taller takes a whole number of lines, but for the room under a heading. A
  tab is 2em wide. →
  src/features/editor/desktop/view.ts, src/features/editor/desktop/desktopEditor.css, src/styles/desktop-fonts.css
- Headings take the redesign's sizes and weights: a first-level heading is 24px 700 on two
  lines; the others fit one line: 22px 700, 20px 600, 19px 600, 18px 500, 17px 500.
  → src/features/editor/desktop/desktopEditor.css
- Every heading has 10px of room under its last row, inside its line: its rows stay whole line
  units from its top. The room belongs to that row: a press in it lands on the row, Up and
  Down cross it as they cross the row, and a selection that runs on past the heading
  highlights it, so the heading's band meets the next line's; one that ends in the heading
  leaves it unpainted. → desktopEditor.css `--row-room`, lineRowAt.ts, highlight.ts,
  hitTest.ts `verticalStop`, tests/desktop-editor-heading-stories.mjs
- Bold, italic, strikethrough and inline code draw where the engine's runs say, in body text
  and headings alike, and compose: bold is one step heavier than its line (700 in body text
  and a 500 heading, 800 in a 600 or 700 heading), italic slants, strikethrough strikes, and
  inline code is Martian Mono at 0.75em on a tint of the text colour (the `--color-code-bg`
  shade), so a selection shows through it, its row still one line unit and the text beside it on the same baseline. Links, wikilinks, tags and the other inline constructs still draw as plain text.
  → src/features/editor/desktop/lineModel.ts `applyBlocks`, lineElements.ts `drawLine`,
  desktopEditor.css, tests/desktop-editor-heading-stories.mjs
- Mod+B bold, Mod+I italic, Mod+E inline code and Mod+Alt+X strikethrough toggle that format
  through the engine: on a selection, the whole selection (one Undo step, the selection
  kept); at a caret, what is typed next, writing nothing to the note until a character is
  typed, and a caret move drops it. Mod+Alt+1…6 make the caret's or the selection's lines a
  heading of that level and Mod+Alt+0 body text (lists and quotes: blocks.md). A chord held
  with Shift is not the shortcut, Mod+Shift+B (quote) aside, whatever the Caps Lock state, and an AltGr chord types its character; with Option or Alt
  the key's place names it (Option+X types ≈). → src/features/editor/desktop/keys.ts
  `formatShortcut`, formatting.ts, tests/desktop-editor-format-stories.mjs
- A format the engine says would change nothing does nothing, from a shortcut or the toolbar
  alike (its `toolbar_state` `allowed` leaves it out): Bold, Italic and Strike inside inline
  code, or a format no spelling can open, as Strike over bold that starts mid-word
  (portable-core/inline-formatting.md). → formatting.ts `allows`, formatting.test.ts
- A non-empty selection shows the selection toolbar: [toolbar.md](toolbar.md).
- A caret between two differently formatted runs is on one side of the edge, the engine's
  affinity, and types with that side's formats; the flag shows them. The page sets the side
  only where it puts the caret, by how the caret came there, and reads the engine's answer
  back. → src/features/editor/desktop/caretSide.ts, formats.ts `arrivalAffinity`, selection.ts
  `sync`
- Left, Right, Option+Left and Option+Right (Ctrl off Apple) leave the caret on the side of the
  character they last passed: after Right the one before it, after Left the one after it,
  across a line break too (Right onto a line's start takes the line break's, no formats). At a
  bold, italic or strikethrough edge that is one stop a character. → formats.ts
  `arrivalAffinity`, caretSide.ts `affinity`, tests/desktop-editor-caret-side-stories.mjs
- Inline code's start and end are two stops each: inside the code and outside it, at the same
  offset. Left or Right from the side it points away from moves the caret to the other side
  without passing a character, the next one moves on; so the caret leaves code that ends a
  line, and enters code that starts one. A format toggled at the caret changes no stop. →
  caretSide.ts `step`, keys.ts,
  tests/desktop-editor-caret-side-stories.mjs
- At inline code's edge the caret draws inside the code's box, within its padding, when the
  next character typed is code, and at the box's outer edge when it is not, on the code's row
  where a soft wrap falls at the edge. → caretSide.ts
  `place`, overlays.ts `caretRect`, tests/desktop-editor-caret-side-stories.mjs
- A click takes the side under the pointer: at inline code's edge the code's side on its box
  (padding included) and the other side off it; at another edge the side of the character the
  pointer is over, and off the text, left of a line's start or right of its end, the line
  break's side, no formats. → caretSide.ts `pressedSide`, hitTest.ts `offsetAt`
- Up, Down, the row's start and end (Cmd+Left and Cmd+Right, Home and End) and a placed caret
  land on the side of the character before the caret; at a line's text start, the first
  character's. → formats.ts `arrivalAffinity`, hitTest.ts `offsetAt`
- Shift+Arrow and a selection have no side: extending moves one character a press. →
  keys.ts, caretSide.ts `affinity`
- After Backspace the character before the caret supplies its formats and after Delete the one
  after it, whichever side the caret was on (the engine's rule). →
  tests/desktop-editor-caret-side-stories.mjs
- The caret's flag is shelved: no build draws it unless a development build's debug menu
  turns it on (maintainers, 2026-11-18, until its design is settled). When on, the caret
  carries a flag, a small pennant in the caret's colour standing on its top (above the caret's
  row, so it covers none of the text beside the caret), whenever the caret is in formatted
  text or will type formatted text: the heading level (H1…H6), then B,
  I, S and <> for bold, italic, strikethrough and inline code, a format a shortcut set at the
  caret included. It is part of the caret: it moves and hides with it and draws no other
  way, and it stays lit while the caret's bar blinks. → src/features/editor/desktop/caret.ts,
  formatting.ts `flag`
- Development builds add a debug section to the note's ⋮ menu, held in memory: which side a
  caret at a format's edge joins (the side it came from, the default; more formatting, always
  left, always right, each for every move but a step at inline code's edge), showing the
  caret's flag, and hiding the flag from an edit until the caret moves or typing pauses for a
  second. →
  src/features/editor/desktop/debugToggles.svelte.ts, src/app/components/NoteWorkspace.svelte
- A line is redrawn only where it changed: a plain line is one text node, a formatted one
  text nodes and one span per run, an atom (a list marker, a divider) one element holding its
  character, and a keystroke inside a run rewrites that run's text alone. At a format's edge
  one offset is two DOM points: the caret and the selection use the start of the text after
  the edge, a caret at a soft wrap's row end or at inline code's end, on either side, the end
  of the text before it. →
  lineElements.ts `drawLine`, `pointInLine`, lineSegments.ts, caretSide.ts `place`
- Every input is answered by the engine through `beforeinput`: typing, Backspace and Delete
  (by character, word and line), Enter and Shift+Enter, Tab and Shift+Tab, Undo and Redo
  (Mod+Z, Shift+Mod+Z, and Ctrl+Y off Apple). The browser changes the note's DOM only while
  an input method composes; the composed text is committed through the engine when
  composition ends, so dead keys (Option-E, E for é) and IMEs type as natively. Backspace at
  the note's start, where the browser sends no input, goes to the engine from the key itself.
  → src/features/editor/desktop/input.ts `beforeInput`, src/features/editor/desktop/composition.ts,
  keys.ts
- Mod+V pastes the clipboard's plain text, read as Markdown (portable-core/clipboard.md);
  the clipboard's HTML is not read, so formatting copied from a page arrives as its plain
  text. Shift+Mod+V, Paste and Match Style, is the same paste: on macOS an Edit menu item
  sends AppKit's `pasteAsPlainText:`, which WebKit answers with a paste whose clipboard holds
  only the plain text; WebKitGTK and WebView2 bind Ctrl+Shift+V to that paste themselves. →
  input.ts `paste`, apps/tauri/src-tauri/src/app_menu.rs
- Mod+Enter opens a new line below the caret's line and Shift+Mod+Enter one above, with the
  caret on it: it is Enter at that line's end or start, so the new line follows the engine's
  Enter rules (below a heading, a paragraph); on a selected code block, beside the block
  (code-blocks.md). On Apple, Ctrl+K deletes the rest of the line
  (at its end, the line break) and keeps what it took, consecutive kills together, for
  Ctrl+Y to put back; Ctrl+T is the engine's transpose; Ctrl+O splits the line and leaves the
  caret before the break. Ctrl+Q does nothing: the app switches
  off AppKit's quote key, so the key after it keeps its own job. →
  src/features/editor/desktop/keys.ts, apps/tauri/src-tauri/src/platform_integration.rs
- The caret is drawn by the editor: the native caret is transparent and the native selection
  stays, so input methods, VoiceOver and zoom follow it. It blinks (with reduced motion on
  too, as native carets do), restarts its blink on every keystroke or move, hides while the
  editor is unfocused, and on an empty line sits at the line's start. It is 2px wide at 1x and
  2x, the nearest whole number of device pixels at a fractional scale, every edge on a device
  pixel wherever the text column sits. In formatted text it stands upright at the point
  between two glyphs (italic included) and is as tall as the line's text, inline code
  included. A font face that finishes loading after the note drew (italic, a heading's bold)
  redraws the caret and the highlight in it. → src/features/editor/desktop/caret.ts
  `measureCaret`, caretPixels.ts `snapCaretToDevicePixels`, view.ts,
  src/styles/desktop-native.css

> **Gap:** _(Linux)_ The blink is an opacity animation, which WebKit runs on its compositor at
> no cost while idle; on WebKitGTK a restart of it (and the caret's new place) can reach the
> screen a frame after the text it follows. A `visibility` blink is drawn with the page, in the
> same frame, but costs a style and paint pass on every blink.

- After an edit the engine applies (typing, Enter, a deletion, a paste, Undo, Redo, a drag
  that moves text, a composition's commit), a caret outside the pane (with a selection, its
  focus) is scrolled into it, by no more than it takes, with a row to spare; a caret inside
  the pane, a focus change, a selection change and Select All scroll nothing. → caret.ts
  `follow`, overlays.ts `revealFocus`, tests/desktop-editor-ledger-checks.mjs
- The engine's selection is the editor's one selection. Every native selection change goes to
  the engine, and the engine's answer is written back to the page when it differs (a caret
  moved out of a CRLF or hidden markup), keeping the selection's direction; Puppet reports an
  error while the two differ. Only an input method's composition leads, until it ends. →
  selection.ts `sync`
- What is drawn is always the engine's reading of the note: after every edit each drawn
  line's text, block and formats equal the engine's projection of it. A line an edit rebuilt
  that the edit's projection does not describe is read from the engine before the edit ends.
  While the page's lines differ from the engine's whole projection, or a line on screen from
  a fresh draw of it, Puppet's `doc` refuses and `state.editor` carries an `error`. → applyViewChanges.ts,
  lineModel.ts `splice`, `describeLines`, applyViewChanges.test.ts (a differential on the real
  engine), src/app/puppet/puppetTextEditor.ts `drawnDrift`
- Every mouse press in the note pane goes through one hit-test; the browser places and drags
  no selection itself. A click places the caret, a double click selects the engine's word, a
  triple click the whole line, wrapped rows included, without its break; Shift+click extends
  from the selection's anchor. A press is on the row whose band holds it: a line's rows are
  contiguous, one row height each, so its top and bottom pixels land at the pressed column on
  that row, never at the row's end, and a press in a line's bottom padding (a code block's
  skirt) is on its last row. Off the text, left of a row is its start, right of it its end
  (of a wrapped row, the end of that row, not the start of the next),
  under two line heights below the last line its row at the pointer's column, and further down
  the end of the note; a double click there is the one on the text, so past a line's end it
  selects the line's last word. A drag extends by the press's unit (a double-click drag by
  words), always holding what the press selected; coming back past the press deselects at
  once. While a drag is above or below the pane, the pane scrolls toward it, faster the further
  out, and the selection follows; nothing runs once the drag ends. A press on selected text
  that moves more than 4 px drags the text: a caret that does not blink shows where it would
  drop, and the release moves it there through the engine, its Markdown cut and pasted as one
  Undo step, and leaves it selected; a drop inside the selection moves nothing, and a press
  there that does not move places the caret. →
  src/features/editor/desktop/pointer.ts, hitTest.ts `hitAt`, lineRowAt.ts,
  tests/desktop-editor-pointer-stories.mjs
- A press in a note that does not have focus leaves the scroll where it is: the caret lands
  where the press was, not at the selection the note kept. → view.ts `focus`,
  tests/desktop-editor-pointer-stories.mjs
- A press on the chrome around the body (the tag bar, the title's row) takes focus from the
  editor and hides its caret; a key typed then, a paste and a cut edit nothing, whether or not
  the window has focus. → view.ts `takesInput`, `focusChange`,
  src/shared/dom/listenForFocusChange.ts, tests/desktop-editor-stories.mjs
- A caret at a soft wrap is on the row it was put on: the end of the upper row and the start
  of the lower one are one offset, and a press right of the upper row, Up or Down onto it, and
  Cmd+Right (End off Apple) leave the caret drawn at the upper row's end, where the next Up,
  Down or Cmd+Left starts from. Any other move or edit puts it at the lower row's start. →
  selection.ts `select`, hitTest.ts `Hit`
- Up and Down (and on Apple Ctrl+P and Ctrl+N) are the editor's: the hit-test a click at the caret's column on the next row up
  or down would make, the column kept through a run of them (so a short line in between does
  not pull the caret left) and forgotten at any other key, press or note. From the first row Up
  goes to the note's start, from the last Down to its end; a row beyond the pane is scrolled
  into it first, one row a press, the same going up as going down. With Shift the focus moves and the anchor stays; without it a selection
  collapses from its edge on that side. → src/features/editor/desktop/keys.ts `vertical`,
  hitTest.ts `verticalStop`
- The row's start and end are the editor's: Cmd+Left and Cmd+Right on Apple, Home and End
  elsewhere, go where a click left or right of the caret's row would. With Shift the focus
  moves and the anchor stays; without it a selection collapses from its edge on that side.
  Cmd+Backspace and Cmd+Delete delete the selection, else to the same place, else (the caret
  at that edge already) one character. → keys.ts, hitTest.ts `rowEdge`
- Words are the engine's: ICU4X's word segmenter with its full dictionaries, so Chinese,
  Japanese and Thai split as macOS splits them; a word never crosses a line break. Option+Left
  and Option+Right (Ctrl off Apple) go to the previous word's start and the next word's end,
  across line breaks and blank lines; with Shift the selection's focus goes there and its
  anchor stays. Option+Backspace and Option+Delete delete to the same stop. →
  crates/futo-notes-editor/src/engine/words.rs, src/features/editor/desktop/keys.ts `wordMotion`
- The selection's highlight is drawn by the editor, in `--color-selection` (the native one is
  transparent): one band per selected row, a row tall, so wrapped rows and blank lines read as
  one block, across format edges too, and a row the selection runs past, a selected line
  break included, reaches the text column's right edge; a line the selection runs into from
  above is highlighted from its left edge, a list's or a quote's indent included. Only the lines near the screen are drawn, so selecting a whole long
  note costs what one screen does. → src/features/editor/desktop/highlight.ts
- The open note is attached to the desktop host, which saves it 500 ms after the last edit
  (2 s at most). It also saves when the editor or the window loses focus, the window is
  hidden, the note is left and the app quits; a failed save keeps the note open and
  retries. A quit waits for the save for 3 s, or 15 s while it is still pending; the
  host then tries one last save, and if that fails too the app exits and logs that
  the unsaved edits are lost. → src/features/editor/desktop/attachedNote.ts,
  src/shared/lifecycle/flushBeforeExit.ts, apps/tauri/src-tauri/src/editor_host/worker.rs,
  docs/architecture/text-first-editor-desktop-host.md
- Our own work per keystroke (the input handler and the caret draw after it) is measured;
  the budget is a median under 1 ms and a p99 under 2 ms. The timings are a note's own:
  opening a note clears them. → src/features/editor/desktop/timings.ts, view.ts `open`
- A long note types as fast as a short one: an edit lays out and repaints only the chunk of
  lines it touched, and every line stays in the DOM, so selection reaches the whole note. →
  src/features/editor/desktop/lineElements.ts
- Puppet drives it with the same verbs as the other editors (`Type`, `Press`, `Select`,
  `PlaceCaret`, `Copy`, `Cut`, `Paste`, `Undo`, `Redo`) in display UTF-16 offsets, plus `PasteAndMatchStyle`,
  and with real mouse input (`click` with `count` and `shift`, `drag` with a `path` out and
  back, `count` 2 for a double-click drag, and moves past the window while held); `show
{"text"}` says where text on a line draws, so a gesture can aim at it, and the formats
  the page draws it in, piece by piece (`plain`, `bold+italic`);
  both pastes take the agent's own clipboard (`clipboard {"text","html"}`), never the OS one.
  `doc` lists every display line, its kind as drawn (blocks.md), and the note's source; `state.editor` adds the drawn caret,
  `flag` (the marks the caret's flag holds, drawn or not), `idle` (every edit acknowledged by the host and written) and `typing` (the keystroke
  timings). →
  src/app/puppet/puppetTextEditor.ts
