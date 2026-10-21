package com.futo.notes.ui

import org.json.JSONObject

internal data class FindMatchesReport(
    val query: String,
    val current: Int,
    val total: Int,
    val label: String,
)

internal fun decodeFindMatches(msg: JSONObject): FindMatchesReport? {
    if (!msg.has("query") || !msg.has("current") || !msg.has("total") || !msg.has("label")) {
        return null
    }
    return FindMatchesReport(
        query = msg.optString("query"),
        current = msg.optInt("current"),
        total = msg.optInt("total"),
        label = msg.optString("label"),
    )
}

/**
 * Rejects an engine echo for an older native query. Android's EditText may
 * still have an active composing span when a bridge message arrives; applying
 * an older query there would replace the user's in-progress IME text.
 */
internal class FindReportGate {
    private var isOpen = false
    private var expectedQuery: String? = null

    fun opened() {
        isOpen = true
        expectedQuery = null
    }

    fun queryChanged(query: String) {
        isOpen = true
        expectedQuery = query
    }

    fun closed() {
        isOpen = false
        expectedQuery = null
    }

    fun accepts(report: FindMatchesReport): Boolean {
        if (!isOpen) return false
        val expected = expectedQuery
        if (expected != null && report.query != expected) return false
        expectedQuery = report.query
        return true
    }
}

internal fun isCurrentFindReportOwner(postedNoteId: String?, currentNoteId: String?): Boolean =
    postedNoteId != null && postedNoteId == currentNoteId
