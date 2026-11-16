package com.futo.notes.textfirst

import android.os.Build
import android.widget.TextView

/** The platform's handle drawables, in [color]. Android 9 has no handle setters and keeps the theme's. */
internal fun TextView.tintSelectionHandles(color: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    textSelectHandle?.let { setTextSelectHandle(it.mutate().apply { setTint(color) }) }
    textSelectHandleLeft?.let { setTextSelectHandleLeft(it.mutate().apply { setTint(color) }) }
    textSelectHandleRight?.let { setTextSelectHandleRight(it.mutate().apply { setTint(color) }) }
}
