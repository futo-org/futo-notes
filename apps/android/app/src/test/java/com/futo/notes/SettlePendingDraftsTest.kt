package com.futo.notes

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettlePendingDraftsTest {
    private val first = PendingDraft("first", "base", "first edit")
    private val second = PendingDraft("second", "base", "second edit")

    @Test
    fun reportsSuccessAndCompletesEveryDraftWhenAllPersist() = runBlocking {
        val persisted = mutableListOf<PendingDraft>()
        val completed = mutableListOf<PendingDraft>()
        val allPersisted = settlePendingDrafts(
            drafts = listOf(first, second),
            persist = { persisted.add(it); true },
            onPersisted = { completed.add(it) },
        )
        assertTrue(allPersisted)
        assertEquals(listOf(first, second), persisted)
        assertEquals(listOf(first, second), completed)
    }

    @Test
    fun attemptsEveryDraftAndReportsFailureWhenOneCannotPersist() = runBlocking {
        val persisted = mutableListOf<PendingDraft>()
        val completed = mutableListOf<PendingDraft>()
        val allPersisted = settlePendingDrafts(
            drafts = listOf(first, second),
            persist = { persisted.add(it); it != first },
            onPersisted = { completed.add(it) },
        )
        assertFalse(allPersisted)
        assertEquals(listOf(first, second), persisted)
        assertEquals(listOf(second), completed)
    }

    @Test
    fun succeedsWithNoRetainedDrafts() = runBlocking {
        val allPersisted = settlePendingDrafts(
            drafts = emptyList(),
            persist = { throw AssertionError("no draft should be persisted") },
            onPersisted = { throw AssertionError("no draft should be completed") },
        )
        assertTrue(allPersisted)
    }
}
