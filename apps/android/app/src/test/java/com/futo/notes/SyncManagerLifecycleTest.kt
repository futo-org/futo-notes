package com.futo.notes

import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import uniffi.futo_notes_ffi.NoHandle
import uniffi.futo_notes_ffi.SyncClient
import uniffi.futo_notes_ffi.SyncEventListener
import uniffi.futo_notes_ffi.SyncSummary

/**
 * Live sync never starts while the app is in the background (live-sync.md).
 * A connect runs its first cycle before going live, and a foreground resume
 * can wait behind other sync work for the gate; a [SyncManager.pauseLive]
 * during either wait stops live sync first, so the start that follows must
 * not reopen the stream in the background — Rust cannot know it was meant to
 * stay stopped.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncManagerLifecycleTest {
    /** The Rust client, as far as the manager can tell: the first cycle waits
     *  until the test lets it finish, and live starts are counted. */
    private class StandInClient : SyncClient(NoHandle) {
        val cycle = CompletableDeferred<SyncSummary>()
        var liveStarts = 0

        override suspend fun syncNow(): SyncSummary = cycle.await()
        override suspend fun startLive(listener: SyncEventListener) { liveStarts += 1 }
        override fun stopLive() {}
    }

    @Before
    fun mainIsTheTestThread() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun restoreMain() = Dispatchers.resetMain()

    @Test
    fun backgroundedDuringAConnectsFirstCycleItDoesNotGoLiveUntilTheNextForeground() = runTest {
        val mgr = SyncManager()
        val client = StandInClient()
        val connect = launch {
            mgr.afterConnect(client, SyncManager.SessionMode.HOSTED, LocalizedMessage("status"))
        }
        testScheduler.runCurrent() // the connect is now waiting on its first cycle

        mgr.pauseLive()
        client.cycle.complete(syncSummary())
        connect.join()
        assertEquals("live sync started in the background", 0, client.liveStarts)

        mgr.resumeLiveAsync()
        assertEquals(1, client.liveStarts)
    }

    @Test
    fun backgroundedWhileAResumeWaitsForTheGateItDoesNotGoLive() = runTest {
        val mgr = SyncManager()
        val client = StandInClient()
        mgr.client = client
        mgr.connected = true

        mgr.storageMigrationGate.runAccess {
            mgr.resumeLiveAsync() // queued behind this access
            mgr.pauseLive()
        }
        assertEquals("live sync started in the background", 0, client.liveStarts)

        mgr.resumeLiveAsync()
        assertEquals(1, client.liveStarts)
    }

    @Test
    fun aForegroundConnectGoesLive() = runTest {
        val mgr = SyncManager()
        val client = StandInClient()
        client.cycle.complete(syncSummary())
        mgr.afterConnect(client, SyncManager.SessionMode.HOSTED, LocalizedMessage("status"))
        assertEquals(1, client.liveStarts)
    }
}
