package com.futo.notes.textfirst

import android.view.KeyEvent
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorInlineFormat

/** What the screen around the note does for a hardware key: the link form, the find bar, the wikilink completion list. */
internal class HardwareKeyHooks {
    var link: (() -> Unit)? = null
    var find: ((FindShortcut) -> Unit)? = null
    /** Up, Down, Enter, Tab and Escape while the completion list is open; true when the list took the key. */
    var completion: ((Int) -> Boolean)? = null

    fun clear() {
        link = null
        find = null
        completion = null
    }
}

/**
 * Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y are the note's history, taken before the keyboard: Gboard otherwise runs its own undo,
 * replaying a stale range of text that can reach into an image and corrupt the note.
 */
internal fun isHistoryChord(keyCode: Int, event: KeyEvent): Boolean =
    event.isCtrlPressed && !event.isAltPressed && (keyCode == KeyEvent.KEYCODE_Z || keyCode == KeyEvent.KEYCODE_Y)

/** The completion list takes its keys before the note does. */
internal fun TextFirstEditText.completionKey(keyCode: Int, event: KeyEvent): Boolean =
    !event.isCtrlPressed && !event.isAltPressed && keyCode in COMPLETION_KEYS && keyHooks.completion?.invoke(keyCode) == true

private val COMPLETION_KEYS = setOf(
    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
    KeyEvent.KEYCODE_TAB, KeyEvent.KEYCODE_ESCAPE,
)

/**
 * A hardware keyboard's Ctrl shortcuts: undo and redo, the inline formats, select all, copy, cut and paste, and
 * desktop's line chords (Ctrl+Alt+1-6 headings, +8 bullets, +7 numbers, Ctrl+Shift+B quote).
 */
internal fun TextFirstEditText.shortcutKey(engine: EditorEngine, keyCode: Int, event: KeyEvent): Boolean {
    if (!event.isCtrlPressed) return false
    if (event.isAltPressed) return altChord(engine, keyCode)
    when (keyCode) {
        KeyEvent.KEYCODE_Z -> { if (event.isShiftPressed) engine.redo() else engine.undo(); return true }
        KeyEvent.KEYCODE_Y -> { engine.redo(); return true }
        KeyEvent.KEYCODE_B -> {
            if (event.isShiftPressed) engine.blockCommand(EditorBlockCommand.Quote) else engine.toggleFormat(EditorInlineFormat.BOLD)
            return true
        }
        KeyEvent.KEYCODE_E -> { engine.toggleFormat(EditorInlineFormat.CODE); return true }
        KeyEvent.KEYCODE_K -> { keyHooks.link?.invoke(); return keyHooks.link != null }
        KeyEvent.KEYCODE_F -> { keyHooks.find?.invoke(FindShortcut.OPEN); return keyHooks.find != null }
        KeyEvent.KEYCODE_G -> {
            keyHooks.find?.invoke(if (event.isShiftPressed) FindShortcut.PREVIOUS else FindShortcut.NEXT)
            return keyHooks.find != null
        }
        KeyEvent.KEYCODE_I -> { engine.toggleFormat(EditorInlineFormat.ITALIC); return true }
        KeyEvent.KEYCODE_A -> { engine.selectAll(); return true }
        KeyEvent.KEYCODE_C -> { onTextContextMenuItem(android.R.id.copy); return true }
        KeyEvent.KEYCODE_X -> { onTextContextMenuItem(android.R.id.cut); return true }
        KeyEvent.KEYCODE_V -> { onTextContextMenuItem(android.R.id.paste); return true }
    }
    return false
}

/** Ctrl+Alt chords: X is strikethrough (it reached Cut before), 1-6 headings, 7 numbers, 8 bullets. */
private fun altChord(engine: EditorEngine, keyCode: Int): Boolean {
    when (keyCode) {
        KeyEvent.KEYCODE_X -> engine.toggleFormat(EditorInlineFormat.STRIKE)
        in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_6 -> engine.blockCommand(EditorBlockCommand.ToggleHeading((keyCode - KeyEvent.KEYCODE_0).toUByte()))
        KeyEvent.KEYCODE_7 -> engine.blockCommand(EditorBlockCommand.OrderedList)
        KeyEvent.KEYCODE_8 -> engine.blockCommand(EditorBlockCommand.BulletList)
        else -> return false
    }
    return true
}

/**
 * The keys that move in the note. One the note cannot make (Up at its start, PageDown at its end) is still the note's:
 * unhandled, the window would move focus to the title.
 */
internal val NOTE_MOVE_KEYS = setOf(
    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
    KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_MOVE_HOME, KeyEvent.KEYCODE_MOVE_END,
)
