package com.futo.notes.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.NorthEast
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.futo.notes.BuildConfig
import com.futo.notes.NotesStore
import com.futo.notes.Prefs
import com.futo.notes.storage.StorageMode
import com.futo.notes.SyncManager
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.MicroLabel
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class ThemeMode { LIGHT, DARK, AUTO }

private const val SOURCE_URL = "https://gitlab.futo.org/futo-notes/futo-notes"
private const val ISSUE_TRACKER_URL = "https://github.com/futo-org/futo-notes/issues"

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
    themeMode: ThemeMode,
    onThemeMode: (ThemeMode) -> Unit,
    onOpenSync: () -> Unit,
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
    var confirmReset by remember { mutableStateOf(false) }
    var resetting by remember { mutableStateOf(false) }

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
            modifier = Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(8.dp))

            // The whole Sync surface is one "Self-hosted sync" row: cloud icon,
            // connected-vs-local status, SYNCED/LOCAL badge. No separate account
            // header, no separate "Server" row (settings.md). Routes to SyncScreen.
            SettingsGroup(localization.localizedText("settings.sections.sync")) {
                SettingsRow(
                    title = localization.localizedText("settings.sync.selfHosted"),
                    subtitle = sync.localizedStatus(localization),
                    onClick = onOpenSync,
                    leading = { Icon(Icons.Filled.Cloud, contentDescription = null, tint = c.textAccent) },
                ) { SyncBadge(connected = sync.connected) }
            }

            SettingsGroup(localization.localizedText("settings.sections.appearance")) {
                SettingsRow(title = localization.localizedText("settings.appearance.theme")) {
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
                    title = localization.localizedText("settings.issueReporting.reportIssue"),
                    subtitle = localization.localizedText("settings.issueReporting.openGitHubIssueTracker"),
                    onClick = {
                        runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ISSUE_TRACKER_URL)))
                        }
                    },
                ) {
                    Icon(
                        Icons.Filled.NorthEast,
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
                    // Pause live sync + auto-push so the wipe can't race a
                    // push, wipe the vault, then drop the session (also clears
                    // the stored password). Parity model: desktop
                    // resetAllNotes (src/app/resetAllNotes.ts).
                    sync.pauseLive()
                    store.suppressAutoPush = true
                    try {
                        withContext(NonCancellable) {
                            store.deleteAll()
                            sync.disconnect()
                        }
                    } finally {
                        store.suppressAutoPush = false
                        resetting = false
                    }
                }
            },
            onDismiss = { confirmReset = false },
        )
    }

    if (resetting) {
        // Blocking overlay — swallow every tap AND Back while the vault is
        // wiped; Back would otherwise leave Settings mid-delete.
        BackHandler {}
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(c.surfaceInverse.copy(alpha = 0.45f))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            contentAlignment = Alignment.Center,
        ) {
            Surface(color = c.surface, shape = RoundedCornerShape(FutoRadius.md)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(20.dp)) {
                    CircularProgressIndicator(color = c.accent, strokeWidth = 2.5.dp, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(14.dp))
                    Text(
                        localization.localizedText("settings.danger.deleting"),
                        style = FutoType.body,
                        color = c.textPrimary,
                    )
                }
            }
        }
    }
    }
}

/// SYNCED / LOCAL pill shown on the single "Self-hosted sync" row.
@Composable
private fun SyncBadge(connected: Boolean) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val badge = if (connected) {
        localization.localizedText("settings.sync.syncedBadge")
    } else {
        localization.localizedText("settings.sync.localBadge")
    }
    val badgeColor = if (connected) c.success else c.textMuted
    Surface(color = badgeColor.copy(alpha = 0.14f), shape = RoundedCornerShape(FutoRadius.pill)) {
        Text(
            badge,
            style = FutoType.micro,
            color = badgeColor,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun SettingsGroup(label: String, content: @Composable () -> Unit) {
    val c = FutoTheme.colors
    MicroLabel(label, Modifier.padding(start = 4.dp, top = 12.dp, bottom = 8.dp))
    Surface(
        color = c.surface,
        shape = RoundedCornerShape(FutoRadius.md),
        border = BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column { content() }
    }
}

@Composable
private fun SettingsRow(
    title: String,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
    titleColor: Color? = null,
    leading: @Composable (() -> Unit)? = null,
    trailing: @Composable (() -> Unit)? = null,
) {
    val c = FutoTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = FutoType.body, color = titleColor ?: c.textPrimary)
            if (subtitle != null) Text(subtitle, style = FutoType.caption, color = c.textMuted)
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

@Composable
private fun Divider() {
    HorizontalDivider(color = FutoTheme.colors.border, modifier = Modifier.padding(horizontal = 16.dp))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Segmented(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    val c = FutoTheme.colors
    SingleChoiceSegmentedButtonRow {
        options.forEachIndexed { i, label ->
            SegmentedButton(
                selected = selectedIndex == i,
                onClick = { onSelect(i) },
                shape = SegmentedButtonDefaults.itemShape(index = i, count = options.size),
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = c.surfaceSelected,
                    activeContentColor = c.textAccent,
                    inactiveContainerColor = Color.Transparent,
                    inactiveContentColor = c.textSecondary,
                    activeBorderColor = c.accent,
                    inactiveBorderColor = c.border,
                ),
            ) {
                Text(label, style = FutoType.small)
            }
        }
    }
}
