package com.futo.notes.textfirst

import android.view.MotionEvent
import uniffi.futo_notes_ffi.EditorBlockCommand

/**
 * A press on a drawn part of a code block (CodeBlockChrome): its header selects the block as one
 * object, "add a line" opens a line beside it, as does the empty space under a block that ends
 * the note. A press in the code places the caret natively.
 */
internal class CodeBlockTouch(private val view: TextFirstEditText) {
    private var pressed: CodeBlockTarget? = null

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> pressed = targetAt(event)
            MotionEvent.ACTION_UP -> {
                val target = pressed ?: return false
                pressed = null
                if (targetAt(event) === target) act(target)
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                val target = pressed
                pressed = null
                return target != null
            }
        }
        return pressed != null
    }

    private fun act(target: CodeBlockTarget) {
        view.showKeyboard()
        val engine = view.engine ?: return
        when (target.action) {
            CodeBlockAction.SELECT_BLOCK -> engine.selectCodeBlock(target.codeStart)
            CodeBlockAction.OPEN_LINE_ABOVE -> engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineBeforeCodeBlock)
            CodeBlockAction.OPEN_LINE_BELOW -> engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineAfterCodeBlock)
        }
    }

    private fun targetAt(event: MotionEvent): CodeBlockTarget? {
        if (event.x < view.totalPaddingLeft) return null
        return view.codeChrome.targetAt(event.x - view.totalPaddingLeft + view.scrollX, event.y - view.totalPaddingTop + view.scrollY)
    }
}
