package com.futo.notes.textfirst

import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Constraints
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import kotlinx.coroutines.launch
import com.futo.notes.ui.EditorToolbar
import com.futo.notes.ui.ToolbarItemAction
import com.futo.notes.ui.ToolbarSpec
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorInlineFormat


/**
 * The keyboard toolbar, shown while the editor has focus and the keyboard is
 * up. Its own composable so the keyboard's per-frame inset animation
 * recomposes only this slot, not the whole note screen (measured: the screen
 * recomposing every animation frame dominated keyboard open/close).
 *
 * Composed once the note has opened and kept, unplaced, while it is hidden.
 * Composed with the keyboard, it held the keyboard's first animation frame for
 * 50-100 ms; composed at the tap, it held the main thread past the moment the
 * keyboard was ready to rise. Either way the keyboard stalled before it moved.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TextFirstToolbarSlot(controller: TextFirstController, onPickImage: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var draft by remember(controller) { mutableStateOf<LinkDraft?>(null) }
    var opening by remember(controller) { mutableStateOf(false) }
    // An open cell carries the note's own toolbar too: the field, not the note view, holds focus then (the find bar may
    // step onto a cell without its field having the keyboard: no bar then).
    val cellOpen = controller.cellView != null && controller.cellFocused
    val visible = (cellOpen || controller.focused) && WindowInsets.isImeVisible
    var composed by remember(controller) { mutableStateOf(false) }
    LaunchedEffect(controller.opened, controller.focused) { if (controller.opened || controller.focused) composed = true }
    // A hidden bar is never told a finger lifted, so a press or drag it hid under stayed live in it: a button drawn
    // pressed, a bar that no longer scrolled. Hidden under a touch, it is composed anew, as every bar once was.
    var touched by remember { mutableStateOf(false) }
    var generation by remember { mutableIntStateOf(0) }
    // Each opening starts at the leading items. Above user input, so it also ends a fling or a drag the hiding
    // interrupted (a drag outranks a plain scrollTo, which it would refuse).
    val scroll = rememberScrollState()
    LaunchedEffect(visible) {
        if (visible) return@LaunchedEffect
        if (touched) {
            touched = false
            generation++
        }
        scroll.scroll(MutatePriority.PreventUserInput) { scrollBy(-scroll.value.toFloat()) }
    }
    suspend fun openLink() {
        if (opening || draft != null) return
        opening = true
        try { draft = controller.linkDraft() } finally { opening = false }
    }
    DisposableEffect(controller) {
        controller.view.keyHooks.link = { if (controller.opened) scope.launch { openLink() } }
        onDispose { controller.view.keyHooks.link = null }
    }
    PuppetVerbScope {
        if (!visible || !controller.opened || opening || draft != null) emptyList() else listOf(
            PuppetVerb("OpenLink") { openLink() },
        ) + if (cellOpen) listOf(PuppetVerb("FinishTableCell") { controller.finishCellEditing() }) else emptyList()
    }
    val caret = controller.caret
    if (composed || visible) key(generation) { EditorToolbar(
        modifier = (if (visible) Modifier else measuredWithoutSpace).pointerInput(Unit) {
            awaitPointerEventScope { while (true) touched = awaitPointerEvent(PointerEventPass.Initial).changes.any { it.pressed } }
        },
        scrollState = scroll,
        onListLine = caret.list != null,
        inContainer = true,
        // Until the whole open lands the note shows read-only: nothing edits it.
        // Block items and pictures cannot go in a cell: the engine does not dim them there, so the host does.
        disabledFormats = (if (controller.opened) caret.disabled else editItems) + if (cellOpen) cellDisabledItems else emptySet(),
        activeFormats = toolbarActive(caret),
        hiddenItems = setOf("paragraph"),
        perform = { item ->
            // A grip's menu is showing: the toolbar behind it is inert.
            if (!controller.gripMenuShowing) when (val action = item.action) {
                ToolbarItemAction.Exec -> if (cellOpen && item.id in cellDisabledItems) Unit
                    else if (item.id == "link") scope.launch { openLink() } else runToolbar(controller, item.id)
                is ToolbarItemAction.PickImage -> if (!cellOpen) onPickImage(action.source)
                ToolbarItemAction.Dismiss -> { if (cellOpen) controller.finishCellEditing(); controller.view.hideKeyboard() }
            }
        },
    ) }
    draft?.let { claim ->
        TextFirstLinkDialog(
            draft = claim,
            onSubmit = { label, destination -> controller.editLink(claim, label, destination) },
            onRemove = { controller.removeLink(claim) },
            onDismiss = { draft = null; controller.cellView?.showKeyboard() ?: controller.view.showKeyboard() },
        )
    }
}


/** Measured, so showing it lays nothing out again, but given no space, never placed or drawn, and hidden from accessibility. */
private val measuredWithoutSpace = Modifier.clearAndSetSemantics {}.layout { measurable, constraints ->
    // Not the height left over: another field's keyboard changes that on every frame of its animation.
    measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
    layout(0, 0) {}
}

