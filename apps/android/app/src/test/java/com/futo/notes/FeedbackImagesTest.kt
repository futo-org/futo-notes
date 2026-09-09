package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedbackImagesTest {
    @Test
    fun `passes through the formats the server accepts`() {
        for (ext in listOf("png", "jpg", "jpeg", "webp", "PNG", "JPEG")) {
            assertFalse(ext, FeedbackImages.needsTranscode(ext, 1024))
        }
    }

    @Test
    fun `transcodes what the dashboard cannot render`() {
        for (ext in listOf("heic", "gif", "avif", "bmp", "tiff", "")) {
            assertTrue(ext, FeedbackImages.needsTranscode(ext, 1024))
        }
    }

    @Test
    fun `transcodes an accepted format that is over the cap`() {
        assertTrue(FeedbackImages.needsTranscode("png", FeedbackImages.MAX_BYTES + 1))
    }

    @Test
    fun `leaves an accepted format exactly at the cap alone`() {
        assertFalse(FeedbackImages.needsTranscode("png", FeedbackImages.MAX_BYTES))
    }
}

class FeedbackSubmissionTest {
    @Test
    fun `posts the field names the server schema expects`() {
        val body = FeedbackSubmission.body("it broke", emptyList())

        assertEquals("it broke", body.getString("message"))
        assertEquals("android", body.getString("platform"))
    }

    @Test
    fun `sends nothing derived from the vault or the open note`() {
        val body = FeedbackSubmission.body("hi", emptyList())
        val keys = body.keys().asSequence().toSortedSet()

        assertEquals(
            sortedSetOf(
                "app_version", "device_info", "images", "message",
                "os_version", "platform",
            ),
            keys,
        )
    }

    @Test
    fun `base64-encodes each image under a data key`() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        val images = FeedbackSubmission.body("shot", listOf(png))
            .getJSONArray("images")

        assertEquals(1, images.length())
        assertEquals("iVBORw==", images.getJSONObject(0).getString("data"))
    }
}
