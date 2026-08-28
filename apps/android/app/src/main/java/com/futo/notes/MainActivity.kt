package com.futo.notes

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.futo.notes.ui.CrashReportDialog
import com.futo.notes.ui.EditorHost
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.PendingStorageMigration
import com.futo.notes.storage.StorageActivationOutcome
import com.futo.notes.storage.StorageAdoptionOutcome
import com.futo.notes.storage.StorageAdoptionSummary
import com.futo.notes.storage.StorageMigrationJournal
import com.futo.notes.storage.StorageMigrationPhase
import com.futo.notes.storage.StorageMode
import com.futo.notes.storage.StorageRecoveryFailure
import com.futo.notes.storage.StorageStartupRecovery
import com.futo.notes.storage.StorageSwitchPlan
import com.futo.notes.storage.StorageSwitchFailureStage
import com.futo.notes.storage.SYNC_CONNECTED_STORAGE_REFUSAL
import com.futo.notes.storage.activateStagedStorageMigration
import com.futo.notes.storage.adoptExistingVault
import com.futo.notes.storage.storageAdoptionMessage
import com.futo.notes.storage.recoverStorageStartup
import com.futo.notes.storage.storageRecoveryMessage
import com.futo.notes.storage.storageSwitchFailureMessage
import com.futo.notes.storage.storageSwitchFailureStage
import com.futo.notes.storage.storageSwitchPlan
import com.futo.notes.testhook.TestHooks
import com.futo.notes.ui.components.ClearFocusOnImeDismiss
import com.futo.notes.ui.components.imeTargetVisible
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.NoteEditorScreen
import com.futo.notes.ui.NoteListScreen
import com.futo.notes.ui.SearchScreen
import com.futo.notes.ui.SettingsScreen
import com.futo.notes.ui.StorageOnboarding
import com.futo.notes.ui.StorageRegrantScreen
import com.futo.notes.ui.SyncScreen
import com.futo.notes.ui.ThemeMode
import com.futo.notes.ui.navigation.AppNavigation
import com.futo.notes.ui.navigation.Screen
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.localization.ProvideLocalization
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

internal data class VaultSurfaceState(
    val renderShell: Boolean,
    val showMovingOverlay: Boolean,
)

internal fun vaultSurfaceState(
    hasStore: Boolean,
    needsRegrant: Boolean,
    storageSwitching: Boolean,
): VaultSurfaceState = VaultSurfaceState(
    renderShell = hasStore,
    showMovingOverlay = hasStore && storageSwitching && !needsRegrant,
)

/** A storage switch waiting on the user's confirmation to open an existing folder. */
private data class PendingStorageAdoption(
    val mode: StorageMode,
    val plan: StorageSwitchPlan.OpenExisting,
)

class MainActivity : ComponentActivity() {
    private lateinit var localization: Localization
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
    private lateinit var storageMigrationJournal: StorageMigrationJournal
    private lateinit var notesRoot: File
    private val store = mutableStateOf<NotesStore?>(null)
    private val showOnboarding = mutableStateOf(false)
    private val showRegrant = mutableStateOf(false)
    private val storageSwitching = mutableStateOf(false)
    private val storageResolving = mutableStateOf(true)
    private val storageRecoveryFailure = mutableStateOf<StorageRecoveryFailure?>(null)
    private val pendingStorageAdoption = mutableStateOf<PendingStorageAdoption?>(null)
    private val themeMode = mutableStateOf(ThemeMode.AUTO)

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

