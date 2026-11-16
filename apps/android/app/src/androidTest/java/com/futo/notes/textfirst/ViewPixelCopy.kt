package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** The view as the window composes it (a hardware draw, so the caret is in it), by PixelCopy. */
internal suspend fun copyViewPixels(view: android.view.View): Bitmap = suspendCancellableCoroutine { done ->
    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    val at = IntArray(2).also(view::getLocationInWindow)
    val window = (view.context as android.app.Activity).window
    PixelCopy.request(window, Rect(at[0], at[1], at[0] + view.width, at[1] + view.height), bitmap, { status ->
        if (status == PixelCopy.SUCCESS) done.resume(bitmap) else {
            bitmap.recycle()
            done.resumeWith(Result.failure(AssertionError("PixelCopy failed: $status")))
        }
    }, Handler(Looper.getMainLooper()))
}
