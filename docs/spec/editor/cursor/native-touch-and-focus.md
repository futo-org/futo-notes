### Native touch and focus

- _(iOS)_ Return or Done in the title transfers focus to the note's current editor, so the next keystroke edits the body. → apps/ios/Sources/Notes/Editor/TitleTextField.swift `onSubmit`, apps/ios/UITests/TextFirstSelectionUITests.swift `testTitleReturnHandsTypingToTheNativeBody`
- Tapping an unfocused editor places the caret at the tap and raises the
  keyboard; wrapped-line taps remain on the tapped visual row. On-text and
  off-text placement alike are the platform's own contenteditable behavior.
  _(native shells)_
- A caret the keyboard rises over is scrolled back into view as the keyboard
  lands: tap the last word of a note that fills the screen and that word ends up
  above the keyboard and its toolbar straight away, not on the first keystroke.
  ProseMirror only scrolls on its own transactions and a tap is not one, so the
  embed re-reveals the selection whenever the shell resizes the web view under a
  focused editor. On Android the editor column's `imePadding` really does resize
  the web view (a window `resize` for each frame of the keyboard animation), and
  the System WebView also scrolls the focused caret into view by itself: with the
  embed's reveal suppressed the tapped line still ended up above the toolbar.
  The embed's reveal is what iOS needs and is harmless there. Verified on the
  emulator (API 36, System WebView 133.0.6943.137) 2026-09-23. _(native
  shells)_ → src/editor-embed/main.ts `resize` listener,
  src/features/editor/milkdown/hostHandleView.ts `revealSelection`

- The editor reserves a tail below the last line — `max(40vh, 280px)` of bottom
  padding on the editable — so the final line can be scrolled clear of the
  keyboard. The tail scales with the viewport, so a note that does not fill the
  screen still has nothing to scroll. →
  src/features/editor/milkdown/milkdownEditor.css `.ProseMirror` padding

- Native-shell policy comes from the host-provided `nativeShell` mode: it is
  what selects the long-press block drag over the ⠿ gutter handle, and what
  turns on the native-toolbar layout. → packages/editor/src/hostBoot.ts,
  src/features/editor/milkdown/blockDragMode.ts `resolveBlockDragMode`
- On-text double/triple-tap selection, selection handles, the loupe and the
  platform callout are all native on both shells; the editor adds nothing to
  them and takes nothing away, except while a block-drag press is live (see
  "Selection"). _(native shells)_
- *(Android text-first editor)* A double tap on a word selects that word even where the platform's own double tap leaves only a caret (seen on Samsung One UI 8.5, Android 16); a double tap on spaces or punctuation adds no selection. → apps/android/app/src/main/java/com/futo/notes/textfirst/LineSelectTouch.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTapGestureTest.kt
- *(Android text-first editor)* A triple tap selects the logical line, including its wrapped rows, and opens the platform's selection handles and callout on every sequence. → apps/android/app/src/main/java/com/futo/notes/textfirst/LineSelectTouch.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTapGestureTest.kt
- *(Android text-first editor)* Platform classification supplies smart callout actions without asynchronously expanding or restoring an earlier selection range. → apps/android/app/src/main/java/com/futo/notes/textfirst/SelectionTextClassifier.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTapGestureTest.kt
- *(Android text-first editor)* Select All preserves the note's current scroll position, and so does ending it: closing the text menu (Back) or dropping the keyboard ends the range at its end without moving the note. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextReveal.kt, TextFirstRenderHold.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstCaretFollowTest.kt, TextFirstBlurTest.kt
- *(Android text-first editor)* Gboard's Text editing Select mode and hardware Shift+arrow keys extend and narrow selections in note text and table cells, including the first selection immediately after typing in a new note; releasing Shift returns arrows to ordinary caret movement. Selection movement changes neither note bytes nor Undo history. Verified on the emulator 2026-11-07. → apps/android/app/src/main/java/com/futo/notes/textfirst/EngineInputConnection.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TableCellEditText.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/ChunkedSelectionNotifications.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstSelectionKeysTest.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/ChunkedEditableTest.kt
- *(Android text-first editor)* Inline formatting and background styling retain the native keyboard selection anchor when displayed text and the canonical range stay unchanged; the next Shift+arrow continues from the same end. Full resets and changed canonical ranges apply their new selection. Verified on the emulator 2026-11-07. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextUpdates.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextStyling.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstSelectionKeysTest.kt
- *(Android text-first editor)* Selection highlights cover visible text up to the editor's top edge while the note is scrolled. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextCode.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstCaretFollowTest.kt
- *(Android text-first editor)* Note text scrolls up to the editor's top edge and is clipped there, never drawn over the title row above it; while the note is scrolled a 1dp border-colour hairline marks that edge, so a heading cut at it reads as scrolled under the title row. Verified emulator 2026-11-05 (pancakes and journal H1s, keyboard open). → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextCode.kt `drawScrollEdge`
- *(Android text-first editor)* The keyboard receives canonical selection and composition coordinates even while the visible note is a prefix. Surrounding context is bounded and surrogate-safe; an oversized selected range omits keyboard context while canonical Copy and input replacement retain the full selection. → apps/android/app/src/main/java/com/futo/notes/textfirst/EngineImeState.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstIme.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/EngineInputConnectionModern.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstStreamingCommandsTest.kt
- *(Android text-first editor)* A keyboard correction that selects text and commits its replacement inside one batch edit (Gboard's double-space period) is one [text-service replacement](../portable-core/interpretation-and-input.md): Undo restores the source and the collapsed caret the correction started from, not the range it selected, and the next typed text lands there, also when the keyboard reads the selected text, the text around the caret or the extracted text during the batch. → apps/android/app/src/main/java/com/futo/notes/textfirst/EngineInputConnection.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstExitTest.kt `undoAfterKeyboardPeriodRestoresTheOpeningCaret`, `readingTheKeyboardReplacementRangeKeepsTheOpeningCaret`
- *(Android native text-first editor)* Tapping to move the caret settles any keyboard composition or reconversion before selecting the tapped position; leaving a suggested word does not require accepting a keyboard suggestion. → apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngine.kt `select`
- *(Android native text-first editor)* A tap or handle drag made while an earlier command is still running (a whole-note format toggle) is applied after that command, carried through its display edits, and shown again over the command's result: the next typed key lands at the tapped caret, never over the selection the tap left, and a tapped table cell still opens. → apps/android/app/src/main/java/com/futo/notes/textfirst/ViewEditJournal.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineTables.kt `selectDisplayRange`, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTapDuringCommandTest.kt
