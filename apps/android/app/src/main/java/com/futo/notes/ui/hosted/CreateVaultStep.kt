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
 * Choose the password that encrypts this vault.
 *
 * [minimumLength] is Rust's own minimum, read through the FFI, so this screen
 * and the engine cannot disagree about what a long-enough password is. The
 * strength readout is advice on top of that one rule — there are no composition
 * rules (ADR 0003, decision 7).
 */
@Composable
fun ColumnScope.CreateVaultStep(
    minimumLength: Int,
    busy: Boolean,
    onCreate: (String) -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var password by remember { mutableStateOf("") }
    var repeated by remember { mutableStateOf("") }

    val strength = vaultPasswordStrength(password, minimumLength)
    val strengthLabel = if (strength == VaultPasswordStrength.TOO_SHORT) {
        localization.localizedText(
            "sync.hosted.createVault.strength.tooShort",
            mapOf("minimum" to minimumLength),
        )
    } else {
        localization.localizedText("sync.hosted.createVault.strength.${strength.catalogSuffix}")
    }
    val typedLength = password.codePointCount(0, password.length)
    val ready = typedLength >= minimumLength && repeated == password && !busy

    HostedStepHeader(
        title = "sync.hosted.createVault.title",
        explanation = "sync.hosted.createVault.body",
    )

    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text(localization.localizedText("sync.hosted.createVault.label")) },
        placeholder = {
            Text(
                localization.localizedText(
                    "sync.hosted.createVault.placeholder",
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
        label = { Text(localization.localizedText("sync.hosted.createVault.repeatLabel")) },
        placeholder = {
            Text(localization.localizedText("sync.hosted.createVault.repeatPlaceholder"))
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
            localization.localizedText("sync.hosted.createVault.mismatch"),
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
        onClick = { onCreate(password) },
    ) {
        Text(
            if (busy) {
                localization.localizedText("sync.working")
            } else {
                localization.localizedText("sync.hosted.createVault.button")
            },
        )
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
