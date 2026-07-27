# Android detached WebView work must not gate non-editor workflows

## Symptom

Changing the Android vault location from Settings could leave the app on the
blocking “Moving notes…” surface forever. Force-stop was the only exit.

## Root cause

The app-lifetime editor WebView is attached only while an editor screen is
composed. Storage migration ran from Settings, after that screen had been
disposed, but still called a capture method that scheduled work with
`WebView.post`. Android queues `View.post` work for a detached view until a
future attachment. No attachment was coming, so the suspended migration never
resumed. Prewarming made the WebView ready flag true and bypassed the method's
only early return.

## Ownership rule

Only editor navigation may capture live CodeMirror content. It must complete the
native persist-or-park workflow before changing screens. Vault migration consumes
durable files plus the store-owned retained-draft register; it must not call,
enable, disable, blur, post to, or otherwise wait on the editor WebView.

Use a main-thread handler or an explicit attachment-aware editor operation when
editor-owned work genuinely has to run while a view may be detached. Never let a
detached view's callback become the completion signal for an unrelated
application workflow.

## Regression coverage

`StorageMigrationEditorIndependenceTest` prevents migration-only capture symbols
from returning and verifies that retained drafts are flushed before vault
staging. `EditorNavigationCommitTest` covers the awaited capture-and-flush gate
when leaving an editor, and `EditorLifecycleFlushTest` covers retained drafts
after disposal.
