package com.futo.notes

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.futo.notes.ui.EditorHost
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.StorageMigrationJournal
import com.futo.notes.storage.StorageMode
import com.futo.notes.storage.StorageRecoveryFailure
import com.futo.notes.storage.recoverStorageStartup
import com.futo.notes.storage.storageRecoveryMessage
import com.futo.notes.testhook.DebugHostedServer
import com.futo.notes.testhook.TestHooks
import com.futo.notes.ui.components.ClearFocusOnImeDismiss
import com.futo.notes.ui.components.imeTargetVisible
import com.futo.notes.ui.navigation.DropLicenseLandingWithoutShell
import com.futo.notes.ui.StorageOnboarding
import com.futo.notes.ui.StorageRegrantScreen
import com.futo.notes.ui.ThemeMode
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.license.LicenseModel
import com.futo.notes.license.LicenseStorage
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.localization.AppLanguageController
import com.futo.notes.localization.ProvideLocalization
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import com.futo.notes.ui.blur
import com.futo.notes.ui.setLocalization

class MainActivity : ComponentActivity() {
    internal lateinit var localization: Localization
    internal lateinit var appLanguage: AppLanguageController
    // Hoisted so onStart/onStop can pause/resume the SSE live stream — the
    // stream shouldn't stay open while backgrounded; re-foregrounding gets a
    // fresh `ready` that drives a catch-up pull.
    internal lateinit var sync: SyncManager

    /** Keystore-backed secret store for this install: the self-hosted sync
     *  password, and the hosted vault key + session token (scoped per notes
     *  root). Hoisted out of [initVault] because the Sync screen hands it to the
     *  hosted wizard's `VaultSecretStore`. */
    internal val secure: SecureStore by lazy { SecureStore(prefs) }

    // Native image pickers for the editor's pickImage bridge message — must
    // register their ActivityResult contracts during onCreate.
    internal lateinit var imagePicker: ImagePicker

    // Crash logs found by the startup scan, surfaced as the crash dialog.
    // Compose state so setContent reacts when the off-main scan lands.
    internal val pendingCrashJson = mutableStateOf<String?>(null)

    // Vault wiring is DEFERRED until the storage location is known [app.md].
    // `store` is null while the first-run picker / lost-permission screen is up;
    // setContent shows the shell only once initVault has run. Resolved early in
    // onCreate (no disk on the main thread — see initVault).
    internal lateinit var prefs: android.content.SharedPreferences
    internal lateinit var license: LicenseModel

    /**
     * A delivered `futonotes://license/{key}/{activation}` link, waiting for the
     * first composition (docs/spec/license.md § Deep link).
     *
     * Compose state rather than a direct call so BOTH deliveries take one path:
     * a cold start writes it in onCreate and the LaunchedEffect below applies it
     * once the shell has painted (M1), while a link arriving at the running app
     * writes it from onNewIntent and recomposition applies it the same way.
     */
    private val pendingLicenseLink = mutableStateOf<String?>(null)
    internal lateinit var storageMigrationJournal: StorageMigrationJournal
    internal lateinit var notesRoot: File
    // `::notesRoot.isInitialized` is only legal inside this class, and the hooks live in an extension.
    internal fun isNotesRootInitialized(): Boolean = ::notesRoot.isInitialized
    internal val store = mutableStateOf<NotesStore?>(null)
    internal val showOnboarding = mutableStateOf(false)
    internal val showRegrant = mutableStateOf(false)
    internal val storageSwitching = mutableStateOf(false)
    internal val storageResolving = mutableStateOf(true)
    internal val storageRecoveryFailure = mutableStateOf<StorageRecoveryFailure?>(null)
    internal val pendingStorageAdoption = mutableStateOf<PendingStorageAdoption?>(null)
    internal val themeMode = mutableStateOf(ThemeMode.AUTO)

    // The All-files-access settings screen returns no result code, so we
    // re-check the actual permission state on return and run the continuation.
    internal var pendingDeviceAction: (() -> Unit)? = null
    internal lateinit var allFilesLauncher: ActivityResultLauncher<Intent>

    override fun onStart() {
        super.onStart()
        if (::sync.isInitialized) sync.resumeLiveAsync()
    }

