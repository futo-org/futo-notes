package com.futo.notes.storage

import com.futo.notes.localization.LocalizedMessage

data class StorageAdoptionSummary(
    val destinationNotes: Int,
    val destinationLastModifiedMs: Long,
    val currentPath: String,
    val currentNotes: Int,
    val nowMs: Long,
)

fun storageAdoptionMessage(summary: StorageAdoptionSummary): LocalizedMessage {
    val arguments = mapOf(
        "destinationNotes" to summary.destinationNotes,
        "currentNotes" to summary.currentNotes,
        "currentPath" to summary.currentPath,
    )
    if (summary.destinationNotes == 0) {
        return LocalizedMessage("storage.android.adoptionNoNotes", arguments)
    }
    if (summary.destinationLastModifiedMs <= 0 || summary.destinationLastModifiedMs > summary.nowMs) {
        return LocalizedMessage("storage.android.adoptionWithNotes", arguments)
    }
    val days = (summary.nowMs - summary.destinationLastModifiedMs) / MILLIS_PER_DAY
    return when {
        days < 1 -> LocalizedMessage("storage.android.adoptionWithNotesToday", arguments)
        days < 2 -> LocalizedMessage("storage.android.adoptionWithNotesYesterday", arguments)
        days < 30 -> LocalizedMessage(
            "storage.android.adoptionWithNotesDaysAgo",
            arguments + ("days" to days),
        )
        else -> LocalizedMessage("storage.android.adoptionWithNotesOverMonth", arguments)
    }
}

private const val MILLIS_PER_DAY = 24 * 60 * 60 * 1000L
