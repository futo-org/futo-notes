package com.futo.notes

import android.content.SharedPreferences
import uniffi.futo_notes_ffi.NoteSortKey
import uniffi.futo_notes_ffi.NoteSortOrder
import uniffi.futo_notes_ffi.SortDirection

object NoteSortPreference {
    val DEFAULT = NoteSortOrder(NoteSortKey.LAST_MODIFIED, SortDirection.DESCENDING)

    fun read(preferences: SharedPreferences): NoteSortOrder =
        resolve(preferences.getString(Prefs.SORT_ORDER, null))

    fun write(preferences: SharedPreferences, order: NoteSortOrder) {
        preferences.edit().putString(Prefs.SORT_ORDER, rawValue(order)).apply()
    }

    // Persisted tokens are ours, not `NoteSortKey.name`: a binding-generator
    // rename would otherwise reset every saved preference.
    private val KEYS = mapOf("LAST_MODIFIED" to NoteSortKey.LAST_MODIFIED, "NAME" to NoteSortKey.NAME)
    private val DIRECTIONS =
        mapOf("DESCENDING" to SortDirection.DESCENDING, "ASCENDING" to SortDirection.ASCENDING)

    fun rawValue(order: NoteSortOrder): String {
        val key = KEYS.entries.first { it.value == order.key }.key
        val direction = DIRECTIONS.entries.first { it.value == order.direction }.key
        return "$key:$direction"
    }

    fun resolve(rawValue: String?): NoteSortOrder {
        val parts = (rawValue ?: "").split(":")
        if (parts.size != 2) return DEFAULT
        val key = KEYS[parts[0]] ?: return DEFAULT
        val direction = DIRECTIONS[parts[1]] ?: return DEFAULT
        return NoteSortOrder(key, direction)
    }

    fun directions(key: NoteSortKey): List<SortDirection> =
        if (key == NoteSortKey.NAME) listOf(SortDirection.ASCENDING, SortDirection.DESCENDING)
        else listOf(SortDirection.DESCENDING, SortDirection.ASCENDING)

    fun withKey(key: NoteSortKey, keepingPositionOf: NoteSortOrder): NoteSortOrder {
        val position =
            directions(keepingPositionOf.key).indexOf(keepingPositionOf.direction).coerceAtLeast(0)
        return NoteSortOrder(key, directions(key)[position])
    }

    fun keyLabelPath(key: NoteSortKey): String =
        if (key == NoteSortKey.NAME) "notes.sort.name" else "notes.sort.lastModified"

    fun directionLabelPath(key: NoteSortKey, direction: SortDirection): String =
        if (key == NoteSortKey.NAME) {
            if (direction == SortDirection.ASCENDING) "notes.sort.aToZ" else "notes.sort.zToA"
        } else {
            if (direction == SortDirection.DESCENDING) "notes.sort.newest" else "notes.sort.oldest"
        }
}
