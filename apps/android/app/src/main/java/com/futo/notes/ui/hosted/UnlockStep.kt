package com.futo.notes.ui.hosted

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.PairingState
import com.futo.notes.sync.hosted.UnlockDoor
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The three doors into an existing vault, all on one screen so a person picks
 * whichever they can do right now (parent spec user story 19).
 *
 * The door is chosen through a callback rather than written directly because
 * leaving the scan door has to stop a live pairing wait, which only the model
 * can do.
 */
@Composable
fun ColumnScope.UnlockStep(
    door: UnlockDoor,
    busy: Boolean,
    pairing: PairingState,
    pairingPayload: String?,
    pairingExpiresAt: String?,
    onDoor: (UnlockDoor) -> Unit,
    onVaultPassword: suspend (String) -> Unit,
    onRecoveryKey: suspend (String) -> Unit,
    onShowPairingCode: suspend () -> Unit,
    onCancelPairing: () -> Unit,
    /** Runs the taps: the section's scope, because a step's own work ends the step. */
    scope: CoroutineScope,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var vaultPassword by remember { mutableStateOf("") }
    var typedRecoveryKey by remember { mutableStateOf("") }

    // The open door's field is the Unlock button's one argument, typed in as a person
    // would. The scan door's own controls are ShowPairingCode's.
    PuppetVerbScope {
        buildList {
            add(
                PuppetVerb("SelectUnlockMethod", required = listOf("method")) { arguments ->
                    val method = arguments.getString("method")
                    val chosen = UnlockDoor.entries.firstOrNull { unlockMethod(it) == method }
                        ?: throw PuppetVerbRefusal(400, "method is vaultPassword, recoveryKey or anotherDevice")
                    onDoor(chosen)
                },
            )
            if (door != UnlockDoor.SCAN) {
                val field = if (door == UnlockDoor.VAULT_PASSWORD) "vaultPassword" else "recoveryKey"
                add(
                    PuppetVerb(
                        "UnlockVault",
                        required = listOf(field),
                        controls = listOf(
                            "sync.hosted.unlock.vaultPasswordLabel",
                            "sync.hosted.unlock.recoveryKeyLabel",
                            "sync.hosted.unlock.button",
                            "sync.working",
                        ),
                    ) { arguments ->
                        refuseWhileBusy(busy)
                        val typed = arguments.getString(field)
                        if (door == UnlockDoor.VAULT_PASSWORD) {
                            vaultPassword = typed
                            onVaultPassword(typed)
                        } else {
                            typedRecoveryKey = typed
                            onRecoveryKey(typed)
                        }
                    },
                )
            }
        }
    }

    HostedStepHeader(
        title = "sync.hosted.unlock.title",
        explanation = "sync.hosted.unlock.body",
    )

    UnlockDoor.entries.forEach { option ->
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .selectable(
                    selected = door == option,
                    role = Role.RadioButton,
                    onClick = { onDoor(option) },
                ),
        ) {
            RadioButton(selected = door == option, onClick = null)
            Text(
                localization.localizedText("sync.hosted.unlock.doors.${option.catalogSuffix}"),
                style = FutoType.body,
                color = c.textPrimary,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }

    when (door) {
        UnlockDoor.VAULT_PASSWORD -> {
            OutlinedTextField(
                value = vaultPassword,
                onValueChange = { vaultPassword = it },
                label = {
                    Text(localization.localizedText("sync.hosted.unlock.vaultPasswordLabel"))
                },
                placeholder = {
                    Text(localization.localizedText("sync.hosted.unlock.vaultPasswordPlaceholder"))
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
            UnlockButton(busy = busy, enabled = vaultPassword.isNotEmpty()) {
                scope.launch { onVaultPassword(vaultPassword) }
            }
        }
        UnlockDoor.SCAN -> ShowPairingCode(
            pairing = pairing,
            payload = pairingPayload,
            expiresAt = pairingExpiresAt,
            busy = busy,
            onShow = onShowPairingCode,
            onCancel = onCancelPairing,
            scope = scope,
        )
        UnlockDoor.RECOVERY_KEY -> {
            OutlinedTextField(
                value = typedRecoveryKey,
                onValueChange = { typedRecoveryKey = it },
                label = { Text(localization.localizedText("sync.hosted.unlock.recoveryKeyLabel")) },
                placeholder = {
                    Text(localization.localizedText("sync.hosted.unlock.recoveryKeyPlaceholder"))
                },
                singleLine = true,
                // A recovery key is not prose: the IME must not capitalize or
                // autocorrect it. Case and dashes are forgiven by the engine,
                // but a substituted word is not.
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    autoCorrectEnabled = false,
                    capitalization = KeyboardCapitalization.Characters,
                ),
                shape = RoundedCornerShape(FutoRadius.md),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                localization.localizedText("sync.hosted.unlock.recoveryKeyHint"),
                style = FutoType.caption,
                color = c.textSecondary,
            )
            UnlockButton(busy = busy, enabled = typedRecoveryKey.isNotEmpty()) {
                scope.launch { onRecoveryKey(typedRecoveryKey) }
            }
        }
    }
}

@Composable
private fun UnlockButton(busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    Button(
        enabled = enabled && !busy,
        colors = ButtonDefaults.buttonColors(
            containerColor = c.accent,
            contentColor = Color.White,
        ),
        shape = RoundedCornerShape(FutoRadius.md),
        onClick = onClick,
    ) {
        Text(
            if (busy) {
                localization.localizedText("sync.working")
            } else {
                localization.localizedText("sync.hosted.unlock.button")
            },
        )
    }
}

/** What the agent calls each door: SCAN is THIS device showing a code for another to
 *  scan, which a name with "scan" in it would read backwards. */
private fun unlockMethod(door: UnlockDoor): String = when (door) {
    UnlockDoor.VAULT_PASSWORD -> "vaultPassword"
    UnlockDoor.RECOVERY_KEY -> "recoveryKey"
    UnlockDoor.SCAN -> "anotherDevice"
}
