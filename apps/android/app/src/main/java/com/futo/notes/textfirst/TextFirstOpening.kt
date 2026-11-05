package com.futo.notes.textfirst

import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoTheme
import kotlinx.coroutines.delay

/** No loading UI for a wait shorter than this: a flash of it feels slower than a short blank. */
internal const val OPENING_INDICATOR_DELAY_MS = 300L

/**
 * Over the top of the note while it opens: after [OPENING_INDICATOR_DELAY_MS],
 * a thin indeterminate line, over faint placeholder lines until any text shows.
 * The line stays until the note can be edited. It overlays the text rather
 * than pushing it down, so it comes and goes without moving anything.
 */
@Composable
internal fun TextFirstOpening(controller: TextFirstController, modifier: Modifier = Modifier) {
    val opening = !controller.opened && controller.openFailure == null
    var late by remember(controller) { mutableStateOf(false) }
    LaunchedEffect(controller, opening) {
        if (opening) {
            delay(OPENING_INDICATOR_DELAY_MS)
            late = true
        }
    }
    if (!opening || !late) return
    val c = FutoTheme.colors
    val context = LocalContext.current
    val animates = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
    }
    val label = LocalLocalization.current.localizedText("editor.progressiveLoad.opening")
    Column(modifier.fillMaxWidth()) {
        val line = Modifier.fillMaxWidth().height(3.dp).semantics {
            contentDescription = label
            progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
        }
        if (animates) {
            LinearProgressIndicator(line, color = c.accent, trackColor = c.border)
        } else {
            // Reduced motion: a still segment says the same without moving.
            Box(line.background(c.border)) {
                Box(Modifier.fillMaxWidth(0.4f).height(3.dp).background(c.accent))
            }
        }
        if (controller.isEmpty) {
            val ghost = RoundedCornerShape(3.dp)
            Column(Modifier.padding(horizontal = 18.dp, vertical = 14.dp)) {
                for ((index, width) in listOf(0.46f, 0.88f, 0.4f, 0.8f).withIndex()) {
                    if (index == 2) Spacer(Modifier.height(10.dp))
                    Box(Modifier.fillMaxWidth(width).height(9.dp).background(c.border, ghost))
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }
}
