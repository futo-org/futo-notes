package com.futo.notes.ui.hosted

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.sync.hosted.PairingState
import com.futo.notes.sync.hosted.formatPairingCountdown
import com.futo.notes.sync.hosted.pairingCodeMatrix
import com.futo.notes.sync.hosted.pairingSecondsRemaining
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.delay

/**
 * The scan door on the unlock screen: this device is the NEW one, so it draws a
 * code for an already-unlocked device to read (parent spec user story 13).
 *
 * Four states, each one Rust's answer rendered and nothing this composable
 * decided: **waiting** (the code, a live countdown to the relay's own
 * `expires_at`, and Cancel), **received** (the key arrived and the vault is
 * unlocked), **expired**, and **refused**. Showing a code again mints a new
 * one, because a live code cannot be withdrawn.
 */
@Composable
fun ColumnScope.ShowPairingCode(
    pairing: PairingState,
    /** The payload to draw, straight from Rust. */
    payload: String?,
    /** RFC 3339, the relay's own deadline. */
    expiresAt: String?,
    busy: Boolean,
    onShow: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current

    when (pairing) {
        PairingState.WAITING -> {
            HostedStepHeader(
                title = "sync.hosted.pairing.title",
                explanation = "sync.hosted.pairing.body",
            )
            payload?.let { PairingCodeImage(it) }
            expiresAt?.let { PairingCountdownLine(it) }
            TextButton(onClick = onCancel) {
                Text(localization.localizedText("sync.hosted.cancel"), color = c.textSecondary)
            }
        }
        PairingState.RECEIVED -> HostedStepHeader(
            title = "sync.hosted.pairing.received.title",
            explanation = "sync.hosted.pairing.android.received.body",
        )
        PairingState.EXPIRED -> {
            HostedStepHeader(
                title = "sync.hosted.pairing.expired.title",
                explanation = "sync.hosted.pairing.expired.body",
            )
            ShowCodeButton("sync.hosted.pairing.showNewCode", busy, onShow)
        }
        PairingState.REFUSED -> {
            HostedStepHeader(
                title = "sync.hosted.pairing.refused.title",
                explanation = "sync.hosted.pairing.refused.body",
            )
            ShowCodeButton("sync.hosted.pairing.showNewCode", busy, onShow)
        }
        PairingState.IDLE -> {
            Text(
                localization.localizedText("sync.hosted.pairing.body"),
                style = FutoType.small,
                color = c.textSecondary,
            )
            ShowCodeButton("sync.hosted.pairing.showCode", busy, onShow)
        }
    }
}

/**
 * The code itself. Fixed black on white whatever the theme is, deliberately: a
 * camera reads dark modules on a light field, so theming this would break the
 * one thing it is for. The quiet zone travels inside the bitmap, and
 * [FilterQuality.None] keeps the modules square instead of smoothing one pixel
 * per module into mush.
 */
@Composable
private fun ColumnScope.PairingCodeImage(payload: String) {
    val localization = LocalLocalization.current
    val label = localization.localizedText("sync.hosted.pairing.android.codeAccessibilityLabel")
    val encoded: ImageBitmap? = remember(payload) {
        pairingCodeMatrix(payload)?.let { matrix ->
            val pixels = IntArray(matrix.size * matrix.size)
            for (row in 0 until matrix.size) {
                for (column in 0 until matrix.size) {
                    pixels[row * matrix.size + column] =
                        if (matrix.isDark(column, row)) BLACK else WHITE
                }
            }
            Bitmap.createBitmap(pixels, matrix.size, matrix.size, Bitmap.Config.ARGB_8888)
                .asImageBitmap()
        }
    }
    val code = encoded ?: return

    Image(
        painter = BitmapPainter(code, filterQuality = FilterQuality.None),
        contentDescription = null,
        modifier = Modifier
            .align(Alignment.CenterHorizontally)
            .size(240.dp)
            .semantics { contentDescription = label },
    )
}

/**
 * The clock on screen. It only describes the relay's deadline — `awaitPairing`
 * is rebuilt from the same timestamp and is the only thing that ends a wait, so
 * reaching 0:00 here means "Rust is about to say expired", never "this shell
 * decided it had". The reading is taken from the clock rather than counted down
 * by the loop, so the code shows its real remaining time on the frame it
 * appears instead of flashing 0:00 until the first tick.
 */
@Composable
private fun ColumnScope.PairingCountdownLine(expiresAt: String) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    var remaining by remember(expiresAt) {
        mutableIntStateOf(pairingSecondsRemaining(expiresAt))
    }
    LaunchedEffect(expiresAt) {
        while (true) {
            delay(1000)
            remaining = pairingSecondsRemaining(expiresAt)
        }
    }
    val clock = formatPairingCountdown(remaining)
    val spoken = localization.localizedText(
        "sync.hosted.pairing.expiresInAccessibilityLabel",
        mapOf("remaining" to clock),
    )
    Text(
        localization.localizedText(
            "sync.hosted.pairing.expiresIn",
            mapOf("remaining" to clock),
        ),
        style = FutoType.caption,
        color = c.textSecondary,
        modifier = Modifier.semantics { contentDescription = spoken },
    )
}

@Composable
private fun ColumnScope.ShowCodeButton(title: String, busy: Boolean, onShow: () -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    Button(
        enabled = !busy,
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        shape = RoundedCornerShape(FutoRadius.md),
        onClick = onShow,
    ) {
        Text(localization.localizedText(title))
    }
}

private const val BLACK = 0xFF000000.toInt()
private const val WHITE = 0xFFFFFFFF.toInt()
