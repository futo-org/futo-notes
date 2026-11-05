package com.futo.notes.textfirst

import android.os.Build
import android.view.inputmethod.InputConnection
import android.view.inputmethod.SurroundingText
import androidx.annotation.RequiresApi

/** Keep API 31-only signatures out of the connection class loaded on Android 9. */
internal fun engineInputConnection(engine: EditorEngine, view: EngineInputConnection.ViewSide, cell: Boolean = false): InputConnection =
    if (Build.VERSION.SDK_INT >= 31) EngineInputConnection31(engine, view, cell) else EngineInputConnection(engine, view, cell)

@RequiresApi(31)
private class EngineInputConnection31(engine: EditorEngine, view: EngineInputConnection.ViewSide, cell: Boolean) : EngineInputConnection(engine, view, cell) {
    override fun getSurroundingText(beforeLength: Int, afterLength: Int, flags: Int): SurroundingText? {
        val context = contextWindow(beforeLength, afterLength) ?: return null
        return SurroundingText(context.text, context.selectionStart, context.selectionEnd, context.start)
    }
}
