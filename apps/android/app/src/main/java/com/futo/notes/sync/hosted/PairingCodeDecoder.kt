package com.futo.notes.sync.hosted

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * The string inside a QR code, or null if this picture has none.
 *
 * The other half of ZXing's job here (see [pairingCodeMatrix]): one camera
 * frame's brightness in, the payload out. It reads QR codes and nothing else —
 * every decision about the string is made above it, which is what lets the
 * whole scan path be driven without a camera (ADR 0003, decision 12).
 *
 * A [LuminanceSource] rather than a camera frame, so this is a plain function
 * over a picture: a JVM test hands it an encoded matrix, the app hands it the
 * brightness plane of a CameraX frame.
 */
fun decodePairingCode(source: LuminanceSource): String? {
    decodeUpright(source)?.let { return it }
    // A code at an angle to the sensor is what the finder patterns are for; a
    // code a quarter turn out is sometimes missed entirely, so the rotated view
    // gets a look too before this frame is given up on — but only where ZXing
    // can turn the picture. A camera frame's Y plane cannot be rotated, and
    // asking anyway throws rather than answering, which took the app down from
    // the analyzer thread on the first frame it ever saw.
    if (!source.isRotateSupported) return null
    return decodeUpright(source.rotateCounterClockwise())
}

private val hints = mapOf(
    // Worth the extra work: this runs on one frame out of many, and a code read
    // half a second sooner is a person not holding a phone still for longer.
    DecodeHintType.TRY_HARDER to true,
    DecodeHintType.CHARACTER_SET to "UTF-8",
)

/** A fresh reader each time: `QRCodeReader` keeps state between calls. */
private fun decodeUpright(source: LuminanceSource): String? = try {
    QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
} catch (_: Exception) {
    // No code in this frame (the overwhelmingly common answer), or one too
    // damaged to read. Both mean the same thing here: not yet.
    null
}
