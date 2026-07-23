package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Pure-logic guard for the vault storage resolver + switch decision (no Android
 * framework — same JVM-unit-test discipline as [SyncManagerDefaultsTest]). The
 * production wiring feeds the real Context/Environment/BuildConfig into these
 * same functions.
 */
class NotesStorageTest {
    @get:Rule val tmp = TemporaryFolder()

    // ── dev/prod guard (the only thing isolating DEVICE mode dev vs prod) ──

    @Test
    fun deviceFolderNameSeparatesDevFromProd() {
        assertEquals("FUTO Notes", NotesStorage.deviceFolderName(isDebug = false))
        assertEquals("FUTO Notes Dev", NotesStorage.deviceFolderName(isDebug = true))
    }

    // ── decideStartup ──

    @Test
    fun savedModeWins() {
        val r = NotesStorage.decideStartup("DEVICE", internalVaultExists = true, deviceModeSupported = true)
        assertEquals(StorageMode.DEVICE, r.mode)
        assertFalse(r.needsOnboarding)
    }

    @Test
    fun existingInstallIsGrandfatheredOnInternal() {
        val r = NotesStorage.decideStartup(null, internalVaultExists = true, deviceModeSupported = true)
        assertEquals(StorageMode.INTERNAL, r.mode)
        assertFalse(r.needsOnboarding)
    }

    @Test
    fun freshInstallShowsPickerWhenDeviceSupported() {
        val r = NotesStorage.decideStartup(null, internalVaultExists = false, deviceModeSupported = true)
        assertNull(r.mode)
        assertTrue(r.needsOnboarding)
    }

    @Test
    fun freshInstallPreAndroid11DefaultsToAppNoPicker() {
        val r = NotesStorage.decideStartup(null, internalVaultExists = false, deviceModeSupported = false)
        assertEquals(StorageMode.APP, r.mode)
        assertFalse(r.needsOnboarding)
    }

    @Test
    fun garbageSavedModeFallsThroughToDetection() {
        val r = NotesStorage.decideStartup("BOGUS", internalVaultExists = false, deviceModeSupported = true)
        assertNull(r.mode)
        assertTrue(r.needsOnboarding)
    }

    @Test
    fun pickerDefaultsToDeviceForLegacyInternalOnlyWhenDeviceSupported() {
        assertEquals(
            StorageMode.DEVICE,
            NotesStorage.pickerInitialMode(StorageMode.INTERNAL, deviceModeSupported = true),
        )
        assertEquals(
            StorageMode.APP,
            NotesStorage.pickerInitialMode(StorageMode.INTERNAL, deviceModeSupported = false),
        )
    }

    @Test
    fun pickerCoercesUnsupportedDeviceModeToAppStorage() {
        assertEquals(
            StorageMode.APP,
            NotesStorage.pickerInitialMode(StorageMode.DEVICE, deviceModeSupported = false),
        )
        assertEquals(
            StorageMode.APP,
            NotesStorage.pickerInitialMode(StorageMode.APP, deviceModeSupported = false),
        )
    }

    // ── looksLikeExistingVault ──

    @Test
    fun emptyOrMissingDirIsNotAnExistingVault() {
        assertFalse(NotesStorage.looksLikeExistingVault(File(tmp.root, "missing")))
        assertFalse(NotesStorage.looksLikeExistingVault(tmp.newFolder("empty")))
    }

    @Test
    fun dirWithContentIsAnExistingVault() {
        val vault = tmp.newFolder("vault")
        File(vault, "note.md").writeText("hi")
        assertTrue(NotesStorage.looksLikeExistingVault(vault))
    }

    @Test
    fun storageSwitchDecisionCommitsOnlySafeOutcomes() {
        val migrated = NotesStorage.storageSwitchDecision(
            NotesStorage.MigrationOutcome.Migrated(files = 2),
        )
        val empty = NotesStorage.storageSwitchDecision(NotesStorage.MigrationOutcome.EmptySource)
        val alreadySelected = NotesStorage.storageSwitchDecision(
            NotesStorage.MigrationOutcome.AlreadyAtDestination,
        )
        val failed = NotesStorage.storageSwitchDecision(
            NotesStorage.MigrationOutcome.Failed("Copy verification failed."),
        )

        assertTrue(migrated.commitPreference)
        assertTrue(migrated.restart)
        assertTrue(migrated.requiresFinalization)
        assertTrue(empty.commitPreference)
        assertTrue(empty.restart)
        assertFalse(empty.requiresFinalization)
        assertFalse(alreadySelected.requiresFinalization)
        assertFalse(failed.commitPreference)
        assertFalse(failed.restart)
        assertFalse(failed.requiresFinalization)
        assertEquals("Copy verification failed.", failed.feedback)
    }

}
