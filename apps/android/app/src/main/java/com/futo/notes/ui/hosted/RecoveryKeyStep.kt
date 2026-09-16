package com.futo.notes.ui.hosted

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * The recovery key, shown exactly once.
 *
 * Rust returns it from `createVault` and keeps no copy, the model holds it only
 * while this screen is up, and continuing past here ends it — so there is no way
 * to ask for it again (ADR 0003, decision 3). Copy and the system share sheet
 * are the two ways off the device; the checkbox gates Continue, and there is no
 * type-back.
 */
@Composable
fun ColumnScope.RecoveryKeyStep(
    recoveryKey: String,
    saved: Boolean,
    busy: Boolean,
    onSavedChange: (Boolean) -> Unit,
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onContinue: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current

    HostedStepHeader(
        title = "sync.hosted.recoveryKey.title",
        explanation = "sync.hosted.recoveryKey.body",
    )

    Surface(
        color = c.surfaceSunken,
        shape = RoundedCornerShape(FutoRadius.md),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            recoveryKey,
            style = FutoType.body.copy(fontFamily = FontFamily.Monospace),
            color = c.textPrimary,
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 14.dp)
                .semantics {
                    contentDescription = localization.localizedText(
                        "sync.hosted.recoveryKey.accessibilityLabel",
                    ) + ": " + recoveryKey
                },
        )
    }

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = onCopy,
        ) {
            Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = c.textSecondary)
            Text(
                localization.localizedText("sync.hosted.recoveryKey.copy"),
                color = c.textSecondary,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
        OutlinedButton(
            enabled = !busy,
            shape = RoundedCornerShape(FutoRadius.md),
            onClick = onShare,
        ) {
            Icon(Icons.Filled.Share, contentDescription = null, tint = c.textSecondary)
            Text(
                localization.localizedText("sync.hosted.recoveryKey.share"),
                color = c.textSecondary,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }

    Text(
        localization.localizedText("sync.hosted.recoveryKey.warning"),
        style = FutoType.small,
        color = c.danger,
    )
    Text(
        localization.localizedText("sync.hosted.recoveryKey.shownOnce"),
        style = FutoType.small,
        color = c.textSecondary,
    )

    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = saved, onCheckedChange = onSavedChange)
        Text(
            localization.localizedText("sync.hosted.recoveryKey.confirmSaved"),
            style = FutoType.body,
            color = c.textPrimary,
        )
    }

    Button(
        enabled = saved && !busy,
        colors = ButtonDefaults.buttonColors(
            containerColor = c.accent,
            contentColor = Color.White,
        ),
        shape = RoundedCornerShape(FutoRadius.md),
        onClick = onContinue,
    ) {
        Text(localization.localizedText("sync.hosted.recoveryKey.continue"))
    }
}
