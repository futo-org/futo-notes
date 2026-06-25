package com.futo.notes

import android.app.Activity
import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.futo.notes.ui.CrashReportDialog
import com.futo.notes.ui.EditorHost
import com.futo.notes.ui.NoteEditorScreen
import com.futo.notes.ui.NoteListScreen
import com.futo.notes.ui.SearchScreen
import com.futo.notes.ui.SettingsScreen
import com.futo.notes.ui.SyncScreen
import com.futo.notes.ui.ThemeMode
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.ui.theme.FutoMotion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.SearchEngine
import java.io.File

/**
 * Process-wide search-engine singleton [search.md:60]. The engine owns
 * Tantivy's exclusive IndexWriter lock on the index directory, so it must be
 * created at most once per process — Activity recreation re-runs onCreate in
 * the same process and a second `SearchEngine(...)` fails with LockBusy.
 */
object SearchEngineHolder {
    @Volatile private var engine: SearchEngine? = null

    fun get(notesRoot: String, indexDir: String): SearchEngine? {
        engine?.let { return it }
        synchronized(this) {
            engine?.let { return it }
            return runCatching { SearchEngine(notesRoot, indexDir) }
                .onFailure { android.util.Log.e("FutoSearch", "search engine init failed", it) }
                .getOrNull()
                ?.also { engine = it }
        }
    }
}

/** A screen in the manual nav stack. Note ids/folders contain `/`, which would
 *  break Navigation-Compose string routes, so the stack holds typed entries. */
sealed interface Screen {
    data object List : Screen
    data class Editor(val noteId: String, val autoFocus: Boolean) : Screen
    data object Search : Screen
    data object Settings : Screen
    data object Sync : Screen
}

class MainActivity : ComponentActivity() {
    // Hoisted so onStart/onStop can pause/resume the SSE live stream — the
    // stream shouldn't stay open while backgrounded; re-foregrounding gets a
    // fresh `ready` that drives a catch-up pull.
    private lateinit var sync: SyncManager

    // Native image pickers for the editor's pickImage bridge message — must
    // register their ActivityResult contracts during onCreate.
    private lateinit var imagePicker: ImagePicker

    // Crash logs found by the startup scan, surfaced as the crash dialog.
    // Compose state so setContent reacts when the off-main scan lands.
    private val pendingCrashJson = mutableStateOf<String?>(null)

    override fun onStart() {
        super.onStart()
        if (::sync.isInitialized) sync.resumeLiveAsync()
    }

