## Markdown toolbar _(native shells / editor-embed fallback)_

The shipping toolbar surface belongs to the native shells. The Tauri desktop
shell uses the floating selection toolbar described above. The standalone editor
embed retains a web toolbar as a bridge
fallback, but iOS and Android call `setNativeToolbar(true)` and render native
toolbar chrome instead. → src/editor-embed/EmbedToolbar.svelte,
EditorWebView.swift, EditorWebView.kt

- [Toolbar commands](markdown-toolbar/toolbar-commands.md)
- [Native toolbar chrome](markdown-toolbar/native-toolbar-chrome.md)
