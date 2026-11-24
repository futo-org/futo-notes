## Markdown elements (rendered / decorated)

- Headings h1–h6, with inline emphasis / code / wikilinks inside.
- _(Android text-first editor)_ Headings take the desktop editor's sizes and weights: h1–h6 are 1.5, 1.375, 1.25, 1.1875, 1.125 and 1.0625 times the body text, so they follow the system font size, at weights 700, 700, 600, 600, 500 and 500. Bold inside a heading is heavier than the heading (700 on a 500 heading, 800 on a 600 or 700 one) and italic keeps the heading's weight; both, and strikethrough, survive a change of level. Each visual row of an h1 or h2 is 1.25 times that heading's font size tall and each row of an h3–h6 one body line, whatever runs it mixes (inline code, bold, a link); its letters as seen (capital tops to descender bottoms) are centred in the row, and there is no other space above the first row or below the last at any level: space around a heading is empty lines. The caret stays centred on the letters inside the row. Inline markers remain hidden while moving the caret. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstSpans.kt `TfHeading`, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstGlyphMetricsTest.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstLineMetricsTest.kt
  > **Gap:** _(iOS)_ headings still use iOS's own sizes and spacing.
- Emphasis: bold, italic, bold-italic, strikethrough — `*` and `_` markers.
- Code: inline (single and double backtick) and fenced (triple backticks or
  triple tildes, with optional language).
- Fenced-code syntax coloring covers a curated language set (~35), each grammar
  fetched the first time a fence uses it. A fence in any other language still
  renders as a code block, just uncoloured.
  → src/features/editor/codeFenceLanguages.ts
- _(Android text-first editor)_ Inline code sits on a rounded chip, as on desktop: the code's letters as seen (capital tops to descender bottoms) with a tenth of its em above and below, never taller than its row, filled with the text colour at 12% so a selection or find mark shows over it; its sides reach into the whitespace beside it, up to three tenths of an em and never over a neighbouring letter. A run that wraps is one chip per row, rounded only at its real start and end. → apps/android/app/src/main/java/com/futo/notes/textfirst/InlineCodeChips.kt
- _(Android text-first editor)_ A code line's letters as seen (capital tops to descender bottoms) are centred in its row; its line number stays on its baseline. → apps/android/app/src/main/java/com/futo/notes/textfirst/TfCodeBlock.kt `chooseHeight`
- _(Android text-first editor)_ Every code-body line has the same inset, including lines added with Enter; hidden fence rows do not add another inset to the first or last body line. → crates/futo-notes-editor/src/host/style_plan.rs
- Links: `[text](url)`, autolinks `<url>`, and bare GFM URLs.
- Blockquotes, including nested: each level renders as an indented block with a
  muted left rule, however its `>` markers are spelled (`>>`, `> >`); a plain
  line under a quote is not quoted (portable-core/linedown.md "Quotes"). No `>`
  marker is on screen at any depth, so no indent shifts
  when the caret enters a quote. → src/features/editor/desktop/desktopEditor.css,
  tests/desktop-editor-block-stories.mjs
- _(Android text-first editor)_ Empty editable lines have the same height as ordinary text lines, including between a quote line and the next line; typing on an empty line does not expand the gap. → crates/futo-notes-editor/src/host/style_plan.rs
- _(Android text-first editor)_ Block styling remains visible while the keyboard composes a word, including the first character on an empty quote, heading or code line; a quote's margin does not extend into the following plain line. → apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstBlockIndicatorTest.kt
- Lists: ordered, unordered, nested, and task checkboxes (checked / unchecked /
  uppercase `X`).
- An empty list item shows its marker: a bullet, number or checkbox started from
  the toolbar or by Enter is drawn before anything is typed. →
  tests/desktop-editor-block-stories.mjs "Enter continues a list, and on an empty
  item leaves it", apps/ios/Tests/Editor/TextFirst/TextFirstListMarkerTests.swift
  `anEmptyTaskKeepsItsCheckboxPositionWhenTypedInto`
