package com.futo.notes.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.SecureStore
import com.futo.notes.SyncManager
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.HostedSyncBuild
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.hosted.HostedSyncSections
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * E2EE sync — the Android counterpart of `SyncView.swift`. All sync logic lives
 * in the Rust `SyncClient` behind `SyncManager` / `HostedSetupClient`; this only
 * drives it.
 *
 * With hosted sync compiled in, the screen leads with "Log in with FUTO" and
 * discloses today's self-hosted fields below it; with the flag off it IS today's
 * self-hosted screen and nothing else exists (ADR 0003, decision 13).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(
    store: NotesStore,
    sync: SyncManager,
    secure: SecureStore,
    onBack: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current

    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopBar(
                title = {
                    Text(
                        localization.localizedText("sync.heading"),
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
            Modifier
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (HostedSyncBuild.isEnabled) {
                HostedSyncSections(store = store, sync = sync, secure = secure)
            } else {
                SelfHostedSyncSections(store = store, sync = sync)
            }
            // No "Done" button — the top app bar's back arrow dismisses the
            // screen (iOS keeps a nav-bar "Done"; Android uses the back affordance).
        }
    }
}
