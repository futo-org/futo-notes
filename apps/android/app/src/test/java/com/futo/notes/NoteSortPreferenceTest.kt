package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.NoteSortKey
import uniffi.futo_notes_ffi.NoteSortOrder
import uniffi.futo_notes_ffi.SortDirection

class NoteSortPreferenceTest {
    @Test
    fun defaultsToLastModifiedNewestFirst() {
        assertEquals(NoteSortKey.LAST_MODIFIED, NoteSortPreference.DEFAULT.key)
        assertEquals(SortDirection.DESCENDING, NoteSortPreference.DEFAULT.direction)
        assertEquals(NoteSortPreference.DEFAULT, NoteSortPreference.resolve(null))
    }

    @Test
    fun roundTripsThroughRawValue() {
        val order = NoteSortOrder(NoteSortKey.NAME, SortDirection.DESCENDING)
        assertEquals("NAME:DESCENDING", NoteSortPreference.rawValue(order))
        assertEquals(order, NoteSortPreference.resolve(NoteSortPreference.rawValue(order)))
    }

    @Test
    fun garbageOrUnknownValuesFallBackToTheDefault() {
        assertEquals(NoteSortPreference.DEFAULT, NoteSortPreference.resolve("CREATED:UP"))
        assertEquals(NoteSortPreference.DEFAULT, NoteSortPreference.resolve("NAME"))
        assertEquals(NoteSortPreference.DEFAULT, NoteSortPreference.resolve("NAME:SIDEWAYS"))
    }

    @Test
    fun eachKeyOffersItsNaturalDirectionFirst() {
        assertEquals(
            listOf(SortDirection.ASCENDING, SortDirection.DESCENDING),
            NoteSortPreference.directions(NoteSortKey.NAME),
        )
        assertEquals(
            listOf(SortDirection.DESCENDING, SortDirection.ASCENDING),
            NoteSortPreference.directions(NoteSortKey.LAST_MODIFIED),
        )
    }

    @Test
    fun keyChangeKeepsTheMenuPosition() {
        val recent = NoteSortOrder(NoteSortKey.LAST_MODIFIED, SortDirection.DESCENDING)
        assertEquals(
            SortDirection.ASCENDING,
            NoteSortPreference.withKey(NoteSortKey.NAME, recent).direction,
        )
        val reversed = NoteSortOrder(NoteSortKey.NAME, SortDirection.DESCENDING)
        assertEquals(
            SortDirection.ASCENDING,
            NoteSortPreference.withKey(NoteSortKey.LAST_MODIFIED, reversed).direction,
        )
    }

    @Test
    fun directionLabelsFollowTheActiveKey() {
        assertEquals(
            "notes.sort.aToZ",
            NoteSortPreference.directionLabelPath(NoteSortKey.NAME, SortDirection.ASCENDING),
        )
        assertEquals(
            "notes.sort.zToA",
            NoteSortPreference.directionLabelPath(NoteSortKey.NAME, SortDirection.DESCENDING),
        )
        assertEquals(
            "notes.sort.newest",
            NoteSortPreference.directionLabelPath(
                NoteSortKey.LAST_MODIFIED,
                SortDirection.DESCENDING,
            ),
        )
        assertEquals(
            "notes.sort.oldest",
            NoteSortPreference.directionLabelPath(
                NoteSortKey.LAST_MODIFIED,
                SortDirection.ASCENDING,
            ),
        )
        assertEquals("notes.sort.name", NoteSortPreference.keyLabelPath(NoteSortKey.NAME))
        assertEquals(
            "notes.sort.lastModified",
            NoteSortPreference.keyLabelPath(NoteSortKey.LAST_MODIFIED),
        )
    }
}
