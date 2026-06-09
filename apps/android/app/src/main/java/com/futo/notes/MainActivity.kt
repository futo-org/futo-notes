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
import com.futo.notes.ui.EditorHost
import com.futo.notes.ui.NoteEditorScreen
import com.futo.notes.ui.NoteListScreen
import com.futo.notes.ui.SearchScreen
import com.futo.notes.ui.SettingsScreen
import com.futo.notes.ui.SyncScreen
import com.futo.notes.ui.ThemeMode
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.ui.theme.FutoMotion
import java.io.File

/** A screen in the manual nav stack. Note ids/folders contain `/`, which would
 *  break Navigation-Compose string routes, so the stack holds typed entries. */
sealed interface Screen {
    data object List : Screen
    data class Editor(val noteId: String, val autoFocus: Boolean) : Screen
    data object Search : Screen
    data object Settings : Screen
    data object Sync : Screen
}

private const val PREFS = "futo_prefs"
private const val KEY_THEME = "theme_mode"

class MainActivity : ComponentActivity() {
    // Hoisted so onStart/onStop can pause/resume the SSE live stream — the
    // stream shouldn't stay open while backgrounded; re-foregrounding gets a
    // fresh `ready` that drives a catch-up pull.
    private lateinit var sync: SyncManager

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
                File(filesDir, "futo-notes") to getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            } finally {
                android.os.StrictMode.setThreadPolicy(saved)
            }
        }
        val store = NotesStore(notesRoot)
        sync = SyncManager()
        // Refresh the note list when a live pull brings in remote changes (sync +
        // note store are separate objects). Mirrors the iOS FutoNotesApp wiring.
        sync.onLivePull = { store.reloadAsync() }
        // Auto-push local edits: every NotesStore mutation signals the live loop,
        // which debounces and pushes to peers (no-op when not connected).
        store.onLocalChange = { sync.noteChanged() }

        // Pre-warm the editor WebView (Chromium renderer + ~2 MB bundle parse +
        // CodeMirror mount) while the list screen is up, so opening a note is a
        // setContent call rather than a cold boot. See EditorHost.
        EditorHost.prewarm(this)

        setContent {
            if (BuildConfig.DEBUG) {
                LaunchedEffect(Unit) { android.util.Log.i("FutoStartup", "first composition reached") }
            }
            var themeMode by remember {
                mutableStateOf(runCatching { ThemeMode.valueOf(prefs.getString(KEY_THEME, "AUTO")!!) }.getOrDefault(ThemeMode.AUTO))
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
                                    prefs.edit().putString(KEY_THEME, it.name).apply()
                                },
                                onOpenSync = { push(Screen.Sync) },
                                onBack = { pop() },
                            )
                            is Screen.Sync -> SyncScreen(store = store, sync = sync, onBack = { pop() })
                        }
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
