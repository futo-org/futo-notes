# Editor — Spec

The editor is a shared WYSIWYG WebView — Milkdown on ProseMirror, the **same
`editor.html` / `packages/editor` bytes on all platforms**. A note is parsed
into a document when it opens and serialized back to Markdown when it saves; its
source markers are never on screen. This file states the behaviors a human cares
about.

- [Native host boot _(iOS/Android)_](editor/native-host-boot.md)
- [Theming](editor/theming.md)
- [WYSIWYG rendering](editor/wysiwyg-rendering.md)
- [Paragraphs and lines](editor/paragraphs-and-lines.md)
- [Markdown house style — what a save writes](editor/markdown-house-style.md)
- [Localization](editor/localization.md)
- [Cursor](editor/cursor.md)
- [Markdown elements (rendered / decorated)](editor/markdown-elements.md)
- [Tags](editor/tags.md)
- [Tag bar _(desktop)_](editor/tag-bar.md)
- [Wikilinks — navigation & integrity](editor/wikilinks.md)
- [External links](editor/external-links.md)
- [Interactive elements](editor/interactive-elements.md)
- [Markdown toolbar _(native shells / editor-embed fallback)_](editor/markdown-toolbar.md)
- [Find in note](editor/find-in-note.md)
- [Images](editor/images.md)
- [Code / fence isolation](editor/code-fence-isolation.md)
- [Performance](editor/performance.md)
- [Saving & rename](editor/saving-and-rename.md)
- [Editor exits — every way an open note ends _(iOS/Android)_](editor/editor-exits.md)
- [Android — IME](editor/android-ime.md)
