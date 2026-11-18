package com.futo.notes.textfirst

import android.graphics.Rect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.viewinterop.AndroidView
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetHostedField
import com.futo.notes.puppet.puppetHostedField

/** Compose hosts one stable native note window; native layout owns the optional cell field. */
@Composable
internal fun TextFirstNoteView(
    controller: TextFirstController,
    enabled: Boolean,
    onOpenWikilink: (String) -> Unit,
    onOpenUrl: (String) -> Boolean,
) {
    val host = remember(controller) { TextFirstTableCellHost(controller.view, controller::finishCellEditing) }
    var bounds by remember(host) { mutableStateOf<Rect?>(null) }
    val density = LocalDensity.current
    val localization = LocalLocalization.current
    val field = controller.cellView
    DisposableEffect(host) {
        host.onBoundsChanged = { bounds = it }
        onDispose { host.onBoundsChanged = {} }
    }
    AndroidView(factory = { host }, modifier = Modifier.fillMaxSize().nativeEditorField(controller),
        onRelease = { it.release() }, update = {
            controller.view.isEnabled = enabled
            controller.view.onOpenWikilink = onOpenWikilink
            controller.view.onOpenUrl = onOpenUrl
            field?.isEnabled = enabled
            it.setCell(field)
        })
    if (field != null) bounds?.let { rect ->
        // This noninteractive semantics proxy reads the real native field. It
        // does not position or paint it; TalkBack reads the native child itself.
        Box(Modifier.offset { IntOffset(rect.left, rect.top) }
            .size(with(density) { rect.width().toDp() }, with(density) { rect.height().toDp() })
            .puppetHostedField { PuppetHostedField(field.text.toString(), localization.localizedText("editor.table.editCell"), field.isFocused) })
    }
}
