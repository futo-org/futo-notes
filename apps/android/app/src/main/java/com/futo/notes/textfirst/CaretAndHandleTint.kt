package com.futo.notes.textfirst

import android.os.Build
import android.widget.TextView

/**
 * The platform's caret and selection handle drawables, in [color]. The note view's caret is its
 * text-height wrapper (TextFirstEditTextCaret.kt), which passes the tint to the platform caret
 * inside it. Android 9 has no setters for them and keeps the theme's.
 */
internal fun TextView.tintCaretAndSelectionHandles(color: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    textCursorDrawable?.let { setTextCursorDrawable(it.mutate().apply { setTint(color) }) }
    textSelectHandle?.let { setTextSelectHandle(it.mutate().apply { setTint(color) }) }
    textSelectHandleLeft?.let { setTextSelectHandleLeft(it.mutate().apply { setTint(color) }) }
    textSelectHandleRight?.let { setTextSelectHandleRight(it.mutate().apply { setTint(color) }) }
}
