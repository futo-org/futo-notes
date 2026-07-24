package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import java.io.File
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.futo.notes.ImagePicker
import com.futo.notes.AdoptFlushOutcome
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.NotesStore
import com.futo.notes.PendingDraft
import com.futo.notes.adoptFlushOutcome
import com.futo.notes.confirmedSavedContent
import com.futo.notes.derivePendingDraft
import com.futo.notes.saveImageDataIntoVault
import com.futo.notes.saveImageIntoVault
import com.futo.notes.shouldCompleteNoteAction
import com.futo.notes.shouldContinueDeleteAfterEditorWrite
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.FolderPickerSheet
import com.futo.notes.ui.theme.FutoType
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import uniffi.futo_notes_ffi.FlushDisposition
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
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    // The shared pre-warmed editor host — needed directly (beyond the
    // EditorWebView props) for the bridge-v2 imperative calls:
    // applyExternalContent (sync adopt) and insertImage (picker round-trip).
    val host = remember { EditorHost.get(context) }

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
    var titleWarning by remember(initialNoteId) { mutableStateOf<String?>(null) }
    var warningJob by remember { mutableStateOf<Job?>(null) }
    // CRITICAL: never block the editor's first frame on a disk read. Start empty
    // and load the note body off the main thread; the WebView mounts immediately
    // and receives the content reactively once the read lands.
    var content by remember(initialNoteId) { mutableStateOf("") }
    var savedContent by remember(initialNoteId) { mutableStateOf("") }
    var loaded by remember(initialNoteId) { mutableStateOf(false) }
    var saveJob by remember { mutableStateOf<Job?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showMoveSheet by remember { mutableStateOf(false) }
    val mutationGate = remember(initialNoteId) { EditorMutationGate() }
    val navigationAdmission = remember(initialNoteId) { EditorNavigationAdmission() }
    var navigationPending by remember(initialNoteId) { mutableStateOf(false) }
    val interactionEnabled = isEditorInteractionEnabled(navigationPending)
    val theme = if (darkTheme) "dark" else "light"

    fun navigateAfterSaving(navigate: () -> Unit) {
        val attachment = host.currentAttachment() ?: return
        if (!navigationAdmission.tryBegin()) return
        navigationPending = true
        focusManager.clearFocus(force = true)
        host.blur()
        scope.launch {
            val canNavigate = mutationGate.runEditorMutation {
                if (!host.isCurrentAttachment(attachment)) return@runEditorMutation false
                saveJob?.cancel()
                val capturedContent =
                    host.captureContentAndWait(attachment) ?: return@runEditorMutation false
                content = capturedContent
                val commit = commitEditorNavigationSnapshot(
                    savedContent = savedContent,
                    content = capturedContent,
                    flush = { base, snapshot ->
                        store.flushDraft(PendingDraft(noteId, base, snapshot))
                    },
                )
                savedContent = commit.savedContent
                if (commit.disposition is FlushDisposition.ParkedConflict) {
                    noteId = commit.disposition.parkedId
                }
                val titleCommit = if (commit.canNavigate) {
                    commitEditorTitleSnapshot(
                        currentId = noteId,
                        targetId = editorTitleTarget(
                            currentId = noteId,
                            rawTitle = titleValue.text,
                            existingIds = store.notes.mapTo(mutableSetOf()) { it.id },
                        ),
                        rename = store::rename,
                    )
                } else {
                    EditorTitleCommit(noteId, committed = false)
                }
                noteId = titleCommit.id
                titleCommit.committed && host.isCurrentAttachment(attachment)
            } ?: false
            if (canNavigate) {
                navigate()
            } else {
                navigationAdmission.retryAfterFailure()
                navigationPending = false
                if (host.isCurrentAttachment(attachment)) {
                    Toast.makeText(
                        context,
                        "Couldn't save note. Your changes are still pending.",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    fun saveImageForAttachment(
        attachment: EditorAttachmentToken,
        failureMessage: String,
        save: (File) -> String?,
    ) {
        scope.launch {
            val name = mutationGate.runEditorMutation {
                if (!host.isCurrentAttachment(attachment)) {
                    return@runEditorMutation null
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
                Toast.makeText(context, failureMessage, Toast.LENGTH_SHORT).show()
            }
        }
    }

    BackHandler {
        if (shouldStartEditorBackNavigation(navigationPending)) {
            navigateAfterSaving(onBack)
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
    DisposableEffect(noteId) {
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

    // Live-sync refresh for the OPEN note [sync.md:239]. A live pull rewrites
    // the file and reloads the store; without this, the open editor keeps
    // showing (and on exit, SAVES BACK) a stale base. Clean drafts adopt the
    // remote content in place via applyExternalContent (selection/scroll
    // preserved, history suppressed); a dirty draft against a REAL remote
    // change is parked as a conflict copy first — neither side's edit is lost.
    LaunchedEffect(initialNoteId) {
        // This emits when `store.notes` changes by list equality. A sync write
        // (including a PUSH-side merge, F2) is seen because apply_delta stamps
        // the merged file's mtime (orchestrator.rs:312-314) → NoteItem.modifiedMs
        // differs → the list is unequal → collect fires and re-reads disk. If a
        // future refactor stops stamping merged-write mtimes, this reload chain
        // breaks silently for a same-length merge — keep the stamp.
        snapshotFlow { store.notes }.collect {
            if (!loaded || !store.exists(noteId)) return@collect
            val disk = store.read(noteId)
            when {
                content == savedContent -> {
                    if (disk != savedContent) {
                        // Clean draft: adopt the remote content in place. Setting
                        // content==savedContent==disk makes the derived register
                        // null this note's draft by construction, so a background
                        // flush can't clobber the peer's edit (PKT-1 R1).
                        host.applyExternalContent(disk)
                        content = disk
                        savedContent = disk
                    }
                }
                disk == content -> {
                    // Our own save echoed back through the rescan — mark clean
                    // (the register re-derives to null).
                    savedContent = disk
                }
                disk != savedContent -> {
                    // Snapshot before each suspending engine flush. If the user
                    // types while it runs, loop with the newer buffer rather than
                    // replacing those keystrokes with the peer version.
                    saveJob?.cancel()
                    val conflictId = noteId
                    while (noteId == conflictId) {
                        val flushed = content
                        val disposition = mutationGate.runEditorMutation {
                            store.flushDraft(
                                PendingDraft(conflictId, savedContent, flushed),
                            )
                        } ?: return@collect
                        when (adoptFlushOutcome(disposition)) {
                            AdoptFlushOutcome.KEEP_DRAFT -> {
                                savedContent = flushed
                                break
                            }
                            AdoptFlushOutcome.RELOAD_DISK -> {
                                if (content != flushed) continue
                                val refreshedDisk = store.read(conflictId)
                                if (noteId != conflictId) return@collect
                                if (content != flushed) continue
                                host.applyExternalContent(refreshedDisk)
                                content = refreshedDisk
                                savedContent = refreshedDisk
                                Toast.makeText(
                                    context,
                                    "Conflicting edits saved to a copy",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                break
                            }
                            AdoptFlushOutcome.RETRY_LATER -> {
                                Toast.makeText(
                                    context,
                                    "Couldn't preserve conflicting edits. Your draft is still open.",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                return@collect
                            }
                        }
                    }
                }
            }
        }
    }

    // Debounced rename (500 ms) — the filename IS the title; Rust resolves
    // collisions and returns the final id.
    LaunchedEffect(initialNoteId) {
        snapshotFlow { titleValue.text }.debounce(500).collectLatest { next ->
            // Flush any pending body edit to the CURRENT id and cancel the
            // in-flight save before the file moves — otherwise a stale save
            // would recreate a ghost note at the old id (data loss). The derived
            // register re-keys to the new id after the rename (its content follows
            // the live noteId), so no manual draft repointing is needed (PKT-1 R4).
            mutationGate.runEditorMutation {
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
                            "Couldn't save note. Your changes are still pending.",
                            Toast.LENGTH_SHORT,
                        ).show()
                        return@runEditorMutation
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
                if (!titleCommit.committed) {
                    Toast.makeText(
                        context,
                        "Couldn't rename note. Your title is still pending.",
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
        val handle: (Uri?) -> Unit = { uri ->
            if (uri != null && attachment != null) {
                saveImageForAttachment(attachment, "Unsupported image type") { root ->
                    saveImageIntoVault(context.contentResolver, root, uri)
                }
            }
        }
        when (source) {
            "camera" -> imagePicker?.captureCamera(handle)
            else -> imagePicker?.pickLibrary(handle)
        }
    }

    // Clipboard image paste [editor.md]: the embed posts the pasted bytes
    // (base64) via the `saveImageData` bridge message → decode + save into the
    // vault root (IMAGE_EXTENSIONS only) → insertImage back. Same vault
    // destination as the picker above, so paste and pick are indistinguishable.
    val saveImageData: (String, String) -> Unit = { base64, ext ->
        val attachment = host.currentAttachment()
        if (attachment != null) {
            saveImageForAttachment(attachment, "Couldn't paste image") { root ->
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
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(
                        enabled = interactionEnabled,
                        onClick = { navigateAfterSaving(onBack) },
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = c.textSecondary)
                    }
                },
                actions = {
                    IconButton(enabled = interactionEnabled, onClick = {
                        val share = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TITLE, titleValue.text)
                            putExtra(Intent.EXTRA_TEXT, content)
                        }
                        context.startActivity(Intent.createChooser(share, "Share note"))
                    }) {
                        Icon(Icons.Filled.Share, contentDescription = "Share", tint = c.textSecondary)
                    }
                    var menu by remember { mutableStateOf(false) }
                    IconButton(enabled = interactionEnabled, onClick = { menu = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "More", tint = c.textSecondary)
                    }
                    // Overflow parity with the list rows [list.md:62].
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text("Move to folder…") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = null, tint = c.textSecondary) },
                            onClick = { menu = false; showMoveSheet = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Copy file path") },
                            leadingIcon = { Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = c.textSecondary) },
                            onClick = {
                                menu = false
                                clipboard.setText(AnnotatedString("${store.rootPath}/$noteId.md"))
                                Toast.makeText(context, "Path copied", Toast.LENGTH_SHORT).show()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Delete note") },
                            leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                            onClick = { menu = false; confirmDelete = true },
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.surface),
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
                enabled = interactionEnabled,
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
                        titleWarning = "That character can't be used in a note title"
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
                        titleWarning = blocking?.message
                            ?: if (dup) "A note with this name already exists" else null
                    }
                },
                singleLine = true,
                textStyle = FutoType.h3.copy(fontWeight = FontWeight.SemiBold, color = c.textPrimary),
                cursorBrush = SolidColor(c.accent),
                modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 4.dp)
                    .onFocusChanged { titleFocused = it.isFocused },
                decorationBox = { inner ->
                    if (titleValue.text.isEmpty()) {
                        Text("Untitled", style = FutoType.h3.copy(fontWeight = FontWeight.SemiBold), color = c.textMuted)
                    }
                    inner()
                },
            )
            titleWarning?.let { w ->
                Text(
                    w,
                    style = FutoType.caption,
                    color = c.danger,
                    modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 2.dp),
                )
            }
            Spacer(Modifier.size(8.dp))

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                EditorWebView(
                    content = content,
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
                    onOpenNote = { linkedNoteId ->
                        if (linkedNoteId != noteId) {
                            navigateAfterSaving { onOpenNote(linkedNoteId) }
                        }
                    },
                    onPickImage = pickImage,
                    onSaveImageData = saveImageData,
                    onMigrationSnapshot = { capturedContent ->
                        saveJob?.cancel()
                        content = capturedContent
                    },
                    onChange = { newContent ->
                        // Data-loss guard: ignore editor change events until the
                        // off-main initial read has landed (`loaded`). The WebView
                        // mounts with "" and can emit a setContent echo before the
                        // real body loads; saving that empty echo would clobber the
                        // note on disk. Once loaded, all edits flow through.
                        if (
                            loaded &&
                            !mutationGate.isDestructiveActionStarted &&
                            !store.isVaultMigrationStarted
                        ) {
                            // Just update the buffer state. The unsaved-draft
                            // register follows from the snapshotFlow derivation
                            // (content != savedContent) — no manual publish; the
                            // register goes clean the instant the debounced save
                            // sets savedContent (PKT-12 R5). F8 jetsam guard.
                            content = newContent
                            saveJob?.cancel()
                            saveJob = scope.launch {
                                delay(400)
                                // Re-read noteId at fire time so a save that lands
                                // after a rename writes to the renamed note, not the
                                // stale id.
                                val outcome = mutationGate.runEditorMutation {
                                    store.write(noteId, newContent)
                                } ?: return@launch
                                savedContent = confirmedSavedContent(
                                    savedContent,
                                    newContent,
                                    outcome,
                                )
                                if (outcome === NoteMutationOutcome.Failed) {
                                    Toast.makeText(
                                        context,
                                        "Couldn't save note. Your changes are still pending.",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                        }
                    },
                )
            }

            // Native markdown toolbar [editor.md]: rendered from the generated
            // ToolbarSpec.kt manifest, docked above the soft keyboard by this
            // Column's imePadding. Gated on focus AND the IME actually being
            // up — the WebView can report a stale focus without the keyboard
            // (DOM focus parks on cm-content while the view itself is
            // unfocused), and the bar should track the keyboard exactly like
            // iOS's inputAccessoryView. Exec items dispatch into the SHARED
            // markdownToolbar.ts commands — no editing logic in Kotlin.
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
        if (navigationPending) {
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
            title = "Delete this note?",
            body = "This action cannot be undone.",
            confirmLabel = "Delete",
            onConfirm = {
                confirmDelete = false
                mutationGate.beginDestructiveAction()
                saveJob?.cancel()
                host.blur()
                scope.launch {
                    var saveFailed = false
                    val outcome = mutationGate.runDestructiveMutation {
                        val flushed = content
                        val hasPendingChanges = flushed != savedContent
                        val writeOutcome = if (hasPendingChanges) {
                            store.write(noteId, flushed)
                        } else {
                            null
                        }
                        if (writeOutcome != null) {
                            savedContent = confirmedSavedContent(
                                savedContent,
                                flushed,
                                writeOutcome,
                            )
                        }
                        if (
                            !shouldContinueDeleteAfterEditorWrite(
                                hasPendingChanges,
                                writeOutcome,
                            )
                        ) {
                            saveFailed = true
                            return@runDestructiveMutation NoteMutationOutcome.Failed
                        }
                        store.delete(noteId)
                    }
                    if (shouldCompleteNoteAction(outcome)) {
                        // Mark clean only after delete commits, so onDispose
                        // cannot recreate the deleted note from its dirty draft.
                        savedContent = content
                        Toast.makeText(context, "Note deleted", Toast.LENGTH_SHORT).show()
                        onBack()
                    } else {
                        mutationGate.cancelDestructiveAction()
                        Toast.makeText(
                            context,
                            if (saveFailed) {
                                "Couldn't save note. Delete is paused while your changes remain pending."
                            } else {
                                "Couldn't delete note. It remains in your notes."
                            },
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
            onDismiss = { confirmDelete = false },
        )
    }

    if (showMoveSheet) {
        FolderPickerSheet(
            store = store,
            onDismiss = { showMoveSheet = false },
            onPick = { folder, isNew ->
                scope.launch {
                    // Flush the draft to the CURRENT id before the file moves —
                    // a stale save would recreate a ghost at the old id. The
                    // derived register re-keys to the moved id afterwards (its
                    // content follows the live noteId), so no manual clear (R4).
                    val outcome = mutationGate.runEditorMutation {
                        saveJob?.cancel()
                        // Snapshot before the suspending write; advance savedContent to
                        // the snapshot, not live `content`, so a keystroke typed during
                        // the write stays dirty in the register and survives a later
                        // background flush (PKT-12 F1 — same as the rename path).
                        val flushed = content
                        if (flushed != savedContent) {
                            val writeOutcome = store.write(noteId, flushed)
                            savedContent =
                                confirmedSavedContent(savedContent, flushed, writeOutcome)
                            if (writeOutcome === NoteMutationOutcome.Failed) {
                                Toast.makeText(
                                    context,
                                    "Couldn't save note. Your changes are still pending.",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                return@runEditorMutation NoteMutationOutcome.Failed
                            }
                        }
                        val moveOutcome = store.moveNote(
                            noteId,
                            folder,
                            createFolder = isNew,
                        )
                        if (moveOutcome is NoteMutationOutcome.Committed) {
                            // Update the live id before releasing the gate. A delete
                            // already waiting behind this move must target the final id.
                            noteId = moveOutcome.value
                        }
                        moveOutcome
                    } ?: return@launch
                    when (outcome) {
                        is NoteMutationOutcome.Committed -> {
                            showMoveSheet = false
                            Toast.makeText(
                                context,
                                "Moved to ${folder.ifEmpty { "Root" }}",
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                        NoteMutationOutcome.Failed -> Toast.makeText(
                            context,
                            "Couldn't move note. It remains in its current folder.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            },
        )
    }
}
