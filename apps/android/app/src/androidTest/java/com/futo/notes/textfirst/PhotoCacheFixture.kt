package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.util.LruCache
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

internal fun cameraJpeg(width: Int, height: Int): ByteArray {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    try {
        bitmap.eraseColor(Color.CYAN)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }.toByteArray()
    } finally {
        bitmap.recycle()
    }
}

internal class PhotoCacheFixture(loader: ImageLoader) {
    @Suppress("UNCHECKED_CAST")
    val bitmaps = loaderField(loader, "cache") as LruCache<String, Bitmap>
    private val executor = loaderField(loader, "executor") as ExecutorService
    /** The sizes the loader remembers per photo for the session; a reopened note's loader starts with none. */
    val photoSizes = loaderField(loader, "photoSizes") as java.util.concurrent.ConcurrentHashMap<*, *>
    private val decodeGate = CountDownLatch(1)

    fun pauseDecodes(): Unit = executor.execute { check(decodeGate.await(10, TimeUnit.SECONDS)) }
    fun resumeDecodes(): Unit = decodeGate.countDown()

    private fun loaderField(loader: ImageLoader, name: String): Any =
        ImageLoader::class.java.getDeclaredField(name).apply { isAccessible = true }.get(loader)
}
