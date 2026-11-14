package com.futo.notes.textfirst

import android.net.Uri
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import com.futo.notes.ImagePicker
import com.futo.notes.NotesStore
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.saveImageIntoVault
import com.futo.notes.ui.showToast
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

internal class TextFirstImageActions(val pending: Int, val recovering: Boolean, val pick: (String) -> Unit)

/** Own the OS round trip separately from the editor screen's navigation. */
@Composable
internal fun rememberTextFirstImages(
    controller: TextFirstController,
    store: NotesStore,
    noteId: String,
    leaving: Boolean,
    imagePicker: ImagePicker?,
): TextFirstImageActions {
    val context = LocalContext.current
    val localization = LocalLocalization.current
    val scope = rememberCoroutineScope()
    var pendingImages by remember(controller) { mutableStateOf(0) }
    var cameraClaim by remember(controller) { mutableStateOf<Pair<String, ULong>?>(null) }
    val cameraCapture = imagePicker?.pendingCamera
    val recoveringCamera = cameraCapture?.let {
        it.recovered && it.noteId == noteId && it.vaultRoot == store.rootPath
    } == true

    suspend fun insertPickedImage(uri: Uri, claim: ULong) {
        if (insertImageUri(controller, store, context.contentResolver, uri, claim)) {
            showToast(context, localization.localizedText("editor.images.unsupportedType"))
        }
    }

    DisposableEffect(controller) {
        controller.acceptImageContent(store, context.contentResolver, scope,
            { pendingImages += it },
            { showToast(context, localization.localizedText("editor.images.unsupportedType")) })
        onDispose { controller.view.clipboard.onImageContent = null }
    }

    LaunchedEffect(cameraCapture?.id, cameraCapture?.complete, controller) {
        val capture = cameraCapture ?: return@LaunchedEffect
        if (!capture.complete) return@LaunchedEffect
        // A live result must still hold the launching session's claim. Only
        // saved OS routing may acquire a new claim, after its original note opens.
        val matches = capture.vaultRoot == store.rootPath &&
            (if (capture.recovered) capture.noteId == noteId else cameraClaim?.first == capture.id)
        if (!matches || (!capture.recovered && cameraClaim?.first != capture.id)) return@LaunchedEffect
        pendingImages += 1
        try {
            if (!capture.success || capture.uri == null || leaving) return@LaunchedEffect
            snapshotFlow { controller.opened || controller.openFailure != null }.first { it }
            if (!controller.opened) return@LaunchedEffect
            // A recreated screen reopened the note with its caret at the top: put it back first.
            val claim = if (capture.recovered) {
                controller.select(capture.caretStart, capture.caretEnd)
                controller.imageClaim()
            } else cameraClaim?.second
            if (claim != null) insertPickedImage(capture.uri, claim)
        } finally {
            pendingImages -= 1
            cameraClaim = null
            imagePicker?.finishCamera(capture.id)
        }
    }

    // Navigation retires a live capture; recreation keeps its SavedState route.
    DisposableEffect(controller) {
        onDispose {
            val activity = context as? android.app.Activity
            if (activity?.isChangingConfigurations != true) {
                val pending = imagePicker?.pendingCamera
                if (pending != null && (cameraClaim?.first == pending.id ||
                    (pending.recovered && pending.noteId == noteId && pending.vaultRoot == store.rootPath))) {
                    imagePicker.finishCamera(pending.id)
                }
            }
        }
    }

    fun pickImage(source: String) {
        scope.launch {
            if (leaving || recoveringCamera) return@launch
            // Camera return can recreate the process. Save before leaving; the
            // persisted capture contains routing only, never an unsaved draft.
            if (source == "camera" && controller.checkpoint() == null && controller.dirty) return@launch
            val claim = controller.imageClaim() ?: return@launch
            if (source == "camera") {
                val view = controller.view
                val id = imagePicker?.captureCameraForNote(noteId, store.rootPath, view.selectionStart.coerceAtLeast(0), view.selectionEnd.coerceAtLeast(0))
                    ?: return@launch
                cameraClaim = id to claim
            } else {
                imagePicker?.pickLibrary { uris ->
                    val uri = uris.firstOrNull() ?: return@pickLibrary
                    pendingImages += 1
                    scope.launch {
                        try { insertPickedImage(uri, claim) }
                        finally { pendingImages -= 1 }
                    }
                }
            }
        }
    }

    return TextFirstImageActions(pendingImages, recoveringCamera, ::pickImage)
}

/** Save one image through the gated vault attachment and insert it at [claim]; true when the type was unsupported. */
internal suspend fun insertImageUri(
    controller: TextFirstController,
    store: NotesStore,
    resolver: android.content.ContentResolver,
    uri: Uri,
    claim: ULong,
): Boolean {
    var refused = false
    val name = store.saveImageIntoVault(
        save = { root -> saveImageIntoVault(resolver, root, uri) },
        useSavedImage = { filename ->
            if (!controller.insertImage(claim, filename)) {
                refused = true
                error("the editor refused the image")
            }
        },
    )
    return name == null && !refused
}

/** The one image a clip carries, or null. A clip holding an image is never also a text paste. */
internal fun clipImageUri(clip: android.content.ClipData?, resolver: android.content.ContentResolver): Uri? {
    clip ?: return null
    for (i in 0 until clip.itemCount) {
        val uri = clip.getItemAt(i).uri ?: continue
        val type = if (clip.itemCount == 1 && clip.description.hasMimeType("image/*")) "image/" else resolver.getType(uri).orEmpty()
        if (type.startsWith("image/")) return uri
    }
    return null
}

/**
 * Route pasted and keyboard-provided images into the note this controller edits.
 * The claim is taken when the content arrives, so it belongs to the session that
 * received it; a closed or replaced session refuses it and nothing is saved.
 */
internal fun TextFirstController.acceptImageContent(
    store: NotesStore,
    resolver: android.content.ContentResolver,
    scope: kotlinx.coroutines.CoroutineScope,
    busy: (Int) -> Unit,
    unsupported: () -> Unit,
) {
    val controller = this
    view.clipboard.onImageContent = { uri, release ->
        busy(1)
        scope.launch {
            try {
                val claim = controller.imageClaim()
                if (claim != null && insertImageUri(controller, store, resolver, uri, claim)) unsupported()
            } finally {
                release()
                busy(-1)
            }
        }
        true
    }
}
