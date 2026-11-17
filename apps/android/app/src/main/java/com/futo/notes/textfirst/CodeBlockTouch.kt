package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs
import uniffi.futo_notes_ffi.EditorBlockCommand

/**
 * A press on a drawn part of a code block (CodeBlockChrome): its header selects the block as one
 * object or edits a field ([act]), "add a line" opens a line beside it, as does the empty space
 * under a block that ends the note. A press in the code places the caret natively.
 */
internal class CodeBlockTouch(private val view: TextFirstEditText) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: CodeBlockTarget? = null
    private var downX = 0f
    private var downY = 0f
    val headerField = CodeHeaderField(view)

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                headerField.close()
                pressed = targetAt(event)
                if (pressed?.action != CodeBlockAction.MARK_MENU) closeMarkMenu()
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) pressed = null
            MotionEvent.ACTION_UP -> {
                val target = pressed ?: return false
                pressed = null
                val held = event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout()
                if (targetAt(event) === target) act(target, held, event.x - view.totalPaddingLeft + view.scrollX)
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

    /**
     * !300's header gestures on touch (cb 606-616, 674-685): a tap on the name edits it only while the
     * block is active and otherwise selects the block; a tap on the language copies, or edits it
     * while the caret is in the block; the copy glyph always copies; a hold on either field edits
     * it, its text selected, and never copies.
     */
    private fun act(target: CodeBlockTarget, held: Boolean, x: Float) {
        val engine = view.engine ?: return
        val action = when {
            target.action == CodeBlockAction.NAME_FIELD && (held || isActive(target)) -> CodeHeaderField.Kind.NAME
            target.action == CodeBlockAction.LANGUAGE_LABEL && (held || isCaretInside(target)) -> CodeHeaderField.Kind.LANGUAGE
            target.action == CodeBlockAction.COPY_CODE && held -> CodeHeaderField.Kind.LANGUAGE
            else -> null
        }
        if (action != null) return headerField.open(target, action, selectAll = held, tapX = x.takeIf { !held })
        when (target.action) {
            CodeBlockAction.NOTHING -> Unit
            // The menu's buttons wait for the engine's mark toggle; a press on the menu keeps it open.
            CodeBlockAction.MARK_MENU -> Unit
            CodeBlockAction.LINE_NUMBER -> { view.codeChrome.markMenuLine = target.codeStart; view.invalidate() }
            CodeBlockAction.COPY_CODE, CodeBlockAction.LANGUAGE_LABEL -> copy(target)
            CodeBlockAction.SELECT_BLOCK, CodeBlockAction.NAME_FIELD -> { view.showKeyboard(); engine.selectCodeBlock(target.codeStart) }
            CodeBlockAction.OPEN_LINE_ABOVE -> { view.showKeyboard(); engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineBeforeCodeBlock) }
            CodeBlockAction.OPEN_LINE_BELOW -> { view.showKeyboard(); engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineAfterCodeBlock) }
        }
    }

    private fun closeMarkMenu() {
        if (view.codeChrome.markMenuLine < 0) return
        view.codeChrome.markMenuLine = -1
        view.invalidate()
    }

    /** The caret or the selection is in the target's block. */
    private fun isActive(target: CodeBlockTarget): Boolean {
        val block = target.block ?: return false
        return view.isFocused && view.selectionStart >= block.start && view.selectionEnd <= block.end
    }

    private fun isCaretInside(target: CodeBlockTarget): Boolean =
        isActive(target) && view.selectionStart == view.selectionEnd && view.selectedCodeBlock == null

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
