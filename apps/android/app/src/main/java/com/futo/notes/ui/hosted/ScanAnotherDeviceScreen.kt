package com.futo.notes.ui.hosted

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.sync.hosted.HostedSetupModel
import com.futo.notes.sync.hosted.PairingCameraAccess
import com.futo.notes.sync.hosted.ScanPhase
import com.futo.notes.sync.hosted.ScannedPairing
import com.futo.notes.sync.hosted.pairingCameraAccess
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch

/**
 * "Scan another device" on an already-unlocked device: the camera, one
 * confirmation naming the device that showed the code, and Send (parent spec
 * user stories 15 and 16).
 *
 * A device with no camera, or one whose camera this app may not use, is not a
 * dead end: it says so and points at the door that is still open — typing the
 * vault password on the device being set up (ADR 0003, decision 5).
 *
 * The CAMERA permission is asked for **here**, as this screen opens, and
 * nowhere earlier: the moment of use is the only moment the request explains
 * itself.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanAnotherDeviceScreen(model: HostedSetupModel, onBack: () -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var askedAlready by remember { mutableStateOf(false) }
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    // Recomputed after every answer, because "refused but we may ask again" and
    // "refused for good" differ only in what the system says about a rationale.
    var rationale by remember { mutableStateOf(shouldExplainCamera(context)) }
    val hasCamera = remember {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        askedAlready = true
        rationale = shouldExplainCamera(context)
    }

    val access = pairingCameraAccess(hasCamera, granted, askedAlready, rationale)

    // The camera permission is requested at the moment of use: opening this
    // screen IS that moment.
    LaunchedEffect(access) {
        if (access == PairingCameraAccess.ASK) ask.launch(Manifest.permission.CAMERA)
    }

    Scaffold(
        containerColor = c.surface,
        topBar = {
            TopBar(
                title = {
                    Text(
                        localization.localizedText("sync.hosted.pairing.scan.title"),
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
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            model.errorMessage?.let { error ->
                Text(
                    localization.localizedText(error.path, error.arguments),
                    style = FutoType.small,
                    color = c.danger,
                )
            }

            when (access) {
                PairingCameraAccess.ASK -> CircularProgressIndicator(
                    Modifier.size(18.dp),
                    color = c.accent,
                    strokeWidth = 2.dp,
                )
                PairingCameraAccess.NO_CAMERA -> WithoutCamera(
                    title = "sync.hosted.pairing.scan.noCamera.title",
                    explanation = "sync.hosted.pairing.scan.noCamera.body",
                )
                PairingCameraAccess.RATIONALE -> {
                    WithoutCamera(
                        title = "sync.hosted.pairing.scan.android.rationale.title",
                        explanation = "sync.hosted.pairing.scan.android.rationale.body",
                    )
                    Button(
                        colors = ButtonDefaults.buttonColors(
                            containerColor = c.accent,
                            contentColor = Color.White,
                        ),
                        shape = RoundedCornerShape(FutoRadius.md),
                        onClick = { ask.launch(Manifest.permission.CAMERA) },
                    ) {
                        Text(
                            localization.localizedText(
                                "sync.hosted.pairing.scan.android.allowCamera",
                            ),
                        )
                    }
                }
                PairingCameraAccess.DENIED -> {
                    WithoutCamera(
                        title = "sync.hosted.pairing.scan.permissionDenied.title",
                        explanation = "sync.hosted.pairing.scan.permissionDenied.body",
                    )
                    OutlinedButton(
                        shape = RoundedCornerShape(FutoRadius.md),
                        onClick = { openAppSettings(context) },
                    ) {
                        Text(
                            localization.localizedText("sync.hosted.pairing.scan.openSettings"),
                            color = c.textSecondary,
                        )
                    }
                }
                PairingCameraAccess.READY -> {
                    val sent = model.scannedPairing
                    if (model.scanPhase == ScanPhase.SENT && sent != null) {
                        Text(
                            localization.localizedText("sync.hosted.pairing.scan.sent.title"),
                            style = FutoType.title,
                            color = c.textPrimary,
                        )
                        Text(
                            localization.localizedText(
                                "sync.hosted.pairing.scan.sent.body",
                                mapOf("device" to describe(sent, localization)),
                            ),
                            style = FutoType.small,
                            color = c.textSecondary,
                        )
                    } else {
                        Text(
                            localization.localizedText("sync.hosted.pairing.scan.body"),
                            style = FutoType.small,
                            color = c.textSecondary,
                        )
                        PairingScannerView(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(360.dp)
                                .clip(RoundedCornerShape(FutoRadius.md)),
                        ) { code -> scope.launch { model.readScannedCode(code) } }
                        if (model.scanPhase == ScanPhase.SENDING) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(
                                    Modifier.size(18.dp),
                                    color = c.accent,
                                    strokeWidth = 2.dp,
                                )
                                Spacer(Modifier.width(12.dp))
                                Text(
                                    localization.localizedText(
                                        "sync.hosted.pairing.scan.sending",
                                    ),
                                    style = FutoType.caption,
                                    color = c.textSecondary,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    val awaiting = model.scannedPairing
    if (model.scanPhase == ScanPhase.CONFIRMING && awaiting != null) {
        AlertDialog(
            onDismissRequest = { model.cancelConfirmation() },
            title = {
                Text(localization.localizedText("sync.hosted.pairing.scan.confirm.title"))
            },
            text = {
                Text(
                    localization.localizedText(
                        "sync.hosted.pairing.scan.confirm.body",
                        mapOf("device" to describe(awaiting, localization)),
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = { scope.launch { model.sendVaultKey() } }) {
                    Text(localization.localizedText("common.actions.send"))
                }
            },
            dismissButton = {
                TextButton(onClick = { model.cancelConfirmation() }) {
                    Text(localization.localizedText("common.actions.cancel"))
                }
            },
        )
    }
}

/** No camera, or no permission to use it — and the way through anyway. */
@Composable
private fun WithoutCamera(title: String, explanation: String) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    Text(localization.localizedText(title), style = FutoType.title, color = c.textPrimary)
    Text(
        localization.localizedText(explanation),
        style = FutoType.small,
        color = c.textSecondary,
    )
    Text(
        localization.localizedText("sync.hosted.pairing.scan.fallback"),
        style = FutoType.body,
        color = c.textPrimary,
    )
}

/**
 * The scanned device, as the confirmation names it: its self-reported name
 * verbatim, and its platform in words. An unrecognised platform is shown as it
 * came rather than as a missing catalog path.
 */
private fun describe(scanned: ScannedPairing, localization: Localization): String {
    val platform = if (scanned.platform in setOf("ios", "android", "desktop")) {
        localization.localizedText("sync.hosted.pairing.scan.confirm.platform.${scanned.platform}")
    } else {
        scanned.platform
    }
    return localization.localizedText(
        "sync.hosted.pairing.scan.confirm.device",
        mapOf("name" to scanned.deviceName, "platform" to platform),
    )
}

/**
 * Whether Android thinks the person is owed an explanation before being asked
 * again. False both before the first ask and after a final refusal, which is
 * why [pairingCameraAccess] is also told whether this screen has asked yet.
 */
private fun shouldExplainCamera(context: Context): Boolean {
    val activity = context.findActivity() ?: return false
    return ActivityCompat.shouldShowRequestPermissionRationale(
        activity,
        Manifest.permission.CAMERA,
    )
}

/** This app's entry in the system settings, where a final refusal is undone. */
private fun openAppSettings(context: Context) {
    context.startActivity(
        Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}
