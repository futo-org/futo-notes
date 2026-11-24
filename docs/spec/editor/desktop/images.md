### Desktop editor: images _(desktop)_

What an image is comes from the engine (portable-core/images.md): an `Image` atom inside its
line's text, its display the whole `![alt](destination)` spelling. The editor draws it and holds
no image rule of its own. Pasting and dropping an image: [paste.md](paste.md).

- An image's atom is one element in its line holding the image's spelling as text, drawn at no
  size, so the page's text, its selection and the engine's are one; a picture of the image is
  drawn after that text in the same element. The element is an inline block hanging from its
  row's top: an image beside text sits in that row, the text standing on the row's first line,
  level with a list item's bullet, number or checkbox, and a picture wider than what is left of
  the row wraps to a row of its own. In a list item, task, quote or heading it sits in that
  line's text column. → src/features/editor/desktop/pictureElements.ts, desktopImages.css
- A line holding only pictures is a block, spaced as a code block is: no page against ordinary
  text, and 4px from a picture line, code block or table right above or below it (the code
  block's touching: one block's last line right over the other's first), a heading's 12px
  above it instead when the picture line is a heading. The gap is the
  picture line's own padding, never a margin, so a press in it lands on that line, and in it
  over a picture selects that picture; between two picture lines the lower one carries it. A
  picture in a table cell keeps 4px from the row's rules. → blockNeighbours.ts,
  desktopImages.css, blockNeighbours.test.ts
- A picture is at most the text column's width and 300px tall, its proportions kept, its
  corners rounded 6px. Its `alt` is the image's alt text and its tooltip the image's title. →
  desktopImages.css, pictureElements.ts `drawPicture`
- A picture taller than a row makes that row as tall as itself, and a click and Up
  and Down measure that row so: a line's rows are line units but a picture's, and a press
  beside a picture anywhere down its height is on its row, landing in that row's first line.
  Selected text on that row is highlighted on the row's first line unit only. A line's rows start below its top padding and end above its bottom
  padding. → lineRowAt.ts `lineRows` / `lineRowAt`, caret.ts `measureCaret`, highlight.ts, hitTest.ts

> **Gap:** A picture in a table cell does not make its row tall to the highlight, a click or Up
> and Down: they read only a line's own pictures, so a cell's picture row is measured as text
> rows. → lineRowAt.ts `lineRows`

- A vault image resolves to a URL for display only, through the shell
  (`$features/images/vaultImageSrc`, on desktop `PlatformFS.getImageUrl`), relative to the
  vault's root; a remote `http:`, `https:` or `data:` image loads from its own address. Nothing
  resolved ever reaches the note. A picture is resolved and loaded only once it comes within a
  screen of the pane, so a long note pays only for the pictures scrolled to. → pictureLoading.ts
  `EditorPictures`, DesktopEditor.svelte
- A picture with nothing to load yet draws nothing. One that will not load (its file missing, or
  not synced in yet) shows its alt text, or its file's name without one, as a small muted label,
  so it can still be seen, selected and deleted. One whose file the shell could not find is asked
  for again when the shell's URLs change; one whose load failed, when the note is opened again.
  → desktopImages.css, pictureLoading.ts, features/images/vaultImageSrc.ts
  `requestVaultImageUrl`
- A picture that loads redraws the caret and the highlight. One above the pane's top that changes
  height scrolls the pane by as much, so the text being read stays still (where the web engine
  does not anchor the scroll itself). Each URL's drawn height is kept, so a picture shown again
  takes its room before it loads. → pictureLoading.ts `keepReaderStill`
- The caret stops only before and after an image, never in its spelling: before it, at the
  picture's left edge; after it, at the start of the text that follows, else at the picture's
  right edge. A caret that touches a picture taller than its text, on the picture's row, is as
  tall as the picture, from the picture's top; beside a shorter picture, or one not loaded, it
  is one text line tall on the row's first line. Left and Right step over an
  image to its other stop, and from the line above or below onto the stop beside a picture that
  starts or ends its line, the pane scrolling only as far as brings the caret in whole (a
  picture's height beside one); Shift with them takes it whole. → lineElements.ts `pointInLine`, pictureStops.ts, caret.ts `measureCaret`, keys.ts
  `besideAtom`
- A press left of a picture, on its rows, puts the caret before it, and one right of it after
  it: never across the picture. → hitTest.ts `besidePictures`
- Up from a selection held in a line of pictures alone puts the caret at the end of the line
  above, and Down at the start of the line below, as off a selected code block; with no line
  there, at the selection's start or end. → pictureLineKeys.ts, tests/desktop-editor-image-stories.mjs
- A click on a picture selects the image whole, whatever its click count, and a drag through it
  takes it whole; Up and Down onto a picture land on the side of it nearer the column. Any
  selection ending inside an image's spelling is fitted outside it by the engine
  (`place_selection`, portable-core/images.md): a caret to its nearer stop (after, on a tie),
  a selection to take it whole. → hitTest.ts `atomHit`, selection.ts `sync`
- The pointer over a picture is the arrow, not the text I-beam. → src/features/editor/desktop/desktopImages.css
- A selected picture is tinted with the selection colour over it, as the highlight behind the
  text is hidden under it, and highlighted over its own box, rounded as it is: never the rest
  of its row beside or under it, or its line's padding; on a line of pictures alone, not the
  spaces between them or its line break either. → pictureSelection.ts,
  desktopImages.css, highlight.ts, highlight.test.ts
- A selected picture joins the highlight it meets, by a code block's corner rule: a band above
  or below it that reaches its row (or its line's padding, on the line's first or last row)
  fills the room between them, over the width the two share, and squares each corner whose x
  it covers, on the picture and on that band if it is a card or a picture; text highlighted
  right beside it squares the corners whose height it covers. Two selected pictures on
  consecutive lines fill the 4px gap between them so. → joinRoundedBands.ts,
  joinRoundedBands.test.ts, tests/desktop-editor-image-stories.mjs
- Backspace with the caret right after an image, or forward Delete right before one, selects
  it; the next press deletes it, one Undo step. A word's Backspace or Delete (Option on Apple,
  Ctrl elsewhere) beside an image selects it the same way; Cmd+Backspace and Cmd+Delete delete
  to the row's edge at once, an image included. → imageDeletion.ts, keys.ts
- Enter with exactly an image selected keeps it and opens a line after it, so an image that ends
  the note can always be left (portable-core/images.md). → input.ts (the engine's Enter)
- Copying a selection that holds an image puts its spelling on the clipboard, as the note has
  it. → input.ts `copy`, tests/desktop-editor-image-stories.mjs