/** Toolbar ids that are dimmed and inert in a table cell: headings, quote, code block, lists, indent and pictures. */
private val cellDisabledItems: Set<String> = setOf(
    "paragraph", "heading-1", "heading-2", "heading-3", "quote", "code-block", "bullet-list", "ordered-list",
    "task-list", "indent", "outdent", "camera", "image",
)

/** Every toolbar item that changes the note: all but Dismiss. */
private val editItems: Set<String> = ToolbarSpec.groups.flatten()
    .filter { it.action != ToolbarItemAction.Dismiss }.mapTo(mutableSetOf()) { it.id }

/** The toolbar ids lit at the caret (ToolbarSpec ids). */
internal fun toolbarActive(caret: CaretState): Set<String> = buildSet {
    if (EditorInlineFormat.BOLD in caret.formats) add("bold")
    if (EditorInlineFormat.ITALIC in caret.formats) add("italic")
    if (EditorInlineFormat.STRIKE in caret.formats) add("strikethrough")
    when {
        caret.code -> add("code-block")
        caret.heading in 1..3 -> add("heading-${caret.heading}")
        !caret.mixed && caret.list == null && !caret.quote -> add("paragraph")
    }
    if (caret.quote) add("quote")
    when (caret.list) {
        ListMarker.Bullet -> add("bullet-list")
        ListMarker.Ordered -> add("ordered-list")
        ListMarker.Task -> add("task-list")
        null -> Unit
    }
}

/** Toolbar item → engine command. The engine owns every rule; this is a name map. */
internal fun runToolbar(controller: TextFirstController, id: String) {
    when (id) {
        "undo" -> controller.undo()
        "redo" -> controller.redo()
        "bold" -> controller.toolbarFormat(EditorInlineFormat.BOLD)
        "italic" -> controller.toolbarFormat(EditorInlineFormat.ITALIC)
        "strikethrough" -> controller.toolbarFormat(EditorInlineFormat.STRIKE)
        "paragraph" -> controller.block(EditorBlockCommand.Heading(0u))
        "heading-1" -> controller.block(EditorBlockCommand.ToggleHeading(1u))
        "heading-2" -> controller.block(EditorBlockCommand.ToggleHeading(2u))
        "heading-3" -> controller.block(EditorBlockCommand.ToggleHeading(3u))
        "quote" -> controller.block(EditorBlockCommand.Quote)
        "code-block" -> controller.block(EditorBlockCommand.WrapCodeBlock)
        "bullet-list" -> controller.block(EditorBlockCommand.BulletList)
        "ordered-list" -> controller.block(EditorBlockCommand.OrderedList)
        "task-list" -> controller.block(EditorBlockCommand.TaskList)
        "indent" -> controller.block(EditorBlockCommand.Indent)
        "outdent" -> controller.block(EditorBlockCommand.Outdent)
    }
}
