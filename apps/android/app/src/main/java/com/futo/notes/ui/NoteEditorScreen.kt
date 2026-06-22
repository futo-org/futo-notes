package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.futo.notes.ImagePicker
import com.futo.notes.NotesStore
import com.futo.notes.saveImageDataIntoVault
import com.futo.notes.saveImageIntoVault
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
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
    val scope = rememberCoroutineScope()
    // The shared pre-warmed editor host — needed directly (beyond the
    // EditorWebView props) for the bridge-v2 imperative calls:
    // applyExternalContent (sync adopt) and insertImage (picker round-trip).
    val host = remember { EditorHost.get(context) }

    var noteId by remember(initialNoteId) { mutableStateOf(initialNoteId) }
    var title by remember(initialNoteId) { mutableStateOf(splitId(initialNoteId).title) }
    // CRITICAL: never block the editor's first frame on a disk read. Start empty
    // and load the note body off the main thread; the WebView mounts immediately
    // and receives the content reactively once the read lands.
    var content by remember(initialNoteId) { mutableStateOf("") }
    var savedContent by remember(initialNoteId) { mutableStateOf("") }
    var loaded by remember(initialNoteId) { mutableStateOf(false) }
    var saveJob by remember { mutableStateOf<Job?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showMoveSheet by remember { mutableStateOf(false) }
    val theme = if (darkTheme) "dark" else "light"

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

    // Flush a pending save when leaving (only if loaded + changed). The exists
    // check and write run off the main thread on the store's scope, which
    // outlives this composable — a composable's onDispose can't suspend.
    DisposableEffect(noteId) {
        onDispose {
            saveJob?.cancel()
            if (loaded && content != savedContent) store.flushAsync(noteId, content)
        }
    }

    // Live-sync refresh for the OPEN note [sync.md:239]. A live pull rewrites
    // the file and reloads the store; without this, the open editor keeps
    // showing (and on exit, SAVES BACK) a stale base. Clean drafts adopt the
    // remote content in place via applyExternalContent (selection/scroll
    // preserved, history suppressed); a dirty draft against a REAL remote
    // change is parked as a conflict copy first — neither side's edit is lost.
    LaunchedEffect(initialNoteId) {
        snapshotFlow { store.notes }.collect {
            if (!loaded || !store.exists(noteId)) return@collect
            val disk = store.read(noteId)
            when {
                content == savedContent -> {
                    if (disk != savedContent) {
                        host.applyExternalContent(disk)
                        content = disk
                        savedContent = disk
                    }
                }
                disk == content -> {
                    // Our own save echoed back through the rescan — mark clean.
                    savedContent = disk
                }
                disk != savedContent -> {
                    // Dirty draft + a real remote change: cancel the pending
                    // save, park the draft as a conflict copy (Rust uniques the
                    // title), then adopt the remote content.
                    saveJob?.cancel()
                    val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
                    val parts = splitId(noteId)
                    store.createNote("${parts.title} (conflict $date)", parts.folder)?.let { copyId ->
                        store.write(copyId, content)
                    }
                    host.applyExternalContent(disk)
                    content = disk
                    savedContent = disk
                    Toast.makeText(context, "Conflicting edits saved to a copy", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // Debounced rename (500 ms) — the filename IS the title; Rust resolves
    // collisions and returns the final id.
    LaunchedEffect(initialNoteId) {
        snapshotFlow { title }.debounce(500).collectLatest { next ->
            val parts = splitId(noteId)
            val clean = sanitizeTitle(next.trim())
            if (clean.isNotEmpty() && clean != parts.title) {
                // Flush any pending body edit to the CURRENT id and cancel the
                // in-flight save before the file moves — otherwise a stale save
                // would recreate a ghost note at the old id (data loss).
                saveJob?.cancel()
                if (content != savedContent) { store.write(noteId, content); savedContent = content }
                val oldId = noteId
                noteId = store.rename(noteId, makeId(parts.folder, clean))
                // Repoint every wikilink at the renamed note [editor.md:88] —
                // fire-and-forget on the store's scope (vault-wide rewrite).
                if (noteId != oldId) store.relink(oldId, noteId)
            }
        }
    }

    // Picker round-trip [editor.md:121+130]: native pick → copy into the vault
    // root (IMAGE_EXTENSIONS only) → insertImage back into the editor. Shared
    // by the native toolbar's camera/image items and the bridge `pickImage`
    // message (kept for older bundles).
    val pickImage: (String) -> Unit = { source ->
        val handle: (Uri?) -> Unit = { uri ->
            if (uri != null) {
                scope.launch {
                    val name = withContext(Dispatchers.IO) {
                        saveImageIntoVault(context.contentResolver, File(store.rootPath), uri)
                    }
                    if (name != null) {
                        host.insertImage(name)
                    } else {
                        Toast.makeText(context, "Unsupported image type", Toast.LENGTH_SHORT).show()
                    }
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
        scope.launch {
            val name = withContext(Dispatchers.IO) {
                runCatching {
                    val bytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)
                    saveImageDataIntoVault(File(store.rootPath), bytes, ext)
                }.getOrNull()
            }
            if (name != null) {
                host.insertImage(name)
            } else {
                Toast.makeText(context, "Couldn't paste image", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // New note → focus the title so the user can name it immediately.
    val titleFocus = remember { FocusRequester() }
    LaunchedEffect(initialNoteId) {
        if (autoFocus) { delay(250); runCatching { titleFocus.requestFocus() } }
    }

    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = c.textSecondary)
                    }
                },
                actions = {
                    IconButton(onClick = {
                        val share = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TITLE, title)
                            putExtra(Intent.EXTRA_TEXT, content)
                        }
                        context.startActivity(Intent.createChooser(share, "Share note"))
                    }) {
                        Icon(Icons.Filled.Share, contentDescription = "Share", tint = c.textSecondary)
                    }
                    var menu by remember { mutableStateOf(false) }
                    IconButton(onClick = { menu = true }) {
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
                value = title,
                onValueChange = { title = it.replace("\n", "") },
                singleLine = true,
                textStyle = FutoType.h3.copy(fontWeight = FontWeight.SemiBold, color = c.textPrimary),
                cursorBrush = SolidColor(c.accent),
                modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 4.dp).focusRequester(titleFocus),
                decorationBox = { inner ->
                    if (title.isEmpty()) {
                        Text("Untitled", style = FutoType.h3.copy(fontWeight = FontWeight.SemiBold), color = c.textMuted)
                    }
                    inner()
                },
            )
            Spacer(Modifier.size(8.dp))

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                EditorWebView(
                    content = content,
                    theme = theme,
                    autoFocus = false,
                    notesJson = notesJson,
                    // Local ![](image.png) resolves against the vault root
                    // [editor.md:121] (allowFileAccess stays on, see EditorHost).
                    imageBaseUrl = "file://${store.rootPath}/",
                    modifier = Modifier.fillMaxSize(),
                    onOpenNote = onOpenNote,
                    onPickImage = pickImage,
                    onSaveImageData = saveImageData,
                    onChange = { newContent ->
                        // Data-loss guard: ignore editor change events until the
                        // off-main initial read has landed (`loaded`). The WebView
                        // mounts with "" and can emit a setContent echo before the
                        // real body loads; saving that empty echo would clobber the
                        // note on disk. Once loaded, all edits flow through.
                        if (loaded) {
                            content = newContent
                            saveJob?.cancel()
                            saveJob = scope.launch {
                                delay(400)
                                // Re-read noteId at fire time so a save that lands
                                // after a rename writes to the renamed note, not the
                                // stale id.
                                store.write(noteId, newContent)
                                savedContent = newContent
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

    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete this note?",
            body = "This action cannot be undone.",
            confirmLabel = "Delete",
            onConfirm = {
                confirmDelete = false
                saveJob?.cancel()
                // Mark clean so the onDispose flush can't resurrect the note,
                // then fire the suspend delete on the composable scope (FFI on
                // IO) and pop back immediately.
                savedContent = content
                scope.launch { store.delete(noteId) }
                onBack()
            },
            onDismiss = { confirmDelete = false },
        )
    }

    if (showMoveSheet) {
        FolderPickerSheet(
            store = store,
            onDismiss = { showMoveSheet = false },
            onPick = { folder, isNew ->
                showMoveSheet = false
                scope.launch {
                    // Flush the draft to the CURRENT id before the file moves —
                    // a stale save would recreate a ghost at the old id.
                    saveJob?.cancel()
                    if (content != savedContent) { store.write(noteId, content); savedContent = content }
                    if (isNew) store.createFolder(folder)
                    val oldId = noteId
                    val moved = store.moveNote(noteId, folder)
                    if (moved != oldId) {
                        noteId = moved
                        store.relink(oldId, moved)
                    }
                    Toast.makeText(context, "Moved to ${folder.ifEmpty { "Root" }}", Toast.LENGTH_SHORT).show()
                }
            },
        )
    }
}
