package com.futo.notes

import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.MimeTypeMap
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object FeedbackImages {
    const val MAX_BYTES = 5 * 1024 * 1024
    const val JPEG_QUALITY = 95
    const val MAX_ATTACHMENTS = 3

    private val serverAccepted = setOf("png", "jpg", "jpeg", "webp")

    fun needsTranscode(ext: String, byteCount: Int): Boolean =
        ext.lowercase() !in serverAccepted || byteCount > MAX_BYTES

    private fun transcodeToJpeg(bytes: ByteArray): ByteArray? {
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        return try {
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) return null
            out.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    suspend fun normalize(resolver: ContentResolver, uri: Uri): ByteArray? = withContext(Dispatchers.IO) {
        read(resolver, uri)
    }

    private fun read(resolver: ContentResolver, uri: Uri): ByteArray? {
        val bytes = try {
            resolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (e: Exception) {
            android.util.Log.w("FeedbackImages", "could not read picked image", e)
            null
        } ?: return null

        val ext = resolver.getType(uri)
            ?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
            ?: uri.lastPathSegment?.substringAfterLast('.', "")
            ?: ""

        if (!needsTranscode(ext, bytes.size)) return bytes
        return transcodeToJpeg(bytes)?.takeIf { it.size <= MAX_BYTES }
    }
}
