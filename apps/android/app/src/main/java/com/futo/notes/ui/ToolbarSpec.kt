// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/toolbar.ts (@futo-notes/editor).
// Regenerate: `just toolbar-spec`. `just toolbar-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

package com.futo.notes.ui

/**
 * What tapping a toolbar item does. `Exec` dispatches
 * `FutoEditor.exec(item.id)` over the bridge into the SHARED
 * markdownToolbar.ts command (TOOLBAR_EXEC) — the native toolbar never
 * reimplements editing semantics, so behavior is identical to the web
 * toolbar by construction.
 */
sealed interface ToolbarItemAction {
    object Exec : ToolbarItemAction
    data class PickImage(val source: String) : ToolbarItemAction
    object Dismiss : ToolbarItemAction
}

data class ToolbarItemSpec(
    val id: String,
    /** Accessibility label — same text as the web toolbar's aria-label. */
    val localizationPath: String,
    /** Material Symbols name; EditorToolbar.kt maps it to an ImageVector. */
    val material: String,
    /** Only visible while the cursor is on a list line (bridge cursorContext). */
    val onlyOnListLine: Boolean,
    val action: ToolbarItemAction,
)

object ToolbarSpec {
    /** The scrollable toolbar body; groups render with a separator between. */
    val groups: List<List<ToolbarItemSpec>> = listOf(
        listOf(
            ToolbarItemSpec(
                id = "bold",
                localizationPath = "editor.toolbar.bold",
                material = "format_bold",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "italic",
                localizationPath = "editor.toolbar.italic",
                material = "format_italic",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "strikethrough",
                localizationPath = "editor.toolbar.strikethrough",
                material = "format_strikethrough",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "link",
                localizationPath = "editor.toolbar.link",
                material = "link",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "heading",
                localizationPath = "editor.toolbar.heading",
                material = "format_h1",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "quote",
                localizationPath = "editor.toolbar.blockQuote",
                material = "format_quote",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "bullet-list",
                localizationPath = "editor.toolbar.bulletList",
                material = "format_list_bulleted",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "ordered-list",
                localizationPath = "editor.toolbar.orderedList",
                material = "format_list_numbered",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "task-list",
                localizationPath = "editor.toolbar.taskList",
                material = "checklist",
                onlyOnListLine = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "outdent",
                localizationPath = "editor.toolbar.outdent",
                material = "format_indent_decrease",
                onlyOnListLine = true,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "indent",
                localizationPath = "editor.toolbar.indent",
                material = "format_indent_increase",
                onlyOnListLine = true,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "camera",
                localizationPath = "editor.toolbar.takePhoto",
                material = "photo_camera",
                onlyOnListLine = false,
                action = ToolbarItemAction.PickImage(source = "camera"),
            ),
            ToolbarItemSpec(
                id = "image",
                localizationPath = "editor.toolbar.chooseFromLibrary",
                material = "image",
                onlyOnListLine = false,
                action = ToolbarItemAction.PickImage(source = "library"),
            ),
        ),
    )

    /** The fixed (non-scrolling) collapse chevron at the right edge. */
    val dismiss = ToolbarItemSpec(
        id = "dismiss",
        localizationPath = "editor.toolbar.dismissKeyboard",
        material = "keyboard_hide",
        onlyOnListLine = false,
        action = ToolbarItemAction.Dismiss,
    )
}
