package com.futo.notes.ui

import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.OpenNoteDisposition
import uniffi.futo_notes_ffi.SyncSummary
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import uniffi.futo_notes_ffi.validateTitle

/** A note title that is still the auto-assigned placeholder: exactly "Untitled",
 *  or a dedup variant "Untitled-N" (the Rust store's `unique_note_id` appends `-2`,
 *  `-3`, …). Tapping such a title selects it whole so a keystroke replaces it;
 *  any other title takes the caret at the tapped character. */
private val UNTITLED_PLACEHOLDER = Regex("""^Untitled(-\d+)?$""")

internal fun isPlaceholderTitle(title: String): Boolean = UNTITLED_PLACEHOLDER.matches(title)

internal fun titleValidationMessage(kind: String): LocalizedMessage? = when (kind) {
    "empty" -> LocalizedMessage("notes.title.empty")
    "forbidden_chars" -> LocalizedMessage("notes.title.forbiddenCharacter")
    "leading_dots" -> LocalizedMessage("notes.title.leadingDot")
    "trailing_dots" -> LocalizedMessage("notes.title.trailingDot")
    "too_long" -> LocalizedMessage(
        "notes.title.tooLong",
        mapOf("maxLength" to TitleSpec.maxLength),
    )
    else -> null
}

/** The persistent warning for a title being typed: dot/too-long first, else a duplicate of
 *  another note in the same folder, else none. Both editor screens show this. */
internal fun titleWarningFor(noteId: String, title: String, existingIds: List<String>): LocalizedMessage? {
    val blocking = validateTitle(title).firstOrNull { it.kind != "empty" && it.kind != "forbidden_chars" }
    val duplicate = title.trim().let { t ->
        t.isNotEmpty() && collidesWithOtherNote(noteId, makeId(splitId(noteId).folder, sanitizeTitle(t)), existingIds)
    }
    return blocking?.let { titleValidationMessage(it.kind) }
        ?: if (duplicate) LocalizedMessage("notes.title.duplicate") else null
}


internal fun canStepFind(total: Int): Boolean = total > 0
