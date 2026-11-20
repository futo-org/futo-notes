# Desktop editor on the Rust engine

Decisions from the 2026-11-02/03 design grill with Mason. Desktop replaces Milkdown with our own
renderer on `crates/futo-notes-editor` (WASM `WasmSession`); mobile keeps Milkdown until Justin's
native editors land. Mason and Claude own the desktop editor and host; Justin owns mobile and
reviews engine changes. Delete this file in the commit that ships the MR.

## Architecture

- A `contenteditable` surface that intercepts `beforeinput`; a plain TypeScript DOM renderer, not
  Svelte per block, and no CodeMirror.
- Replace Milkdown on this branch, one MR at the end. Start small and build out slice by slice.
- Port today's look, except the line rhythm: every row is one fixed line unit and anything
  taller is a whole number of lines (Mason, 2026-11-03), but for a first- and second-level
  heading's rows, 30px and 28px with no space around them, as on Android (Mason, 2026-11-20).
  The desktop title field stays separate from the body.
- We change the engine when a behavior needs it; Justin reviews. Note rules stay in Rust.
- macOS is checked here; Windows and Linux on masons-desktop.
- The host attachment is the one owner of the open note: which note it is, its source,
  its saved state and every rename or park. The note session follows what the editor
  reports and keeps only the title's rename debounce (Mason, 2026-11-03: fix races
  fundamentals-first).
- After a save parks the draft (a peer or outside edit landed while it was dirty), the editor
  stays on the draft in its conflict copy, as iOS and Android do; main's desktop showed the
  original instead (Mason, 2026-11-04, 1A).
- A crash between a pulled rename's file move and the sync checkpoint stays a recorded Gap
  (`remote-edits-to-the-open-note.md`); push does not learn content-based rename detection
  for it (Mason, 2026-11-04, 2A).
- The page applies edits at once (the recovery log is gone, f996e7996). Saves are the host's
  debounced whole-note save, plus editor blur, app blur, window hidden or minimized, and
  sleep, lock, logout or shutdown.
- No virtualization and no gigabyte notes for now; `docs/learnings/large-file-editing.md` has the
  plan if measurement says otherwise.
- Typing budget: our own work per keystroke has a median under 1 ms and p99 under 2 ms, measured
  on the MacBook's 120 Hz display, from slice 1 on.
- Spellcheck stays off in the editor (Mason, 2026-11-04, 6B).
- VoiceOver, Narrator and Orca must work before the MR (Mason, 2026-11-04, 7A).

## Puppet and tests

- Puppet keeps its verb names, addresses the editor by engine display offsets, and `doc` shows the
  display lines plus the source. Puppet input goes through the same `beforeinput` path.
- A slice is done only when it works through Puppet with an idle signal.
- Puppet stories replace the desktop Playwright editor specs, which are deleted as stories cover
  them. Vitest covers pure logic. Stories run in macOS CI and join `release:gate.needs`.
- The 12 non-editor Playwright specs move to Puppet in a separate session and MR.
- The pointer gets a Puppet matrix; `drag` gains a `path` option.

## Caret, selection and pointer

- The caret is drawn by us from slice 1: the native caret is transparent and the native selection
  stays, so IME, VoiceOver and zoom still follow it.
- The engine's selection is the authority, and the native selection is always the same range, so
  VoiceOver, input methods and Puppet read what is drawn. We draw the highlight, line breaks and
  atoms included; the native highlight is transparent. One `--selection` color token (Mason,
  2026-11-04).
- One owner: every native selection change goes into the engine, and the engine's answer is
  written back when it differs; every engine change is written to the page by one function. The
  caret, the highlight and Puppet read the engine's selection, and Puppet reports an error when
  the two differ. Only an input method's composition leads; the engine takes over when it ends
  (Mason, 2026-11-04).
- A double click past a line's end selects the line's last word (Mason, 2026-11-04, 3B).
- A triple click selects the whole line, wrapped rows included, without its line break (Mason,
  2026-11-04, 5B).
- Words come from the engine: ICU4X's word segmenter with its full dictionaries, so Chinese,
  Japanese and Southeast Asian scripts split as macOS does. Double click, Option+Arrow and
  Option+Backspace all use it, atoms counting as one word. It adds 3.1 MB to the WASM and 1.9 MB
  to the download; the smaller LSTM data splits Thai and Lao wrongly (Mason, 2026-11-04, 4A).
- We handle every mouse gesture in the note pane with one hit-test. Off-text presses follow
  !300's rules: left space → line start, right space → line end, under 2 line heights below →
  the pointer's column on the last row, further → end of note; off-text double click equals the
  on-text one; the tag row is chrome. Distances are to tune.
