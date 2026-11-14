package com.futo.notes

/** A snapshot supplied explicitly to a Rust note mutation. */
data class PendingDraft(val id: String, val base: String, val content: String)

/** Reset retirement for native editor-owned mutations, independent of rendering. */
internal class EditorDraftOwnership {
    private var seq = 0L
    private var retiredThrough = 0L
    fun claim(): Long = ++seq
    fun owns(token: Long): Boolean = token > retiredThrough && token <= seq
    fun reset() { retiredThrough = seq }
}

/** Native sessions own their bytes and durability; the store only coordinates handoffs. */
internal data class NativeEditorDraft(
    val checkpoint: suspend () -> Boolean,
    val unsavedNoteId: () -> String?,
    val checkpointForMigration: suspend () -> Boolean = checkpoint,
)

internal suspend fun checkpointNativeDrafts(
    drafts: List<NativeEditorDraft>,
    forMigration: Boolean = false,
): Boolean {
    var allSaved = true
    for (draft in drafts) {
        val saved = if (forMigration) draft.checkpointForMigration() else draft.checkpoint()
        if (!saved) allSaved = false
    }
    return allSaved
}
