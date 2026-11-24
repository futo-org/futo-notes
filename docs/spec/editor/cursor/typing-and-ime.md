### Typing and IME

- The note asks the keyboard for autocorrect and sentence capitalization, and
  turns off spellcheck underlines and inline writing predictions (desktop:
  `autocorrect="on"`, `autocapitalize="sentences"`, `spellcheck="false"`,
  `writingsuggestions="false"`; iOS: `inlinePredictionType = .no`; Android keeps
  the keyboard's suggestions and drops only TextView's spell checker). A keyboard
  is not an implementation detail of the engine: an editor once shipped with
  autocorrect off alongside the squiggle fix, and every note typed on a phone lost
  autocorrect and predictive text until 2026-09-01. →
  src/features/editor/desktop/view.ts,
  apps/ios/Sources/Editor/TextFirst/TextFirstEditorController.swift,
  apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditText.kt
  `isSuggestionsEnabled`
- _(Android text-first editor)_ The keyboard disables autocorrect, suggestions and sentence capitalization inside a code block and restores the prose keyboard settings when the caret leaves code. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditText.kt `setCodeInput`
