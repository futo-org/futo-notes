package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorUtf16Range

// The toolbar's and the shortcut keys' commands, queued in order behind typing (ToolbarCommandQueue).

internal fun EditorEngine.toggleFormat(format: EditorInlineFormat) = toolbarCommands.post {
    if (mirror.overlay != null) commitComposition(null)
    session?.toggleFormat(rev, format)?.let(::accept)
}

/** A toolbar tap: a caret inside a word or at its start formats the whole word. */
internal fun EditorEngine.toggleToolbarFormat(format: EditorInlineFormat) = toolbarCommands.post {
    if (mirror.overlay != null) commitComposition(null)
    session?.toggleToolbarFormat(rev, format)?.let(::accept)
}

internal fun EditorEngine.blockCommand(command: EditorBlockCommand) = toolbarCommands.post {
    if (mirror.overlay != null) commitComposition(null)
    session?.blockCommandUtf16(rev, EditorUtf16Range(mirror.selStart.toULong(), mirror.selEnd.toULong()), command)?.let(::accept)
}

internal fun EditorEngine.undo() = toolbarCommands.post {
    if (mirror.overlay != null) commitComposition(null)
    session?.undo(rev)?.let(::accept)
}

internal fun EditorEngine.redo() = toolbarCommands.post {
    if (mirror.overlay != null) commitComposition(null)
    session?.redo(rev)?.let(::accept)
}