- Dragging back past the press point deselects at once. Auto-scroll while dragging (feel to tune).
- `resolve_selection(anchor, head)` lives in the engine (added with the first atom, slice 4). A
  selection started outside a code block takes the whole block; atoms such as `---` copy as their
  source.
- Up/Down are ours: the same hit-test as a click at the remembered column on the next text row.
- Drag-to-move selected text goes through the engine as one Undo step.

## Atoms

- A click selects an atom whole; the caret jumps over it; Shift-extend and drags take it whole.
- Backspace next to an image selects it first and deletes on the second press; chips and dividers
  delete at once. Arrow keys enter code blocks (their chrome is click-only).
- A copied image goes to the clipboard as its `![alt](src)` text. A right-click "Copy image" may
  come later.

## Code blocks

- !300's feature set, implemented more simply.
- The anchor picks the area. Shift+Up/Down at a block's edge continues outward. Cmd+A inside
  selects the code, a second Cmd+A the note. Copying a whole block includes its fences.
- Header fields: Tab walks name → language → code; Shift-Tab walks language → name, and reaches
  the language from the code only at the very start of the first line. Enter in a field goes to
  the code. A field edit is one engine edit and one Undo step on the fence (new engine command).
- Inside code the toolbar shows only Highlight and Lowlight; format shortcuts do nothing.

## Format edges and the flag

- At an edge the caret takes the side it came from; inline code's edges are two stops, inside
  and outside; a click takes the side under the pointer; Up, Down and the row ends land on the
  character before (spec: editor/desktop/editing.md). A link never grows at either edge. The
  older rules (more formatting, always left, always right) stay a prototype toggle.
- A format shortcut with no selection arms a pending format and writes nothing; moving the
  caret drops it. The full rule is in "Source-preserving formatting" below.
- Right moves one visual character, but at inline code's edge it first changes sides. At the end of a line inside formatting, Right turns the
  formatting off and adds a pending space only when the previous character is not a space;
  nothing is written until you type.
- The flag is the Solid pennant on the caret, shown whenever the caret is in formatted text: inline
  formats and heading level. No fade. Hiding while typing is a prototype toggle.
- The rules are tuned by feel in slice 3, behind prototype toggles, once formats are drawn.

## Source-preserving formatting (Mason with Justin, 2026-11-10)

The agreed contract for every editor on the engine. Rationale, and the choices not taken, are
in ADR 0013 (`docs/adr/0013-source-preserving-markdown-and-editing-preview.md`, engine branch
`mason/source-preserving-markdown`, not on this branch yet). The Rust changes are that
branch's: this branch does not change engine semantics for it, and draws and dispatches what
the engine gives once it lands. None of it is built or checked here yet.

1. At a collapsed caret a format command (Bold, Italic and the rest) arms a pending format. It
   inserts no empty markers. Typing the first character writes the real markers around it.
2. Backspacing the last character inside the markers removes the now-empty markers and returns
   to the pending format; typing again writes them again.
3. Moving the caret or the selection yourself clears the pending format. The caret moving
   because you typed or backspaced does not, and neither does an input method's own echo. It
   is never a setting that lasts.
4. Ordinary typing, replacing and deleting never escape punctuation, write numeric entities or
   rewrite untouched neighbours to keep how the text looked. Escapes and entities the author
   wrote stay as written outside the edited range. Opening a note reads its Markdown as it is:
   no unescaping or migration of existing notes.
5. Structural commands and defined typing patterns may change syntax (Backspace at `- |` takes
   the list prefix; a structural list join may remove markers); an ordinary replacement never
   does so on the side. The engine's edit intent tells the two apart, in the shared command
   layer; the shells only dispatch.
6. A space typed at the end of formatted text is saved outside the closing markers, so the
   formatted word stays valid Markdown: `**word|**` and Space give `**word** |`. Typing on in
   the same typing sequence takes that space back inside with the new text: `**word next|**`.
   Backspacing the space in that sequence puts the caret back inside the markers. Moving the
   caret yourself ends the sequence, and coming back does not restart it; the caret moving
   because you typed, and an input method's echo, do not end it. This is one authorised typing
   rule that moves a space, in the shared engine for every host; it brings back no escaping,
   entities or other neighbour repair. It covers the inline formats whose syntax allows it;
   links, code and blocks keep their own whitespace rules until looked at, and repeated spaces,
   line breaks and nesting follow the existing contracts.
   Superseded the same day: keeping the space inside the markers (`**word |**`) and holding
   the bold drawing while the Markdown was briefly invalid. No timer or held rendering is
   built for it.
7. Formatting already in the source under a caret you moved there still follows the source:
   clearing a pending format never makes formatted text plain.

