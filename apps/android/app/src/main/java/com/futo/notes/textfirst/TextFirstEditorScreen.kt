package com.futo.notes.textfirst

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.core.content.res.ResourcesCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.futo.notes.ImagePicker
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NoteShare
import com.futo.notes.NotesStore
import com.futo.notes.puppet.PuppetOpenNote
import com.futo.notes.R
import com.futo.notes.awaitEditorLeaves
import com.futo.notes.claimDraftOwnership
import com.futo.notes.delete
import com.futo.notes.launchEditorLeave
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.moveNote
import com.futo.notes.releaseDraftOwnership
import com.futo.notes.rename
import com.futo.notes.ui.EditorToolbar
import com.futo.notes.ui.TitleFieldState
import com.futo.notes.ui.ToolbarItemAction
import com.futo.notes.ui.affectsOpenNote
import com.futo.notes.ui.collidesWithOtherNote
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.FolderPickerSheet
import com.futo.notes.ui.commitEditorTitleSnapshot
import com.futo.notes.ui.editorTitleTarget
import com.futo.notes.ui.titleWarningFor
import com.futo.notes.ui.isPlaceholderTitle
import com.futo.notes.ui.showToast
import com.futo.notes.ui.theme.FutoPalette
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.titleValidationMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.splitId

/**
 * The shipping native Linedown note screen.
 *
 * Saving is the engine's: edits live in the Store's session and the Markdown
 * file is written on the Store's debounce (500 ms idle, 2 s max wait), on
 * pause, and when leaving detaches. So the screen never holds the
 * note body; rename, move and delete go through the Store's ordinary
 * workflows, which retarget or end the live attachment themselves.
 *
 * Feature controls live beside their owning native adapters.
 */
