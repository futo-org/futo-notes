package com.futo.notes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.SyncManager
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

/**
 * E2EE sync — the Android counterpart of `SyncView.swift`. All sync logic lives
 * in the Rust `SyncClient` behind `SyncManager`; this only drives it. Re-dressed
 * with the FUTO design tokens.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(store: NotesStore, sync: SyncManager, onBack: () -> Unit) {
    val c = FutoTheme.colors
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }

    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopAppBar(
                title = { Text("Sync", style = FutoType.title, color = c.textPrimary) },
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
            Modifier.padding(padding).padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = sync.serverUrl,
                onValueChange = { sync.serverUrl = it },
                label = { Text("Server URL") },
                singleLine = true,
                enabled = !sync.connected,
                shape = RoundedCornerShape(FutoRadius.md),
                modifier = Modifier.fillMaxWidth(),
            )
            if (!sync.connected) {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    shape = RoundedCornerShape(FutoRadius.md),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Text(sync.status, style = FutoType.small, color = c.textSecondary)
            sync.lastError?.let { Text(it, style = FutoType.small, color = c.danger) }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                val emberColors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = androidx.compose.ui.graphics.Color.White)
                if (!sync.connected) {
                    Button(
                        enabled = !sync.busy && password.isNotEmpty(),
                        colors = emberColors,
                        shape = RoundedCornerShape(FutoRadius.md),
                        onClick = { scope.launch { sync.connectAndSync(store.rootPath, password); store.reload() } },
                    ) { Text("Connect & Sync") }
                } else {
                    Button(
                        enabled = !sync.busy,
                        colors = emberColors,
                        shape = RoundedCornerShape(FutoRadius.md),
                        onClick = { scope.launch { sync.syncNow(); store.reload() } },
                    ) { Text("Sync now") }
                    OutlinedButton(
                        shape = RoundedCornerShape(FutoRadius.md),
                        onClick = { scope.launch { sync.disconnect() } },
                    ) { Text("Disconnect", color = c.textSecondary) }
                }
            }
            if (sync.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = c.accent)
            TextButton(onClick = onBack) { Text("Done", color = c.textAccent) }
        }
    }
}
