package com.futo.notes

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
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
import com.futo.notes.ui.components.ClearFocusOnImeDismiss
import com.futo.notes.ui.NoteEditorScreen
import com.futo.notes.ui.NoteListScreen
import com.futo.notes.ui.isAtListTop
import com.futo.notes.ui.SearchScreen
import com.futo.notes.ui.SettingsScreen
import com.futo.notes.ui.StorageOnboarding
import com.futo.notes.ui.StorageRegrantScreen
import com.futo.notes.ui.SyncScreen
import com.futo.notes.ui.ThemeMode
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.ui.theme.FutoMotion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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

    // Vault wiring is DEFERRED until the storage location is known [app.md].
    // `store` is null while the first-run picker / lost-permission screen is up;
    // setContent shows the shell only once initVault has run. Resolved early in
    // onCreate (no disk on the main thread — see initVault).
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var notesRoot: File
    private val store = mutableStateOf<NotesStore?>(null)
    private val showOnboarding = mutableStateOf(false)
    private val showRegrant = mutableStateOf(false)
    private val showStoragePicker = mutableStateOf(false)

    // The All-files-access settings screen returns no result code, so we
    // re-check the actual permission state on return and run the continuation.
    private var pendingDeviceAction: (() -> Unit)? = null
    private lateinit var allFilesLauncher: ActivityResultLauncher<Intent>

    override fun onStart() {
        super.onStart()
        if (::sync.isInitialized) sync.resumeLiveAsync()
    }

    override fun onPause() {
        super.onPause()
        // Flush the open editor's pending edit at the FIRST leave-foreground
        // signal (onPause always precedes onStop) — an edit caught inside the
        // 400 ms autosave debounce would otherwise be lost if the OS kills the
        // backgrounded process or the user swipes the app away. F8 jetsam-guard
        // parity with iOS FutoNotesApp scenePhase `.inactive`. Idempotent and a
        // no-op when the draft is clean; the write is fire-and-forget so it never
        // blocks the main thread. `store` is null while the first-run picker is up.
        store.value?.flushPendingEditor()
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
        // enableEdgeToEdge() (androidx.activity) is the non-deprecated path: on
        // API 35 it draws bar scrims via an overlay instead of the now-deprecated
        // Window.setStatusBarColor/setNavigationBarColor (which Play flags and
        // which are no-ops under Android 15's forced edge-to-edge). SystemBarAppearance
        // below still owns light/dark icon contrast, reactive to the app theme.
        // Requires androidx.activity >= 1.12 — earlier versions call the deprecated
        // setters internally, so the Play warning would persist (see build.gradle.kts).
        enableEdgeToEdge()

        // `getSharedPreferences` + the internal-vault stat each do a one-time
        // framework disk read to resolve the app's private dirs. Not note-domain
        // hot paths (scan + CRUD FFI run off-main, see NotesStore); they're
        // unavoidable cold-start resolution. Permit them inside a narrow window so
        // the debug StrictMode policy stays a clean tripwire for note I/O that
        // slips onto the UI thread.
        val startup = android.os.StrictMode.allowThreadDiskReads().let { saved ->
            try {
                prefs = getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
                NotesStorage.decideStartup(
                    savedMode = prefs.getString(Prefs.STORAGE_MODE, null),
                    internalVaultExists = NotesStorage.looksLikeExistingVault(NotesStorage.internalRoot(this)),
                    deviceModeSupported = NotesStorage.deviceModeSupported(),
                )
            } finally {
                android.os.StrictMode.setThreadPolicy(saved)
            }
        }

        // Re-check the All-files grant when we return from the system settings
        // screen, then run whatever device-storage action was pending.
        allFilesLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val action = pendingDeviceAction
            pendingDeviceAction = null
            if (NotesStorage.hasDeviceAccess()) {
                action?.invoke()
            } else {
                Toast.makeText(
                    this,
                    "FUTO Notes needs “All files access” to use a shared folder.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }

        imagePicker = ImagePicker(this)

        // Pre-warm the editor WebView (Chromium renderer + ~2 MB bundle parse +
        // CodeMirror mount) while the list screen is up, so opening a note is a
        // setContent call rather than a cold boot. See EditorHost.
        EditorHost.prewarm(this)

        // Resolve where the vault lives. A known location boots straight into the
        // shell; a fresh install shows the picker; a DEVICE vault whose permission
        // was revoked shows the re-grant screen instead of an empty vault.
        if (startup.needsOnboarding) {
            showOnboarding.value = true
        } else {
            val mode = startup.mode!!
            // Pin the derived mode (grandfathered INTERNAL / pre-11 APP) so later
            // launches resolve deterministically without re-detecting.
            prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).apply()
            if (mode == StorageMode.DEVICE && !NotesStorage.hasDeviceAccess()) {
                showRegrant.value = true
            } else {
                initVault(NotesStorage.rootFor(this, mode, BuildConfig.DEBUG))
            }
        }

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
                // App-wide: back-gesture keyboard dismissal must drop the
                // focused field's caret (#24) — native fields via clearFocus,
                // the editor WebView's DOM caret via a bridge blur (it
                // survives clearFocus). Dialog windows install their own.
                val editorHost = remember { EditorHost.get(this) }
                ClearFocusOnImeDismiss {
                    if (editorHost.editorFocused) editorHost.blur()
                }
                Surface(modifier = Modifier.fillMaxSize()) {
                    val s = store.value
                    when {
                        s == null && showRegrant.value -> StorageRegrantScreen(
                            onGrant = { requestDeviceAccess { showRegrant.value = false; initVault(NotesStorage.deviceRoot(BuildConfig.DEBUG)) } },
                            onUseAppStorage = {
                                // commit() — restartApp() kills the process before an
                                // async apply() would flush (see performSwitch).
                                prefs.edit().putString(Prefs.STORAGE_MODE, StorageMode.APP.name).commit()
                                restartApp()
                            },
                        )
                        s == null -> StorageOnboarding(
                            initialMode = StorageMode.DEVICE,
                            deviceModeSupported = NotesStorage.deviceModeSupported(),
                            onConfirm = { chooseStorage(it) },
                        )
                        else -> AppShell(s, themeMode, onThemeMode = {
                            themeMode = it
                            prefs.edit().putString(Prefs.THEME, it.name).apply()
                        }, dark = dark)
                    }
                }
            }
        }
    }

    /** The normal app once the vault location is known. */
    @Composable
    private fun AppShell(
        s: NotesStore,
        themeMode: ThemeMode,
        onThemeMode: (ThemeMode) -> Unit,
        dark: Boolean,
    ) {
        val stack = remember { mutableStateListOf<Screen>(Screen.List) }

        // Hoist list state above the screen composition so navigation preserves
        // its scroll position [list.md:59].
        val listState = rememberLazyListState()

        fun push(screen: Screen) = stack.add(screen)

        // Re-pin an at-top viewport after rank changes; otherwise key anchoring
        // can hide rows inserted above it. Preserve deep scrolls [list.md:41,59].
        // requestScrollToItem applies the snap during the next measure.
        fun pop() {
            if (stack.size <= 1) return
            stack.removeAt(stack.lastIndex)
            if (stack.last() is Screen.List) {
                val atTop = isAtListTop(
                    listState.firstVisibleItemIndex,
                    listState.firstVisibleItemScrollOffset,
                )
                if (atTop) listState.requestScrollToItem(0)
            }
        }

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
                    store = s,
                    listState = listState,
                    onOpenNote = { push(Screen.Editor(it, autoFocus = false)) },
                    onCreate = { id -> push(Screen.Editor(id, autoFocus = true)) },
                    onOpenSearch = { push(Screen.Search) },
                    onOpenSettings = { push(Screen.Settings) },
                )
                is Screen.Editor -> NoteEditorScreen(
                    store = s,
                    initialNoteId = top.noteId,
                    autoFocus = top.autoFocus,
                    darkTheme = dark,
                    onBack = { pop() },
                    // Wikilink tap [editor.md:77]: PUSH a new editor entry so Back
                    // returns to the note you came FROM (not straight to the list).
                    // Only the top screen is composed (AnimatedContent(stack.last())),
                    // so the shared editor WebView still binds exactly one note at a
                    // time even as the stack of visited notes grows. Skip a self-link
                    // (a wikilink to the note you're already on) so Back isn't a no-op.
                    onOpenNote = { id ->
                        if (id != top.noteId) push(Screen.Editor(id, autoFocus = false))
                    },
                    imagePicker = imagePicker,
                )
                is Screen.Search -> SearchScreen(
                    store = s,
                    onOpenNote = { push(Screen.Editor(it, autoFocus = false)) },
                    onBack = { pop() },
                )
                is Screen.Settings -> SettingsScreen(
                    store = s,
                    sync = sync,
                    themeMode = themeMode,
                    onThemeMode = onThemeMode,
                    onOpenSync = { push(Screen.Sync) },
                    storageMode = currentMode(),
                    onChangeStorage = { showStoragePicker.value = true },
                    onBack = { pop() },
                )
                is Screen.Sync -> SyncScreen(store = s, sync = sync, onBack = { pop() })
            }
        }

        // Crash Report dialog [app.md:61]: shown when the startup scan found
        // reports and always-send is off. "Don't Send" is the desktop-parity
        // permanent opt-out.
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

        // Change-storage overlay (Settings → Storage location). Migrates + restarts.
        if (showStoragePicker.value) {
            StorageOnboarding(
                initialMode = currentMode(),
                deviceModeSupported = NotesStorage.deviceModeSupported(),
                onConfirm = { performStorageChange(it) },
                onCancel = { showStoragePicker.value = false },
            )
        }
    }

    /**
     * Build the vault-dependent objects for [root] — mirrors what onCreate used
     * to do inline. Touches no disk on the main thread: `NotesStore` is lazy +
     * scans off-main, and search/crash scans run on IO. Makes `store` non-null,
     * which flips setContent from the picker to the shell.
     */
    private fun initVault(root: File) {
        notesRoot = root

        // Crash pipeline [app.md:61]: persist uncaught exceptions to
        // <vault>/.crashlogs on the way down (then chain to the platform handler);
        // the scan below offers them for upload.
        CrashReporter.install(root, BuildConfig.VERSION_NAME)

        val s = NotesStore(root, File(filesDir, "search"))
        sync = SyncManager(SecureStore(prefs), prefs)
        // Sync writes bypass local mutations, so reconcile the store-owned
        // index and project one fresh snapshot.
        sync.onLivePull = { s.liveDataChanged() }
        // Auto-push local edits: every NotesStore mutation signals the live loop,
        // which debounces and pushes to peers (no-op when not connected).
        s.onLocalChange = { sync.noteChanged() }

        // Silent sync-session restore [sync.md:91] — off-main, fire-and-forget,
        // never gates render. No-op when no password is stored.
        sync.restoreSession(s.rootPath)

        // Crash-log scan [settings.md:43] — backgrounded, never gates render.
        lifecycleScope.launch(Dispatchers.IO) {
            val pending = CrashReporter.pending(root)
            if (pending.isEmpty()) return@launch
            if (!prefs.getBoolean(Prefs.CRASH_ENABLED, true)) return@launch
            if (prefs.getBoolean(Prefs.CRASH_ALWAYS_SEND, false)) {
                CrashReporter.sendAll(root, null)
            } else {
                val json = pending.joinToString("\n\n") { f ->
                    runCatching { f.readText() }.getOrDefault("")
                }.trim()
                if (json.isNotEmpty()) {
                    withContext(Dispatchers.Main) { pendingCrashJson.value = json }
                }
            }
        }

        store.value = s
    }

    // ── Storage-mode flows ──

    private fun currentMode(): StorageMode =
        runCatching { StorageMode.valueOf(prefs.getString(Prefs.STORAGE_MODE, null) ?: "") }
            .getOrDefault(StorageMode.APP)

    /** First-run picker confirm: DEVICE goes through the permission grant first. */
    private fun chooseStorage(mode: StorageMode) {
        if (mode == StorageMode.DEVICE) requestDeviceAccess { finalizeFreshChoice(StorageMode.DEVICE) }
        else finalizeFreshChoice(mode)
    }

    private fun finalizeFreshChoice(mode: StorageMode) {
        prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).apply()
        showOnboarding.value = false
        initVault(NotesStorage.rootFor(this, mode, BuildConfig.DEBUG))
    }

    /** Settings change-location confirm: migrate the vault, then relaunch. */
    private fun performStorageChange(mode: StorageMode) {
        showStoragePicker.value = false
        if (mode == currentMode()) return
        if (mode == StorageMode.DEVICE && !NotesStorage.deviceModeSupported()) {
            Toast.makeText(this, "Device storage requires Android 11 or newer.", Toast.LENGTH_LONG).show()
            return
        }
        if (mode == StorageMode.DEVICE) requestDeviceAccess { performSwitch(StorageMode.DEVICE) }
        else performSwitch(mode)
    }

    private fun performSwitch(newMode: StorageMode) {
        val current = store.value ?: return
        val from = File(current.rootPath)
        val to = NotesStorage.rootFor(this, newMode, BuildConfig.DEBUG)
        lifecycleScope.launch(Dispatchers.IO) {
            NotesStorage.migrate(from, to)
            // commit() (synchronous) — NOT apply(): restartApp() kills the process
            // immediately, and an async apply() write would be lost before it
            // flushes, stranding the app back in the old mode + re-seeding.
            prefs.edit().putString(Prefs.STORAGE_MODE, newMode.name).commit()
            // A vault move changes the path captured by the process-singleton
            // search engine + sync client, so relaunch the process to rebuild
            // them cleanly (desktop's "the app will restart" parity).
            withContext(Dispatchers.Main) { restartApp() }
        }
    }

    /**
     * Request the "All files access" special permission (Android 11+). The
     * settings screen returns no result code, so [allFilesLauncher]'s callback
     * re-checks [NotesStorage.hasDeviceAccess] and runs [onGranted].
     */
    private fun requestDeviceAccess(onGranted: () -> Unit) {
        if (!NotesStorage.deviceModeSupported()) {
            Toast.makeText(this, "Device storage requires Android 11 or newer.", Toast.LENGTH_LONG).show()
            return
        }
        if (NotesStorage.hasDeviceAccess()) { onGranted(); return }
        pendingDeviceAction = onGranted
        val perApp = Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.fromParts("package", packageName, null),
        )
        runCatching { allFilesLauncher.launch(perApp) }.onFailure {
            // Some OEMs lack the per-app deep link — fall back to the global list.
            runCatching { allFilesLauncher.launch(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
        }
    }

    private fun restartApp() {
        packageManager.getLaunchIntentForPackage(packageName)?.let {
            it.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(it)
        }
        Runtime.getRuntime().exit(0)
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
