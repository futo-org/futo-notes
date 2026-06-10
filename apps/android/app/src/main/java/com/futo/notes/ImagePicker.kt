package com.futo.notes

import android.content.ContentResolver
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Image extensions the sync layer treats as images. HARDCODED MIRROR of
 * `IMAGE_EXTENSIONS` in `packages/shared/src/sync.ts` — keep in lockstep.
 */
val IMAGE_EXTENSIONS = setOf("jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "heic")

/**
 * Native image pickers behind the editor's `pickImage` bridge message
 * [editor.md:121, editor.md:130]. The Photo Picker needs no permission on any
 * API level; TakePicture writes into a FileProvider cache file and needs NO
 * camera permission either (it delegates to the system camera app — that's
 * why the manifest stays CAMERA-less).
 *
 * Must be constructed during Activity onCreate: ActivityResult contracts have
 * to register before the activity is started.
 */
class ImagePicker(private val activity: ComponentActivity) {
    private var onPicked: ((Uri?) -> Unit)? = null
    private var cameraUri: Uri? = null

    private val pickMedia =
        activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            onPicked?.invoke(uri)
            onPicked = null
        }

    private val takePicture =
        activity.registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
            onPicked?.invoke(if (ok) cameraUri else null)
            onPicked = null
        }

    fun pickLibrary(callback: (Uri?) -> Unit) {
        onPicked = callback
        pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    fun captureCamera(callback: (Uri?) -> Unit) {
        onPicked = callback
        val dir = File(activity.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "capture-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        cameraUri = uri
        takePicture.launch(uri)
    }
}

/**
 * Copy a picked image into the vault root under a generated unique name
 * (preserving the extension). Returns the saved filename, or null when the
 * source isn't one of [IMAGE_EXTENSIONS] or the copy fails. Blocking I/O —
 * call from Dispatchers.IO.
 */
fun saveImageIntoVault(resolver: ContentResolver, vaultRoot: File, uri: Uri): String? {
    val ext = imageExtension(resolver, uri) ?: return null
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
    var name = "image-$stamp.$ext"
    var n = 2
    while (File(vaultRoot, name).exists()) {
        name = "image-$stamp-$n.$ext"
        n++
    }
    return try {
        resolver.openInputStream(uri)?.use { input ->
            File(vaultRoot, name).outputStream().use { input.copyTo(it) }
        } ?: return null
        name
    } catch (e: Exception) {
        android.util.Log.e("ImagePicker", "image import failed", e)
        null
    }
}

private fun imageExtension(resolver: ContentResolver, uri: Uri): String? {
    val fromMime = resolver.getType(uri)
        ?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
    val ext = (fromMime ?: uri.lastPathSegment?.substringAfterLast('.', ""))?.lowercase()
    return ext?.takeIf { it in IMAGE_EXTENSIONS }
}
