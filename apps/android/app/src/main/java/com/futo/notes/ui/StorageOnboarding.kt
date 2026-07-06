package com.futo.notes.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStorage
import com.futo.notes.StorageMode
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * First-run / change-storage picker, mirroring Obsidian's vault-location screen.
 * When supported, DEVICE is the pre-selected RECOMMENDED option (a default with
 * an escape hatch). Picking DEVICE shows a permission RATIONALE screen before
 * the caller launches the system "All files access" dialog [the priming screen];
 * APP confirms immediately. On API < 30, DEVICE is not supported and the picker
 * presents APP as the only valid target.
 *
 * Pure UI: it never touches disk or permissions itself — [onConfirm] hands the
 * chosen mode back to the Activity, which persists it, requests the permission,
 * and seeds/migrates. Used full-screen on first run and as an overlay from
 * Settings.
 */
@Composable
fun StorageOnboarding(
    initialMode: StorageMode,
    deviceModeSupported: Boolean,
    onConfirm: (StorageMode) -> Unit,
    onCancel: (() -> Unit)? = null,
) {
    var selected by remember(initialMode, deviceModeSupported) {
        mutableStateOf(NotesStorage.pickerInitialMode(initialMode, deviceModeSupported))
    }
    var showRationale by remember { mutableStateOf(false) }
    val c = FutoTheme.colors

    Surface(color = c.surface, modifier = Modifier.fillMaxSize()) {
        if (showRationale && deviceModeSupported) {
            RationaleScreen(
                primaryLabel = "Continue",
                onPrimary = { onConfirm(StorageMode.DEVICE) },
                secondaryLabel = "Back",
                onSecondary = { showRationale = false },
            )
            return@Surface
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
        ) {
            Spacer(Modifier.height(24.dp))
            Text("Where should your notes live?", style = FutoType.display, color = c.textPrimary)
            Spacer(Modifier.height(8.dp))
            Text(
                "Your notes are plain Markdown files. Choose where to keep them.",
                style = FutoType.body,
                color = c.textMuted,
            )
            Spacer(Modifier.height(28.dp))

            if (deviceModeSupported) {
                StorageOptionCard(
                    title = "Device storage",
                    icon = Icons.Filled.Folder,
                    recommended = true,
                    selected = selected == StorageMode.DEVICE,
                    bullets = listOf(
                        "Open, back up, and sync your notes from your Files app and other apps.",
                        "Requires the “All files access” permission.",
                    ),
                    onClick = { selected = StorageMode.DEVICE },
                )
                Spacer(Modifier.height(12.dp))
            }
            StorageOptionCard(
                title = "App storage",
                icon = Icons.Filled.Lock,
                recommended = !deviceModeSupported,
                selected = selected == StorageMode.APP,
                bullets = listOf(
                    "Your notes stay private to FUTO Notes.",
                    "Android deletes your notes if you uninstall the app.",
                ),
                onClick = { selected = StorageMode.APP },
            )

            Spacer(Modifier.height(28.dp))
            Button(
                onClick = {
                    if (selected == StorageMode.DEVICE && deviceModeSupported) {
                        showRationale = true
                    } else {
                        onConfirm(StorageMode.APP)
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.textOnInk),
                shape = RoundedCornerShape(FutoRadius.pill),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Text("Continue", style = FutoType.body, fontWeight = FontWeight.SemiBold)
            }
            if (onCancel != null) {
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = onCancel,
                    shape = RoundedCornerShape(FutoRadius.pill),
                    border = BorderStroke(1.dp, c.border),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Text("Cancel", style = FutoType.body, color = c.textSecondary)
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * Shown when DEVICE mode was chosen but "All files access" is not granted (lost
 * after a system revoke, or on relaunch). Re-explains and routes to the grant
 * flow, with an escape to private app storage so the user is never stuck on an
 * unreadable vault.
 */
@Composable
fun StorageRegrantScreen(onGrant: () -> Unit, onUseAppStorage: () -> Unit) {
    Surface(color = FutoTheme.colors.surface, modifier = Modifier.fillMaxSize()) {
        RationaleScreen(
            primaryLabel = "Grant access",
            onPrimary = onGrant,
            secondaryLabel = "Use private app storage instead",
            onSecondary = onUseAppStorage,
        )
    }
}

@Composable
private fun RationaleScreen(
    primaryLabel: String,
    onPrimary: () -> Unit,
    secondaryLabel: String,
    onSecondary: () -> Unit,
) {
    val c = FutoTheme.colors
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
    ) {
        Spacer(Modifier.height(32.dp))
        Icon(Icons.Filled.Folder, contentDescription = null, tint = c.textAccent, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(16.dp))
        Text("Allow access to your files", style = FutoType.display, color = c.textPrimary)
        Spacer(Modifier.height(12.dp))
        Text(
            "To keep your notes in a folder you can open from the Files app, back up, " +
                "and sync with other apps, FUTO Notes needs Android’s “All files access” " +
                "permission.\n\nOn the next screen, turn on “Allow access to manage all files”.",
            style = FutoType.body,
            color = c.textSecondary,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "FUTO Notes only ever touches its own notes folder. Your notes never leave " +
                "your device unless you set up sync.",
            style = FutoType.caption,
            color = c.textMuted,
        )
        Spacer(Modifier.height(32.dp))
        Button(
            onClick = onPrimary,
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.textOnInk),
            shape = RoundedCornerShape(FutoRadius.pill),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text(primaryLabel, style = FutoType.body, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = onSecondary,
            shape = RoundedCornerShape(FutoRadius.pill),
            border = BorderStroke(1.dp, c.border),
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            Text(secondaryLabel, style = FutoType.body, color = c.textSecondary)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun StorageOptionCard(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    recommended: Boolean,
    selected: Boolean,
    bullets: List<String>,
    onClick: () -> Unit,
) {
    val c = FutoTheme.colors
    Surface(
        color = if (selected) c.surfaceSelected else c.surface,
        shape = RoundedCornerShape(FutoRadius.md),
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) c.accent else c.border),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(
                    selected = selected,
                    onClick = onClick,
                    colors = RadioButtonDefaults.colors(selectedColor = c.accent, unselectedColor = c.textMuted),
                )
                Spacer(Modifier.width(4.dp))
                Icon(icon, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(title, style = FutoType.title, color = c.textPrimary, modifier = Modifier.weight(1f))
                if (recommended) RecommendedBadge()
            }
            Spacer(Modifier.height(8.dp))
            bullets.forEach { line ->
                Row(modifier = Modifier.padding(start = 12.dp, top = 4.dp)) {
                    Text("•  ", style = FutoType.caption, color = c.textMuted)
                    Text(line, style = FutoType.caption, color = c.textSecondary)
                }
            }
        }
    }
}

@Composable
private fun RecommendedBadge() {
    val c = FutoTheme.colors
    Surface(color = c.success.copy(alpha = 0.16f), shape = RoundedCornerShape(FutoRadius.pill)) {
        Text(
            "RECOMMENDED",
            style = FutoType.micro,
            color = c.success,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}
