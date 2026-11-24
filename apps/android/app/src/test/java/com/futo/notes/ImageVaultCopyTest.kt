package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The picker and clipboard paths (saveImageIntoVault) name every saved image
 * `image-<second>[-n].<ext>`. Saves that land in the same wall-clock second must
 * each get their own file and keep their own bytes: the old exists()-check-then-write
 * let two of them pick one name and clobber each other.
 */
class ImageVaultCopyTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun rapidSavesGetDistinctFilesAndDoNotClobber() {
        // A vault folder that does not exist yet: the first save creates it.
        val root = File(tmp.root, "vault")
        val names = (0 until 25).map { i ->
            copyImageIntoVault(root, "png") { byteArrayOf(i.toByte()).inputStream() }!!
        }
        assertEquals("every save got a unique filename", names.size, names.toSet().size)
        names.forEachIndexed { i, name ->
            assertEquals(listOf(i.toByte()), File(root, name).readBytes().toList())
        }
    }
}