        // Construct the preferences handle synchronously, but do not read it
        // before the first composition. Theme and storage recovery load on IO
        // after setContent, preserving the never-gate-render invariant.
        prefs = getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)

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
                    localization.localizedText("storage.android.permission.denied"),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }

        imagePicker = ImagePicker(this) { localization }

        TestHooks.install(this, testHooks())

        setContent {
            ProvideLocalization {
                val currentLocalization = LocalLocalization.current
                SideEffect { localization = currentLocalization }
                if (BuildConfig.DEBUG) {
                    LaunchedEffect(Unit) {
                        android.util.Log.i("FutoStartup", "first composition reached")
                    }
                }
                LaunchedEffect(currentLocalization.effectiveLanguage.tag) {
                    EditorHost.prewarm(this@MainActivity)
                    EditorHost.get(this@MainActivity).setLocalization(currentLocalization)
                }
                val selectedTheme = themeMode.value
                val dark = when (selectedTheme) {
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
                    ClearFocusOnImeDismiss(imeTargetVisible()) {
                        val editorHost = EditorHost.get(this)
                        if (editorHost.editorFocused) editorHost.blur()
                    }
                    Surface(modifier = Modifier.fillMaxSize()) {
                        val s = store.value
                        val vaultSurface = vaultSurfaceState(
                            hasStore = s != null,
                            needsRegrant = showRegrant.value,
                            storageSwitching = storageSwitching.value,
                        )
                        val recoveryFailure = storageRecoveryFailure.value
                        when {
                            recoveryFailure != null -> Box(
                                contentAlignment = Alignment.Center,
                                modifier = Modifier.fillMaxSize(),
                            ) {
                                Text(
                                    storageRecoveryMessage(recoveryFailure).let {
                                        currentLocalization.localizedText(it.path, it.arguments)
                                    },
                                )
                            }
                            storageResolving.value -> Box(
                                contentAlignment = Alignment.Center,
                                modifier = Modifier.fillMaxSize(),
                            ) {
                                CircularProgressIndicator()
                            }
                            vaultSurface.renderShell -> Box(modifier = Modifier.fillMaxSize()) {
                                AppShell(s!!, selectedTheme, onThemeMode = {
                                    themeMode.value = it
                                    prefs.edit().putString(Prefs.THEME, it.name).apply()
                                }, dark = dark)
                                if (vaultSurface.showMovingOverlay) {
                                    // The tap swallow below has a Back twin: without
                                    // it Back reaches the shell underneath and pops
                                    // (or, at the list, finishes the activity) while
                                    // the vault is being moved.
                                    BackHandler {}
                                    Surface(
                                        modifier = Modifier
                                            .fillMaxSize()
                                            .clickable(onClick = {}),
                                    ) {
                                        Box(
                                            contentAlignment = Alignment.Center,
                                            modifier = Modifier.fillMaxSize(),
                                        ) {
                                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                                CircularProgressIndicator()
                                                Text(currentLocalization.localizedText("storage.android.movingNotes"))
                                            }
                                        }
                                    }
                                }
                            }
                            showRegrant.value -> StorageRegrantScreen(
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
                        }
                    }
                }
            }
        }

        lifecycleScope.launch {
            val recovered = withContext(Dispatchers.IO) {
                storageMigrationJournal =
                    StorageMigrationJournal(File(filesDir, ".storage-migration"))
                val storedTheme =
                    runCatching {
                        ThemeMode.valueOf(prefs.getString(Prefs.THEME, "AUTO")!!)
                    }.getOrDefault(ThemeMode.AUTO)
                storedTheme to recoverStorageStartup(
                    context = this@MainActivity,
                    preferences = prefs,
                    journal = storageMigrationJournal,
                    isDebug = BuildConfig.DEBUG,
                )
            }
            themeMode.value = recovered.first
            applyStorageStartup(recovered.second)
        }
    }

    private fun applyStorageStartup(recovery: StorageStartupRecovery) {
        storageRecoveryFailure.value = recovery.failure
        if (recovery.failure != null) android.util.Log.e("FutoStorage", "Storage recovery failed")
        val startup = recovery.startup
        if (startup == null) {
            storageResolving.value = false
            return
        }
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
        storageResolving.value = false
    }

    /** The normal app once the vault location is known. */
    @Composable
    private fun AppShell(
        s: NotesStore,
        themeMode: ThemeMode,
        onThemeMode: (ThemeMode) -> Unit,
        dark: Boolean,
    ) {
        AppNavigation(
            hasBootstrapped = s.hasBootstrapped,
            availableFolderPaths = s.folders,
        ) { screen, navigator, noteListState ->
            when (screen) {
                is Screen.Folder -> NoteListScreen(
                    store = s,
                    state = noteListState,
                    folder = screen.path,
                    onOpenNote = navigator::openNote,
                    onCreate = navigator::openCreatedNote,
                    onOpenFolder = navigator::openFolder,
                    onFolderMoved = navigator::followFolderMove,
                    onOpenSearch = navigator::openSearch,
                    onOpenSettings = navigator::openSettings,
                    onBack = navigator::goBack,
                )
                is Screen.Editor -> NoteEditorScreen(
                    store = s,
                    initialNoteId = screen.noteId,
                    autoFocus = screen.autoFocus,
                    darkTheme = dark,
                    onBack = navigator::goBack,
                    // Wikilink tap [editor.md:77]: PUSH a new editor entry so Back
                    // returns to the note you came FROM (not straight to the list).
                    onOpenNote = navigator::openNote,
                    imagePicker = imagePicker,
                )
                is Screen.Search -> SearchScreen(
                    store = s,
                    onOpenNote = navigator::openNote,
                    onBack = navigator::goBack,
                )
                is Screen.Settings -> SettingsScreen(
                    store = s,
                    sync = sync,
                    themeMode = themeMode,
                    onThemeMode = onThemeMode,
                    onOpenSync = navigator::openSync,
                    storageMode = currentMode(),
                    onChangeStorage = navigator::openStorageLocation,
                    onBack = navigator::goBack,
                )
                // Settings -> Storage location. A screen, not an overlay: Back and
                // Cancel are the same pop, and the Settings entry stays underneath
                // it (github#28). Confirming migrates + restarts.
                is Screen.StorageLocation -> StorageOnboarding(
                    initialMode = currentMode(),
                    deviceModeSupported = NotesStorage.deviceModeSupported(),
                    onConfirm = {
                        navigator.goBack()
                        performStorageChange(it)
                    },
                    onCancel = navigator::goBack,
                )
                is Screen.Sync -> SyncScreen(
                    store = s,
                    sync = sync,
                    onBack = navigator::goBack,
                )
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

        // The target folder already has notes, so the switch opens it instead of
        // copying. Both folders are named with what they hold so the user can
        // tell a current vault from a leftover one before committing.
        pendingStorageAdoption.value?.let { adoption ->
            val currentLocalization = LocalLocalization.current
            val adoptionMessage = storageAdoptionMessage(
                StorageAdoptionSummary(
                    destinationNotes = adoption.plan.notes,
                    destinationLastModifiedMillis = adoption.plan.lastModifiedMs,
                    currentPath = notesRoot.path,
                    currentNotes = store.value?.notes?.size ?: 0,
                    currentTimeMillis = System.currentTimeMillis(),
                ),
                currentLocalization::localizedRelativeTime,
            )
            ConfirmDialog(
                title = currentLocalization.localizedText("storage.android.openExistingHeading"),
                body = currentLocalization.localizedText(
                    adoptionMessage.path,
                    adoptionMessage.arguments,
                ),
                confirmLabel = currentLocalization.localizedText("storage.android.openExistingAction"),
                onConfirm = {
                    pendingStorageAdoption.value = null
                    adoptExistingStorage(adoption)
                },
                onDismiss = { pendingStorageAdoption.value = null },
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
        // Sync writes bypass local mutations, so project the engine-reported
        // affected rows and deliver the same summary to an open editor.
        sync.onLocalTreeChanged = { summary -> s.localTreeChanged(summary) }
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

    // ── Automation hooks (debug builds only) ──

    /**
     * What a harness or an interactive session can ask this activity to do, by
     * name. Hooks call the same entry points the UI calls, so what they replace is
     * the tapping, not the code under test; `TestHooks` compiles to nothing in a
     * release build. Field names in `state` are read by
     * `tests/lib/android/testHooks.mjs`.
     */
    private fun testHooks(): Map<String, (Intent) -> Map<String, Any?>?> = mapOf(
        // Every field here replaces an accessibility-tree read, which costs ~2s and
        // reports whatever Compose last managed to render rather than app state
        // (AGENTS.md M21).
        "state" to {
            mapOf(
                "storageMode" to currentMode().name,
                "vaultPath" to if (::notesRoot.isInitialized) notesRoot.path else null,
                "notes" to (store.value?.notes?.size ?: 0),
                // First-run only. The Settings change-location picker is an
                // ordinary screen now, so it is observed by its own label.
                "onboarding" to showOnboarding.value,
                "movingNotes" to storageSwitching.value,
                "awaitingStorageConfirmation" to (pendingStorageAdoption.value != null),
                "shellVisible" to (store.value != null && !storageSwitching.value),
            )
        },
        "storage-mode" to { intent ->
            val requested = intent.getStringExtra("mode").orEmpty()
            // Throwing is the contract for a bad argument: the ack carries the
            // reason, where a silent no-op would look like a hung switch.
            performStorageChange(
                runCatching { StorageMode.valueOf(requested) }.getOrElse {
                    error("no such storage mode: $requested")
                },
            )
            null
        },
        "confirm-storage" to {
            val adoption = checkNotNull(pendingStorageAdoption.value) {
                "no storage switch is awaiting confirmation"
            }
            pendingStorageAdoption.value = null
            adoptExistingStorage(adoption)
            null
        },
        // Focusing the editor is native focus + DOM focus, in that order
        // (EditorWebView.focusEditor) — evaluating `FutoEditor.focus()` from
        // outside the app does only the DOM half, which Chromium then withholds
        // because the document itself is unfocused, so `.cm-focused` never
        // appears. This hook calls the SAME entry point the quick-capture open
        // uses, so a harness's focus is a user's focus.
        "focus-editor" to {
            val editorHost = EditorHost.get(this)
            // Throwing is the contract for a hook that cannot mean anything yet:
            // with no editor attached, focusing would be a silent no-op that
            // looks exactly like a hung open.
            checkNotNull(editorHost.currentAttachment()) { "no note is open in the editor" }
            editorHost.focusEditor()
            null
        },
    )

    override fun onDestroy() {
        TestHooks.uninstall(this)
        super.onDestroy()
    }

    /** Settings change-location confirm: migrate the vault, then relaunch. */
    private fun performStorageChange(mode: StorageMode) {
        if (mode == currentMode()) return
        if (mode == StorageMode.DEVICE && !NotesStorage.deviceModeSupported()) {
            Toast.makeText(
                this,
                localization.localizedText("storage.android.permission.unsupported"),
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        if (mode == StorageMode.DEVICE) requestDeviceAccess { planStorageChange(StorageMode.DEVICE) }
        else planStorageChange(mode)
    }

    /**
     * Copying the vault and re-pointing at an existing one are different
     * operations, so what is already in the target decides which one runs.
     */
    private fun planStorageChange(newMode: StorageMode) {
        if (storageSwitching.value) return
        val current = store.value ?: return
        val to = NotesStorage.rootFor(this, newMode, BuildConfig.DEBUG)
        lifecycleScope.launch {
            when (val plan = storageSwitchPlan(current.inspectVaultDestination(to), sync.connected)) {
                StorageSwitchPlan.Migrate -> performSwitch(newMode)
                is StorageSwitchPlan.OpenExisting ->
                    pendingStorageAdoption.value = PendingStorageAdoption(newMode, plan)
                is StorageSwitchPlan.Refuse -> {
                    android.util.Log.e("FutoStorage", "Storage switch refused")
                    Toast.makeText(
                        this@MainActivity,
                        if (plan.message == SYNC_CONNECTED_STORAGE_REFUSAL) {
                            localization.localizedText("storage.android.disconnectSyncFirst")
                        } else {
                            localization.localizedText("storage.android.folderUnavailable")
                        },
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    /**
     * Point the app at the notes already in [mode]'s folder. Nothing is copied,
     * merged, or deleted, so the previous folder keeps every note it has — the
     * user has already been shown both sides. Relaunching is what rebuilds every
     * vault-derived object against the new root (M4); the drafts are flushed
     * first because `exit(0)` would otherwise drop a retained one.
     */
    private fun adoptExistingStorage(adoption: PendingStorageAdoption) {
        val current = store.value ?: return
        // No `storageSwitching` guard: the confirmation has already been consumed
        // by the time this runs, so bailing out here would swallow the user's
        // answer with nothing on screen to explain it. The vault gate below is the
        // real serialization, and it refuses out loud.
        storageSwitching.value = true
        if (!current.tryBeginStorageMigration()) {
            storageSwitching.value = false
            Toast.makeText(
                this,
                localization.localizedText("storage.android.saveInProgress"),
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        lifecycleScope.launch {
            // The step order and every failure message live in adoptExistingVault
            // so they can be unit-tested; this only supplies the effects.
            val outcome = adoptExistingVault(
                mode = adoption.mode,
                isSyncConnected = { sync.connected },
                flushDrafts = { current.flushDraftsForVaultHandoff() },
                clearJournal = {
                    withContext(Dispatchers.IO) { storageMigrationJournal.clear() }.isSuccess
                },
                // commit() — restartApp() kills the process before an async apply()
                // would flush (see performSwitch).
                commitPreference = { mode ->
                    withContext(Dispatchers.IO) {
                        prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).commit()
                    }
                },
            )
            when (outcome) {
                StorageAdoptionOutcome.Restart -> restartApp()
                is StorageAdoptionOutcome.KeepCurrent -> {
                    android.util.Log.e("FutoStorage", "Storage adoption failed")
                    current.resumeAfterStorageMigrationFailure()
                    storageSwitching.value = false
                    Toast.makeText(
                        this@MainActivity,
                        localization.localizedText("storage.android.adoptionFailed"),
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    private fun performSwitch(newMode: StorageMode) {
        if (storageSwitching.value) return
        val current = store.value ?: return
        val previousMode = currentMode()
        val to = NotesStorage.rootFor(this, newMode, BuildConfig.DEBUG)
        storageSwitching.value = true
        if (!current.tryBeginStorageMigration()) {
            storageSwitching.value = false
            Toast.makeText(
                this,
                localization.localizedText("storage.android.saveInProgress"),
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        // Latch BOTH vault owners synchronously. onStop may fire as soon as the
        // picker Activity loses focus; it must not abort the graceful sync stop.
        sync.beginStorageMigration()
        current.suppressAutoPush = true
        lifecycleScope.launch {
            val prepared = PendingStorageMigration(
                from = previousMode,
                to = newMode,
                phase = StorageMigrationPhase.PREPARED,
                cleanupRequired = false,
            )
            val outcome = runCatching {
                sync.quiesceForStorageMigration()
                withContext(Dispatchers.IO) {
                    storageMigrationJournal.write(prepared).getOrThrow()
                }
                current.migrateVault(to)
            }.getOrElse {
                NotesStorage.MigrationOutcome.Failed(
                    "The notes folder could not be moved. The original notes are unchanged.",
                )
            }
            val decision = NotesStorage.storageSwitchDecision(outcome)
            val failureStage = storageSwitchFailureStage(decision)
            val activation = activateStagedStorageMigration(
                prepared = prepared,
                decision = decision,
                writeJournal = { record ->
                    withContext(Dispatchers.IO) {
                        storageMigrationJournal.write(record).isSuccess
                    }
                },
                finalizeSource = {
                    runCatching {
                        current.finalizeVaultMigration(
                            to,
                            allowSourceRemoval = previousMode != StorageMode.DEVICE,
                        )
                    }.getOrNull()
                },
                commitPreference = { mode ->
                    withContext(Dispatchers.IO) {
                        prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).commit()
                    }
                },
                clearJournal = {
                    withContext(Dispatchers.IO) { storageMigrationJournal.clear() }
                },
            )
            if (activation == StorageActivationOutcome.Restart) {
                restartApp()
                return@launch
            }

            // PREPARED (or no journal) means the source remains authoritative.
            // Clearing is best effort: a surviving PREPARED record also selects
            // the source on the next launch.
            withContext(Dispatchers.IO) {
                storageMigrationJournal.clear()
                prefs.edit()
                    .putString(Prefs.STORAGE_MODE, previousMode.name)
                    .commit()
            }
            current.suppressAutoPush = false
            current.resumeAfterStorageMigrationFailure()
            storageSwitching.value = false
            sync.resumeAfterStorageMigrationFailure()
            Toast.makeText(
                this@MainActivity,
                storageSwitchFailureMessage(failureStage).let {
                    localization.localizedText(it.path, it.arguments)
                },
                Toast.LENGTH_LONG,
            ).show()
            if (activation is StorageActivationOutcome.KeepSource) {
                android.util.Log.e(
                    "FutoStorage",
                    when (failureStage) {
                        StorageSwitchFailureStage.MIGRATION -> "Storage migration failed"
                        StorageSwitchFailureStage.ACTIVATION -> "Storage activation failed"
                    },
                )
            }
        }
    }

    /**
     * Request the "All files access" special permission (Android 11+). The
     * settings screen returns no result code, so [allFilesLauncher]'s callback
     * re-checks [NotesStorage.hasDeviceAccess] and runs [onGranted].
     */
    private fun requestDeviceAccess(onGranted: () -> Unit) {
        if (!NotesStorage.deviceModeSupported()) {
            Toast.makeText(
                this,
                localization.localizedText("storage.android.permission.unsupported"),
                Toast.LENGTH_LONG,
            ).show()
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
