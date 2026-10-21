package com.futo.notes.ui

import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.OpenNoteDisposition
import uniffi.futo_notes_ffi.SyncSummary

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

internal fun SyncSummary.affectsOpenNote(id: String): Boolean =
    id in updatedIds ||
        id in deletedIds ||
        renamed.any { it.fromId == id || it.toId == id }

internal fun editedDuringOpenNoteGather(
    reconciliationStartVersion: Long,
    currentEditVersion: Long,
): Boolean = currentEditVersion != reconciliationStartVersion

internal enum class FindBackAction { DismissFind, ExitNote }

/**
 * The height the editor pane is held at, or null to let it follow its box.
 * While an exit holds the interaction lock the editor is leaving: the blur
 * drops the keyboard and the format toolbar, and letting the WebView follow
 * would relayout the whole note on every frame of the keyboard animation
 * (Chromium walks the whole document for any layout inside its scroll box),
 * competing with the note list's first frames. Held at its last settled
 * height instead; an exit that stays on the note releases the lock and the
 * pane follows again.
 */
internal fun leavingEditorHeight(interactionLocked: Boolean, settledHeightPx: Int): Int? =
    if (interactionLocked && settledHeightPx > 0) settledHeightPx else null

internal fun findBackAction(findVisible: Boolean): FindBackAction =
    if (findVisible) FindBackAction.DismissFind else FindBackAction.ExitNote

internal fun isFindStateCurrent(savedProcessToken: String, currentProcessToken: String): Boolean =
    savedProcessToken == currentProcessToken

internal fun canStepFind(total: Int): Boolean = total > 0

internal fun logOpenNoteDisposition(
    disposition: OpenNoteDisposition?,
    focused: Boolean,
) {
    if (disposition != null) {
        android.util.Log.d(
            "FutoOpenNote",
            "disposition=${disposition.javaClass.simpleName} focused=$focused",
        )
    }
}
