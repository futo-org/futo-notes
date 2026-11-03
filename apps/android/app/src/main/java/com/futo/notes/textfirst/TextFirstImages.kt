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
        var refused = false
        val name = store.saveImageIntoVault(
            save = { root -> saveImageIntoVault(context.contentResolver, root, uri) },
            useSavedImage = { filename ->
                if (!controller.insertImage(claim, filename)) {
                    refused = true
                    error("the editor refused the image")
                }
            },
        )
        if (name == null && !refused) showToast(context, localization.localizedText("editor.images.unsupportedType"))
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
            val claim = if (capture.recovered) controller.imageClaim() else cameraClaim?.second
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
                val id = imagePicker?.captureCameraForNote(noteId, store.rootPath) ?: return@launch
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
