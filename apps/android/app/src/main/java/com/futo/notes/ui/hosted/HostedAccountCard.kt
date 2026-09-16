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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.subscriptionStateMessage
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
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
    busy: Boolean,
    onManage: () -> Unit,
    onSignOut: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var confirmingSignOut by remember { mutableStateOf(false) }

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

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = onManage,
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
                    onSignOut()
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
