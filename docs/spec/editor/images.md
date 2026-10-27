## Images

- Pasting an image into the editor (desktop) saves it to the notes directory
  and inserts `![](filename)`; supported types follow
  `@futo-notes/editor` `IMAGE_EXTENSIONS`, conformance-locked to the canonical
  Rust vault rule. Native Swift/Kotlin pickers receive that Rust list through
  generated UniFFI bindings. Both clipboard shapes work: a raw
  bitmap (OS screenshot-to-clipboard) and a browser **Copy Image** (which the
  source app puts on the clipboard as an `<img>` `text/html` fragment plus a
  bitmap). When the paste event exposes an image file its bytes are saved by
  `fs_save_image`; otherwise the bitmap is read from the OS clipboard via the
  `fs_paste_clipboard_image` Tauri command. This native fallback is required on
  Linux/Wayland, where WebKitGTK hides the clipboard image from the JS paste
  event — a screenshot arrives with empty `items`, and a Copy Image arrives as
  a lone `text/html` item — so the gate is "no image file found and no
  `text/plain` to paste" (plain/rich-text pastes are left untouched).
  Verified on Linux (WebKitGTK) and Windows (WebView2), both image types,
  2026-06-22. → imagePaste.ts `handlePasteEvent` / `looksLikeImagePaste` /
  `pasteFromNativeClipboard`;
  `apps/tauri/src-tauri/src/image_commands.rs` `fs_save_image` /
  `fs_paste_clipboard_image`
- Images render inline via the Tauri asset protocol, with a
  `readFile`→blob-URL fallback when the asset protocol can't actually decode an
  `<img>` (macOS WKWebView / Linux WebKitGTK answer the request but paint a
  blank white box; the gate is a real image-decode probe, not a HEAD probe).
  → `src/lib/platform/tauri/images.ts` `getImageUrl` / `canDecodeImageUrl`.
  _(Tauri)_
- The native shells render local images inline through a host-registered
  image base URL (`setImageBaseUrl`): iOS serves the vault root through a
  `futo-asset://` WKURLSchemeHandler (path-traversal- and image-extension-
  guarded); Android serves `file://<vault root>/` directly. Insert path is
  the toolbar Camera/Image flow above; picked images save into the vault and
  render inline (verified end-to-end on emulator + simulator 2026-06-09).
  → EditorImages.swift `FutoAssetSchemeHandler`, ImagePicker.kt,
  packages/editor/src/hostBoot.ts `setImageBaseUrl`,
  src/features/images/vaultImageSrc.ts, tests/editor-embed-milkdown.spec.ts
- Inline image rendering depends on the referenced file existing in the vault.
  That file is delivered across devices by sync — the image binary syncs
  alongside its note, so `![](image-…)` resolves on every device, not just the
  one that created it. → [sync.md](../sync.md) "Embedded images sync with their
  notes"
