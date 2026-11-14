## Markdown toolbar _(native shells / editor-embed fallback)_

Mobile renders native toolbar chrome from the shared item manifest and dispatches
editing through Rust editor sessions. Desktop uses the floating selection toolbar;
the standalone browser fixture retains its web toolbar. → packages/editor/src/toolbar.ts,
apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Toolbar.swift,
apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstToolbar.kt

- [Toolbar commands](markdown-toolbar/toolbar-commands.md)
- [Native toolbar chrome](markdown-toolbar/native-toolbar-chrome.md)
