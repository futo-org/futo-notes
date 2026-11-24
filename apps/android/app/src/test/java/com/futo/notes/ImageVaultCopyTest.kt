package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The picker and clipboard paths (saveImageIntoVault) name every saved image
 * `image-<second>[-n].<ext>`. Saves that land in the same wall-clock second must
 * each get their own file and keep their own bytes, and the name must be taken on
 * disk before any byte is read: an exists()-check-then-write allocator lets two
 * concurrent saves pick one name and clobber each other.
 */
class ImageVaultCopyTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun rapidSavesGetDistinctReservedFilesAndDoNotClobber() {
        // A vault folder that does not exist yet: the first save creates it.
        val root = File(tmp.root, "vault")
        val names = (0 until 25).map { i ->
            copyImageIntoVault(root, "png") {
                // When the copy asks for the bytes, its file already exists, empty, beside
                // the i files saved before it.
                val files = root.listFiles().orEmpty()
                assertEquals("save $i: reserved before the copy starts", i + 1, files.size)
                assertEquals("save $i: exactly one empty reservation", 1, files.count { it.length() == 0L })
                byteArrayOf(i.toByte()).inputStream()
            }!!
        }
        assertEquals("every save got a unique filename", names.size, names.toSet().size)
        names.forEachIndexed { i, name ->
            assertEquals(listOf(i.toByte()), File(root, name).readBytes().toList())
        }
    }
}
