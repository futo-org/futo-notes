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
    /** The code start of the block whose copy glyph shows a checkmark, -1 for none. */
    var copiedBlock = -1
        private set

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                headerField.close()
                pressed = targetAt(event)
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) pressed = null
            MotionEvent.ACTION_UP -> {
                val target = pressed ?: return false
                pressed = null
                val held = event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout()
                if (isSamePart(target, targetAt(event))) act(target, held, event.x - view.totalPaddingLeft + view.scrollX)
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
     * Typing made a block whose opening fence takes the next letters as its language (the third backtick on a line,
     * writes_language): its language field opens on that block, as !300 focused it. Once the block is drawn.
     */
    fun openLanguageAt(offset: Int) {
        view.postOnAnimation {
            view.post {
                val e = view.editableText ?: return@post
                val range = codeRangesNear(e, offset, offset).firstOrNull { offset in it.start..it.end } ?: return@post
                val area = view.codeChrome.areaOf(range.start, CodeBlockAction.LANGUAGE_LABEL) ?: return@post
                val target = view.codeChrome.targetAt(area.centerX(), area.centerY()) ?: return@post
                val block = target.block ?: return@post
                headerField.open(target.codeStart, CodeHeaderField.Kind.LANGUAGE, block.language.orEmpty(), block.name.orEmpty(), selectAll = false)
            }
        }
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
        // A tap on the language takes the whole word, as !300's did; a tap on the name puts the caret at the tap.
        val selectAll = held || action == CodeHeaderField.Kind.LANGUAGE
        val block = target.block
        if (action != null && block != null) {
            return headerField.open(target.codeStart, action, block.language.orEmpty(), block.name.orEmpty(), selectAll, tapX = x.takeIf { !selectAll })
        }
        when (target.action) {
            CodeBlockAction.NOTHING -> Unit
            CodeBlockAction.COPY_CODE, CodeBlockAction.LANGUAGE_LABEL -> copy(target)
            CodeBlockAction.SELECT_BLOCK, CodeBlockAction.NAME_FIELD -> { view.showKeyboard(); engine.selectCodeBlock(target.codeStart) }
            CodeBlockAction.OPEN_LINE_ABOVE -> { view.showKeyboard(); engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineBeforeCodeBlock) }
            CodeBlockAction.OPEN_LINE_BELOW -> { view.showKeyboard(); engine.openCodeBlockLine(target.codeStart, EditorBlockCommand.OpenLineAfterCodeBlock) }
        }
    }

    /**
     * Whether a lift at [lifted] ends the press that began on [pressed]. Not by identity: every frame
     * draws the chrome's targets anew, and a hold outlasts frames (the caret blinks). The language and
     * the copy glyph are one chip, so a finger drifting between them still holds the chip.
     */
    private fun isSamePart(pressed: CodeBlockTarget, lifted: CodeBlockTarget?): Boolean {
        if (lifted == null || lifted.codeStart != pressed.codeStart) return false
        if (lifted.action == pressed.action) return true
        val chip = setOf(CodeBlockAction.LANGUAGE_LABEL, CodeBlockAction.COPY_CODE)
        return pressed.action in chip && lifted.action in chip
    }

    /** The caret or the selection is in the target's block. */
    private fun isActive(target: CodeBlockTarget): Boolean {
        val block = view.editableText?.codeBlockStartingAt(target.codeStart) ?: return false
        return view.isFocused && view.selectionStart >= block.start && view.selectionEnd <= block.end
    }

    private fun isCaretInside(target: CodeBlockTarget): Boolean =
        isActive(target) && view.selectionStart == view.selectionEnd && view.selectedCodeBlock == null

    /** The checkmark stands for about a second, as in !300. */
    private fun copy(target: CodeBlockTarget) {
        view.clipboard.copyCode(target.codeStart)
        copiedBlock = target.codeStart
        view.invalidate()
        view.removeCallbacks(clearCopied)
        view.postDelayed(clearCopied, COPIED_MILLISECONDS)
    }

    private val clearCopied = Runnable {
        copiedBlock = -1
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
