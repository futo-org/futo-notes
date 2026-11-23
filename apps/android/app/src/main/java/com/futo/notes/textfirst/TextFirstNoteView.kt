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
import androidx.compose.runtime.rememberUpdatedState
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
    onOpenWikilink: (WikilinkDestination) -> Unit,
    onOpenUrl: (String) -> Boolean,
) {
    val localization = LocalLocalization.current
    val gripLabels by rememberUpdatedState(TableGripLabels(
        localization.localizedText("editor.table.addRowAbove"), localization.localizedText("editor.table.addRowBelow"),
        localization.localizedText("editor.table.deleteRow"), localization.localizedText("editor.table.addColumnLeft"),
        localization.localizedText("editor.table.addColumnRight"), localization.localizedText("editor.table.deleteColumn"),
        localization.localizedText("editor.table.deleteTable"),
        localization.localizedText("editor.tableGrips.rowOptionsAccessibilityLabel"),
        localization.localizedText("editor.tableGrips.columnOptionsAccessibilityLabel"),
    ))
    val host = remember(controller) {
        TextFirstTableCellHost(controller.view, controller::finishCellEditing, object : TableGripActions {
            override val labels get() = gripLabels
            override fun command(which: uniffi.futo_notes_ffi.EditorTableCommand) = controller.tableCommand(which)
            override fun deleteTable() {
                val hides = controller.view.keyboardHides
                controller.deleteTable()
                // The popup is still closing and takes the window's focus with it: the keyboard is asked for again once
                // it is gone, unless the table has come back (Undo opens its cell), the person has hidden the keyboard, or has
                // gone on to the title or Find field, which a refocus of the note would take the focus from.
                controller.view.postDelayed({
                    if (controller.cellView == null && controller.view.keyboardHides == hides && !controller.screenFieldFocused()) controller.view.showKeyboard()
                }, 400)
            }
            override fun menuShowing(showing: Boolean) { controller.gripMenuShowing = showing }
        })
    }
    var bounds by remember(host) { mutableStateOf<Rect?>(null) }
    val density = LocalDensity.current
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
