package com.futo.notes.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.Editable
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.Toast
import java.io.File
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.futo.notes.ImagePicker
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.PendingDraft
import com.futo.notes.confirmedSavedContent
import com.futo.notes.derivePendingDraft
import com.futo.notes.saveImageDataIntoVault
import com.futo.notes.saveImageIntoVault
import com.futo.notes.shouldCompleteNoteAction
import com.futo.notes.shouldContinueDeleteAfterEditorWrite
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.FolderPickerSheet
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoType
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.KeepDraftReason
import uniffi.futo_notes_ffi.OpenNoteDisposition
import uniffi.futo_notes_ffi.OpenNoteFacts
import uniffi.futo_notes_ffi.SyncSummary
import uniffi.futo_notes_ffi.classifyOpenNote
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import uniffi.futo_notes_ffi.validateTitle

/** A note title that is still the auto-assigned placeholder: exactly "Untitled",
 *  or a dedup variant "Untitled-N" (the Rust store's `unique_note_id` appends `-2`,
 *  `-3`, …). Tapping such a title selects it whole so a keystroke replaces it;
 *  any other title takes the caret at the tapped character. */
private val UNTITLED_PLACEHOLDER = Regex("""^Untitled(-\d+)?$""")

internal fun isPlaceholderTitle(title: String): Boolean = UNTITLED_PLACEHOLDER.matches(title)

private fun titleValidationMessage(kind: String): LocalizedMessage? = when (kind) {
    "empty" -> LocalizedMessage("notes.title.empty")
    "forbidden_chars" -> LocalizedMessage("notes.title.forbiddenCharacter")
    "leading_dots" -> LocalizedMessage("notes.title.leadingDot")
    "trailing_dots" -> LocalizedMessage("notes.title.trailingDot")
    "too_long" -> LocalizedMessage(
        "notes.title.tooLong",
        mapOf("maxLength" to TitleSpec.maxLength),
    )
    else -> null
}

private fun SyncSummary.affectsOpenNote(id: String): Boolean =
    id in updatedIds ||
        id in deletedIds ||
        renamed.any { it.fromId == id || it.toId == id }

internal fun editedDuringOpenNoteGather(
    reconciliationStartVersion: Long,
    currentEditVersion: Long,
): Boolean = currentEditVersion != reconciliationStartVersion

internal enum class FindBackAction { DismissFind, ExitNote }

internal fun findBackAction(findVisible: Boolean): FindBackAction =
    if (findVisible) FindBackAction.DismissFind else FindBackAction.ExitNote

internal fun isFindStateCurrent(savedProcessToken: String, currentProcessToken: String): Boolean =
    savedProcessToken == currentProcessToken

internal fun canStepFind(total: Int): Boolean = total > 0

