package com.futo.notes.sync.hosted

import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two halves of the camera path, checked against each other: a payload
 * drawn as squares, and those same squares read back as a payload.
 *
 * Neither half knows what a pairing payload contains — a QR code is bytes in,
 * bytes out — so these use a real one only because that is the size and shape
 * the app actually draws.
 */
class PairingCodeTest {
    private val payload = """
        {"futo_notes_pairing":1,"id":"01J9ZS1V7K8S3W4T5Q6R7Y8Z9A",
        "pk":"kZ3nQ8v2cR1sT7uY0wX5bN6mJ4hG9fD8aS2pL1kO3iU=",
        "name":"Pixel 8","platform":"android"}
    """.trimIndent().replace("\n", "")

    @Test
    fun `a payload drawn as a code reads back as the same payload`() {
        val matrix = pairingCodeMatrix(payload)
        assertNotNull(matrix)
        assertEquals(payload, decodePairingCode(matrix!!.asLuminance(scale = 4)))
    }

    @Test
    fun `a code carries its four-square quiet zone, so a scanner can find it`() {
        val matrix = pairingCodeMatrix(payload)!!
        // The outermost four rings of modules are white on every side.
        for (ring in 0 until 4) {
            for (i in 0 until matrix.size) {
                assertTrue(
                    "quiet zone broken at ring $ring, index $i",
                    !matrix.isDark(i, ring) &&
                        !matrix.isDark(i, matrix.size - 1 - ring) &&
                        !matrix.isDark(ring, i) &&
                        !matrix.isDark(matrix.size - 1 - ring, i),
                )
            }
        }
    }

    @Test
    fun `a code still reads when it is a quarter turn out`() {
        val matrix = pairingCodeMatrix(payload)!!
        assertEquals(
            payload,
            decodePairingCode(matrix.asLuminance(scale = 4).rotateCounterClockwise()),
        )
    }

    /**
     * The regression for the first crash a real camera produced: a CameraX
     * frame's brightness plane cannot be rotated, and ZXing answers that by
     * throwing. Asking anyway took the whole app down from the analyzer thread
     * on the first frame the scanner ever saw. The test uses the same source
     * type the app uses, not the rotatable one a picture file produces.
     */
    @Test
    fun `a camera frame, which cannot be rotated, reads without taking the app down`() {
        val matrix = pairingCodeMatrix(payload)!!
        assertEquals(payload, decodePairingCode(matrix.asCameraFrame(scale = 4)))
        // And a frame with nothing in it answers null rather than throwing.
        val blank = PlanarYUVLuminanceSource(
            ByteArray(80 * 80) { WHITE_LUMA },
            80,
            80,
            0,
            0,
            80,
            80,
            false,
        )
        assertFalse("this is the source type that cannot rotate", blank.isRotateSupported)
        assertNull(decodePairingCode(blank))
    }

    @Test
    fun `a picture with no code in it reads as nothing rather than as something`() {
        val blank = IntArray(80 * 80) { WHITE }
        assertNull(decodePairingCode(RGBLuminanceSource(80, 80, blank)))
    }

    @Test
    fun `a payload too long for any QR code is no code at all, not a crash`() {
        // Version 40 at error correction M tops out around 2,300 bytes.
        assertNull(pairingCodeMatrix("x".repeat(5000)))
    }

    /**
     * The grid as ONE CAMERA FRAME: a `PlanarYUVLuminanceSource` over a
     * brightness plane, which is exactly what CameraX hands the analyzer. Its
     * `rowStride` is deliberately wider than the image, as a real frame's
     * usually is.
     */
    private fun PairingCodeMatrix.asCameraFrame(scale: Int): PlanarYUVLuminanceSource {
        val side = size * scale
        val stride = side + 16
        val plane = ByteArray(stride * side) { WHITE_LUMA }
        for (y in 0 until side) {
            for (x in 0 until side) {
                plane[y * stride + x] = if (isDark(x / scale, y / scale)) BLACK_LUMA else WHITE_LUMA
            }
        }
        return PlanarYUVLuminanceSource(plane, stride, side, 0, 0, side, side, false)
    }

    /** The grid as a picture, one square blown up to [scale] pixels a side. */
    private fun PairingCodeMatrix.asLuminance(scale: Int): RGBLuminanceSource {
        val side = size * scale
        val pixels = IntArray(side * side)
        for (y in 0 until side) {
            for (x in 0 until side) {
                pixels[y * side + x] = if (isDark(x / scale, y / scale)) BLACK else WHITE
            }
        }
        return RGBLuminanceSource(side, side, pixels)
    }

    private companion object {
        const val BLACK = 0xFF000000.toInt()
        const val WHITE = 0xFFFFFFFF.toInt()

        /** One byte of brightness, as a YUV plane carries it. */
        const val BLACK_LUMA: Byte = 0
        const val WHITE_LUMA: Byte = -1
    }
}
