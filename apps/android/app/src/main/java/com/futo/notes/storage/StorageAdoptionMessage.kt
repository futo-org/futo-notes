package com.futo.notes.storage

/** Both sides of an about-to-open notes folder, for the confirmation body. */
data class StorageAdoptionSummary(
    val destinationNotes: Int,
    /** Newest note mtime in the destination; 0 when it holds no notes. */
    val destinationLastModifiedMs: Long,
    val currentPath: String,
    val currentNotes: Int,
    val nowMs: Long,
)

/**
 * Describe opening an existing notes folder.
 *
 * Both note counts and the destination's age are load-bearing, not decoration:
 * the folder being opened is often a backup this app left behind on an earlier
 * switch, and its age is the only thing that tells the user they are about to
 * look at older notes rather than the ones they were just editing.
 */
fun describeStorageAdoption(summary: StorageAdoptionSummary): String {
    val holds = when {
        summary.destinationNotes == 0 -> "That folder already has files in it, but no notes."
        else ->
            "That folder already has ${noteCount(summary.destinationNotes)}" +
                lastChanged(summary.destinationLastModifiedMs, summary.nowMs) + "."
    }
    return "$holds\n\nFUTO Notes will open it. Your current " +
        "${noteCount(summary.currentNotes)} are not moved or deleted — they stay in " +
        "${summary.currentPath}."
}

private fun noteCount(notes: Int): String = if (notes == 1) "1 note" else "$notes notes"

private fun lastChanged(lastModifiedMs: Long, nowMs: Long): String {
    if (lastModifiedMs <= 0) return ""
    val days = (nowMs - lastModifiedMs) / MILLIS_PER_DAY
    val age = when {
        days < 0 -> return ""
        days < 1 -> "today"
        days < 2 -> "yesterday"
        days < 30 -> "$days days ago"
        else -> "over a month ago"
    }
    return ", last changed $age"
}

private const val MILLIS_PER_DAY = 24 * 60 * 60 * 1000L
