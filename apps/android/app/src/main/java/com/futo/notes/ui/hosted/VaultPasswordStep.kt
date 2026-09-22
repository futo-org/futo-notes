package com.futo.notes.ui.hosted

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.VaultPasswordStrength
import com.futo.notes.sync.hosted.vaultPasswordStrength
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * Which of the two vault-password screens this is: the wizard's "choose one",
 * or the account card's "choose a new one". Everything below the heading is the
 * same either way — the minimum, the meter, the repeat field — so the two share
 * one composable rather than one copying the other.
 */
enum class VaultPasswordPurpose(val catalogSuffix: String) {
    CREATE("create"),
    CHANGE("change"),
}

/**
 * Choose the password that encrypts this vault.
 *
 * [minimumLength] is Rust's own minimum, read through the FFI, so this screen
 * and the engine cannot disagree about what a long-enough password is. The
 * strength readout is advice on top of that one rule — there are no composition
 * rules (ADR 0003, decision 7).
 *
 * The change screen asks for no current secret: this device already holds the
 * vault key, and a device paired by QR never knew the old password (ADR 0003,
 * decision 10).
 */
@Composable
fun ColumnScope.VaultPasswordStep(
    purpose: VaultPasswordPurpose,
    minimumLength: Int,
    busy: Boolean,
    onCancel: (() -> Unit)? = null,
    onSubmit: (String) -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var password by remember { mutableStateOf("") }
    var repeated by remember { mutableStateOf("") }

    val strength = vaultPasswordStrength(password, minimumLength)
    val strengthLabel = if (strength == VaultPasswordStrength.TOO_SHORT) {
        localization.localizedText(
            "sync.hosted.vaultPassword.strength.tooShort",
            mapOf("minimum" to minimumLength),
        )
    } else {
        localization.localizedText("sync.hosted.vaultPassword.strength.${strength.catalogSuffix}")
    }
    val typedLength = password.codePointCount(0, password.length)
    val ready = typedLength >= minimumLength && repeated == password && !busy

    HostedStepHeader(
        title = "sync.hosted.vaultPassword.${purpose.catalogSuffix}.title",
        explanation = "sync.hosted.vaultPassword.${purpose.catalogSuffix}.body",
    )

    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text(localization.localizedText("sync.hosted.vaultPassword.label")) },
        placeholder = {
            Text(
                localization.localizedText(
                    "sync.hosted.vaultPassword.placeholder",
                    mapOf("minimum" to minimumLength),
                ),
            )
        },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        // PasswordVisualTransformation masks only the DISPLAY; without these the
        // IME autocapitalizes and autocorrects, so the bytes that reach the
        // engine differ from what was typed (the same trap SyncScreen hit).
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            autoCorrectEnabled = false,
            capitalization = KeyboardCapitalization.None,
        ),
        shape = RoundedCornerShape(FutoRadius.md),
        modifier = Modifier.fillMaxWidth(),
    )

    Row(verticalAlignment = Alignment.CenterVertically) {
        LinearProgressIndicator(
            progress = { strengthFraction(strength) },
            color = strengthColor(strength, c.danger, c.accent, c.success),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        Text(strengthLabel, style = FutoType.small, color = c.textSecondary)
    }

    OutlinedTextField(
        value = repeated,
        onValueChange = { repeated = it },
        label = { Text(localization.localizedText("sync.hosted.vaultPassword.repeatLabel")) },
        placeholder = {
            Text(localization.localizedText("sync.hosted.vaultPassword.repeatPlaceholder"))
        },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            autoCorrectEnabled = false,
            capitalization = KeyboardCapitalization.None,
        ),
        shape = RoundedCornerShape(FutoRadius.md),
        modifier = Modifier.fillMaxWidth(),
    )

    if (repeated.isNotEmpty() && repeated != password) {
        Text(
            localization.localizedText("sync.hosted.vaultPassword.mismatch"),
            style = FutoType.small,
            color = c.danger,
        )
    }

    Button(
        enabled = ready,
        colors = ButtonDefaults.buttonColors(
            containerColor = c.accent,
            contentColor = Color.White,
        ),
        shape = RoundedCornerShape(FutoRadius.md),
        onClick = { onSubmit(password) },
    ) {
        Text(
            if (busy) {
                localization.localizedText("sync.working")
            } else {
                localization.localizedText(
                    "sync.hosted.vaultPassword.${purpose.catalogSuffix}.button",
                )
            },
        )
    }

    // Only the change screen offers a way back; the wizard has none.
    if (onCancel != null) {
        TextButton(onClick = onCancel) {
            Text(localization.localizedText("sync.hosted.cancel"), color = c.textSecondary)
        }
    }
}

private fun strengthFraction(strength: VaultPasswordStrength): Float = when (strength) {
    VaultPasswordStrength.TOO_SHORT -> 0.1f
    VaultPasswordStrength.WEAK -> 0.35f
    VaultPasswordStrength.FAIR -> 0.7f
    VaultPasswordStrength.STRONG -> 1f
}

private fun strengthColor(
    strength: VaultPasswordStrength,
    danger: Color,
    accent: Color,
    success: Color,
): Color = when (strength) {
    VaultPasswordStrength.TOO_SHORT, VaultPasswordStrength.WEAK -> danger
    VaultPasswordStrength.FAIR -> accent
    VaultPasswordStrength.STRONG -> success
}
