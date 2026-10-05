package com.futo.notes.ui

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class EditorMailboxTest {
    @Test fun currentNeedsNoBridgeTraffic() = runBlocking {
        val mailbox = EditorMailbox()
        mailbox.loaded("a", 1, "base")
        val answer = mailbox.awaitCurrent("a") { fail("current mailbox must not flush") }
        assertEquals("base", answer.latest?.content)
        assertTrue(answer.canProceed)
    }
    @Test fun outgoingChangeNeverOverwritesTheIncomingNote() {
        val mailbox = EditorMailbox()
        mailbox.loaded("a", 1, "A")
        mailbox.loaded("b", 3, "B")
        mailbox.edited("a", 2)
        mailbox.change("a", 2, "A edited")
        assertEquals("A edited", mailbox.current("a").latest?.content)
        assertEquals("B", mailbox.current("b").latest?.content)
        assertFalse(mailbox.change("a", 1, "old"))
    }
    @Test fun behindFlushesOnceAndAnyNewChangeSatisfiesIt() = runBlocking {
        val mailbox = EditorMailbox()
        mailbox.loaded("a", 1, "base")
        mailbox.edited("a", 2)
        var calls = 0
        val answer = mailbox.awaitCurrent("a") {
            calls++
            mailbox.change("a", 3, "typed")
        }
        assertEquals(1, calls)
        assertEquals("typed", answer.latest?.content)
        assertTrue(answer.canProceed)
    }
    @Test fun unansweredBehindRefusesThenRetrySeesTheDeliveredChange() = runBlocking {
        val mailbox = EditorMailbox()
        mailbox.loaded("a", 1, "base")
        mailbox.edited("a", 2)
        assertFalse(mailbox.awaitCurrent("a", 1) {}.canProceed)
        mailbox.change("a", 2, "typed")
        assertTrue(mailbox.awaitCurrent("a") { fail("retry already current") }.canProceed)
    }
    @Test fun failureRefusesButRendererDeathProceedsWithLatest() = runBlocking {
        val mailbox = EditorMailbox()
        mailbox.loaded("a", 1, "base")
        mailbox.edited("a", 2)
        assertFalse(mailbox.awaitCurrent("a") { mailbox.failed("a", it) }.canProceed)
        val answer = mailbox.awaitCurrent("a") { mailbox.rendererGone() }
        assertTrue(answer.canProceed)
        assertEquals("base", answer.latest?.content)
        mailbox.loaded("a", 1, "restored")
        assertFalse(mailbox.current("a").rendererGone)
    }
    @Test fun cancelledWaitDoesNotConsumeTheNextChange() = runBlocking {
        val mailbox = EditorMailbox()
        mailbox.loaded("a", 1, "base")
        mailbox.edited("a", 2)
        val started = kotlinx.coroutines.CompletableDeferred<Unit>()
        val pending = async { mailbox.awaitCurrent("a") { started.complete(Unit) } }
        started.await()
        pending.cancel()
        pending.join()
        mailbox.change("a", 2, "typed")
        assertTrue(mailbox.current("a").canProceed)
    }
    @Test fun detachedOutgoingOwnerRetainsOneLateDraft() {
        val mailbox = EditorMailbox()
        val a = mutableListOf<String>()
        val b = mutableListOf<String>()
        val retained = mutableListOf<String>()
        mailbox.bind(1, "a") { a.add(it) }
        mailbox.bind(2, "b") { b.add(it) }
        mailbox.loaded("a", 1, "A")
        mailbox.loaded("b", 3, "B")
        mailbox.edited("a", 2)
        mailbox.detach(1)
        mailbox.retainUnflushed("a") { retained.add(it) }
        mailbox.change("a", 2, "A edited")
        mailbox.change("a", 2, "duplicate")
        assertTrue(a.isEmpty())
        assertTrue(b.isEmpty())
        assertEquals(listOf("A edited"), retained)
        assertEquals("B", mailbox.current("b").latest?.content)
    }
    @Test fun detachCannotRemoveANewerBindingForTheSameNote() {
        val mailbox = EditorMailbox()
        val reports = mutableListOf<String>()
        mailbox.bind(1, "a") { fail("detached callback") }
        mailbox.bind(2, "a") { reports.add(it) }
        mailbox.detach(1)
        mailbox.change("a", 2, "latest")
        assertEquals(listOf("latest"), reports)
    }
    @Test fun aNewOpenCannotReuseThePlaceholderOrAnEarlierCleanSnapshot() {
        val mailbox = EditorMailbox()
        mailbox.loaded("", 1, "")
        mailbox.loaded("a", 2, "old body")
        mailbox.prepareLoad("a")
        assertFalse(mailbox.change("a", 2, "late blur echo"))
        assertNull(mailbox.current("a").latest)
        assertTrue(mailbox.current("a").canProceed)
        mailbox.loaded("a", 3, "disk body")
        assertEquals("disk body", mailbox.current("a").latest?.content)
        mailbox.edited("a", 4)
        mailbox.prepareLoad("a")
        assertTrue(mailbox.current("a").behind)
        assertEquals("disk body", mailbox.current("a").latest?.content)
    }

    @Test fun renamedIdentityWaitsForItsOwnAcknowledgmentBeforeRelinking(): Unit = runBlocking {
        val mailbox = EditorMailbox()
        mailbox.loaded("old", 1, "back to [[old]]")
        mailbox.loaded("new", 0, "earlier deleted note")
        mailbox.prepareLoad("new")
        var loads = 0
        val pending = async {
            mailbox.awaitLoaded("new", 1_000) { loads += 1 }
        }
        kotlinx.coroutines.yield()
        assertFalse(pending.isCompleted)
        mailbox.loaded("other", 2, "other body")
        assertFalse(pending.isCompleted)
        mailbox.loaded("new", 3, "back to [[old]]")
        val ready = pending.await()
        assertEquals(1, loads)
        assertEquals(3L, ready.latest?.generation)
        assertEquals("back to [[old]]", ready.latest?.content)
        mailbox.awaitLoaded("new") { fail("already loaded") }
    }
    @Test fun unansweredLoadDoesNotInventARevision() = runBlocking {
        val mailbox = EditorMailbox()
        assertNull(mailbox.awaitLoaded("new", 1) {}.latest)
    }

    @Test fun pruningReleasesUnusedBodiesAndKeepsLateDraftDelivery() {
        val mailbox = EditorMailbox()
        mailbox.loaded("old", 1, "large old body")
        mailbox.prune("new")
        assertNull(mailbox.current("old").latest)
        mailbox.loaded("dirty", 2, "base")
        mailbox.edited("dirty", 3)
        val retained = mutableListOf<String>()
        mailbox.retainUnflushed("dirty") { retained += it }
        mailbox.prune("new")
        mailbox.change("dirty", 3, "late draft")
        assertEquals(listOf("late draft"), retained)
        mailbox.prune("new")
        assertNull(mailbox.current("dirty").latest)
    }

    @Test fun retargetHandsTheOpenNotesBindingToItsNewIdentity(): Unit = runBlocking {
        val mailbox = EditorMailbox()
        val reports = mutableListOf<String>()
        mailbox.bind(1, "old") { reports.add(it) }
        mailbox.loaded("old", 1, "base")
        mailbox.change("old", 2, "base tail")
        // A keystroke lands after the rename's flush was answered.
        mailbox.edited("old", 3)
        mailbox.prepareLoad("new")
        mailbox.retarget("old", "new")
        // The editor reports its live document under the new id, which can beat
        // the composition's re-attach; the open note must still receive it.
        mailbox.change("new", 4, "base tail late")
        mailbox.change("old", 3, "late report under the old id")
        assertEquals(listOf("base tail", "base tail late"), reports)
        val current = mailbox.awaitCurrent("new") { fail("the report made the new id current") }
        assertEquals("base tail late", current.latest?.content)
    }
}
