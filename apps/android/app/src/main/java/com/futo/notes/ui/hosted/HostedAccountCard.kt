package com.futo.notes.ui.hosted

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.subscriptionStateMessage
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.BillingStatus

/**
 * What a signed-in device shows: who is signed in, the subscription in words,
 * storage used against the quota, the payment provider's portal, and Sign out.
 *
 * The app writes no billing state — cancellation, invoices, and cards live
 * behind the portal (ADR 0003, decision 8).
 */
@Composable
fun ColumnScope.HostedAccountCard(
    email: String,
    billing: BillingStatus?,
    /**
     * What this vault's sync session is doing, in words the sync screen already
     * uses. Shown here because the end of the wizard is a running sync: a card
     * that reported only the account would leave a person watching
     * `0 B of 10 GB used` with no sign anything had started.
     */
    syncStatus: String,
    busy: Boolean,
    onManage: suspend () -> Unit,
    onChangeVaultPassword: () -> Unit,
    onNewRecoveryKey: suspend () -> Unit,
    onScanAnotherDevice: () -> Unit,
    onSignOut: suspend () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val scope = rememberCoroutineScope()
    var confirmingSignOut by remember { mutableStateOf(false) }

    // Sign out asks first: the confirmation's own ConfirmDialog or DismissDialog answers it.
    PuppetVerbScope {
        if (confirmingSignOut) {
            listOf(
                PuppetVerb("ConfirmDialog", controls = listOf("sync.hosted.account.signOut")) {
                    confirmingSignOut = false
                    onSignOut()
                },
                PuppetVerb("DismissDialog", controls = listOf("common.actions.cancel")) {
                    confirmingSignOut = false
                },
            )
        } else {
            listOf(
                PuppetVerb("ManageSubscription", controls = listOf("sync.hosted.account.manageSubscription")) {
                    refuseWhileBusy(busy)
                    onManage()
                },
                PuppetVerb("OpenVaultPasswordChange", controls = listOf("sync.hosted.account.changeVaultPassword")) {
                    refuseWhileBusy(busy)
                    onChangeVaultPassword()
                },
                PuppetVerb("ReplaceRecoveryKey", controls = listOf("sync.hosted.account.newRecoveryKey")) {
                    refuseWhileBusy(busy)
                    onNewRecoveryKey()
                },
                PuppetVerb("OpenScanner", controls = listOf("sync.hosted.pairing.scan.action")) {
                    refuseWhileBusy(busy)
                    onScanAnotherDevice()
                },
                PuppetVerb(
                    "SignOutOfFuto",
                    optional = listOf("answer"),
                    controls = listOf("sync.hosted.account.signOut"),
                ) {
                    refuseWhileBusy(busy)
                    confirmingSignOut = true
                },
            )
        }
    }

    Text(
        localization.localizedText("sync.hosted.account.heading"),
        style = FutoType.title,
        color = c.textPrimary,
    )
    Text(email, style = FutoType.body, color = c.textPrimary)

    if (billing != null) {
        val state = subscriptionStateMessage(billing, localization::localizedRelativeTime)
        Text(
            localization.localizedText(state.path, state.arguments),
            style = FutoType.body,
            color = c.textSecondary,
        )
        Text(
            localization.localizedText(
                "sync.hosted.account.storage",
                mapOf(
                    "used" to localization.localizedFileSize(billing.bytesUsed.toLong()),
                    "quota" to localization.localizedFileSize(billing.storageQuotaBytes.toLong()),
                ),
            ),
            style = FutoType.small,
            color = c.textSecondary,
        )
    }

    Text(syncStatus, style = FutoType.small, color = c.textSecondary)

    // Neither asks for a current secret: this device already holds the vault
    // key, and one set up by scanning a code never knew the vault password
    // (ADR 0003, decision 10).
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = onChangeVaultPassword,
        ) {
            Text(
                localization.localizedText("sync.hosted.account.changeVaultPassword"),
                color = c.textSecondary,
            )
        }
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = { scope.launch { onNewRecoveryKey() } },
        ) {
            Text(
                localization.localizedText("sync.hosted.account.newRecoveryKey"),
                color = c.textSecondary,
            )
        }
    }

    // This device holds the vault key, so it is the one that can hand it to a
    // new device: phones scan, laptops show (ADR 0003, decision 5).
    OutlinedButton(
        enabled = !busy,
        shape = RoundedCornerShape(FutoRadius.md),
        onClick = onScanAnotherDevice,
    ) {
        Text(
            localization.localizedText("sync.hosted.pairing.scan.action"),
            color = c.textSecondary,
        )
    }

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = { scope.launch { onManage() } },
        ) {
            Text(
                localization.localizedText("sync.hosted.account.manageSubscription"),
                color = c.textSecondary,
            )
        }
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = { confirmingSignOut = true },
        ) {
            Text(localization.localizedText("sync.hosted.account.signOut"), color = c.danger)
        }
    }

    if (confirmingSignOut) {
        AlertDialog(
            onDismissRequest = { confirmingSignOut = false },
            title = { Text(localization.localizedText("sync.hosted.signOut.confirmationTitle")) },
            text = {
                Text(localization.localizedText("sync.hosted.signOut.android.confirmationBody"))
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingSignOut = false
                    scope.launch { onSignOut() }
                }) {
                    Text(
                        localization.localizedText("sync.hosted.account.signOut"),
                        color = c.danger,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingSignOut = false }) {
                    Text(localization.localizedText("common.actions.cancel"))
                }
            },
            modifier = Modifier,
        )
    }
}