    override fun onStop() {
        super.onStop()
        if (::sync.isInitialized) sync.pauseLive()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Regression guard for F12/F13 (never gate render on disk I/O; no
        // blocking FFI on the main thread). StrictMode flags any disk read/write
        // that lands on the main thread on the hot paths — if the note scan or a
        // CRUD FFI call ever slips back onto the UI thread it shows up in logcat
        // (tag "StrictMode"). Debug-only; release builds keep the default policy.
        if (BuildConfig.DEBUG) {
            android.os.StrictMode.setThreadPolicy(
                android.os.StrictMode.ThreadPolicy.Builder()
                    .detectDiskReads()
                    .detectDiskWrites()
                    .penaltyLog()
                    .build()
            )
            android.util.Log.i("FutoStartup", "onCreate begin (pre-scan)")
        }

        super.onCreate(savedInstanceState)

        // Edge-to-edge; Compose Scaffold/TopAppBar handle the system-bar insets.
        // Transparent bars so the Compose background shows (not the leftover
        // Material manifest theme's primary color).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT

        // Vault under app-private storage: /data/data/com.futo.notes/files/futo-notes.
        // `filesDir` and `getSharedPreferences` each do a one-time framework disk
        // stat to resolve/seed the app's private dirs. These are NOT note-domain
        // hot paths (the scan + CRUD FFI calls all run off-main, see NotesStore);
        // they're unavoidable cold-start path resolution that every Android app
        // pays once. Permit them inside a narrow window so the debug StrictMode
        // policy below stays a clean, meaningful tripwire for note I/O that ever
        // slips back onto the UI thread, without false-positive startup noise.
        val (notesRoot, prefs) = android.os.StrictMode.allowThreadDiskReads().let { saved ->
            try {
                File(filesDir, "futo-notes") to getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
            } finally {
                android.os.StrictMode.setThreadPolicy(saved)
            }
        }

        // Crash pipeline [app.md:61]: persist uncaught exceptions to
        // <vault>/.crashlogs on the way down (then chain to the platform
        // handler); the scan below offers them for upload NEXT launch.
        CrashReporter.install(notesRoot, BuildConfig.VERSION_NAME)

        val store = NotesStore(notesRoot)
        sync = SyncManager(SecureStore(prefs), prefs)
        // Refresh the note list when a live pull brings in remote changes (sync +
        // note store are separate objects). Mirrors the iOS FutoNotesApp wiring.
        // A pull rewrites arbitrary files on disk, so the search engine gets a
        // full rescan alongside the list reload [search.md:60].
        sync.onLivePull = { store.reloadAsync(); store.engineRescanAsync() }
        // Auto-push local edits: every NotesStore mutation signals the live loop,
        // which debounces and pushes to peers (no-op when not connected).
        store.onLocalChange = { sync.noteChanged() }
        imagePicker = ImagePicker(this)

        // Silent sync-session restore [sync.md:91] — off-main, fire-and-forget,
        // never gates render. No-op when no password is stored.
        sync.restoreSession(store.rootPath)

        // BM25 search engine. Opening/building the Tantivy index
        // does disk I/O, so construction runs off-main; SearchScreen falls back
        // to substring filtering until `store.engine` lands. Process-singleton:
        // the engine holds Tantivy's exclusive IndexWriter lock, so a second
        // construction in the same process (Activity recreation) fails LockBusy.
        lifecycleScope.launch(Dispatchers.IO) {
            SearchEngineHolder.get(store.rootPath, File(filesDir, "search").absolutePath)
                ?.let { engine -> withContext(Dispatchers.Main) { store.engine = engine } }
        }

        // Crash-log scan [settings.md:43] — backgrounded, never gates render.
        // Mirrors desktop initCrashReporting (App.svelte): reporting disabled →
        // leave files alone; always-send → upload + delete silently; otherwise
        // surface the dialog.
        lifecycleScope.launch(Dispatchers.IO) {
            val pending = CrashReporter.pending(notesRoot)
            if (pending.isEmpty()) return@launch
            if (!prefs.getBoolean(Prefs.CRASH_ENABLED, true)) return@launch
            if (prefs.getBoolean(Prefs.CRASH_ALWAYS_SEND, false)) {
                CrashReporter.sendAll(notesRoot, null)
            } else {
                val json = pending.joinToString("\n\n") { f ->
                    runCatching { f.readText() }.getOrDefault("")
                }.trim()
                if (json.isNotEmpty()) {
                    withContext(Dispatchers.Main) { pendingCrashJson.value = json }
                }
            }
        }

        // Pre-warm the editor WebView (Chromium renderer + ~2 MB bundle parse +
        // CodeMirror mount) while the list screen is up, so opening a note is a
        // setContent call rather than a cold boot. See EditorHost.
        EditorHost.prewarm(this)

        setContent {
            if (BuildConfig.DEBUG) {
                LaunchedEffect(Unit) { android.util.Log.i("FutoStartup", "first composition reached") }
            }
            var themeMode by remember {
                mutableStateOf(runCatching { ThemeMode.valueOf(prefs.getString(Prefs.THEME, "AUTO")!!) }.getOrDefault(ThemeMode.AUTO))
            }
            val dark = when (themeMode) {
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
                ThemeMode.AUTO -> isSystemInDarkTheme()
            }

            FutoNotesTheme(darkTheme = dark) {
                SystemBarAppearance(dark)
                Surface(modifier = Modifier.fillMaxSize()) {
                    val stack = remember { mutableStateListOf<Screen>(Screen.List) }
                    fun push(s: Screen) = stack.add(s)
                    fun pop() { if (stack.size > 1) stack.removeAt(stack.lastIndex) }

                    // List scroll position survives navigation [list.md:26]: the
                    // list's LazyListState is owned HERE, not in NoteListScreen —
                    // pushing the editor (or Search/Settings) takes the list out
                    // of composition, and a screen-local rememberLazyListState
                    // would be recreated at the top on pop.
                    val listState = rememberLazyListState()

                    BackHandler(enabled = stack.size > 1) { pop() }

                    AnimatedContent(
                        targetState = stack.last(),
                        transitionSpec = {
                            val forward = targetState !is Screen.List
                            val fadeS = tween<Float>(FutoMotion.Base, easing = FutoMotion.EaseSoft)
                            val slideS = tween<androidx.compose.ui.unit.IntOffset>(FutoMotion.Base, easing = FutoMotion.EaseSoft)
                            if (forward) {
                                (slideInHorizontally(slideS) { it / 6 } + fadeIn(fadeS)) togetherWith fadeOut(fadeS)
                            } else {
                                fadeIn(fadeS) togetherWith (slideOutHorizontally(slideS) { it / 6 } + fadeOut(fadeS))
                            }
                        },
                        label = "route",
                    ) { top ->
                        when (top) {
                            is Screen.List -> NoteListScreen(
                                store = store,
                                listState = listState,
                                onOpenNote = { push(Screen.Editor(it, autoFocus = false)) },
                                onCreate = { id -> push(Screen.Editor(id, autoFocus = true)) },
                                onOpenSearch = { push(Screen.Search) },
                                onOpenSettings = { push(Screen.Settings) },
                            )
                            is Screen.Editor -> NoteEditorScreen(
                                store = store,
                                initialNoteId = top.noteId,
                                autoFocus = top.autoFocus,
                                darkTheme = dark,
                                onBack = { pop() },
                                // Wikilink tap [editor.md:77]: REPLACE the current
                                // editor entry (pop + push) so Back returns to the
                                // list, not a chain of editors.
                                onOpenNote = { id ->
                                    stack[stack.lastIndex] = Screen.Editor(id, autoFocus = false)
                                },
                                imagePicker = imagePicker,
                            )
                            is Screen.Search -> SearchScreen(
                                store = store,
                                onOpenNote = { push(Screen.Editor(it, autoFocus = false)) },
                                onBack = { pop() },
                            )
                            is Screen.Settings -> SettingsScreen(
                                store = store,
                                sync = sync,
                                themeMode = themeMode,
                                onThemeMode = {
                                    themeMode = it
                                    prefs.edit().putString(Prefs.THEME, it.name).apply()
                                },
                                onOpenSync = { push(Screen.Sync) },
                                onBack = { pop() },
                            )
                            is Screen.Sync -> SyncScreen(store = store, sync = sync, onBack = { pop() })
                        }
                    }

                    // Crash Report dialog [app.md:61]: shown when the startup
                    // scan found reports and always-send is off. "Don't Send"
                    // is the desktop-parity permanent opt-out.
                    pendingCrashJson.value?.let { json ->
                        CrashReportDialog(
                            reportJson = json,
                            onSend = { userNote, alwaysSend ->
                                pendingCrashJson.value = null
                                if (alwaysSend) prefs.edit().putBoolean(Prefs.CRASH_ALWAYS_SEND, true).apply()
                                lifecycleScope.launch(Dispatchers.IO) {
                                    CrashReporter.sendAll(notesRoot, userNote)
                                }
                            },
                            onDontSend = {
                                pendingCrashJson.value = null
                                prefs.edit().putBoolean(Prefs.CRASH_ENABLED, false).apply()
                                lifecycleScope.launch(Dispatchers.IO) {
                                    CrashReporter.discardAll(notesRoot)
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SystemBarAppearance(dark: Boolean) {
    val view = LocalView.current
    LaunchedEffect(dark) {
        val window = (view.context as Activity).window
        val controller = WindowCompat.getInsetsController(window, view)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }
}
