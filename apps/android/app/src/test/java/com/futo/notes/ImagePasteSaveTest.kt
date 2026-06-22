package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Guards [saveImageDataIntoVault] — the clipboard-paste save path. The naming
 * must be COLLISION-SAFE: two pastes landing in the same wall-clock second must
 * not pick the same filename and clobber each other (the bug an adversarial
 * review flagged when the old code did exists()-check-then-write). These run as
 * plain JVM tests — the happy path touches only java.io, no Android framework.
 */
class ImagePasteSaveTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun savesBytesAndReturnsFilename() {
        val root = tmp.newFolder("vault")
        val bytes = byteArrayOf(1, 2, 3, 4)
        val name = saveImageDataIntoVault(root, bytes, "png")
        assertTrue(name!!.startsWith("image-"))
        assertTrue(name.endsWith(".png"))
        assertTrue(File(root, name).readBytes().contentEquals(bytes))
    }

    @Test
    fun rejectsDisallowedExtension() {
        val root = tmp.newFolder("vault")
        assertNull(saveImageDataIntoVault(root, byteArrayOf(1), "exe"))
    }

    @Test
    fun rapidPastesGetDistinctFilesAndDoNotClobber() {
        val root = tmp.newFolder("vault")
        // Many saves in a tight loop (same second) — each must get its own file
        // with its own bytes; none may overwrite another.
        val names = (0 until 25).map { i ->
            saveImageDataIntoVault(root, byteArrayOf(i.toByte()), "png")!!
        }
        assertEquals("every save got a unique filename", names.size, names.toSet().size)
        names.forEachIndexed { i, name ->
            assertEquals(byteArrayOf(i.toByte()).toList(), File(root, name).readBytes().toList())
        }
    }

    @Test
    fun createsVaultDirIfMissing() {
        val root = File(tmp.root, "does/not/exist/yet")
        val name = saveImageDataIntoVault(root, byteArrayOf(9), "jpg")
        assertTrue(File(root, name!!).exists())
    }
}
