### Native touch and focus

- Tapping an unfocused editor places the caret at the tap and raises the
  keyboard; wrapped-line taps remain on the tapped visual row. On-text and
  off-text placement alike are the platform's own contenteditable behavior.
  _(native shells)_
- A caret the keyboard rises over is scrolled back into view as the keyboard
  lands: tap the last word of a note that fills the screen and that word ends up
  above the keyboard and its toolbar straight away, not on the first keystroke.
  ProseMirror only scrolls on its own transactions and a tap is not one, so the
  embed re-reveals the selection whenever the shell resizes the web view under a
  focused editor. On Android the editor column's `imePadding` really does resize
  the web view (a window `resize` for each frame of the keyboard animation), and
  the System WebView also scrolls the focused caret into view by itself: with the
  embed's reveal suppressed the tapped line still ended up above the toolbar.
  The embed's reveal is what iOS needs and is harmless there. Verified on the
  emulator (API 36, System WebView 133.0.6943.137) 2026-09-23. _(native
  shells)_ → src/editor-embed/main.ts `resize` listener,
  src/features/editor/milkdown/hostHandleView.ts `revealSelection`

- The editor reserves a tail below the last line — `max(40vh, 280px)` of bottom
  padding on the editable — so the final line can be scrolled clear of the
  keyboard. The tail scales with the viewport, so a note that does not fill the
  screen still has nothing to scroll. →
  src/features/editor/milkdown/milkdownEditor.css `.ProseMirror` padding

- Native-shell policy comes from the host-provided `nativeShell` mode: it is
  what selects the long-press block drag over the ⠿ gutter handle, and what
  turns on the native-toolbar layout. → packages/editor/src/hostBoot.ts,
  src/features/editor/milkdown/blockDragMode.ts `resolveBlockDragMode`
- On-text double/triple-tap selection, selection handles, the loupe and the
  platform callout are all native on both shells; the editor adds nothing to
  them and takes nothing away, except while a block-drag press is live (see
  "Selection"). _(native shells)_
