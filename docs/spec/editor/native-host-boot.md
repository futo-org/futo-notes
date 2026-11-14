# Native editor boot

- *(mobile)* Release and debug builds open notes in native views backed by the Rust Linedown engine; there is no web-editor fallback or renderer-selection preference. → apps/ios/Sources/Notes/List/NoteListView.swift, apps/android/app/src/main/java/com/futo/notes/MainActivityShell.kt
- *(mobile)* Builds regenerate Rust bindings and native resources, and never bundle or load `editor.html`. → just/mobile.justfile
- *(desktop)* The editor continues to use Milkdown and ProseMirror. → src/features/editor/milkdown/

Native session, rendering, saving and input behavior is specified in [mobile](mobile.md) and [portable-core](portable-core.md).
