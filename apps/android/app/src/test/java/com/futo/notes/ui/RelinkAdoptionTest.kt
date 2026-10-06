package com.futo.notes.ui

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class RelinkAdoptionTest {
    @Test fun refusedRelinkRebasesOnEachRevisionAndStopsAfterThree() = runBlocking {
        val generations = mutableListOf<Long>()
        var revision = 0L
        var live = "[[old]]"
        var base = live
        settleRelinkAdoption(
            flushed = live, relinkedBody = "[[new]]",
            awaitCurrent = { EditorCurrent(DocumentSnapshot(++revision, live), false) },
            liveContent = { live }, receiveChange = { live = it }, setBaseline = { base = it },
            apply = { text, generation -> assertEquals("[[new]]", text); generations += generation; false },
        )
        assertEquals(listOf(1L, 2L, 3L), generations)
        assertEquals("[[old]]", live)
        assertEquals("[[new]]", base)
    }

    @Test fun editDeliveredAfterRefusalIsKeptAgainstRelinkedBaseline() = runBlocking {
        var waits = 0
        var offers = 0
        var live = "[[old]]"
        var base = live
        settleRelinkAdoption(
            flushed = live, relinkedBody = "[[new]]",
            awaitCurrent = { EditorCurrent(DocumentSnapshot((++waits).toLong(), if (waits == 1) live else "[[old]] typed"), false) },
            liveContent = { live }, receiveChange = { live = it }, setBaseline = { base = it },
            apply = { _, _ -> offers++; false },
        )
        assertEquals(1, offers)
        assertEquals("[[old]] typed", live)
        assertEquals("[[new]]", base)
    }
}
