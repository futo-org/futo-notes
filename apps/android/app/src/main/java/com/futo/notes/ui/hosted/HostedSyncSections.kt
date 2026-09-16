package com.futo.notes.ui.hosted

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.futo.notes.NotesStore
import com.futo.notes.SecureStore
import com.futo.notes.SyncManager
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.HostedBanner
import com.futo.notes.sync.hosted.HostedScreen
import com.futo.notes.sync.hosted.HostedWait
import com.futo.notes.sync.hosted.LiveHostedSetupShell
import com.futo.notes.sync.hosted.liveHostedSetupModel
import com.futo.notes.ui.SelfHostedSyncSections
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

/**
 * The hosted sync surface on the Sync screen: the wizard, the account card, the
 * two refused-write banners, and the "Use my own server" disclosure.
 *
 * Which screen this shows comes from Rust's `currentStep` every time it loads.
 * Nothing here remembers a position, which is what makes quitting halfway
 * through setup and reopening land on the right step (ADR 0003, decision 3).
 */
@Composable
fun ColumnScope.HostedSyncSections(store: NotesStore, sync: SyncManager, secure: SecureStore) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val scope = rememberCoroutineScope()
    val activity = requireNotNull(LocalContext.current.findActivity()) {
        "the hosted wizard needs an Activity to launch a browser tab from"
    }
    // The shell outlives a language change — the model holds it, and re-making
    // one would leave the model wired to a shell nothing observes — so it reads
    // the current localization through a function rather than keeping one.
    val currentLocalization = rememberUpdatedState(localization)
    val shell = remember(activity) {
        LiveHostedSetupShell(activity) { currentLocalization.value }
    }
    val model = remember(store.rootPath) {
        liveHostedSetupModel(store.rootPath, secure, shell)
    }

    // A Custom Tab has no dismissal callback, so leaving and returning to the
    // app IS the signal. Observed here rather than in the shell so the observer
    // is removed with the screen.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, shell) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> shell.onAppPaused()
                Lifecycle.Event.ON_RESUME -> shell.onAppResumed()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(model) { model.load() }

    model.errorMessage?.let { error ->
        Text(
            localization.localizedText(error.path, error.arguments),
            style = FutoType.small,
            color = c.danger,
        )
    }

    when (model.banner) {
        HostedBanner.NONE -> Unit
        HostedBanner.SYNC_PAUSED -> HostedBannerCard(
            title = "sync.hosted.banner.syncPaused.title",
            explanation = "sync.hosted.banner.syncPaused.body",
            action = "sync.hosted.banner.syncPaused.action",
            busy = model.busy,
        ) { scope.launch { model.subscribe() } }
        HostedBanner.VAULT_FULL -> HostedBannerCard(
            title = "sync.hosted.banner.vaultFull.title",
            explanation = "sync.hosted.banner.vaultFull.body",
            action = "sync.hosted.banner.vaultFull.action",
            busy = model.busy,
        ) { scope.launch { model.manageSubscription() } }
    }

    when (model.screen) {
        HostedScreen.LOADING -> Text(
            localization.localizedText("sync.hosted.loading"),
            style = FutoType.small,
            color = c.textSecondary,
        )
        HostedScreen.UNAVAILABLE -> Text(
            localization.localizedText("sync.hosted.unavailable"),
            style = FutoType.small,
            color = c.textSecondary,
        )
        HostedScreen.SIGN_IN -> {
            HostedStepHeader("sync.hosted.signIn.title", "sync.hosted.signIn.body")
            Button(
                enabled = !model.busy,
                colors = ButtonDefaults.buttonColors(
                    containerColor = c.accent,
                    contentColor = Color.White,
                ),
                shape = RoundedCornerShape(FutoRadius.md),
                onClick = { scope.launch { model.signIn() } },
            ) { Text(localization.localizedText("sync.hosted.signIn.button")) }
            Text(
                localization.localizedText(
                    "sync.hosted.signIn.serverLine",
                    mapOf("server" to model.serverUrl),
                ),
                style = FutoType.caption,
                color = c.textSecondary,
            )
        }
        HostedScreen.SUBSCRIBE -> {
            HostedStepHeader("sync.hosted.subscribe.title", "sync.hosted.subscribe.body")
            Button(
                enabled = !model.busy,
                colors = ButtonDefaults.buttonColors(
                    containerColor = c.accent,
                    contentColor = Color.White,
                ),
                shape = RoundedCornerShape(FutoRadius.md),
                onClick = { scope.launch { model.subscribe() } },
            ) { Text(localization.localizedText("sync.hosted.subscribe.button")) }
        }
        HostedScreen.CREATE_VAULT -> CreateVaultStep(
            minimumLength = model.minimumVaultPasswordLength,
            busy = model.busy,
        ) { vaultPassword -> scope.launch { model.createVault(vaultPassword) } }
        HostedScreen.RECOVERY_KEY -> model.recoveryKey?.let { key ->
            RecoveryKeyStep(
                recoveryKey = key,
                saved = model.recoveryKeySaved,
                busy = model.busy,
                onSavedChange = { model.recoveryKeySaved = it },
                onCopy = { model.copyRecoveryKey() },
                onShare = { model.shareRecoveryKey() },
                onContinue = { scope.launch { model.continueAfterRecoveryKey() } },
            )
        }
        HostedScreen.UNLOCK -> UnlockStep(
            door = model.unlockDoor,
            busy = model.busy,
            onDoor = { model.unlockDoor = it },
            onVaultPassword = { scope.launch { model.unlockWithPassword(it) } },
            onRecoveryKey = { scope.launch { model.unlockWithRecoveryKey(it) } },
        )
        HostedScreen.ACCOUNT -> HostedAccountCard(
            email = model.email,
            billing = model.billing,
            busy = model.busy,
            onManage = { scope.launch { model.manageSubscription() } },
            onSignOut = { scope.launch { model.signOut() } },
        )
    }

    model.waiting?.let { waiting ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(18.dp), color = c.accent, strokeWidth = 2.dp)
            Spacer(Modifier.width(12.dp))
            Text(
                localization.localizedText(
                    if (waiting == HostedWait.SIGN_IN) {
                        "sync.hosted.signIn.waiting"
                    } else {
                        "sync.hosted.subscribe.waiting"
                    },
                ),
                style = FutoType.caption,
                color = c.textSecondary,
            )
        }
        TextButton(onClick = { model.cancelWaiting() }) {
            Text(localization.localizedText("sync.hosted.cancel"), color = c.textSecondary)
        }
    }

    // Self-hosting is unchanged and stays available. The disclosed panel is
    // literally the rows a flag-off build renders, not a copy of them (parent
    // spec user story 34). The offer goes away once hosted sync is set up.
    if (model.screen != HostedScreen.ACCOUNT) {
        Surface(
            color = c.surface,
            shape = RoundedCornerShape(FutoRadius.md),
            border = BorderStroke(1.dp, c.border),
            modifier = Modifier.fillMaxWidth().clickable {
                model.selfHostedOpen = !model.selfHostedOpen
            },
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                Icon(
                    if (model.selfHostedOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = c.textSecondary,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    localization.localizedText("sync.hosted.useMyOwnServer"),
                    style = FutoType.body,
                    color = c.textPrimary,
                )
            }
        }
        if (model.selfHostedOpen) {
            SelfHostedSyncSections(store = store, sync = sync)
        }
    }
}

/**
 * The Activity behind a Compose `LocalContext`, which may be a ContextWrapper
 * chain rather than the Activity itself.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** The title and explanation every wizard step opens with. */
@Composable
fun ColumnScope.HostedStepHeader(title: String, explanation: String) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    Text(localization.localizedText(title), style = FutoType.title, color = c.textPrimary)
    Text(
        localization.localizedText(explanation),
        style = FutoType.small,
        color = c.textSecondary,
    )
}

@Composable
private fun ColumnScope.HostedBannerCard(
    title: String,
    explanation: String,
    action: String,
    busy: Boolean,
    onAction: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    Surface(
        color = c.surfaceSunken,
        shape = RoundedCornerShape(FutoRadius.md),
        border = BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(localization.localizedText(title), style = FutoType.title, color = c.textPrimary)
            Text(
                localization.localizedText(explanation),
                style = FutoType.small,
                color = c.textSecondary,
            )
            OutlinedButton(
                enabled = !busy,
                shape = RoundedCornerShape(FutoRadius.md),
                onClick = onAction,
            ) {
                Text(localization.localizedText(action), color = c.textAccent)
            }
        }
    }
}
