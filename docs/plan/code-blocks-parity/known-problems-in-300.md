# Known problems in !300

Each entry is a candidate to do better.

- `cb 131-141`: Gap: Shift-Down/Shift-Up cannot extend a selection out of a block. A keyboard user must move the caret out first.
- `cb 213-216`: Gap: on Android (Blink), typing over a selected block that ends the note leaves a spare empty line (`X\n`, not `X`).
- `cb 255-260`: Gap: in light theme the translucent selection lowers syntax-token contrast inside the well (weakest token 2.62:1 to 2.13:1). No token meets WCAG AA, selected or not.
- `cb 524-527`: Gap: the fence markers are real text in the accessibility tree, so a screen reader announces the three-backtick markers.
- `cb 567-573`: Gap: the iOS ring-and-tint treatment for a fully selected block is not implemented. iOS shows the ordinary fill under UIKit's overlay (darker bands).
- `cb 574-582`: Gap: on iOS the native overlay paints the raw range, so a drag out of a block shows a native highlight running into the prose.
- `ed 293-297`: Gap: the WKWebView triple-click collapse was never reproduced outside the real app. Only a real triple click in the desktop app confirms it.
- `l10n 74-81`: Gap: the block's chrome strings (placeholders, copy-chip title, add-a-line labels, mark buttons, code toolbar accessibility label) are hard-coded English. Only the toasts are translated.
- `cb 459-463`: Unverified: the Android handle-drag behaviour that the fence-row design protects is checked only by hand. No test runs against a real Android WebView.
- `cb 126-130`: Admitted cost: pressing exactly on a content edge and dragging outward selects nothing and paints nothing.
- `cb 374-379 vs cb 679-685`: Contradiction: "A MOUSE click on the name field edits it, wherever the caret was" against "a click or tap on it edits only while the block is active … otherwise it selects the block".
- `cb 877-879 vs cb 397-401, cb 536-539`: Contradiction: "Select All — is an ordinary selection and CM6 paints it" against "ONE painter draws EVERY selection" and "CodeMirror's own selection rectangles are hidden whenever a non-empty selection exists".
- `cb 402-408 vs cb 540-543`: Contradiction: "Its rectangle is the union of the DOM `Range` client rects" against "every partly covered line is drawn by CM6's own `RectangleMarker.forRange`".
- `cb 929-932 vs cb 726-731`: Contradiction: a caret "already parked on one [fence] by a document change stays there" against "A change that lands the caret ON a fence line is corrected".
- `cb 985-986 vs cb 732-735`: Contradiction: "a block with no content line at all" against "A block always keeps at least ONE content line".
- `cb 48-55`: Ambiguous: the language is "Everything before the first recognized key" and also "always ONE whitespace-free token". The chip's capitalised display label ("C sharp") is implied but not stated.
- `cb 57`: Unstated: "a line carries at most one mark", but which mark wins when a file lists a line in both `hl:` and `ll:` is not stated.
- `cb 226-238`: Task-premise conflict: the brief calls marks following their lines an improvement on !300, but !300's spec says it already did this, with merge rules.
- `cb 988-989`: Unstated: whether Enter in code carries the line's leading whitespace ("a plain newline").
- `cb 969-970`: Unstated: the unit Tab indents by inside code, and whether it inserts at the caret or indents the line.
- `cb 194-198 vs cb 711-716`: Unstated: whether a paste over a selection that crosses a block's edge widens to take the block, or is suppressed.
- `ed 697-699`: Ambiguous: the third-backtick rule tests "the REST OF THE LINE", but the reason given is "a block cannot be opened in the middle of a sentence". Text BEFORE the backticks is not addressed.
- `ed 763-769`: Unstated: what the slash menu's "code" item inserts.
- `cb 77-80 vs ed 757-760`: Contradiction: inside a block the selection toolbar "shows ONLY Highlight and Lowlight" and "The one-line-only rule lifts", against the toolbar that "hides for empty/multi-line selections and inside tables/code".
- `ed 841-842 vs ed 782`: Contradiction: "Indent/Outdent stay live inside code" against the phone toolbar's "Indent/Outdent (shown when the cursor is on a list line)".
- `cb 946-953 vs ed 312-315, ed 674-676`: Ambiguous: Backspace on a line with text below a block "is only selected", but list/quote continuation claims Backspace "ahead of every CM6 keymap". Which wins on a list item or quote line below a block is not stated.
- `cb 872-876`: Unstated: where the caret or selection ends up when an arrow press on a selected block "is consumed" with nowhere to go.