@OptIn(ExperimentalLayoutApi::class, FlowPreview::class)
@Composable
internal fun TextFirstEditorScreen(
    store: NotesStore,
    initialNoteId: String,
    autoFocus: Boolean,
    darkTheme: Boolean,
    onBack: () -> Unit,
    onOpenNote: (String) -> Unit,
    imagePicker: ImagePicker? = null,
    registerLeave: (((() -> Unit) -> Unit) -> (() -> Unit)),
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    var noteId by remember(initialNoteId) { mutableStateOf(initialNoteId) }
    val titleField = remember(initialNoteId) { TitleFieldState(splitId(initialNoteId).title) }
    var leaving by remember(initialNoteId) { mutableStateOf(false) }
    var saveFailed by remember(initialNoteId) { mutableStateOf(false) }
    var confirmDiscard by remember(initialNoteId) { mutableStateOf(false) }
    var pendingNavigation by remember(initialNoteId) { mutableStateOf<(() -> Unit)?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showMoveSheet by remember { mutableStateOf(false) }
    val ownerToken = remember(initialNoteId) { store.claimDraftOwnership() }
    // Title renames, moves, deletes and reloads run one at a time.
    val work = remember(initialNoteId) { Mutex() }

    val controller = remember(initialNoteId) {
        val density = context.resources.displayMetrics.density
        val scaled = context.resources.displayMetrics.scaledDensity
        val regular = ResourcesCompat.getFont(context, R.font.barlow_regular)!!
        val style = TextFirstStyle(
            density = density,
            textSizePx = 17f * scaled,
            regular = regular,
            semibold = ResourcesCompat.getFont(context, R.font.barlow_semibold)!!,
            bold = ResourcesCompat.getFont(context, R.font.barlow_bold)!!,
            italic = ResourcesCompat.getFont(context, R.font.barlow_italic)!!,
            boldItalic = ResourcesCompat.getFont(context, R.font.barlow_bold_italic)!!,
            semiboldItalic = ResourcesCompat.getFont(context, R.font.barlow_semibold_italic)!!,
            mono = ResourcesCompat.getFont(context, R.font.jetbrains_mono_regular)!!,
            textColor = c.textPrimary.toArgb(),
            mutedColor = c.textMuted.toArgb(),
            linkColor = c.accent.toArgb(),
            borderColor = c.border.toArgb(),
            codeBackground = (if (darkTheme) FutoPalette.InkHairline else FutoPalette.N200).toArgb(),
            surfaceColor = c.surfaceSunken.toArgb(),
        )
        TextFirstController(context, { store.core }, java.io.File(store.rootPath), style, store)
    }
    LaunchedEffect(controller, c, darkTheme) {
        controller.updateColors(
            text = c.textPrimary.toArgb(),
            muted = c.textMuted.toArgb(),
            link = c.accent.toArgb(),
            border = c.border.toArgb(),
            code = (if (darkTheme) FutoPalette.InkHairline else FutoPalette.N200).toArgb(),
            surface = c.surfaceSunken.toArgb(),
        )
    }

    val find = rememberTextFirstFind(controller, initialNoteId)
    val images = rememberTextFirstImages(controller, store, noteId, leaving, imagePicker)

    val titleWarning = remember(initialNoteId) { TitleWarning(scope) }
    fun showTitleValidation(title: String) {
        titleWarning.validate(titleWarningFor(noteId, title, store.notes.map { it.id }))
    }

    fun adoptIdentity(finalId: String) {
        if (finalId == noteId) return
        noteId = finalId
        if (!titleField.isFocused) titleField.commit(splitId(finalId).title)
    }
    controller.onAttachmentChanged = ::adoptIdentity
    controller.onCheckpointed = { result, finalId ->
        saveFailed = false
        // A save that succeeds on its own supersedes a Back whose save failed earlier;
        // Retry must then only save, not replay that navigation. An in-flight leave keeps its own.
        if (!leaving) pendingNavigation = null
        result.mutation?.let {
            store.applyMutation(it)
            store.signalLocalChange()
        }
        val disposition = result.disposition
        if (disposition is FlushDisposition.ParkedConflict) {
            showToast(context, localization.localizedText("notes.save.conflictCopy"))
        }
        adoptIdentity(finalId)
    }
    controller.onFailure = { saveFailed = true }
    controller.onClipboardRefused = { showToast(context, localization.localizedText("editor.android.clipboardTooLarge"), long = true) }

    // Open after any leave of this same note has released its attachment.
    LaunchedEffect(initialNoteId) {
        store.awaitEditorLeaves()
        // A note made just now has nothing to return to; any other opens where it was left.
        controller.open(initialNoteId, restore = if (autoFocus) null else NoteScrollMemory.get(initialNoteId)) { error ->
            // A note that cannot be opened never shows as a blank page; leave,
            // as the WebView editor does when its read fails.
            if (error != null) {
                onBack()
            } else if (autoFocus) {
                controller.view.post { controller.view.showKeyboard() }
            }
        }
    }

    // Save on pause, ahead of the debounce: the process may not come back.
    DisposableEffect(lifecycle, controller) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) scope.launch { controller.checkpoint() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    /**
     * Rename to the typed title. A refused title (blank, illegal, or another note's name)
     * keeps the current name and is not a failure; false only when the store's rename failed.
     */
    suspend fun renameTo(next: String): Boolean {
        val wanted = editorTitleTarget(noteId, next, store.notes.mapTo(mutableSetOf()) { it.id })
        val commit = commitEditorTitleSnapshot(noteId, wanted) { from, to ->
            store.rename(from, to, draft = null, ownerToken = ownerToken)
        }
        if (!commit.isCommitted) {
            showToast(context, localization.localizedText("notes.title.renameFailed"))
            return false
        }
        if (wanted != null && wanted != noteId) {
            noteId = commit.id
            if (titleField.text == next) titleField.commit(splitId(noteId).title)
            controller.drainCoordinatedChanges()
        }
        return true
    }

    LaunchedEffect(initialNoteId) {
        snapshotFlow { titleField.text }.debounce(500).collect { next ->
            if (!leaving) work.withLock { renameTo(next) }
        }
    }

    LaunchedEffect(titleField) {
        titleField.watchEdits { title -> showTitleValidation(title) }
    }

    LaunchedEffect(titleField.isFocused) {
        if (titleField.isFocused && isPlaceholderTitle(titleField.text)) titleField.selectAll()
    }

    // Local mutations and remote summaries both commit this projection. Do not
    // rescan the vault for body updates or on each completion request.
    LaunchedEffect(controller.opened, store.notes.map { it.id }.toSet()) {
        if (controller.opened) controller.refreshCompletionNoteIds()
    }

    // The Store has already applied explicit remote identity changes. Reconcile
    // through that same attachment so shared Rust retains selection and local history.
    LaunchedEffect(initialNoteId) {
        store.localTreeChanges.collect { summary ->
            if (!summary.affectsOpenNote(noteId) || leaving) return@collect
            work.withLock {
                val renamed = summary.renamed.any { it.fromId == noteId }
                if (!renamed && noteId in summary.deletedIds && !controller.dirty) {
                    leaving = true
                    controller.close()
                    showToast(context, localization.localizedText("notes.deletedElsewhere"))
                    onBack()
                } else {
                    controller.reconcileExternalChanges()
                }
            }
        }
    }

    fun leave(navigate: () -> Unit): kotlinx.coroutines.Job? {
        if (leaving) return null
        pendingNavigation = navigate
        leaving = true
        return scope.launch {
            // The title field can accept input before the session finishes opening.
            snapshotFlow { controller.opened || controller.openFailure != null }.first { it }
            if (controller.openFailure != null) return@launch
            work.withLock {
                val untouched = autoFocus && noteId == initialNoteId && controller.isEmpty && !controller.dirty &&
                    titleField.text == splitId(initialNoteId).title && images.pending == 0 &&
                    imagePicker?.pendingCamera?.noteId != noteId
                if (!renameTo(titleField.text) || controller.close() == null) {
                    leaving = false
                    saveFailed = true
                    return@withLock
                }
                if (untouched) store.delete(noteId, ownerToken = ownerToken)
                pendingNavigation = null
                navigate()
            }
        }
    }

    DisposableEffect(controller) {
        val unregister = registerLeave { navigate ->
            if (controller.canNavigateWithoutSaving) navigate() else leave(navigate)
        }
        onDispose { unregister() }
    }

    // Lifecycle disposal is a fallback; ordinary navigation has already saved
    // before it can remove the screen. A failed fallback retains the session.
    DisposableEffect(initialNoteId) {
        onDispose {
            // Before the detach below: the view still holds the note as the reader left it.
            NoteScrollMemory.put(noteId, controller.view.scrollAnchor())
            store.launchEditorLeave {
                val saved = controller.close()
                if (saved != null || !controller.opened) {
                    controller.dispose()
                    store.releaseDraftOwnership(ownerToken)
                }
            }
        }
    }

    BackHandler {
        when {
            find.visible -> find.close()
            controller.cellView != null -> controller.finishCellEditing()
            else -> onBack()
        }
    }
    TextFirstFindVerbs(find, enabled = !leaving)

    suspend fun retrySave() {
        val navigate = pendingNavigation
        if (navigate != null) leave(navigate)?.join()
        else controller.checkpoint()
    }

    fun deleteNote() {
        leaving = true
        scope.launch {
            work.withLock {
                when (store.delete(noteId, ownerToken = ownerToken)) {
                    is NoteMutationOutcome.Committed -> {
                        controller.close()
                        showToast(context, localization.localizedText("notes.deleted"))
                        onBack()
                    }
                    NoteMutationOutcome.Failed -> {
                        leaving = false
                        showToast(context, localization.localizedText("notes.errors.deleteFailed"))
                    }
                }
            }
        }
    }

    fun moveNote(folder: String): Deferred<Boolean> {
        val moved = CompletableDeferred<Boolean>()
        scope.launch {
            work.withLock {
                val outcome = store.moveNote(noteId, folder, draft = null, ownerToken = ownerToken)
                if (outcome is NoteMutationOutcome.Committed) {
                    noteId = outcome.value.id
                    titleField.commit(splitId(noteId).title)
                    controller.drainCoordinatedChanges()
                    showMoveSheet = false
                    showToast(
                        context,
                        if (folder.isEmpty()) localization.localizedText("notes.movedToRoot")
                        else localization.localizedText("notes.movedTo", mapOf("destination" to folder)),
                    )
                    moved.complete(true)
                } else {
                    showToast(context, localization.localizedText("notes.errors.moveFailed"))
                    moved.complete(false)
                }
            }
        }
        return moved
    }

    PuppetOpenNote(noteId, controller.opened)
    Scaffold(
        containerColor = c.surface,
        topBar = {
            TextFirstTopBar(
                onBack = onBack,
                onShare = {
                    scope.launch {
                        val body = controller.sourceText() ?: return@launch
                        if (!NoteShare.share(context, titleField.text, body, localization.localizedText("notes.shareChooserTitle"))) {
                            showToast(context, localization.localizedText("notes.shareFailed"))
                        }
                    }
                },
                onFind = find::open,
                onMove = { showMoveSheet = true },
                onCopyPath = {
                    clipboard.setText(AnnotatedString("${store.rootPath}/$noteId.md"))
                    showToast(context, localization.localizedText("notes.pathCopied"))
                },
                onDelete = { confirmDelete = true },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize().imePadding(),
        ) {
            TextFirstTitle(
                titleField, titleWarning.message, enabled = !leaving && !images.recovering,
                verbsEnabled = !leaving && !images.recovering && controller.opened,
                onCommit = { work.withLock { renameTo(titleField.text) } },
                onReturn = { controller.view.showKeyboard() },
            ) { title, forbidden ->
                if (forbidden) titleWarning.forbiddenCharacter() else showTitleValidation(title)
            }
            if (saveFailed) {
                TextFirstSaveError(
                    onRetry = ::retrySave,
                    onDiscard = { confirmDiscard = true },
                )
            }
            Spacer(Modifier.size(4.dp))
            Box(modifier = Modifier.weight(1f).fillMaxWidth().clipToBounds()) {
                TextFirstNoteView(controller, enabled = !images.recovering && !leaving,
                    onOpenWikilink = { target -> if (target != noteId) onOpenNote(target) },
                    onOpenUrl = { url -> com.futo.notes.ui.openExternalUrl(context, url) })
                TextFirstOpening(controller)
            }
            if (!leaving && !images.recovering) TextFirstCompletions(controller)
            TextFirstFindBar(find)
            TextFirstToolbarSlot(controller, onPickImage = images.pick)
        }
    }

    if (confirmDiscard) {
        ConfirmDialog(
            title = localization.localizedText("notes.save.discardQuestion"),
            body = localization.localizedText("notes.save.discardWarning"),
            confirmLabelKey = "notes.save.discard",
            onConfirm = {
                work.withLock {
                    leaving = true
                    controller.discard()
                    confirmDiscard = false
                    val navigate = pendingNavigation
                    pendingNavigation = null
                    if (navigate != null) navigate() else onBack()
                }
            },
            onDismiss = { confirmDiscard = false },
        )
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = localization.localizedText("notes.delete.thisNoteQuestion"),
            body = localization.localizedText("notes.delete.recoverableWarning"),
            confirmLabelKey = "common.actions.delete",
            onConfirm = { confirmDelete = false; deleteNote() },
            onDismiss = { confirmDelete = false },
        )
    }

    if (showMoveSheet) {
        FolderPickerSheet(store = store, onDismiss = { showMoveSheet = false }, onPick = ::moveNote)
    }
}
