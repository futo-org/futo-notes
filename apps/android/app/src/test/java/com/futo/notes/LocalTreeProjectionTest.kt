package com.futo.notes

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The post-sync note-list refresh runs on the release path too, inside a serial
 * chain: a refresh that never succeeds must end in a rescan and still publish
 * the summary, or every later sync's list update queues behind it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LocalTreeProjectionTest {
    private class Probe {
        var refreshes = 0
        var applied = emptyList<String>()
        var rebuilds = 0
        var emits = 0
    }

    private suspend fun run(
        probe: Probe,
        active: () -> Boolean = { true },
        refresh: suspend (Int) -> String,
    ) = projectLocalTree(
        retry = LocalTreeRetry(attempts = 3, delayMs = 2_000),
        active = active,
        refresh = { refresh(++probe.refreshes) },
        apply = { probe.applied = probe.applied + it },
        rebuild = { probe.rebuilds++ },
        emit = { probe.emits++ },
    )

    @Test
    fun aTransientRefreshFailureIsRetriedAndNeverRebuilds() = runTest {
        val probe = Probe()
        run(probe) { n -> if (n < 3) error("busy") else "mutation" }
        assertEquals(3, probe.refreshes)
        assertEquals(listOf("mutation"), probe.applied)
        assertEquals(0, probe.rebuilds)
        assertEquals(1, probe.emits)
    }

    @Test
    fun aPersistentRefreshFailureIsBoundedThenRescansAndStillPublishes() = runTest {
        val probe = Probe()
        run(probe) { error("malformed id") }
        assertEquals(3, probe.refreshes)
        assertEquals(emptyList<String>(), probe.applied)
        assertEquals(1, probe.rebuilds)
        assertEquals(1, probe.emits)
        assertEquals("no wait after the last attempt", 4_000, currentTime)
    }

    @Test
    fun aFailingRescanStillPublishesTheSummary() = runTest {
        val probe = Probe()
        projectLocalTree<String>(
            retry = LocalTreeRetry(attempts = 2, delayMs = 10),
            active = { true },
            refresh = { error("refresh") },
            apply = { probe.applied = probe.applied + it },
            rebuild = { error("rescan") },
            emit = { probe.emits++ },
        )
        assertEquals(1, probe.emits)
    }

    @Test
    fun aResetDuringRetryAbandonsTheEventWithoutRebuildOrPublish() = runTest {
        val probe = Probe()
        var live = true
        run(probe, active = { live }) { live = false; error("busy") }
        assertEquals(1, probe.refreshes)
        assertEquals(0, probe.rebuilds)
        assertEquals(0, probe.emits)
        assertTrue(probe.applied.isEmpty())
    }
}