- _(Android text-first editor)_ In a right-to-left paragraph a code line's number sits on the right, between the block's edge and its rule, and a selected photo's or table row's tint covers the photo or the grid as drawn. → apps/android/app/src/main/java/com/futo/notes/textfirst/CodeGutter.kt, ImageSelectionTint.kt `imageDrawnRect`, TableSelectionPaint.kt
- _(Android text-first editor)_ A right-to-left paragraph (Hebrew, Arabic) draws its list number, bullet, task checkbox and quote bars on its right, beside where its text starts, and a tap there toggles the checkbox. The toggle's touch area is the task's marker unit, from beside where the text starts across the marker column: taps on blank padding, below the content, in a wrapped continuation's gutter or on the text (its first letter included) place the caret and leave the task as it was. → apps/android/app/src/main/java/com/futo/notes/textfirst/TfListMarker.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstSpans.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstCheckbox.kt, apps/android/app/src/test/java/com/futo/notes/textfirst/RtlListMarkerTest.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTapGestureTest.kt
- Nesting indentation is BOUNDED, so a deeply nested list stays readable at
  phone width: levels one to four indent 1.4em each, five to eight 0.7em, and
  from level nine the indent stops growing — at most 8.4em (143px) in total,
  which leaves ~187px of column at ANY depth on a 402px screen. Before this, a
  590-byte note holding one bullet nested 20 levels deep opened to a completely
  blank body: a `padding-left` larger than its container shrinks the content box
  instead of overflowing it, so levels 13+ computed to ZERO width, 14+ started
  past the right edge, `scrollWidth === clientWidth` left nothing to scroll to,
  and the load-time viewport parked in the empty region. Ordinary one-to-three
  level lists are unchanged; past level eight the levels stop being told apart
  by their left edge, which is the deliberate half of the trade. Measured at
  402x874. → src/features/editor/desktop/desktopEditor.css, desktop/blocks.md,
  apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstSpans.kt,
  apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstGlyphMetricsTest.kt
  `deepListIndentStopsConsumingThePhoneColumn`

- A list item that wraps **hanging-indents** its continuation lines: wrapped
  rows start under the item's text, never back under its marker, while the
  first visual row still starts at the nesting indent. Applies to bullets,
  ordered items, and task items at every nesting depth, on every platform
  (spec decision 2026-08-14, reversing the 2026-06-10 decision that put
  wrapped rows at the left margin). →
  desktop/blocks.md, src/features/editor/desktop/desktopEditor.css
- Tables (GFM), horizontal rules, and images render as themselves. A table
  scrolls sideways inside its own box rather than widening the note; an image is
  capped at the column width and 300px tall. →
  desktop/tables.md, desktop/images.md, src/features/editor/desktop/desktopTables.css
- Wikilinks `[[Title]]`.

### YAML front matter

- A note that OPENS with a `---` fence, closed by a later `---` fence, carries
  YAML front matter: the two fences and everything between them are metadata,
  not markdown. The bytes survive every edit made elsewhere in the note
  byte-for-byte — brackets, hashes, asterisks, quotes, indentation, trailing
  spaces and interior blank lines included. Front matter is not markdown, so
  there is no re-spelling of it that preserves its meaning to the tools that
  read it. → portable-core/foreign-content.md, desktop/tags.md
- Both fences must be exactly `---`, the first on the note's first line. `--- `,
  ` ---`, `----` and a `---` with no closing fence open no front matter: they
  read as Linedown reads any line, and a `---` anywhere but the first line is a
  divider unless it closes front matter. (`+++` TOML front matter is not
  recognized and stays the plain lines it was typed as.) →
  portable-core/foreign-content.md, portable-core/linedown.md "Front matter"
- The block is RENDERED, as one inert metadata panel above the body: muted, monospace, with a left rule, and no
  caret. It cannot be typed into, clicked into, dragged, or reordered — the
  editor has no YAML model, so it shows the bytes and refuses to edit them.
  Deleting the whole note still deletes it. →
  desktop/tags.md, src/features/editor/desktop/desktopTags.css
- _(Android text-first editor)_ An ordered item's marker unit is as wide as its complete number and text gap, so wider numbers can give their item a wider text column. Wrapped and continued text hangs at that item's column while retaining the base nesting indentation; number-only style updates reflow the column and restore it when the number narrows. → apps/android/app/src/main/java/com/futo/notes/textfirst/ListMarkerColumn.kt, TfListMarker.kt, TextFirstSpans.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstGlyphMetricsTest.kt `orderedMarkerInkSurvivesTheNativeViewClip`, `numberMetadataAloneReflowsItsHangingContinuation`