- The native shells ALSO support clipboard image paste. The native WebView has
  no `saveImageBytes` (that's a Tauri-desktop FS method), so the embed reads the
  pasted image bytes and hands them to the host via the `saveImageData` bridge
  message (base64 + extension); the host decodes and saves them into the vault
  through the SAME path as the Camera/Image picker, then calls
  `insertImage(filename)` — so a pasted image is indistinguishable from a picked
  one (`![](image-…ext)`, stored as a vault blob, no inline base64). Verified
  end-to-end on the Android emulator 2026-06-22. When the WebView hides the
  bitmap from the JS paste event (no File — WKWebView/WebKitGTK), the embed
  instead posts the payload-less `pasteClipboardImage` message (bridge contract
  v5) and the host reads the image off the native clipboard. Android ALSO takes
  this fallback for a THIRD clipboard shape (QA #006, 2026-09-11): copying an
  image out of Photos/Files/Gallery/Drive (or a browser's "Copy image") puts a
  `content://` URI on Android's clipboard as `text/plain`, not a `File` —
  `classifyImagePaste` recognizes that scheme and claims it as a hidden bitmap,
  and `EditorWebView.kt` reads the URI off the real `ClipboardManager` and
  copies it into the vault through the SAME `saveImageIntoVault` the picker
  uses. Verified end-to-end on a real Android emulator (API 36, 2026-09-11):
  copied a PNG via Chrome's "Copy image", pasted into a note, and the vault
  gained a byte-identical `image-…png` with `![](…)` inserted at the caret. →
  src/features/editor/imagePasteSink.ts, bridge.ts `SaveImageDataMessage` /
  `PasteClipboardImageMessage` (contract v5), EditorWebView.kt + ImagePicker.kt
  `saveImageDataIntoVault` / `clipboardImageUri` / `saveImageIntoVault`
  (Android), EditorWebView.swift `saveImageData` +
  `clipboardImageData` + EditorImages.swift `VaultImages.save` (iOS),
  fs_paste_clipboard_image (Tauri), tests/editor-embed-milkdown.spec.ts
- A vault image is a ProseMirror node whose rendered
  `<img src>` is resolved for display only; the node's own `src` — what gets
  serialized — stays the bare vault reference the note holds. Opening a note
  with an image therefore leaves the file byte-identical, and an edit elsewhere
  in the note still writes `![](image-…ext)`, never the shell's `futo-asset://`
  or `asset://` URL. → milkdown/vaultImageView.ts, features/images/
  vaultImageSrc.ts, tests/editor-embed-milkdown.spec.ts
- A vault image whose URL cannot be resolved yet renders as nothing rather than
  a broken-image glyph, and resolves itself as soon as the URL arrives — the
  host may call `setImageBaseUrl` after `setContent`, and a per-file resolution
  is asynchronous, neither of which is accompanied by a document change.
  → milkdown/vaultImageView.ts, features/images/vaultImageSrc.ts
  `onVaultImageSrcChange`
- The two hosts resolve a vault image two different ways, and the editor
  asks per image RENDERED rather than scanning the document, so a large note
  only pays for the images someone looks at (M5). The native shells serve the
  whole vault off one host-registered base URL and need nothing per file
  _(native shells)_; Tauri desktop has no base URL and resolves each file
  through `PlatformFS.getImageUrl`, which the editor installs at mount as the
  per-file resolver _(desktop)_. A file that will not resolve — it has not
  synced in yet — is retried by a later render rather than remembered as
  failed. → features/images/vaultImageUrlResolver.ts, features/images/
  vaultImageSrc.ts `requestVaultImageUrl`
- **Desktop has three ways to add an image, and all three end in the same
  place**: the bytes land in the vault root under a generated space-free name
  and `![](image-…ext)` goes into the note at the caret. _(desktop)_
  1. **Paste** — the clipboard path above.
  2. **`/image`** — the `/` block menu's Image item opens the OS file picker
     (`PlatformFS.pickImage`), copies the chosen file into the vault
     (`saveImage` → `fs_save_image`) and inserts the reference. The pick is
     asynchronous while the menu's exec map is not, so the typed `/image` run is
     deleted immediately and the reference lands whenever the file is chosen.
     The item is offered on every host the menu is (desktop only); where there
     is no picker it is inert rather than hidden, and inserts nothing.
  3. **Drag and drop** — dropping image files from the OS onto the editor
     inserts them at the drop point, or at the caret when the point resolves to
     no text position. Several images at once are inserted in the order dropped,
     and one that fails to save does not abort the rest.
     → src/features/editor/imageInsert.ts, milkdown/slash/items.ts + exec.ts,
     src/lib/platform/tauri/images.ts `pickImage`, tests/image-drop.spec.ts,
     tests/slash-menu.spec.ts
- **A file drop reaches the app as an ordinary HTML5 `drop`, but the SHAPE it
  carries is engine-dependent.** The desktop window config sets
  `dragDropEnabled: false` on every platform (Linux too since QA #017),
  which stops wry installing a native drop target, so the drop arrives in the
  page and ProseMirror's `handleDrop` prop reads it directly. Linux used to
  leave the flag at its default, reasoning that the same native layer was
  needed to leave the sidebar's internal drags alone; that GTK relay's own
  external file-URI handling turned out to never fire the `drag-drop` signal
  at all on a native-Wayland compositor (confirmed Hyprland/wlroots — matches
  upstream tauri-apps/tauri#11282, tauri-apps/wry#1256), so a file dragged in
  from a file manager silently did nothing in a packaged build — invisible
  from `just tauri-dev`, which has always forced the flag off. Chromium
  (macOS/Windows) populates `dataTransfer.files` with the bytes already read.
  WebKitGTK (Linux) does NOT populate `files` for an OS file drop at all, and
  a real capture off a packaged Fedora/Hyprland build (2026-09-15) showed its
  payload is NOT where RFC 2483 says it should be either: WebKitGTK
  ADVERTISES `text/uri-list` in `dataTransfer.types`, but `getData` on it
  always returns an empty string — the dropped path lives only in the
  sibling `text/html` flavor, as an `<a>` element whose TEXT CONTENT is the
  `file://` URI, with no `href` attribute at all. Internal sidebar/tab
  dragging is untouched either way (pure in-page HTML5 DnD that wry's signal
  handlers never intercepted, and never advertises `text/uri-list`). Tauri's
  own drag-drop event (`PlatformFS.onFileDrop`, paths only, no bytes) stays
  wired as a defensive fallback for a distro/compositor combination that
  still runs wry's native layer, but nothing is currently expected to deliver
  that shape.
  _(desktop)_ → apps/tauri/src-tauri/tauri.conf.json,
  src/lib/platform/tauri/fileDrop.ts,
  src/lib/platform/dragDropConfig.test.ts,
  src/features/editor/imageInsert.ts `filePathsFromDrop`,
  milkdown/MilkdownEditor.svelte `dropHandler`

- **A drop carrying files, or one advertising `text/uri-list` with none, is
  always claimed, image or not.** The browser's default for an unclaimed file
  drop is to navigate the webview to that file, which would tear the running
  app down mid-edit — so a dropped `.md`, PDF or archive is swallowed and
  ignored rather than inserted, and never becomes an `![](…)`. A drop
  carrying neither shape is left entirely alone, so an in-page drag is
  unaffected. The editor's own block drag is pointer-driven and sends no drop
  at all. _(desktop)_
  → src/features/editor/imageInsert.ts `dropCarriesFiles` / `imageFilesIn` /
  `filePathsFromDrop` / `imagePathsIn`, tests/image-drop.spec.ts
- Which dropped or picked files count as images is `isImageFilename` — the same
  `IMAGE_EXTENSIONS` list paste uses, conformance-locked to the canonical Rust
  vault rule, never a second list. A file's own extension decides the name it is
  stored under, falling back to its MIME type when it carries no image
  extension. → packages/editor/src/images.ts,
  src/features/editor/imageInsert.ts `imageExtensionFor`

  Verified on the real Linux desktop app (Fedora 44, WebKitGTK, dev build,
  2026-09-03): a pasted PNG landed in the vault as a valid 1×1 PNG with
  `![](image-…png)` in the note; the `/` menu offered 12 items and `/image`
  filtered to Image; `fs_save_image` copied a real path in and refused a `.md`
  at the Rust layer; and a `tauri://drag-drop` carrying an image path inserted
  it at the drop point, while the same event carrying a `.md`, or carrying an
  image dropped outside the editor's box, left the note untouched. Not yet
  exercised by a genuine human OS drag on any platform, nor the native file
  chooser opening (`dialog:allow-open` is granted and the command reaches
  argument parsing, so the permission half is proven).

- Clipboard image paste claims the paste through
  ProseMirror's `handlePaste` and captures it through the sink for the host it
  is running in: the `saveImageData` / `pasteClipboardImage` bridge messages on
  the native shells (the host writes the file and calls `insertImage` back), or
  `PlatformFS` on Tauri desktop. `classifyImagePaste` decides which pastes count
  as an image, and a claimed image paste never also lands as pasted content. A
  paste carrying plain text is left to the editor. →
  src/features/editor/imagePasteSink.ts, imagePaste.ts `classifyImagePaste`,
  tests/editor-embed-milkdown.spec.ts
- An image destination containing a space needs its CommonMark spelling
  (`![](<my photo.png>)`); the bare `![](my photo.png)`
  is not an image in CommonMark and renders as text. Every filename the app
  itself generates is space-free, so this only reaches notes written elsewhere.
  → `image_commands::write_image`, tests/editor-embed-milkdown.spec.ts

  Verified on a real Android device (moto g play 2023, WebView 140) and the iOS
  26.5 simulator, 2026-08-28: a vault-relative image renders and decodes, and
  opening the note leaves it byte-identical on disk. Android also verified
  end-to-end for paste — the host wrote the file and `insertImage` put
  `![](image-…png)` in the note.

- iOS clipboard image paste is covered at the bundle seam and, for the shared
  decision and bridge sink, end-to-end against the real Android host.

- **A delayed image completion belongs to the note it was started on** — the
  same rule as the native attachment generation below, stated once for the
  shared editor, which is a SINGLE component reused across every note. Drop,
  `/image` pick and clipboard paste each claim the live document BEFORE their
  first `await`; one claim covers a whole multi-image batch. When the editor
  has adopted another note (or been torn down) by the time the bytes land,
  nothing is inserted anywhere — never into the note now on screen — and the
  image file that insertion just created is deleted from the vault, so an
  abandoned drop leaves no blob nothing points at. Equal text in the two notes
  does not preserve the outgoing note's claim. Silent: there is no
  message, because the note the user is looking at is correct and untouched.
  _(desktop)_ → src/features/editor/imageInsertTarget.ts, imageInsert.ts,
  imagePasteSink.ts, milkdown/documentSession.svelte.ts `documentIdentity`,
  milkdown/imageInsertIdentity.test.ts
- A delayed native picker/clipboard completion belongs to the editor attachment
  generation that started it. Detaching, deleting, or adopting another note
  invalidates the completion, so it cannot insert Markdown into a different
  note. Android holds both the editor mutation permit and vault gate through
  confirmed WebView insertion, and cancellation cannot leave a queued main-
  thread insertion behind; iOS checks the adopted WebView generation before
  and after inserting, increments that generation on detach, queues every image
  completion, and drains the queue through the editor's next animation frame
  before a navigation commit. It removes a just-saved image when its attachment
  became stale before insertion. →
  `EditorAttachmentGate.kt`, `EditorWebView.insertImageAndWait`,
  `EditorHost.detach`, `EditorCompletionQueue`, `VaultImages.remove`
