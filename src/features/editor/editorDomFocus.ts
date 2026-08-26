/**
 * The one answer to "is the typist in the editor right now?", as reported to
 * every host: the desktop shell's external-change coordinator, and the two
 * native shells over the `futoBridge` `focus` message.
 *
 * It is not simply CodeMirror's `view.hasFocus`, because that is
 * `document.hasFocus() && activeElement === contentDOM` — and a WKWebView
 * routinely reports a false `document.hasFocus()` while its contenteditable
 * really is focused with the keyboard up, which used to hide the mobile
 * keyboard toolbar mid-typing (commit 52c174cf1).
 */
export interface EditorFocusProbe {
  /** CodeMirror's own verdict. */
  hasFocus: boolean;
  /** The contenteditable the caret lives in. */
  contentDOM: Element;
  /** The whole editor, widgets and panels included. */
  dom: Element;
}

/**
 * Whether the editor holds the caret, from the host's point of view.
 *
 * The lenient arm — DOM focus is parked inside the editor even though
 * CodeMirror disagrees — only means "still focused" while the document itself
 * has focus, or on iOS where a blurred document is routine. Everywhere else a
 * blurred document with a stale `activeElement` is a genuine page-level blur:
 * that is exactly what an Android WebView produces when the IME is dismissed
 * with Back or when a native field (the inline title) takes over, and reading
 * it as "still focused" stranded a deferred open-note adoption forever, since
 * the shell never saw the blur edge it settles on (docs/spec/sync.md — open
 * note dispositions).
 */
export function editorHasDomFocus(view: EditorFocusProbe, isIOSHost: boolean): boolean {
  const activeElement = document.activeElement;
  if (activeElement?.closest('[data-editor-body-focus="false"]')) return false;
  if (view.hasFocus) return true;
  const domFocusIsInsideEditor =
    activeElement === view.contentDOM || view.dom.contains(activeElement);
  if (!domFocusIsInsideEditor) return false;
  return isIOSHost || document.hasFocus();
}
