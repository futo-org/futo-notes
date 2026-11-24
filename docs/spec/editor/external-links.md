## External links

- *(desktop)* Clicking an external link opens the system browser. Scrolling or dragging from a link does not open it; separate rapid clicks each open the URL. → src/features/editor/desktop/linkPress.ts, linkTarget.ts, tests/desktop-editor-link-stories.mjs
- *(mobile)* Native link taps ask the Rust engine for the destination and use a scheme-guarded OS open (`UIApplication.open` / `ACTION_VIEW`); they never navigate an editor web page. → crates/futo-notes-ffi/src/editor/links.rs, apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Links.swift, apps/android/app/src/main/java/com/futo/notes/ui/ExternalLinks.kt

  > **Gap:** _(Android, desktop)_ the iOS guard (`TextFirstEditorController.externalLinkURL`, also used by the
  > native text-first editor's link taps) opens `sms:` links, matching the engine's link rule
  > (`http`, `https`, `mailto`, `tel`, `sms`); Android's `openExternalUrl` in
  > `ExternalLinks.kt` and the desktop host's openers (`open_url_behind.rs`) still deny `sms:`.
  > The set is pinned on iOS in `TextFirstLinkTests.swift`.

- Only the link's own glyphs open it: the hit is the anchor element under the
  pointer, so clicking the blank space past the end of a link — including a link
  that wraps onto several visual lines — places the caret instead of opening the
  URL. → src/features/editor/desktop/linkPress.ts, tests/desktop-editor-link-stories.mjs

- The portable replacement core preserves canonical link meaning, exact source and transient input lifetimes through correction, Code, structural commands, own-action relinks and saving; its source contract is [link editing and source ownership](portable-core/links.md). Native mobile consumes this contract through the Rust session. → crates/futo-notes-editor/src/link_target.rs, crates/futo-notes-ffi/src/editor/links.rs

- *(Android native text-first editor)* A link whose destination has no scheme but names a host (`futo.org`, `www.example.org/a`) opens over `https`. A tap on a link the system cannot open — another scheme, a note file name such as `other.md`, no app to handle it — is an ordinary tap that places the caret, never swallowed. → apps/android/app/src/main/java/com/futo/notes/ui/ExternalLinks.kt `externalLinkTarget`, apps/android/app/src/main/java/com/futo/notes/textfirst/ExternalLinkTouch.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTapGestureTest.kt
- *(Android native text-first editor)* The keyboard toolbar's Link action opens a native form with link text and destination. A selection supplies its visible label; a caret inside an existing link supplies the complete link label and current destination. → apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineLinks.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstLinkDialog.kt
- *(Android native text-first editor)* Add or Update submits one canonical engine edit and one Undo step, preserving surrounding source; saving and reopening retain the intended label and destination. → apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstLinkTest.kt
- *(Android native text-first editor)* Remove link retains its label, including existing formatting; Cancel changes no text or history. → apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineLinks.kt
- *(Android native text-first editor)* Composition settles before the form opens; input or an attachment change while it is open invalidates the form's claim instead of editing another range or note. → apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstLinkTest.kt
