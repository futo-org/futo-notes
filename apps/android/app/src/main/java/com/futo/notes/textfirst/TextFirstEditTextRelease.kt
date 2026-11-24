package com.futo.notes.textfirst

import android.text.Selection
import android.widget.TextView.BufferType

/** Final disposal follows scroll capture and a successful engine detach. */
internal fun TextFirstEditText.releasePayload() {
    check(engine == null)
    imePublisher.release()
    onFrameDrawn = null
    onRenderFrame = null
    onApplyMeasured = null
    onOpenWikilink = null
    keyHooks.clear()
    onOpenUrl = null
    onTableCell = null
    tableTouch.hooks.missing = null
    tableTouch.hooks.tableOpen = { false }
    setOnFocusChangeListener(null)
    clearFocus()
    scroll.stop()
    stopPinning()
    restoring = null
    pendingTimings = null
    composing = null
    contentComplete = true
    val wasApplying = applying
    applying = true
    try {
        // Replace the buffer itself. Deleting its text would reflow and retain
        // the old large span/chunk arrays in a platform-retained view.
        setText(ChunkedEditable.from(TextFirstEditText.END_SENTINEL), BufferType.EDITABLE)
        Selection.setSelection(editableText, 0)
        scrollTo(0, 0)
    } finally { applying = wasApplying }
}
