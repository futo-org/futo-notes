package com.futo.notes.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Description
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
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.futo.notes.BuildConfig
import com.futo.notes.NotesStore
import com.futo.notes.Prefs
import com.futo.notes.SyncManager
import com.futo.notes.ui.components.MicroLabel
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class ThemeMode { LIGHT, DARK, AUTO }

private const val SOURCE_URL = "https://gitlab.futo.org/futo-notes/futo-notes"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    store: NotesStore,
    sync: SyncManager,
    themeMode: ThemeMode,
    onThemeMode: (ThemeMode) -> Unit,
    onOpenSync: () -> Unit,
    onBack: () -> Unit,
) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Same prefs file the Activity already loaded — getSharedPreferences is a
    // cached lookup by now, no disk hit.
    val prefs = remember { context.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE) }
    var crashEnabled by remember { mutableStateOf(prefs.getBoolean(Prefs.CRASH_ENABLED, true)) }
    var crashAlwaysSend by remember { mutableStateOf(prefs.getBoolean(Prefs.CRASH_ALWAYS_SEND, false)) }
    var resetArmed by remember { mutableStateOf(false) }
    var resetting by remember { mutableStateOf(false) }

    // Two-tap full reset [settings.md:43]: disarm automatically if the user
    // walks away after the first tap.
    LaunchedEffect(resetArmed) {
        if (resetArmed) { delay(5000); resetArmed = false }
    }

    Box {
    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopAppBar(
                title = { Text("Settings", style = FutoType.title, color = c.textPrimary) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = c.textSecondary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.surface),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        ) {
            AccountHeader(connected = sync.connected, onClick = onOpenSync)
            Spacer(Modifier.height(8.dp))

            SettingsGroup("Sync") {
                SettingsRow(
                    title = "Hosted sync",
                    subtitle = sync.status,
                    onClick = onOpenSync,
                ) { Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = c.textMuted) }
                Divider()
                SettingsRow(
                    title = "Server",
                    subtitle = sync.serverUrl,
                    onClick = onOpenSync,
                ) { Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = c.textMuted) }
            }

            SettingsGroup("Appearance") {
                SettingsRow(title = "Theme") {
                    Segmented(
                        options = listOf("Light", "Dark", "Auto"),
                        selectedIndex = themeMode.ordinal,
                        onSelect = { onThemeMode(ThemeMode.entries[it]) },
                    )
                }
            }

            SettingsGroup("Editor") {
                Text(
                    "Notes are Markdown files — file over app.",
                    style = FutoType.caption,
                    color = c.textMuted,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }

            // Crash reporting [settings.md:43]. Reports never leave the device
            // without the toggle being on (and either a per-crash OK or the
            // always-send opt-in).
            SettingsGroup("Crash reporting") {
                SettingsRow(title = "Share crash reports", subtitle = "Reports are saved locally first") {
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
                    SettingsRow(title = "Always send automatically", subtitle = "Skip the crash dialog") {
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
            }

            SettingsGroup("Storage") {
                SettingsRow(title = "Notes directory", subtitle = store.rootPath)
            }

            SettingsGroup("About") {
                SettingsRow(
                    title = "Open source",
                    onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SOURCE_URL))) }
                    },
                ) { Icon(Icons.Filled.NorthEast, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(18.dp)) }
                Divider()
                SettingsRow(title = "Version") {
                    Text(
                        BuildConfig.VERSION_NAME,
                        style = FutoType.caption.copy(fontFamily = FontFamily.Monospace),
                        color = c.textMuted,
                    )
                }
            }

            SettingsGroup("Danger zone") {
                SettingsRow(
                    title = if (resetArmed) "Tap again to confirm" else "Full reset",
                    subtitle = if (resetArmed) "This cannot be undone!" else "Delete every note, folder, and crash log",
                    titleColor = c.danger,
                    onClick = {
                        if (!resetArmed) {
                            resetArmed = true
                        } else {
                            resetArmed = false
                            resetting = true
                            scope.launch {
                                // Pause live sync + auto-push so the wipe can't
                                // race a push, wipe the vault, then drop the
                                // session (also clears the stored password)
                                // [settings.md:43]. Parity model: desktop
                                // deleteAllNotes (src/lib/notes.svelte.ts).
                                sync.pauseLive()
                                store.suppressAutoPush = true
                                try {
                                    store.deleteAll()
                                    sync.disconnect()
                                } finally {
                                    store.suppressAutoPush = false
                                    resetting = false
                                }
                            }
                        }
                    },
                )
            }

            if (BuildConfig.DEBUG) {
                SettingsGroup("Debug") {
                    SettingsRow(
                        title = "Test crash",
                        subtitle = "Throws RuntimeException to exercise the crash pipeline",
                        titleColor = c.danger,
                        onClick = { throw RuntimeException("Test crash from Settings (debug)") },
                    )
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (resetting) {
        // Blocking overlay — swallow every tap while the vault is wiped.
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
                    Text("Deleting all notes…", style = FutoType.body, color = c.textPrimary)
                }
            }
        }
    }
    }
}

@Composable
private fun AccountHeader(connected: Boolean, onClick: () -> Unit) {
    val c = FutoTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 16.dp),
    ) {
        Box(
            modifier = Modifier.size(50.dp).background(c.surfaceSelected, RoundedCornerShape(FutoRadius.md)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Description, contentDescription = null, tint = c.textAccent, modifier = Modifier.size(24.dp))
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text("FUTO Notes", style = FutoType.title.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            Text(
                if (connected) "Sync enabled" else "Local — tap to set up sync",
                style = FutoType.small,
                color = c.textTertiary,
            )
        }
        val badge = if (connected) "SYNCED" else "LOCAL"
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
