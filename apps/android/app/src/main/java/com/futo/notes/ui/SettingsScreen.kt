package com.futo.notes.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.futo.notes.ui.settings.appicon.AppIconController
import com.futo.notes.ui.settings.appicon.AppIconSettingsGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.NorthEast
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.futo.notes.BuildConfig
import com.futo.notes.NotesStore
import com.futo.notes.Prefs
import com.futo.notes.storage.StorageMode
import com.futo.notes.SyncManager
import com.futo.notes.license.LicenseModel
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

enum class ThemeMode { LIGHT, DARK, AUTO }

private const val SOURCE_URL = "https://gitlab.futo.org/futo-notes/futo-notes"

private fun storageModeLabel(mode: StorageMode, localization: Localization): String = when (mode) {
    StorageMode.DEVICE -> localization.localizedText("settings.storage.sharedFolderDescription")
    StorageMode.APP -> localization.localizedText("settings.storage.appFolderDescription")
    StorageMode.INTERNAL -> localization.localizedText("settings.storage.legacyInternalDescription")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    store: NotesStore,
    sync: SyncManager,
    license: LicenseModel,
    themeMode: ThemeMode,
    onThemeMode: (ThemeMode) -> Unit,
    selectedLanguageTag: String?,
    onSelectLanguage: (String?) -> Unit,
    onOpenSync: () -> Unit,
    onOpenFeedback: () -> Unit,
    storageMode: StorageMode,
    onChangeStorage: () -> Unit,
    onBack: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Same prefs file the Activity already loaded — getSharedPreferences is a
    // cached lookup by now, no disk hit.
    val prefs = remember { context.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE) }
    var crashEnabled by remember { mutableStateOf(prefs.getBoolean(Prefs.CRASH_ENABLED, true)) }
    var crashAlwaysSend by remember { mutableStateOf(prefs.getBoolean(Prefs.CRASH_ALWAYS_SEND, false)) }
    val appIcons = remember { AppIconController(context) }
    // Bumped by the picker's "I already paid"; the License card opens its key
    // field on each change.
    var keyEntryRequest by remember { mutableStateOf(0) }
    val scrollState = rememberScrollState()
    LifecycleResumeEffect(appIcons) {
        scope.launch { appIcons.refresh() }
        onPauseOrDispose {}
    }
    var confirmReset by remember { mutableStateOf(false) }
    var resetting by remember { mutableStateOf(false) }

    LaunchedEffect(keyEntryRequest) {
        // The License card is the first group: "I already paid" brings it back.
        if (keyEntryRequest > 0) scrollState.animateScrollTo(0)
    }

    Box {
    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopBar(
                title = {
                    Text(
                        localization.localizedText("settings.heading"),
                        style = FutoType.title,
                        color = c.textPrimary,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = localization.localizedText("common.actions.back"),
                            tint = c.textSecondary,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).verticalScroll(scrollState).padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(8.dp))

            // FIRST, at the top: mobile has no ambient "Unlicensed" label
            // outside Settings, so this row's status text IS the label
            // (docs/spec/license.md § States and copy).
            LicenseSettingsSection(license, keyEntryRequest)

            // The whole Sync surface is one "Sync" row: cloud icon,
            // connected-vs-local status, SYNCED/LOCAL badge. No separate account
            // header, no separate "Server" row (settings.md). Routes to SyncScreen.
            SettingsGroup(localization.localizedText("settings.sections.sync")) {
                SettingsRow(
                    title = localization.localizedText("settings.sync.label"),
                    subtitle = sync.localizedStatus(localization),
                    onClick = onOpenSync,
                    leading = { Icon(Icons.Filled.Cloud, contentDescription = null, tint = c.textAccent) },
                ) { SyncBadge(connected = sync.connected) }
            }

            SettingsGroup(localization.localizedText("settings.sections.appearance")) {
                // Label ABOVE the control, not beside it. A three-option
                // segmented control wants ~250dp, and `SettingsRow` measures
                // its trailing slot first — so at 360dp, the commonest Android
                // width, the label was left less room than the word "Theme"
                // and Compose broke it mid-word as "Them / e". Stacking is the
                // same answer the License plate gives its own rows, and it
                // cannot wrap at any width.
                SettingsStackedRow(localization.localizedText("settings.appearance.theme")) {
                    Segmented(
                        options = listOf(
                            localization.localizedText("settings.appearance.light"),
                            localization.localizedText("settings.appearance.dark"),
                            localization.localizedText("settings.appearance.auto"),
                        ),
                        selectedIndex = themeMode.ordinal,
                        onSelect = { onThemeMode(ThemeMode.entries[it]) },
                    )
                }
            }

            AppIconSettingsGroup(
                appIcons,
                license,
                landingBlocked = confirmReset || resetting,
                // Scrolls to the card and opens its key field.
                onAlreadyPaid = { keyEntryRequest += 1 },
            )

            SettingsGroup(localization.localizedText("settings.language.heading")) {
                SettingsRow(
                    title = localization.localizedText("settings.language.heading"),
                    leading = {
                        Icon(Icons.Filled.Language, contentDescription = null, tint = c.textAccent)
                    },
                ) {
                    LanguageMenu(
                        localization = localization,
                        selectedLanguageTag = selectedLanguageTag?.let {
                            localization.effectiveLanguage.tag
                        },
                        onSelect = onSelectLanguage,
                    )
                }
            }

            // Issue reporting [settings.md]. Reports never leave the device
            // without the toggle being on (and either a per-crash OK or the
            // always-send opt-in).
            SettingsGroup(localization.localizedText("settings.sections.issueReporting")) {
                SettingsRow(
                    title = localization.localizedText("settings.issueReporting.shareCrashReports"),
                    subtitle = localization.localizedText("settings.issueReporting.reportsSavedLocallyFirst"),
                ) {
                    Switch(
                        checked = crashEnabled,
                        onCheckedChange = {
                            crashEnabled = it
                            prefs.edit().putBoolean(Prefs.CRASH_ENABLED, it).apply()
                        },
                        colors = SwitchDefaults.colors(checkedTrackColor = c.accent),
                    )
                }
                if (crashEnabled) {
                    Divider()
                    SettingsRow(
                        title = localization.localizedText("settings.issueReporting.sendAutomatically"),
                        subtitle = localization.localizedText("settings.issueReporting.skipCrashDialog"),
                    ) {
                        Switch(
                            checked = crashAlwaysSend,
                            onCheckedChange = {
                                crashAlwaysSend = it
                                prefs.edit().putBoolean(Prefs.CRASH_ALWAYS_SEND, it).apply()
                            },
                            colors = SwitchDefaults.colors(checkedTrackColor = c.accent),
                        )
                    }
                }
                Divider()
                SettingsRow(
                    title = localization.localizedText("settings.issueReporting.sendFeedback"),
                    subtitle = localization.localizedText("settings.issueReporting.sendFeedbackDescription"),
                    onClick = onOpenFeedback,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = c.textMuted,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            SettingsGroup(localization.localizedText("settings.sections.storage")) {
                SettingsRow(
                    title = localization.localizedText("settings.storage.storageLocation"),
                    subtitle = storageModeLabel(storageMode, localization),
                    onClick = onChangeStorage,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = c.textMuted,
                        modifier = Modifier.size(20.dp),
                    )
                }
                Divider()
                SettingsRow(
                    title = localization.localizedText("settings.storage.folder"),
                    subtitle = store.rootPath,
                )
            }

            SettingsGroup(localization.localizedText("settings.sections.about")) {
                SettingsRow(
                    title = localization.localizedText("settings.about.openSource"),
                    onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SOURCE_URL))) }
                    },
                ) { Icon(Icons.Filled.NorthEast, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(18.dp)) }
                Divider()
                SettingsRow(title = localization.localizedText("settings.about.version")) {
                    Text(
                        BuildConfig.VERSION_NAME,
                        style = FutoType.caption.copy(fontFamily = FontFamily.Monospace),
                        color = c.textMuted,
                    )
                }
            }

            SettingsGroup(localization.localizedText("settings.sections.dangerZone")) {
                SettingsRow(
                    title = localization.localizedText("settings.danger.fullReset"),
                    // Shared copy [settings-visual.md "Copy is shared"] — same
                    // wording as desktop's Danger-zone row.
                    subtitle = localization.localizedText("settings.danger.permanentlyRemoveAll"),
                    titleColor = c.danger,
                    onClick = { confirmReset = true },
                )
            }

            if (BuildConfig.DEBUG) {
                SettingsGroup(localization.localizedText("settings.debug.heading")) {
                    SettingsRow(
                        title = localization.localizedText("settings.debug.testCrash.title"),
                        subtitle = localization.localizedText(
                            "settings.debug.testCrash.android.description",
                        ),
                        titleColor = c.danger,
                        onClick = { throw RuntimeException("Test crash from Settings (debug)") },
                    )
                }
            }

            Spacer(Modifier.height(32.dp))
        }
    }


    // Modal confirmation [settings.md]: a stray double-tap on the row must not
    // be able to wipe the vault — only confirming in this dialog deletes.
    if (confirmReset) {
        ConfirmDialog(
            title = localization.localizedText("settings.danger.fullReset"),
            body = localization.localizedText("settings.danger.confirmation"),
            confirmLabel = localization.localizedText("settings.danger.deleteEverything"),
            onConfirm = {
                confirmReset = false
                resetting = true
                scope.launch {
                    try {
                        fullReset(store, sync, license, appIcons) { path ->
                            android.widget.Toast.makeText(
                                context, localization.localizedText(path), android.widget.Toast.LENGTH_LONG,
                            ).show()
                        }
                    } finally {
                        resetting = false
                    }
                }
            },
            onDismiss = { confirmReset = false },
        )
    }

    if (resetting) ResettingOverlay()
    }
}
