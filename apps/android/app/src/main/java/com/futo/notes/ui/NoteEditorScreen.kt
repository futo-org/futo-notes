package com.futo.notes.ui

import android.content.Intent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.ui.theme.FutoType
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId

@OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)
@Composable
fun NoteEditorScreen(
    store: NotesStore,
    initialNoteId: String,
    autoFocus: Boolean,
    darkTheme: Boolean,
    onBack: () -> Unit,
) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var noteId by remember(initialNoteId) { mutableStateOf(initialNoteId) }
    var title by remember(initialNoteId) { mutableStateOf(splitId(initialNoteId).title) }
    // CRITICAL: never block the editor's first frame on a disk read. Start empty
    // and load the note body off the main thread; the WebView mounts immediately
    // and receives the content reactively once the read lands.
    var content by remember(initialNoteId) { mutableStateOf("") }
    var savedContent by remember(initialNoteId) { mutableStateOf("") }
    var loaded by remember(initialNoteId) { mutableStateOf(false) }
    var saveJob by remember { mutableStateOf<Job?>(null) }
    val theme = if (darkTheme) "dark" else "light"
    val wordCount = remember(content) { content.split(Regex("\\s+")).count { it.isNotBlank() } }

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

    // Live-sync refresh for the OPEN note. A live pull rewrites the file and
    // reloads the store; without this, the open editor keeps showing (and on
    // exit, SAVES BACK) a stale base — silently clobbering the remote edit.
    // Adopt the on-disk content only when the local draft is clean; a dirty
    // draft still wins. Mirrors the iOS NoteEditorView behavior.
    LaunchedEffect(initialNoteId) {
        snapshotFlow { store.notes }.collect {
            if (content == savedContent && store.exists(noteId)) {
                val disk = store.read(noteId)
                if (disk != savedContent) {
                    content = disk
                    savedContent = disk
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
                noteId = store.rename(noteId, makeId(parts.folder, clean))
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
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text("Delete note") },
                            leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = c.danger) },
                            onClick = {
                                menu = false
                                saveJob?.cancel()
                                // `delete` is suspend (FFI on IO); fire it on the
                                // store's scope so the file removal can't block the
                                // UI thread, then pop back immediately.
                                scope.launch { store.delete(noteId) }
                                onBack()
                            },
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.surface),
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().imePadding()) {
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
            Spacer(Modifier.size(4.dp))
            Text(
                text = "$wordCount words",
                style = FutoType.caption,
                color = c.textMuted,
                modifier = Modifier.padding(horizontal = 22.dp),
            )
            Spacer(Modifier.size(8.dp))

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                EditorWebView(
                    content = content,
                    theme = theme,
                    autoFocus = false,
                    modifier = Modifier.fillMaxSize(),
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
        }
    }
}