For this branch: the format-edge rules above (which side a caret joins, Right at a line's end)
are tuned on top of this contract, and a rule that would need the page to hold a Markdown rule
of its own goes to the engine instead. Open, not approved by this handoff: the private
exact-source caret mapping proposal.

## Tables

- In this MR before merge, in their own slice. Table selection behavior is deferred.

## Specs

- Editor specs split into `docs/spec/editor/shared/` (the engine, from `portable-core/`),
  `desktop/` (ours) and `mobile/` (Justin's; today's Milkdown docs). Justin agreed. The README
  conventions change with it.

## Ledger

- `docs/plan/desktop-editor-ledger/` holds 315 behaviour rules gathered from the app's history
  (merge requests, commits, deleted plans, specs) and Mason's Android text-first notes
  (2026-11-10). Each row names its slice. A slice is done when its rows pass; by the merge every
  row is a spec line or a story and the ledger is deleted.
- Decided 2026-11-10 (Mason): typed Markdown stays as typed in the file, never silently escaped,
  and draws as formatting when it forms valid Markdown (see "Source-preserving formatting");
  headings take bold, italic,
  strikethrough and code; the toolbar shows what is on for the caret or selection, disables what
  cannot apply, and an active button turns its format off.

## Slices

1. Open and render paragraphs and headings; typing, deletion, Enter, Undo/Redo, plain paste and
   composition through `beforeinput`; the drawn caret; saves and triggers; Puppet `type`,
   `press`, `doc`, caret and idle; typing timings.
2. Pointer: whole-pane mouse handling, off-text rules, auto-scroll, selection paint,
   drag-to-move, Puppet `drag` path and matrix. Built (2026-11-09); `resolve_selection` has
   nothing to resolve until atoms and code blocks exist, so the atom rules land in slices 4–5
   and the code-block one in 6.
3. Inline formats: toolbar, shortcuts, format edges and the flag. The edge and flag rules are
   tuned here, on the drawn formats, behind prototype toggles (Mason, 2026-11-09: they need
   real bold and headings to be felt). Step 1 is built (2026-11-10): bold, italic,
   strikethrough and inline code draw in body text and headings, from the engine's runs;
   bold in a heading uses a Barlow 800 face the desktop editor loads. The rest is built
   (2026-11-10): the format and heading shortcuts, the selection toolbar (lit from the
   engine's runs, disabled in inline code), the caret's flag, and the edge rule, with the
   edge rule and hiding the flag while typing as debug toggles in the note's ⋮ menu (dev
   builds) to tune by feel. Waiting on the `mason/source-preserving-markdown` branch: the
   pending format surviving a Backspace of its last character, the space saved outside the
   markers, typed markers kept as typed, and Right at a formatted line's end turning
   formatting off with a pending space. A link never growing at an edge comes with links
   (slice 5). The engine's `toolbar_state` (session/toolbar.rs) is not in the WASM yet; the
   toolbar reads the runs, which give the same answer for inline formats.
4. Lists, tasks, quotes and dividers. Tab and Shift+Tab indent and dedent a list item; on a
   text line they already add and remove a leading tab (Mason, 2026-11-04). Built
   (2026-11-10): each line draws its engine block (bullets, numbers, task checkboxes, quote
   bars, the divider's rule) as classes and CSS, a task's checkbox toggling through the
   engine's `ToggleTask`, and the divider as an atom (a click and a drag take it whole); the
   keys are the engine's, plus Mod+Alt+7, Mod+Alt+8 and Mod+Shift+B
   (`docs/spec/editor/desktop/blocks.md`). The engine has no `resolve_selection` yet: the
   divider's display text is one character, so the caret has no place inside it without one.
5. Links, wikilinks (chips and completion) and images (paste and copy).
6. Code blocks.
7. Find, tag bar, front matter and rich paste. Rich paste is done: Mod+V pastes the HTML form
   as Markdown when it holds formatting, Shift+Mod+V the plain text (Mason, 2026-11-05).
8. Outside changes: a three-way merge adopted as one edit.
9. Tables.
10. Merge bar: parity through Puppet, macOS CI in the gate, the typing budget met, Windows and
    Linux checked, VoiceOver, Narrator and Orca working, Milkdown and its Playwright editor specs gone from desktop, `just check`
    green, Justin's review.

Later, not yet in a slice:

- Research and tune Undo in general, how typing groups into Undo steps and what each step
  selects (Mason, 2026-11-05).
- Progressive open (Mason, 2026-11-10): draw a note's first screen at once and the rest in the
  background, with an indicator for a slow open, and a press on another note taking over at
  once. Measured on the 58,000-line note (debug build): 1.1 s in the host, then 1.7 s of layout
  and paint that block the page, so a press during the open waits for all of it. Open
  question from the same day: one long-lived dev session spent over 3 s building the line
  elements (40 ms in a fresh app), not reproduced.
