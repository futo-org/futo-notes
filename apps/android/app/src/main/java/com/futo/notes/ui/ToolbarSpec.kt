// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/toolbar.ts (@futo-notes/editor).
// Regenerate: `just toolbar-spec`. `just toolbar-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

package com.futo.notes.ui

/**
 * What tapping a toolbar item does. `Exec` dispatches
 * `FutoEditor.exec(item.id)` over the bridge into the SHARED
 * toolbarExec.ts command — the native toolbar never
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
    val label: String,
    /** Material Symbols name; EditorToolbar.kt maps it to an ImageVector. */
    val text: String?,
    val material: String,
    /** Only visible in a list or quote (cursorContext and formatState). */
    val onlyInContainer: Boolean,
    val action: ToolbarItemAction,
)

object ToolbarSpec {
    /** The scrollable toolbar body; groups render with a separator between. */
    val groups: List<List<ToolbarItemSpec>> = listOf(
        listOf(
            ToolbarItemSpec(
                id = "bold",
                label = "Bold",
                text = null,
                material = "format_bold",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "italic",
                label = "Italic",
                text = null,
                material = "format_italic",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "strikethrough",
                label = "Strikethrough",
                text = null,
                material = "format_strikethrough",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "link",
                label = "Link",
                text = null,
                material = "link",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "paragraph",
                label = "Text",
                text = "Text",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "heading-1",
                label = "Heading 1",
                text = "H1",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "heading-2",
                label = "Heading 2",
                text = "H2",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "heading-3",
                label = "Heading 3",
                text = "H3",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "quote",
                label = "Block quote",
                text = null,
                material = "format_quote",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "bullet-list",
                label = "Bullet list",
                text = null,
                material = "format_list_bulleted",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "ordered-list",
                label = "Ordered list",
                text = null,
                material = "format_list_numbered",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "task-list",
                label = "Task list",
                text = null,
                material = "checklist",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "outdent",
                label = "Outdent",
                text = null,
                material = "format_indent_decrease",
                onlyInContainer = true,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "indent",
                label = "Indent",
                text = null,
                material = "format_indent_increase",
                onlyInContainer = true,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "camera",
                label = "Take photo",
                text = null,
                material = "photo_camera",
                onlyInContainer = false,
                action = ToolbarItemAction.PickImage(source = "camera"),
            ),
            ToolbarItemSpec(
                id = "image",
                label = "Choose from library",
                text = null,
                material = "image",
                onlyInContainer = false,
                action = ToolbarItemAction.PickImage(source = "library"),
            ),
        ),
    )

    /** The fixed (non-scrolling) collapse chevron at the right edge. */
    val dismiss = ToolbarItemSpec(
        id = "dismiss",
        label = "Dismiss keyboard",
        text = null,
        material = "keyboard_hide",
        onlyInContainer = false,
        action = ToolbarItemAction.Dismiss,
    )
}