private fun logOpenNoteDisposition(
    disposition: OpenNoteDisposition?,
    focused: Boolean,
) {
    if (disposition != null) {
        android.util.Log.d(
            "FutoOpenNote",
            "disposition=${disposition.javaClass.simpleName} focused=$focused",
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class, FlowPreview::class)
@Composable
fun NoteEditorScreen(
    store: NotesStore,
    initialNoteId: String,
    autoFocus: Boolean,
    darkTheme: Boolean,
    onBack: () -> Unit,
    onOpenNote: (String) -> Unit = {},
    imagePicker: ImagePicker? = null,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    // The shared pre-warmed editor host — needed directly (beyond the
    // EditorWebView props) for the bridge-v2 imperative calls:
    // applyExternalContent (sync adopt) and insertImage (picker round-trip).
    val host = remember { EditorHost.get(context) }
    var savedFindProcessToken by rememberSaveable(initialNoteId) {
        mutableStateOf(host.processToken)
    }
    var savedFindVisible by rememberSaveable(initialNoteId) { mutableStateOf(false) }
    var findQuery by rememberSaveable(initialNoteId) { mutableStateOf("") }
    var findLabel by rememberSaveable(initialNoteId) { mutableStateOf("0") }
    var findTotal by rememberSaveable(initialNoteId) { mutableStateOf(0) }
    val findStateCurrent = isFindStateCurrent(savedFindProcessToken, host.processToken)
    val findVisible = savedFindVisible && findStateCurrent

    LaunchedEffect(host.processToken) {
        if (!findStateCurrent) {
            savedFindProcessToken = host.processToken
            savedFindVisible = false
            findQuery = ""
            findLabel = "0"
            findTotal = 0
        }
    }
    // Gate the editor pane on the boot outcome, not a WebView version
    // (EditorEngineSupport.kt). Read as state, not remember{}, so a late verdict
    // swaps the notice in — though the app-start prewarm normally settles it
    // before the first note-open.
    val hasWebViewProvider = remember { currentWebViewProvider() != null }
    val editorPaneUnavailable = isEditorPaneUnavailable(hasWebViewProvider, host.engineFailure)

    var noteId by remember(initialNoteId) { mutableStateOf(initialNoteId) }
    // TextFieldValue (not String) so we can control the selection: tapping a
    // still-placeholder title selects it whole (see the select-all effect below).
    var titleValue by remember(initialNoteId) {
        mutableStateOf(TextFieldValue(splitId(initialNoteId).title))
    }
    var titleFocused by remember(initialNoteId) { mutableStateOf(false) }
    // Inline title-validation warning (desktop parity): forbidden char → transient
    // 2 s; dot/too-long/duplicate → persistent + blocks the rename. Shown in
    // danger red under the title field.
    var titleWarning by remember(initialNoteId) { mutableStateOf<LocalizedMessage?>(null) }
    var warningJob by remember { mutableStateOf<Job?>(null) }
    // CRITICAL: never block the editor's first frame on a disk read. Start empty
    // and load the note body off the main thread; the WebView mounts immediately
    // and receives the content reactively once the read lands.
    var content by remember(initialNoteId) { mutableStateOf("") }
    var savedContent by remember(initialNoteId) { mutableStateOf("") }
    var loaded by remember(initialNoteId) { mutableStateOf(false) }
    var saveJob by remember { mutableStateOf<Job?>(null) }
    var editVersion by remember(initialNoteId) { mutableStateOf(0L) }
    var editorAttachment by remember(initialNoteId) {
        mutableStateOf<EditorAttachmentToken?>(null)
    }
    var confirmDelete by remember { mutableStateOf(false) }
    var showMoveSheet by remember { mutableStateOf(false) }
    var interactionLocked by remember(initialNoteId) { mutableStateOf(false) }
    // The one owner of "a note is open; here is every way it ends" — the task
    // ordering, the latches, and the drain-and-commit each exit runs. See
    // EditorSession.kt for the drain table.
    val session = remember(initialNoteId) {
        EditorSession(scope) { locked -> interactionLocked = locked }
    }
    val theme = if (darkTheme) "dark" else "light"

    fun scheduleBodySave(snapshot: String) {
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(400)
            session.runAutosave {
                val targetId = noteId
                val base = savedContent
                when (
                    val disposition = store.flushDraft(
                        PendingDraft(targetId, base, snapshot),
                    )
                ) {
                    FlushDisposition.Wrote,
                    FlushDisposition.Converged,
                    FlushDisposition.Recreated,
                    -> savedContent = snapshot

                    is FlushDisposition.ParkedConflict -> {
                        noteId = disposition.parkedId
                        titleValue = TextFieldValue(splitId(disposition.parkedId).title)
                        savedContent = snapshot
                        Toast.makeText(
                            context,
                            localization.localizedText("notes.save.conflictCopy"),
                            Toast.LENGTH_SHORT,
                        ).show()
                    }

                    null -> Toast.makeText(
                        context,
                        localization.localizedText("notes.save.failedPending"),
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    fun dismissFind() {
        // Take the soft keyboard down with the bar. The query field is a native
        // EditText, and Android does NOT hide the IME when the view serving it
        // is removed: closing the bar while it owned the keyboard left
        // `mInputShown=true` on a served view that accepts no input (the bare
        // AndroidComposeView), so the next Back was swallowed by the IME instead
        // of reaching this screen's BackHandler and leaving the note took a
        // second press. Clearing focus is the mechanism `prepare()` below
        // already relies on, and the only one measured to drop that keyboard: a
        // bridge `host.blur()` cannot, because find owns the field and the
        // WebView is unfocused (document.activeElement is BODY). When the editor
        // body owns the keyboard the user is typing in the note, so it stays up
        // and Back behaves as it does without find [editor.md].
        if (!host.editorFocused) focusManager.clearFocus(force = true)
        savedFindVisible = false
        host.closeFind()
    }

    fun openNoteEffects(
        summary: SyncSummary?,
        reconciliationStartEditVersion: Long,
    ): OpenNoteEffects =
        object : OpenNoteEffects {
            override fun currentNoteId(): String = noteId

            override fun isCurrentEditor(): Boolean =
                editorAttachment?.let(host::isCurrentAttachment) == true

            override suspend fun gatherFacts(noteId: String): OpenNoteFacts {
                // The reconciliation owns the debounce now. If it was already
                // writing, the session lock made us wait; otherwise cancel it
                // before reading so stale-base bytes cannot follow this pass.
                saveJob?.cancel()
                val base = savedContent
                val draft = content
                val disk = store.readIfExists(noteId)
                return OpenNoteFacts(
                    base = base,
                    draft = draft,
                    disk = disk,
                    renamedTo = summary
                        ?.renamed
                        ?.firstOrNull { it.fromId == noteId }
                        ?.toId,
                    editorFocused = host.editorFocused,
                    editedDuringCycle = editedDuringOpenNoteGather(
                        reconciliationStartVersion = reconciliationStartEditVersion,
                        currentEditVersion = editVersion,
                    ),
                )
            }

            override fun classify(facts: OpenNoteFacts): OpenNoteDisposition =
                classifyOpenNote(facts)

            override fun resumeDraftPersistence() {
                if (content != savedContent) scheduleBodySave(content)
            }

            override fun apply(
                noteIdAtRead: String,
                disposition: OpenNoteDisposition,
            ) {
                when (disposition) {
                    OpenNoteDisposition.Leave,
                    OpenNoteDisposition.DeferAdopt -> Unit

                    is OpenNoteDisposition.Adopt -> {
                        host.applyExternalContent(disposition.content)
                        content = disposition.content
                        savedContent = disposition.content
                    }

                    is OpenNoteDisposition.FollowRename -> {
                        noteId = disposition.toId
                        titleValue = TextFieldValue(splitId(disposition.toId).title)
                    }

                    is OpenNoteDisposition.KeepDraft -> {
                        savedContent = disposition.base
                        when (disposition.reason) {
                            KeepDraftReason.PEER_DELETED -> Toast.makeText(
                                context,
                                localization.localizedText("notes.save.peerDeletedDraftOpen"),
                                Toast.LENGTH_SHORT,
                            ).show()

                            KeepDraftReason.DIVERGED -> Toast.makeText(
                                context,
                                localization.localizedText("notes.save.peerChangedDraftOpen"),
                                Toast.LENGTH_SHORT,
                            ).show()

                            KeepDraftReason.CONVERGED -> Unit
                        }
                        if (content != savedContent) scheduleBodySave(content)
                    }

                    OpenNoteDisposition.Close -> {
                        saveJob?.cancel()
                        // The session is already latched closed. Mark the
                        // buffer clean before navigation so onDispose cannot
                        // recreate a peer-deleted note.
                        savedContent = content
                        dismissFind()
                        Toast.makeText(
                            context,
                            localization.localizedText("notes.deletedElsewhere"),
                            Toast.LENGTH_SHORT,
                        ).show()
                        onBack()
                    }
                }
            }
        }

    fun navigateAfterSaving(navigate: () -> Unit) {
        val attachment = host.currentAttachment()
        session.end(
            EditorExit.NAVIGATE,
            object : EditorExitEffects {
                override fun isAttached(): Boolean =
                    attachment != null && host.isCurrentAttachment(attachment)

                // The legacy-WebView notice (github#8) renders no editor, so
                // Back must still work there with nothing to drain or commit.
                override fun exitWithoutEditor() {
                    if (editorPaneUnavailable) {
                        dismissFind()
                        navigate()
                    }
                }

                override fun prepare() {
                    focusManager.clearFocus(force = true)
                    dismissFind()
                    host.blur()
                }

                override suspend fun cancelPendingSave() {
                    saveJob?.cancel()
                }

                override suspend fun captureBody(): String? =
                    attachment?.let { host.captureContentAndWait(it) }

                override suspend fun commitBody(body: String): Boolean {
                    content = body
                    val commit = commitEditorNavigationSnapshot(
                        savedContent = savedContent,
                        content = body,
                        flush = { base, snapshot ->
                            store.flushDraft(PendingDraft(noteId, base, snapshot))
                        },
                    )
                    savedContent = commit.savedContent
                    if (commit.disposition is FlushDisposition.ParkedConflict) {
                        noteId = commit.disposition.parkedId
                    }
                    return commit.canNavigate
                }

                override suspend fun commitTitle(): Boolean {
                    val titleCommit = commitEditorTitleSnapshot(
                        currentId = noteId,
                        targetId = editorTitleTarget(
                            currentId = noteId,
                            rawTitle = titleValue.text,
                            existingIds = store.notes.mapTo(mutableSetOf()) { it.id },
                        ),
                        rename = store::rename,
                    )
                    noteId = titleCommit.id
                    return titleCommit.isCommitted
                }

                override suspend fun perform(): Boolean {
                    navigate()
                    return true
                }

                override fun onFailed(failure: EditorExitFailure) {
                    if (attachment != null && host.isCurrentAttachment(attachment)) {
                        Toast.makeText(
                            context,
                            localization.localizedText("notes.save.failedPending"),
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
        )
    }

    fun saveImageForAttachment(
        attachment: EditorAttachmentToken,
        failureMessage: LocalizedMessage,
        save: (File) -> String?,
    ) {
        scope.launch {
            val name = session.runWork {
                if (!host.isCurrentAttachment(attachment)) {
                    return@runWork null
                }
                store.saveImageIntoVault(
                    save = save,
                    useSavedImage = { filename ->
                        withContext(Dispatchers.Main.immediate) {
                            check(host.insertImageAndWait(filename, attachment)) {
                                "The editor was unavailable for image insertion"
                            }
                        }
                    },
                )
            }
            if (name == null && host.isCurrentAttachment(attachment)) {
                Toast.makeText(
                    context,
                    localization.localizedText(failureMessage.path, failureMessage.arguments),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    BackHandler {
        when (findBackAction(findVisible)) {
            FindBackAction.DismissFind -> dismissFind()
            FindBackAction.ExitNote -> {
                // The session refuses a second exit on its own; consuming Back
                // here keeps the gesture from falling through while one runs.
                if (!interactionLocked) navigateAfterSaving(onBack)
            }
        }
    }

    // The editor's note universe [editor.md:77]: id/title/modifiedMs/tags JSON
    // for the wikilink suffix resolver + autocomplete. Rebuilt only when the
    // list actually changes; the host dedupes pushes by content hash.
    val notesJson = remember(store.notes) {
        JSONArray().apply {
            store.notes.forEach { n ->
                put(JSONObject().apply {
                    put("id", n.id)
                    put("title", n.title)
                    put("modifiedMs", n.modifiedMs)
                    put("tags", JSONArray(n.tags))
                })
            }
        }.toString()
    }

    // Off-main initial load of the note body. Until it lands, `loaded` is false,
    // which gates the live-sync adopt + onChange save so an empty placeholder is
    // never written back over the real note (data-loss guard).
    LaunchedEffect(initialNoteId) {
        val disk = store.read(initialNoteId)
        content = disk
        savedContent = disk
        loaded = true
    }

    // The unsaved-draft register (F8 jetsam guard) is DERIVED, not hand-synced
    // (PKT-12 R5). Claim ownership for this editor instance, then register ONE
    // derivation closure — so "is there an unsaved draft, for which note" has a
    // single source of truth instead of ~7 imperative set/clear sites that raced
    // the editor (PKT-1 R1-R4). The closure is pulled SYNCHRONOUSLY at flush time
    // (onPause), reading the editor's live snapshot state, so an edit landing
    // immediately before onPause is always seen (no async publication-window
    // gap). It returns null the instant content==savedContent (save completes /
    // remote adopted) and re-keys to the new id on rename (content follows the
    // live noteId), both by construction. `base` = savedContent is the flush's
    // conditional-write expected-previous.
    // Claim ownership + register the provider inside the effect (NOT in remember —
    // remember must stay pure; claiming there would advance the generation counter
    // for a composition that is later abandoned without ever releasing, PKT-12 F6).
    // Keyed on initialNoteId (stable for this editor instance, so a rename doesn't
    // re-claim mid-life). The effect body runs before any leave-foreground flush
    // can occur, so first-publish ordering holds. A superseded editor's release is
    // a no-op, so the incoming editor's provider survives the cross-fade overlap
    // (PKT-1 R2). The provider is the single derivation (derivePendingDraft),
    // pulled synchronously at flush time.
    DisposableEffect(initialNoteId) {
        val ownerToken = store.claimDraftOwnership()
        store.setDraftProvider(ownerToken) {
            derivePendingDraft(loaded, noteId, savedContent, content)
        }
        onDispose { store.releaseDraftOwnership(ownerToken) }
    }

    // Flush a pending save when leaving (only if loaded + changed). The exists
    // check and write run off the main thread on the store's scope, which
    // outlives this composable — a composable's onDispose can't suspend. This is
    // the POP flush (navigating back isn't a background signal, so onPause won't
    // fire); the register handles the background flush.
    DisposableEffect(initialNoteId) {
        onDispose {
            saveJob?.cancel()
            // Discard an untouched quick-capture note: opened brand-new
            // (autoFocus), never renamed (id unchanged AND title still the
            // created placeholder), body still empty. Backing out leaves nothing
            // behind — desktop parity (list.md). deleteAsync runs on the store's
            // scope (onDispose can't suspend and the composable scope is gone).
            if (autoFocus && noteId == initialNoteId && content.isEmpty()
                && titleValue.text == splitId(initialNoteId).title) {
                store.deleteAsync(noteId)
            } else if (loaded && content != savedContent) {
                store.flushAsync(PendingDraft(noteId, savedContent, content))
            }
        }
    }

    // Render the engine's open-note disposition after the exact live-pull list
    // mutation lands. Reported renames are followed as renames; missing and
    // empty are distinguished by one atomic store read; focused adoption stays
    // deferred until blur.
    LaunchedEffect(initialNoteId) {
        store.localTreeChanges.collect { summary ->
            // A delivered summary starts a fresh native reconciliation epoch.
            // Carrying the previous completion's version would misclassify an
            // already-saved clean local edit as still in flight.
            val reconciliationStartEditVersion = editVersion
            try {
                // Do not drop a cycle that lands during the initial disk read:
                // wait for the buffer, then classify it against current disk.
                if (!loaded && summary.affectsOpenNote(noteId)) {
                    snapshotFlow { loaded }.first { it }
                }
                if (summary.affectsOpenNote(noteId)) {
                    val disposition =
                        session.reconcileOpenNote(
                            openNoteEffects(summary, reconciliationStartEditVersion),
                        )
                    logOpenNoteDisposition(disposition, host.editorFocused)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.e("NoteEditor", "open-note reconciliation failed", e)
                Toast.makeText(
                    context,
                    localization.localizedText("notes.save.refreshFailedDraftOpen"),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    LaunchedEffect(host.editorFocused, loaded, noteId) {
        if (loaded && !host.editorFocused && !session.isClosing) {
            try {
                val disposition = session.settleDeferredAdoption(
                    openNoteEffects(
                        summary = null,
                        reconciliationStartEditVersion = editVersion,
                    ),
                )
                logOpenNoteDisposition(disposition, host.editorFocused)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.e("NoteEditor", "deferred open-note adoption failed", e)
            }
        }
    }

    // Debounced rename (500 ms) — the filename IS the title; Rust resolves
    // collisions and returns the final id.
    LaunchedEffect(initialNoteId) {
        snapshotFlow { titleValue.text }.debounce(500).collect { next ->
            // Flush any pending body edit to the CURRENT id and cancel the
            // in-flight save before the file moves — otherwise a stale save
            // would recreate a ghost note at the old id (data loss). The derived
            // register re-keys to the new id after the rename (its content follows
            // the live noteId), so no manual draft repointing is needed (PKT-1 R4).
            session.runWork {
                saveJob?.cancel()
                // Snapshot the body BEFORE the suspending write and advance savedContent
                // to exactly that snapshot — never to the live `content`. If the user
                // types during the suspended write, `content` moves ahead of the bytes
                // on disk; assigning savedContent from live `content` would mark that
                // newer keystroke as saved and the register would go clean, losing it on
                // background/process death (PKT-12 F1).
                val flushed = content
                if (flushed != savedContent) {
                    val outcome = store.write(noteId, flushed)
                    savedContent = confirmedSavedContent(savedContent, flushed, outcome)
                    if (outcome === NoteMutationOutcome.Failed) {
                        Toast.makeText(
                            context,
                            localization.localizedText("notes.save.failedPending"),
                            Toast.LENGTH_SHORT,
                        ).show()
                        return@runWork
                    }
                }
                val titleCommit = commitEditorTitleSnapshot(
                    currentId = noteId,
                    targetId = editorTitleTarget(
                        currentId = noteId,
                        rawTitle = next,
                        existingIds = store.notes.mapTo(mutableSetOf()) { it.id },
                    ),
                    rename = store::rename,
                )
                noteId = titleCommit.id
                if (!titleCommit.isCommitted) {
                    Toast.makeText(
                        context,
                        localization.localizedText("notes.title.renameFailed"),
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    // Picker round-trip [editor.md:121+130]: native pick → copy into the vault
    // root (IMAGE_EXTENSIONS only) → insertImage back into the editor. Shared
    // by the native toolbar's camera/image items and the bridge `pickImage`
    // message (kept for older bundles).
    val pickImage: (String) -> Unit = { source ->
        val attachment = host.currentAttachment()
        val handle: (List<Uri>) -> Unit = { uris ->
            val uri = uris.firstOrNull()
            if (uri != null && attachment != null) {
                saveImageForAttachment(
                    attachment,
                    LocalizedMessage("editor.images.unsupportedType"),
                ) { root ->
                    saveImageIntoVault(context.contentResolver, root, uri)
                }
            }
        }
        when (source) {
            "camera" -> imagePicker?.captureCamera(handle)
            else -> imagePicker?.pickLibrary(callback = handle)
        }
    }

    // Clipboard image paste [editor.md]: the embed posts the pasted bytes
    // (base64) via the `saveImageData` bridge message → decode + save into the
    // vault root (IMAGE_EXTENSIONS only) → insertImage back. Same vault
    // destination as the picker above, so paste and pick are indistinguishable.
    val saveImageData: (String, String) -> Unit = { base64, ext ->
        val attachment = host.currentAttachment()
        if (attachment != null) {
            saveImageForAttachment(
                attachment,
                LocalizedMessage("editor.images.pasteFailed"),
            ) { root ->
                val bytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)
                saveImageDataIntoVault(root, bytes, ext)
            }
        }
    }

    // Select the whole title when the field gains focus AND is still a
    // placeholder ("Untitled"/"Untitled-N"), so a keystroke replaces it; a real
    // title keeps the tapped caret. Keyed on the focus transition so it fires
    // once per focus (after the tap's caret placement settles — otherwise the
    // tap's collapsed selection would win), not on every tap while focused.
    LaunchedEffect(titleFocused) {
        if (titleFocused && isPlaceholderTitle(titleValue.text)) {
            titleValue = titleValue.copy(selection = TextRange(0, titleValue.text.length))
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopBar(
                title = {},
                navigationIcon = {
                    IconButton(
                        enabled = !interactionLocked,
                        onClick = { navigateAfterSaving(onBack) },
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = localization.localizedText("common.actions.back"),
                            tint = c.textSecondary,
                        )
                    }
                },
                actions = {
                    IconButton(enabled = !interactionLocked, onClick = {
                        val share = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TITLE, titleValue.text)
                            putExtra(Intent.EXTRA_TEXT, content)
                        }
                        context.startActivity(
                            Intent.createChooser(
                                share,
                                localization.localizedText("notes.shareChooserTitle"),
                            ),
                        )
                    }) {
                        Icon(
                            Icons.Filled.Share,
                            contentDescription = localization.localizedText("notes.actions.share"),
                            tint = c.textSecondary,
                        )
                    }
                    var menu by remember { mutableStateOf(false) }
                    IconButton(enabled = !interactionLocked, onClick = { menu = true }) {
                        Icon(
                            Icons.Filled.MoreVert,
                            contentDescription = localization.localizedText("notes.actions.moreAccessibilityLabel"),
                            tint = c.textSecondary,
                        )
                    }
                    // Overflow parity with the list rows [list.md:62].
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(localization.localizedText("editor.find.open")) },
                            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = c.textSecondary) },
                            onClick = {
                                menu = false
                                savedFindProcessToken = host.processToken
                                savedFindVisible = true
                                host.openFind()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(localization.localizedText("notes.actions.moveToFolderEllipsis")) },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null, tint = c.textSecondary) },
                            onClick = { menu = false; showMoveSheet = true },
                        )
                        DropdownMenuItem(
                            text = { Text(localization.localizedText("notes.actions.copyFilePath")) },
                            leadingIcon = { Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = c.textSecondary) },
                            onClick = {
                                menu = false
                                clipboard.setText(AnnotatedString("${store.rootPath}/$noteId.md"))
                                Toast.makeText(
                                    context,
                                    localization.localizedText("notes.pathCopied"),
                                    Toast.LENGTH_SHORT,
                                ).show()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(localization.localizedText("notes.actions.deleteNote")) },
                            leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                            onClick = { menu = false; confirmDelete = true },
                        )
                    }
                },
            )
        },
    ) { padding ->
        // consumeWindowInsets(padding): the Scaffold padding already covers the
        // navigation-bar inset, and imePadding() would otherwise add the FULL
        // keyboard height on top of it — double-counting the nav-bar portion
        // as a white band between the toolbar and the keyboard.
        Column(
            modifier = Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .fillMaxSize()
                .imePadding(),
        ) {
            BasicTextField(
                enabled = !interactionLocked,
                value = titleValue,
                onValueChange = { v ->
                    // Strip forbidden filesystem chars in-place (desktop parity —
                    // the illegal char never persists) + cap at the length limit.
                    val noNewline = v.text.replace("\n", "")
                    val cleaned = TitleSpec.forbiddenChars.replace(noNewline, "")
                    val forbidden = cleaned != noNewline
                    val capped = if (cleaned.length > TitleSpec.maxLength) cleaned.take(TitleSpec.maxLength) else cleaned
                    titleValue =
                        if (capped == v.text) v
                        else TextFieldValue(capped, TextRange(minOf(v.selection.end, capped.length)))
                    if (forbidden) {
                        // Transient warning (auto-hide after 2 s).
                        titleWarning = LocalizedMessage("notes.title.forbiddenCharacter")
                        warningJob?.cancel()
                        warningJob = scope.launch { delay(2000); titleWarning = null }
                    } else {
                        // Persistent warning for dot/too-long; else duplicate; else clear.
                        warningJob?.cancel()
                        val blocking = validateTitle(capped)
                            .firstOrNull { it.kind != "empty" && it.kind != "forbidden_chars" }
                        val dup = capped.trim().let { t ->
                            t.isNotEmpty() && makeId(splitId(noteId).folder, sanitizeTitle(t)).let { tgt ->
                                tgt != noteId && store.notes.any { it.id == tgt }
                            }
                        }
                        titleWarning = blocking?.let { titleValidationMessage(it.kind) }
                            ?: if (dup) LocalizedMessage("notes.title.duplicate") else null
                    }
                },
                singleLine = true,
                textStyle = FutoType.h3.copy(fontWeight = FontWeight.SemiBold, color = c.textPrimary),
                cursorBrush = SolidColor(c.accent),
                modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 4.dp)
                    .onFocusChanged { titleFocused = it.isFocused },
                decorationBox = { inner ->
                    if (titleValue.text.isEmpty()) {
                        Text(
                            localization.localizedText("notes.untitledPlaceholder"),
                            style = FutoType.h3.copy(fontWeight = FontWeight.SemiBold),
                            color = c.textMuted,
                        )
                    }
                    inner()
                },
            )
            titleWarning?.let { warning ->
                Text(
                    localization.localizedText(warning.path, warning.arguments),
                    style = FutoType.caption,
                    color = c.danger,
                    modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 2.dp),
                )
            }
            Spacer(Modifier.size(8.dp))

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                // An engine that can't run the bundle would paint a blank pane
                // (github#8) — show the native "update WebView" notice instead.
                if (editorPaneUnavailable) {
                    LegacyWebViewNotice()
                } else {
                    EditorWebView(
                        content = content,
                        languageTag = localization.effectiveLanguage.tag,
                        // Quick capture: a brand-new note (autoFocus) opens with the
                        // BODY focused — keyboard on the editor, not the title field —
                        // so the first keystrokes are the note, not its name. Opening
                        // an existing note leaves the keyboard down (autoFocus false).
                        // [list.md]
                        theme = theme,
                        autoFocus = autoFocus,
                        notesJson = notesJson,
                        // Local ![](image.png) resolves against the vault root
                        // [editor.md:121] (allowFileAccess stays on, see EditorHost).
                        imageBaseUrl = "file://${store.rootPath}/",
                        modifier = Modifier.fillMaxSize(),
                        onAttachmentChange = { editorAttachment = it },
                        onOpenNote = { linkedNoteId ->
                            if (linkedNoteId != noteId) {
                                navigateAfterSaving { onOpenNote(linkedNoteId) }
                            }
                        },
                        onPickImage = pickImage,
                        onSaveImageData = saveImageData,
                        onFindMatches = { report ->
                            if (isFindStateCurrent(savedFindProcessToken, host.processToken)) {
                                findQuery = report.query
                                findLabel = report.label
                                findTotal = report.total
                            }
                        },
                        onChange = { newContent ->
                            // Data-loss guard: ignore editor change events until the
                            // off-main initial read has landed (`loaded`). The WebView
                            // mounts with "" and can emit a setContent echo before the
                            // real body loads; saving that empty echo would clobber the
                            // note on disk. Once loaded, all edits flow through.
                            if (
                                session.acceptsEditorChange(
                                    loaded = loaded,
                                    storageMigrationStarted = store.isVaultMigrationStarted,
                                )
                            ) {
                                // Just update the buffer state. The unsaved-draft
                                // register follows from the snapshotFlow derivation
                                // (content != savedContent) — no manual publish; the
                                // register goes clean the instant the debounced save
                                // sets savedContent (PKT-12 R5). F8 jetsam guard.
                                content = newContent
                                editVersion += 1
                                scheduleBodySave(newContent)
                            }
                        },
                    )
                }
            }

            // This bottom slot is inside the Column's imePadding(), which
            // keeps the find bar docked directly above the virtual keyboard.
            if (findVisible) {
                FindInNoteBar(
                    query = findQuery,
                    label = findLabel,
                    total = findTotal,
                    onQueryChange = {
                        findQuery = it
                        host.setFindQuery(it)
                    },
                    onStep = host::stepFind,
                    onClose = {
                        dismissFind()
                    },
                )
            }

            // Native markdown toolbar [editor.md]: rendered from the generated
            // ToolbarSpec.kt manifest, docked above the soft keyboard by this
            // Column's imePadding. Gated on focus AND the IME actually being
            // up: the bar is docked to the keyboard, so it tracks the keyboard
            // exactly like iOS's inputAccessoryView rather than tracking focus
            // alone (the two can legitimately differ — a hardware keyboard, or
            // the frame in which the IME is still animating). Exec items dispatch
            // into the SHARED markdownToolbar.ts commands — no editing logic in
            // Kotlin.
            if (host.editorFocused && WindowInsets.isImeVisible) {
                EditorToolbar(
                    onListLine = host.onListLine,
                    perform = { item ->
                        when (val action = item.action) {
                            ToolbarItemAction.Exec -> host.exec(item.id)
                            is ToolbarItemAction.PickImage -> pickImage(action.source)
                            ToolbarItemAction.Dismiss -> host.blur()
                        }
                    },
                )
            }
        }
    }
        if (interactionLocked) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                    ),
            )
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = localization.localizedText("notes.delete.thisNoteQuestion"),
            body = localization.localizedText("notes.delete.recoverableWarning"),
            confirmLabel = localization.localizedText("common.actions.delete"),
            onConfirm = {
                confirmDelete = false
                session.end(
                    EditorExit.DELETE,
                    object : EditorExitEffects {
                        override fun prepare() {
                            // The session has already latched closed, so a
                            // change arriving from here on is dropped; killing
                            // the queued debounce keeps it from waiting behind
                            // the delete only to be refused.
                            saveJob?.cancel()
                            host.blur()
                        }

                        override suspend fun captureBody(): String = content

                        override suspend fun commitBody(body: String): Boolean {
                            val hasPendingChanges = body != savedContent
                            val writeOutcome = if (hasPendingChanges) {
                                store.write(noteId, body)
                            } else {
                                null
                            }
                            if (writeOutcome != null) {
                                savedContent = confirmedSavedContent(
                                    savedContent,
                                    body,
                                    writeOutcome,
                                )
                            }
                            return shouldContinueDeleteAfterEditorWrite(
                                hasPendingChanges,
                                writeOutcome,
                            )
                        }

                        override suspend fun perform(): Boolean =
                            shouldCompleteNoteAction(store.delete(noteId))

                        override fun onSucceeded() {
                            // Mark clean only after delete commits, so onDispose
                            // cannot recreate the deleted note from its dirty draft.
                            savedContent = content
                            dismissFind()
                            Toast.makeText(
                                context,
                                localization.localizedText("notes.deleted"),
                                Toast.LENGTH_SHORT,
                            ).show()
                            onBack()
                        }

                        override fun onFailed(failure: EditorExitFailure) {
                            Toast.makeText(
                                context,
                                if (failure == EditorExitFailure.BODY) {
                                    localization.localizedText("notes.delete.savePending")
                                } else {
                                    localization.localizedText("notes.errors.deleteFailed")
                                },
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                    },
                )
            },
            onDismiss = { confirmDelete = false },
        )
    }

    if (showMoveSheet) {
        FolderPickerSheet(
            store = store,
            onDismiss = { showMoveSheet = false },
            onPick = { folder, isNew ->
                session.end(
                    EditorExit.MOVE,
                    object : EditorExitEffects {
                        // Move never touches the WebView, so the live buffer IS
                        // the freshest body. Snapshot it inside the drain and
                        // advance savedContent to that snapshot, not to live
                        // `content`, so a keystroke typed during the write stays
                        // dirty in the register and survives a later background
                        // flush (PKT-12 F1 — same as the rename path).
                        override suspend fun captureBody(): String = content

                        override suspend fun cancelPendingSave() {
                            saveJob?.cancel()
                        }

                        // Flush the draft to the CURRENT id before the file
                        // moves — a stale save would recreate a ghost at the old
                        // id. The derived register re-keys to the moved id
                        // afterwards (its content follows the live noteId), so
                        // no manual clear (R4).
                        override suspend fun commitBody(body: String): Boolean {
                            if (body == savedContent) return true
                            val writeOutcome = store.write(noteId, body)
                            savedContent =
                                confirmedSavedContent(savedContent, body, writeOutcome)
                            if (writeOutcome === NoteMutationOutcome.Failed) {
                                Toast.makeText(
                                    context,
                                    localization.localizedText("notes.save.failedPending"),
                                    Toast.LENGTH_SHORT,
                                ).show()
                                return false
                            }
                            return true
                        }

                        override suspend fun perform(): Boolean {
                            val moveOutcome = store.moveNote(
                                noteId,
                                folder,
                                createFolder = isNew,
                            )
                            if (moveOutcome !is NoteMutationOutcome.Committed) return false
                            // Update the live id before releasing the drain. A
                            // delete already waiting behind this move must
                            // target the final id.
                            noteId = moveOutcome.value
                            return true
                        }

                        override fun onSucceeded() {
                            showMoveSheet = false
                            Toast.makeText(
                                context,
                                if (folder.isEmpty()) {
                                    localization.localizedText("notes.movedToRoot")
                                } else {
                                    localization.localizedText(
                                        "notes.movedTo",
                                        mapOf("destination" to folder),
                                    )
                                },
                                Toast.LENGTH_SHORT,
                            ).show()
                        }

                        override fun onFailed(failure: EditorExitFailure) {
                            // REJECTED (a delete latched first) stays silent —
                            // the delete reports for itself.
                            if (failure == EditorExitFailure.REJECTED) return
                            Toast.makeText(
                                context,
                                localization.localizedText("notes.errors.moveFailed"),
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                    },
                )
            },
        )
    }
}

private class FindQueryEditText(context: Context) : EditText(context) {
    var onQueryChange: (String) -> Unit = {}
    var onStep: (Int) -> Unit = {}
    var onClose: () -> Unit = {}
    private var applyingQuery = false

    init {
        isSingleLine = true
        // hint/contentDescription are catalog-resolved by the composable, in
        // `update` as well as `factory`, so an interface-language change
        // re-labels a bar that is already on screen.
        imeOptions = EditorInfo.IME_ACTION_SEARCH
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (!applyingQuery) onQueryChange(s?.toString().orEmpty())
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                onStep(1)
                true
            } else if (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN) {
                onStep(if (event.isShiftPressed) -1 else 1)
                true
            } else {
                false
            }
        }
    }

    fun applyQuery(query: String) {
        if (text.toString() == query) return
        applyingQuery = true
        setText(query)
        setSelection(query.length)
        applyingQuery = false
    }

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            onClose()
            return true
        }
        return super.onKeyPreIme(keyCode, event)
    }
}

@Composable
private fun FindInNoteBar(
    query: String,
    label: String,
    total: Int,
    onQueryChange: (String) -> Unit,
    onStep: (Int) -> Unit,
    onClose: () -> Unit,
) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val localization = LocalLocalization.current
    val queryHint = localization.localizedText("editor.find.queryHint")
    val queryLabel = localization.localizedText("editor.find.queryLabel")

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.surface),
    ) {
        HorizontalDivider(thickness = 0.5.dp, color = c.border)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .padding(start = 16.dp, end = 4.dp),
        ) {
            AndroidView(
                factory = {
                    FindQueryEditText(context).apply {
                        background = null
                        hint = queryHint
                        contentDescription = queryLabel
                        setPadding(0, 0, 0, 0)
                        setTextColor(c.textPrimary.toArgb())
                        setHintTextColor(c.textMuted.toArgb())
                        textSize = 18f
                        includeFontPadding = false
                        this.onQueryChange = onQueryChange
                        this.onStep = onStep
                        this.onClose = onClose
                        applyQuery(query)
                        requestFocus()
                        // The AndroidView can own focus before its window is
                        // ready for IME attachment. Let the composed frame
                        // settle, then repeat focus + show as one operation.
                        postDelayed({
                            requestFocus()
                            context.getSystemService(InputMethodManager::class.java)
                                ?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
                            ViewCompat.getWindowInsetsController(this)
                                ?.show(WindowInsetsCompat.Type.ime())
                        }, 150)
                    }
                },
                update = { field ->
                    field.hint = queryHint
                    field.contentDescription = queryLabel
                    field.onQueryChange = onQueryChange
                    field.onStep = onStep
                    field.onClose = onClose
                    field.setTextColor(c.textPrimary.toArgb())
                    field.setHintTextColor(c.textMuted.toArgb())
                    field.applyQuery(query)
                },
                modifier = Modifier
                    .height(55.dp)
                    .weight(1f),
            )

            Text(
                label,
                style = FutoType.body,
                color = if (query.isNotEmpty() && total == 0) c.danger else c.textSecondary,
                modifier = Modifier.padding(horizontal = 12.dp),
            )

            VerticalDivider(
                thickness = 0.5.dp,
                color = c.border,
                modifier = Modifier.height(36.dp),
            )

            IconButton(
                enabled = canStepFind(total),
                onClick = { onStep(-1) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Filled.KeyboardArrowUp,
                    contentDescription = localization.localizedText("editor.find.previousMatch"),
                    tint = if (canStepFind(total)) c.textSecondary else c.textMuted,
                )
            }
            IconButton(
                enabled = canStepFind(total),
                onClick = { onStep(1) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = localization.localizedText("editor.find.nextMatch"),
                    tint = if (canStepFind(total)) c.textSecondary else c.textMuted,
                )
            }
            IconButton(
                onClick = onClose,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = localization.localizedText("editor.find.close"),
                    tint = c.textPrimary,
                    modifier = Modifier.size(26.dp),
                )
            }
        }
    }
}
