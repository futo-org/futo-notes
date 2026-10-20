## 4. Parity buckets (`docs/spec/editor.md`, ~155 behavior lines)

- **Bucket 1 — full parity required before replacement**: wikilinks (navigate, shortest-unique-
  suffix display, `[[` autocomplete over `setNotes`, rename integrity — **a wikilink remark
  extension + node/mark plugin is mandatory scope**: without it Milkdown escapes `[[x]]` to
  `\[\[x]]` on save, breaking a live feature), tags + tag bar, images (vault-relative render +
  native paste), checkboxes/interactive elements, toolbar surface on PM commands via shared
  `TOOLBAR_EXEC` (M10), fence syntax highlighting (maintained Milkdown/PM highlight plugin),
  saving/rename flows, editor-exit flows, Android IME spec behaviors, theming. Audit is
  line-by-line against the spec file so "done" is checkable.
- **Bucket 2 — renegotiated**: live-preview/decorated-source sections (marker reveal near caret is
  meaningless in WYSIWYG). Rewritten to describe the new model in a dedicated MR Justin reviews
  (D9). Until the swap lands, existing spec lines stay in force (ADR-0002).
- **Bucket 3 — new spec lines**: block drag, format-state toolbar highlighting, progressive-open
  behavior (§5), normalize-once semantics.

### Android drags the block, not a handle (2026-09-01)

Both native shells now mount the SAME Notion-style long-press block drag; the ⠿ gutter handle is the
desktop browser's gesture alone. `resolveBlockDragMode(nativeShell)` is the whole gate, so the
embed's own host flag decides and no user-agent sniff is left in it. Consequences worth recording:

- The only page a headless harness can load is `editor.html`, whose host flag is a hard-coded
  `nativeShell: true`, so the ⠿ path lost its harness. `blockDragMode.ts`'s test-only override was
  widened to force EITHER mode (`?blockDragMode=gutter-handle`), which is what the handle's
  touch-drag spec now uses.
- Measured on the reference phone (moto g play 2023, Android 13, System WebView 151): Chromium shows
  NO word highlight, selection handles, floating Cut/Copy action mode or magnifier over a lifted
  block, focused or unfocused. WebKit's whole `isTextInteractionEnabled` problem simply does not
  exist here — the page's own `selectstart`/`contextmenu`/selection defences hold. So the shell
  ignores `blockDrag` entirely.
- The one leak was haptic, not visual: the WebView fires its own `LONG_PRESS` buzz 128-141 ms after
  the editor's lift (its recogniser trips around touch-down + 480 ms against the 340 ms lift), so a
  pickup felt like a stutter. `EditorWebView.setBlockPressActive` turns the WebView's view-level
  haptics off for the press and the editor's own three opt past with `FLAG_IGNORE_VIEW_SETTING`; a
  long press the editor does not claim keeps its normal buzz.
