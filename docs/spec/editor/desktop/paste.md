### Desktop editor: pasting and dropping _(desktop)_

What a paste writes is the engine's ([portable-core/clipboard.md](../portable-core/clipboard.md));
an image's file is saved by the shell's image doors, the same ones the Milkdown editor uses
([images.md](../images.md)), and its reference is written by the engine's image insertion
([portable-core/images.md](../portable-core/images.md)). The page builds no Markdown itself.
Stories: tests/desktop-editor-paste-stories.mjs, through Puppet's `clipboard {"image"}` and
`DropFiles`, which send the page the paste and drop events; a real OS drag (its `dragover`
against the window's drop guard) is not among them.

- Paste (Cmd/Ctrl+V) carrying no image pastes the clipboard's plain text, read as Markdown, as
  one Undo step; Paste and Match Style is the same paste. A clipboard's HTML is not read: text
  copied from a web page or a document pastes as its plain text. → src/features/editor/desktop/
  input.ts `paste`

> **Gap:** Rich paste (Mod+V reads HTML that holds formatting as its Markdown, Shift+Mod+V the
> plain text; Mason 2026-11-05, docs/plan/desktop-editor.md) needs the engine's HTML paste,
> which went with the old engine (#423) and has no Linedown replacement yet:
> `paste_clipboard(revision, start, end, text, html)` beside `paste_markdown`
> (portable-core/clipboard.md, #303).

- A paste carrying an image file is an image paste, also with text beside it: the file is
  saved into the vault under a generated name and `![](image-…ext)` is written at the caret,
  or in place of the selection, one Undo step, on a line of its own where the engine's insertion
  puts it there (portable-core/images.md). A paste with no image file and no plain text
  (a Linux screenshot, a browser's Copy Image there) reads the picture off the OS clipboard.
  A paste with plain text and no image file is a text paste. → src/features/editor/desktop/
  imageInput.ts `paste`, src/features/editor/imagePaste.ts `classifyImagePaste`,
  imagePasteSink.ts
- Image files dropped from the OS onto the note land where a click at the drop point would put
  the caret, in the order dropped, each its own Undo step; one that fails to save does not stop
  the others. A drop carrying files is always taken, so a dropped file never replaces the app:
  files that are not images are ignored. WebKitGTK's drop (paths in `text/uri-list` or its
  HTML) and Tauri's window drop event are read too. → imageInput.ts `drop` / `dragOver` /
  `listenForWindowDrops`, src/features/editor/imageInsert.ts
- Nothing shows while an image saves, and typing goes on. The insertion is claimed when the paste
  or drop happens, for that note's engine session: edits in the meantime keep the claim, and the
  image lands at the caret as it then is, after an input method's composition ends if one is
  open. Another note, the same note opened again, or no note open by then gets nothing, and the
  saved file is deleted from the vault; so does an insertion the engine refuses (the caret in
  code, a paused note). → src/features/editor/desktop/imageClaimTarget.ts
- A read-only note takes no image: a paste is the text paste, a drop is taken and ignored.
  → imageInput.ts `editable`

- The `/image` file picker ([images.md](../images.md), the second way to add an image) is the `/`
  menu's Image item: the picked file takes this same path, its claim taken as the picker opens.
  → [slash-menu.md](slash-menu.md), imageInput.ts `pick`
