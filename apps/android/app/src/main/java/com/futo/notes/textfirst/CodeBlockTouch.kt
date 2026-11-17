package com.futo.notes.textfirst

import android.view.MotionEvent

/** A press on a code block's header selects the block as one object; a press in its code places the caret natively. */
internal class CodeBlockTouch(private val view: TextFirstEditText) {
    private var pressedBlock = -1

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> pressedBlock = headerAt(event.x, event.y)
            MotionEvent.ACTION_UP -> {
                val pressed = pressedBlock.takeIf { it >= 0 } ?: return false
                pressedBlock = -1
                if (headerAt(event.x, event.y) != pressed) return true
                view.showKeyboard()
                view.engine?.selectCodeBlock(pressed)
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                val pressed = pressedBlock
                pressedBlock = -1
                return pressed >= 0
            }
        }
        return pressedBlock >= 0
    }

    /** The start of the code under the header at ([x], [y]), or -1 off every header. */
    private fun headerAt(x: Float, y: Float): Int {
        val layout = view.layout ?: return -1
        val text = view.editableText ?: return -1
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height || x < view.totalPaddingLeft) return -1
        val line = layout.getLineForVertical(localY.toInt())
        val start = layout.getLineStart(line)
        val code = text.getSpans(start, start, TfCodeBlock::class.java)
            .firstOrNull { it.line.first && text.getSpanStart(it) == start } ?: return -1
        if (localY >= layout.getLineTop(line) + view.style.codeHeaderHeight) return -1
        return text.getSpanStart(code)
    }
}