    override fun onPause() {
        super.onPause()
        store.value?.requestPendingEditorFlush()
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
        lifecycleScope.launch {
            val icons = com.futo.notes.ui.settings.appicon.AppIconController(this@MainActivity)
            icons.refresh()
            if (icons.failed) android.util.Log.w("AppIcon", "Launcher icon reconciliation failed")
        }

        // Edge-to-edge; Compose Scaffold/TopAppBar handle the system-bar insets.
        // enableEdgeToEdge() (androidx.activity) is the non-deprecated path: on
        // API 35 it draws bar scrims via an overlay instead of the now-deprecated
        // Window.setStatusBarColor/setNavigationBarColor (which Play flags and
        // which are no-ops under Android 15's forced edge-to-edge). SystemBarAppearance
        // below still owns light/dark icon contrast, reactive to the app theme.
        // Requires androidx.activity >= 1.12 — earlier versions call the deprecated
        // setters internally, so the Play warning would persist (see build.gradle.kts).
        enableEdgeToEdge()

        localization = Localization.system(
            resources.configuration.locales.toLanguageTags().split(',').filter(String::isNotBlank),
        )

        // Construct the preferences handle synchronously, but do not read it
        // before the first composition. Theme and storage recovery load on IO
        // after setContent, preserving the never-gate-render invariant.
        prefs = getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
        // Touches neither disk nor FFI: the stored pair is read on IO by
        // `license.load()` below and lands reactively (M1). BuildConfig
        // .APPLICATION_ID carries the `.dev` suffix on debug builds, and that
        // id is what selects the staging keys and endpoint — never a compile
        // profile, since both dev builds ship the optimized release-ffi Rust
        // (M3).
        license = LicenseModel(LicenseStorage(prefs), BuildConfig.APPLICATION_ID)
        license.showMessage = { message ->
            Toast.makeText(
                this,
                localization.localizedText(message.path, message.arguments),
                Toast.LENGTH_LONG,
            ).show()
        }
        // Only on a genuinely NEW launch. A recreation — process death, a
        // configuration change outside the list above — re-delivers the SAME
        // launch intent, and re-applying it would announce a license the user
        // already has for a second time. `savedInstanceState != null` is what
        // distinguishes the two; nothing is lost if a link was still pending
        // when the process died, because nothing had been stored yet.
        if (savedInstanceState == null) pendingLicenseLink.value = licenseLinkOf(intent)
        appLanguage = AppLanguageController(this, prefs)
        CrashlogEndpoint.attach(prefs)

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
        // A debug build can be launched pointed at a local hosted server; a
        // release build compiles the no-op sibling and always uses the baked
        // address. Applied before anything can ask the engine where hosted sync
        // lives.
        DebugHostedServer.applyOverride(intent)

        setContent {
            ProvideLocalization(appLanguage.selectedLanguageTag) {
                val currentLocalization = LocalLocalization.current
                SideEffect { localization = currentLocalization }
                val configuration = LocalConfiguration.current
                LaunchedEffect(configuration) { appLanguage.refresh() }
                if (BuildConfig.DEBUG) {
                    LaunchedEffect(Unit) {
                        android.util.Log.i("FutoStartup", "first composition reached")
                    }
                }
                // A link is applied only once the shell is interactive, so a
                // cold-start link lands — and toasts — on a painted screen
                // (docs/spec/license.md § Deep link, M1). What the URL MEANS is
                // Rust's verdict: anything the crate does not define is ignored
                // silently, right down to no toast.
                val licenseLink = pendingLicenseLink.value
                LaunchedEffect(licenseLink) {
                    if (licenseLink == null) return@LaunchedEffect
                    pendingLicenseLink.value = null
                    license.handle(licenseLink)
                }
                DropLicenseLandingWithoutShell(license, noShell = hasNoShell())
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

        // Un-awaited, like every other startup read: the stored license is two
        // preference strings plus an offline signature check, and the License
        // row fills itself in when they land. Nothing about the shell waits for
        // it (M1).
        lifecycleScope.launch { license.load() }

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

    /**
     * A `futonotes://` link delivered while the app is already running. The
     * activity is `singleTop`, so the OS hands it here instead of stacking a
     * second MainActivity; `setIntent` keeps `getIntent()` honest for anything
     * that reads it later.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        licenseLinkOf(intent)?.let { pendingLicenseLink.value = it }
    }

    /** The URL of a VIEW intent, or null for the launcher's MAIN intent. */
    private fun licenseLinkOf(intent: Intent?): String? =
        intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data?.toString()

    override fun onDestroy() {
        TestHooks.uninstall(this)
        super.onDestroy()
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
