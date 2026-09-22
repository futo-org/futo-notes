package com.futo.notes.sync.hosted

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.WriterException
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * A pairing payload as a grid of black and white squares.
 *
 * One of the two things Rust cannot do for pairing (ADR 0003, decision 11): the
 * engine hands over a payload string and this turns it into squares. Nothing
 * here reads the payload's shape — a QR code is bytes in, modules out — so a
 * change to what the payload carries never reaches this file.
 *
 * Kept separate from the composable that paints it so the encoding can be
 * tested on the JVM: ZXing is plain Java, while `android.graphics.Bitmap` is a
 * stub that throws in a unit test.
 */
class PairingCodeMatrix(
    /** The grid's width in squares, INCLUDING the quiet border. */
    val size: Int,
    private val dark: BooleanArray,
) {
    fun isDark(column: Int, row: Int): Boolean = dark[row * size + column]
}

/**
 * Error correction is `M`, matching the desktop and iOS renderers: a screen is
 * not a printed label, but a phone camera reads it at an angle, off a display
 * with its own glare and scaling, so the cheapest level is not the right one.
 * The border is the four-square quiet zone the QR spec asks for — without it a
 * scanner cannot find the code against whatever is next to it — and it is baked
 * into the grid rather than left to layout padding, so the picture is scannable
 * wherever it is drawn.
 *
 * Returns null for a payload ZXing will not encode at all, which the caller
 * renders as no code rather than as a crash.
 */
fun pairingCodeMatrix(payload: String): PairingCodeMatrix? {
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.CHARACTER_SET to "UTF-8",
        EncodeHintType.MARGIN to 4,
    )
    // Asking for 1×1 does not shrink anything: QRCodeWriter enlarges to the
    // symbol's own size, so this asks for exactly one pixel per module.
    val matrix = try {
        QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 1, 1, hints)
    } catch (_: WriterException) {
        return null
    } catch (_: IllegalArgumentException) {
        return null
    }
    if (matrix.width != matrix.height) return null
    val size = matrix.width
    val dark = BooleanArray(size * size)
    for (row in 0 until size) {
        for (column in 0 until size) {
            dark[row * size + column] = matrix.get(column, row)
        }
    }
    return PairingCodeMatrix(size, dark)
}
