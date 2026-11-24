### Placement

- Tapping text places the caret at the tapped character. →
  src/features/editor/desktop/hitTest.ts, apps/ios/UITests/TextFirstSelectionUITests.swift
  `testSingleTapsInNestedTextInsertWithoutReplacingTheWord`
- Caret placement, arrow motion, word/paragraph selection on multi-tap, and
  drag-selection are the PLATFORM's own: the editor runs no pointer hit-testing
  or cursor-motion code of its own. (The CodeMirror editor did, because a
  live-preview document has hidden source a native hit test would place a caret
  inside; there is no hidden source here.) _(iOS, Android)_ The desktop editor
  answers every press itself, through one hit-test (desktop/editing.md).

- Pressing Enter in a continued list item scrolls the new item into view. →
  docs/learnings/ios-keyboard-editor-jump.md _(iOS)_

- _(Android text-first editor)_ The caret, in the note and in a table cell's field, is the app's accent colour in light and dark, following a theme change, as the selection highlight and handles do. In the note it is as tall as the font of the text at it (its ascent to its descent; in code, body text's) and centred on that text as seen, as far above its capitals as below its descenders, inside its row: a line a span makes taller than its text (an h1's two body lines, a code block's label header) does not stretch it. Android 9 has no cursor drawable setter and keeps the platform caret. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextCaret.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/CaretAndHandleTint.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstCaretTest.kt `caretOnAHeadingIsTheHeightOfItsText`, `caretOnBodyTextIsCentredOnItsLetters`
  > **Gap:** _(Android)_ the selection highlight still covers a line's added height, such as a code block's label header.
