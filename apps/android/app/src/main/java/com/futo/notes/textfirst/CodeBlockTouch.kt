package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
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

    /**
     * A tap in an empty block selected as one object leaves the view's caret where it was, so the
     * view reports no selection: tell the engine the user placed it there, or the next letter
     * would replace the block (!300 cb 172-185).
     */
    fun settleTap(event: MotionEvent) {
        if (event.actionMasked != MotionEvent.ACTION_UP || view.selectedCodeBlock == null) return
        if (event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout()) return
        view.engine?.viewSelection(view.appliedSeq, view.selectionStart, view.selectionEnd)
    }

    private fun act(target: CodeBlockTarget) {
        val engine = view.engine ?: return
        if (target.action != CodeBlockAction.COPY_CODE && target.action != CodeBlockAction.NOTHING) view.showKeyboard()
        when (target.action) {
            CodeBlockAction.NOTHING -> Unit
            CodeBlockAction.COPY_CODE -> copy(target)
            CodeBlockAction.SELECT_BLOCK -> engine.selectCodeBlock(target.codeStart)
            CodeBlockAction.OPEN_LINE_ABOVE -> engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineBeforeCodeBlock)
            CodeBlockAction.OPEN_LINE_BELOW -> engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineAfterCodeBlock)
        }
    }

    /** The checkmark stands for about a second, as in !300. */
    private fun copy(target: CodeBlockTarget) {
        val block = target.block ?: return
        view.clipboard.copyCode(block.start, block.end)
        view.codeChrome.copiedBlock = target.codeStart
        view.invalidate()
        view.removeCallbacks(clearCopied)
        view.postDelayed(clearCopied, COPIED_MILLISECONDS)
    }

    private val clearCopied = Runnable {
        view.codeChrome.copiedBlock = -1
        view.invalidate()
    }

    private companion object {
        const val COPIED_MILLISECONDS = 1_100L
    }

    private fun targetAt(event: MotionEvent): CodeBlockTarget? {
        if (event.x < view.totalPaddingLeft) return null
        return view.codeChrome.targetAt(event.x - view.totalPaddingLeft + view.scrollX, event.y - view.totalPaddingTop + view.scrollY)
    }
}
