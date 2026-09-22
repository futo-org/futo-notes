package com.futo.notes.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.SyncManager
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

private const val SERVER_REPO_URL = "https://gitlab.futo.org/futo-notes/futo-notes-server"

/**
 * Today's self-hosted sync surface: server URL and password, connect / sync /
 * disconnect, and live status.
 *
 * Extracted from [SyncScreen] unchanged so there is exactly one of it. A build
 * with hosted sync off renders these rows directly; a build with it on
 * discloses these same rows behind "Use my own server", rather than a second
 * copy that could drift from them (parent spec user story 34).
 */
@Composable
fun ColumnScope.SelfHostedSyncSections(store: NotesStore, sync: SyncManager) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var password by remember { mutableStateOf("") }

    OutlinedTextField(
        value = sync.serverUrl,
        onValueChange = { sync.serverUrl = it },
        label = { Text(localization.localizedText("sync.serverUrl")) },
        singleLine = true,
        enabled = !sync.connected,
        // A URL is not prose: tell the IME so it stops autocapitalizing
        // the scheme/host and offering autocorrect/predictive suggestions
        // that silently mangle what the user types [sync.md].
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Uri,
            autoCorrectEnabled = false,
            capitalization = KeyboardCapitalization.None,
        ),
        shape = RoundedCornerShape(FutoRadius.md),
        modifier = Modifier.fillMaxWidth(),
    )
    if (!sync.connected) {
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(localization.localizedText("sync.password")) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            // PasswordVisualTransformation only masks the DISPLAY — without
            // password keyboard options the IME still autocapitalizes the
            // first letter and autocorrects, so the bytes sent to the server
            // differ from what the user typed → "invalid password" [sync.md].
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                autoCorrectEnabled = false,
                capitalization = KeyboardCapitalization.None,
            ),
            shape = RoundedCornerShape(FutoRadius.md),
            modifier = Modifier.fillMaxWidth(),
        )
        // Point the user at how to get a server (sync.md): a bordered
        // link card to the FUTO Notes server repo (mirrors the iOS
        // SyncView link row). Only shown before connecting.
        Surface(
            color = c.surface,
            shape = RoundedCornerShape(FutoRadius.md),
            border = BorderStroke(1.dp, c.border),
            modifier = Modifier.fillMaxWidth().clickable {
                runCatching {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SERVER_REPO_URL)))
                }
            },
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.OpenInNew,
                    contentDescription = null,
                    tint = c.textAccent,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    localization.localizedText("sync.serverSetupLink"),
                    style = FutoType.body,
                    color = c.textAccent,
                )
            }
        }
    }
    Text(sync.localizedStatus(localization), style = FutoType.small, color = c.textSecondary)
    sync.localizedError(localization)?.let {
        Text(it, style = FutoType.small, color = c.danger)
    }

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        val emberColors = ButtonDefaults.buttonColors(
            containerColor = c.accent,
            contentColor = Color.White,
        )
        if (!sync.connected) {
            Button(
                enabled = !sync.busy && password.isNotEmpty(),
                colors = emberColors,
                shape = RoundedCornerShape(FutoRadius.md),
                onClick = {
                    scope.launch { sync.connectAndSync(store.rootPath, password) }
                },
            ) { Text(localization.localizedText("sync.connectAndSync")) }
        } else {
            Button(
                enabled = !sync.busy,
                colors = emberColors,
                shape = RoundedCornerShape(FutoRadius.md),
                onClick = { scope.launch { sync.syncNow() } },
            ) { Text(localization.localizedText("sync.syncNow")) }
            OutlinedButton(
                shape = RoundedCornerShape(FutoRadius.md),
                onClick = { scope.launch { sync.disconnect() } },
            ) {
                Text(
                    localization.localizedText("sync.disconnect"),
                    color = c.textSecondary,
                )
            }
        }
    }
    if (sync.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.accent)
}
