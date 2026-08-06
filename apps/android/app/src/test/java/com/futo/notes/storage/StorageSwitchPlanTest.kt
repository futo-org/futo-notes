package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Changing storage location and moving notes are separate operations: FUTO Notes
 * copies the vault only into a folder with nothing in it, and opens a folder that
 * already holds files instead of merging into it or deleting it.
 *
 * Before this split, an occupied destination was refused outright — which meant a
 * Device source retained as a backup permanently blocked ever switching back to
 * Device storage, with no in-app way out.
 */
class StorageSwitchPlanTest {
    @Test
    fun anEmptyDestinationIsMigratedInto() {
        assertEquals(
            StorageSwitchPlan.Migrate,
            storageSwitchPlan(StorageDestination.Empty, isSyncConnected = false),
        )
    }

    @Test
    fun anOccupiedDestinationIsOpenedWithWhatItHolds() {
        assertEquals(
            StorageSwitchPlan.OpenExisting(notes = 12, lastModifiedMs = 1_700_000_000_000),
            storageSwitchPlan(
                StorageDestination.Occupied(notes = 12, lastModifiedMs = 1_700_000_000_000),
                isSyncConnected = false,
            ),
        )
    }

    /** The regression this split exists for: a leftover Device backup must not be
     *  a dead end. */
    @Test
    fun aLeftoverBackupNoLongerBlocksSwitchingBack() {
        val plan = storageSwitchPlan(
            StorageDestination.Occupied(notes = 3, lastModifiedMs = 1_600_000_000_000),
            isSyncConnected = false,
        )
        assertTrue(
            "an occupied destination must be openable, never a refusal",
            plan is StorageSwitchPlan.OpenExisting,
        )
    }

    /** A folder holding only non-note files is still occupied — `stage` refuses any
     *  non-empty destination — so it is opened, honestly reporting no notes. */
    @Test
    fun aDestinationWithFilesButNoNotesIsStillOpenedRatherThanCopiedInto() {
        assertEquals(
            StorageSwitchPlan.OpenExisting(notes = 0, lastModifiedMs = 0),
            storageSwitchPlan(
                StorageDestination.Occupied(notes = 0, lastModifiedMs = 0),
                isSyncConnected = false,
            ),
        )
    }

    @Test
    fun anUnusableDestinationIsRefused() {
        val plan = storageSwitchPlan(StorageDestination.Unusable, isSyncConnected = false)
        assertTrue(plan is StorageSwitchPlan.Refuse)
    }

    /**
     * Opening a populated folder adopts that folder's `.e2ee-state.json`, so a live
     * session would reconcile a different note set against the current watermark
     * and park every drifted note as a conflict copy. A migration carries the state
     * file along, so it stays allowed.
     */
    @Test
    fun openingAnOccupiedFolderIsRefusedWhileSyncIsConnected() {
        val plan = storageSwitchPlan(
            StorageDestination.Occupied(notes = 5, lastModifiedMs = 1_700_000_000_000),
            isSyncConnected = true,
        )
        assertTrue(plan is StorageSwitchPlan.Refuse)
        assertTrue(
            "the refusal has to say what to do about sync",
            (plan as StorageSwitchPlan.Refuse).message.contains("sync", ignoreCase = true),
        )
    }

    @Test
    fun migratingIntoAnEmptyFolderStaysAllowedWhileSyncIsConnected() {
        assertEquals(
            StorageSwitchPlan.Migrate,
            storageSwitchPlan(StorageDestination.Empty, isSyncConnected = true),
        )
    }
}
