package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Pure-logic guard for the vault storage resolver + migration (no Android
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

    // ── migrate ──

    @Test
    fun migrateCopiesDotfilesAndImagesThenDeletesSource() {
        val from = tmp.newFolder("from")
        File(from, "note.md").writeText("# hello")
        File(from, "Folder").mkdirs()
        File(from, "Folder/nested.md").writeText("nested")
        File(from, "image.png").writeBytes(byteArrayOf(1, 2, 3))
        // dotfiles: sync state + crash logs must travel with the vault
        File(from, ".futo").mkdirs()
        File(from, ".futo/.e2ee-state.json").writeText("{\"objectMap\":{}}")
        File(from, ".crashlogs").mkdirs()
        File(from, ".crashlogs/crash-1.json").writeText("{}")

        val to = File(tmp.root, "to")
        val result = NotesStorage.migrate(from, to)

        assertTrue(result.migrated)
        assertEquals(5, result.files)
        assertTrue(File(to, "note.md").exists())
        assertTrue(File(to, "Folder/nested.md").exists())
        assertTrue(File(to, "image.png").exists())
        assertEquals("{\"objectMap\":{}}", File(to, ".futo/.e2ee-state.json").readText())
        assertTrue(File(to, ".crashlogs/crash-1.json").exists())
        // verify-before-delete: source is gone only after a reconciled copy
        assertFalse(from.exists())
    }

    @Test
    fun migrateIsIdempotentWhenRerun() {
        val from = tmp.newFolder("from2")
        File(from, "a.md").writeText("a")
        val to = File(tmp.root, "to2")

        val first = NotesStorage.migrate(from, to)
        assertTrue(first.migrated)
        // Re-running with the (now-deleted) source is a no-op, not a crash.
        val second = NotesStorage.migrate(from, to)
        assertFalse(second.migrated)
        assertTrue(File(to, "a.md").exists())
    }

    @Test
    fun migrateNoOpsOnEmptyOrSamePath() {
        val empty = tmp.newFolder("empty2")
        assertFalse(NotesStorage.migrate(empty, File(tmp.root, "dest")).migrated)

        val same = tmp.newFolder("same")
        File(same, "x.md").writeText("x")
        assertFalse(NotesStorage.migrate(same, same).migrated)
        assertTrue(File(same, "x.md").exists())
    }
}
