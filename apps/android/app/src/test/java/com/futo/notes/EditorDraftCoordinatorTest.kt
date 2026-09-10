package com.futo.notes

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorDraftCoordinatorTest {
    @Test
    fun `reset invalidates queued work even after admission resumes`() {
        val coordinator = EditorDraftCoordinator()
        val old = coordinator.admit("note")!!
        coordinator.beginReset()
        assertNull(coordinator.admit("new"))
        assertFalse(coordinator.permits(old))
        coordinator.endReset()
        assertFalse(coordinator.permits(old))
        assertNotNull(coordinator.admit("note"))
    }

    @Test
    fun `queued draft is stale once identity mutation begins`() {
        val coordinator = EditorDraftCoordinator()
        val draft = coordinator.admit("note")!!

        val mutation = coordinator.beginIdentityMutation("note")

        assertFalse(coordinator.permits(draft))
        assertNull(coordinator.admit("note"))
        coordinator.finishIdentityMutation(mutation, committed = true)
        assertNull(coordinator.admit("note"))
    }

    @Test
    fun `failed identity mutation reopens drafts but not the stale generation`() {
        val coordinator = EditorDraftCoordinator()
        val stale = coordinator.admit("note")!!
        val mutation = coordinator.beginIdentityMutation("note")

        coordinator.finishIdentityMutation(mutation, committed = false)

        val retry = coordinator.admit("note")
        assertNotNull(retry)
        assertFalse(coordinator.permits(stale))
        assertTrue(coordinator.permits(retry!!))
    }

    @Test
    fun `same id reuse opens a new generation after committed delete`() {
        val coordinator = EditorDraftCoordinator()
        val deletedOwner = coordinator.admit("note")!!
        val deletion = coordinator.beginIdentityMutation("note")
        coordinator.finishIdentityMutation(deletion, committed = true)

        coordinator.reopen("note")

        val newOwner = coordinator.admit("note")
        assertNotNull(newOwner)
        assertFalse(coordinator.permits(deletedOwner))
        assertTrue(coordinator.permits(newOwner!!))
    }
}
