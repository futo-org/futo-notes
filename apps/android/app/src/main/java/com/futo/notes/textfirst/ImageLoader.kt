package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import java.io.File
import java.util.concurrent.Executors

/**
 * Decodes vault images for image atoms, off the UI and editor threads. The
 * engine never reads image files (images.md); this resolves a vault reference
 * against the vault root for display only, as the WebView does with its
 * `file://<vault root>/` base. Remote images are not fetched yet.
 */
internal class ImageLoader(private val vaultRoot: File) {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "futo-editor-images").apply { priority = Thread.MIN_PRIORITY } }
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 8).toInt()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    fun load(destination: String, vault: Boolean, maxWidth: Int, done: (Bitmap?) -> Unit) {
        if (!vault) { done(null); return }
        val key = "$destination@$maxWidth"
        cache.get(key)?.let { done(it); return }
        executor.execute {
            val bitmap = runCatching { decode(resolve(destination), maxWidth) }.getOrNull()
            if (bitmap != null) cache.put(key, bitmap)
            main.post { done(bitmap) }
        }
    }

    private fun resolve(destination: String): File {
        val decoded = Uri.decode(destination.removePrefix("<").removeSuffix(">"))
        val file = File(vaultRoot, decoded).canonicalFile
        require(file.path.startsWith(vaultRoot.canonicalPath + File.separator)) { "image outside the vault" }
        return file
    }

    private fun decode(file: File, maxWidth: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        // Camera photos store their rotation in EXIF; measure the turned size.
        val degrees = when (android.media.ExifInterface(file.path).getAttributeInt(
            android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL,
        )) {
            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90
            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180
            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
        }
        val displayWidth = if (degrees % 180 == 0) bounds.outWidth else bounds.outHeight
        var sample = 1
        while (displayWidth / (sample * 2) >= maxWidth) sample *= 2
        val decoded = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        if (degrees == 0) return decoded
        val turn = android.graphics.Matrix().apply { postRotate(degrees.toFloat()) }
        return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, turn, true).also {
            if (it !== decoded) decoded.recycle()
        }
    }

    fun shutdown() = executor.shutdown()
}
