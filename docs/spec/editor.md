# Editor — Spec

Desktop draws the text-first engine's display text (editor/desktop/) and saves the
note's own bytes. Mobile uses the Rust Linedown engine rendered by native TextKit (iOS)
and Android views. Mobile behavior is specified under mobile and portable-core below.
Milkdown on ProseMirror remains only as the standalone `editor-embed` fixture, which no
app ships; the Milkdown rendering and serialization sections describe that fixture.
Native views and the desktop host preserve the exact source through the Rust session; on
every platform a note's hidden markers are never on screen. This file states the
behaviors a human cares about.

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
- [Portable text-first core _(under development)_](editor/portable-core.md)
- [Desktop editor: rendering, input, caret and saving _(desktop)_](editor/desktop/editing.md)
- [Desktop editor: lists, tasks, quotes and dividers _(desktop)_](editor/desktop/blocks.md)
- [Desktop editor: code blocks _(desktop)_](editor/desktop/code-blocks.md)
- [Desktop editor: the selection toolbar _(desktop)_](editor/desktop/toolbar.md)
- [Desktop editor: the `/` menu _(desktop)_](editor/desktop/slash-menu.md)
- [Desktop editor: find in note _(desktop)_](editor/desktop/find.md)
- [Desktop editor: code colours _(desktop)_](editor/desktop/code-colours.md)
- [Desktop editor: links and wikilinks _(desktop)_](editor/desktop/links.md)
- [Desktop editor: paired typing _(desktop)_](editor/desktop/paired-typing.md)
- [Desktop editor: tables _(desktop)_](editor/desktop/tables.md)
- [Desktop editor: tags and front matter _(desktop)_](editor/desktop/tags.md)
- [Desktop editor: a change to the open note from outside _(desktop)_](editor/desktop/outside-changes.md)
- [Desktop editor: pasting and dropping _(desktop)_](editor/desktop/paste.md)
- [Native mobile text-first editor _(iOS/Android)_](editor/mobile.md)
- [Editor exits — every way an open note ends _(iOS/Android)_](editor/editor-exits.md)
- [Android — IME](editor/android-ime.md)
