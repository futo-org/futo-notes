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
    val localizationPath: String,
    val text: String?,
    /** Material Symbols name; EditorToolbar.kt maps it to an ImageVector. */
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
                id = "undo",
                localizationPath = "editor.toolbar.undo",
                text = null,
                material = "undo",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "redo",
                localizationPath = "editor.toolbar.redo",
                text = null,
                material = "redo",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "bold",
                localizationPath = "editor.toolbar.bold",
                text = null,
                material = "format_bold",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "italic",
                localizationPath = "editor.toolbar.italic",
                text = null,
                material = "format_italic",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "strikethrough",
                localizationPath = "editor.toolbar.strikethrough",
                text = null,
                material = "format_strikethrough",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "link",
                localizationPath = "editor.toolbar.link",
                text = null,
                material = "link",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "paragraph",
                localizationPath = "editor.toolbar.paragraph",
                text = "Text",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "heading-1",
                localizationPath = "editor.toolbar.headingOne",
                text = "H1",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "heading-2",
                localizationPath = "editor.toolbar.headingTwo",
                text = "H2",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "heading-3",
                localizationPath = "editor.toolbar.headingThree",
                text = "H3",
                material = "format_h1",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "quote",
                localizationPath = "editor.toolbar.blockQuote",
                text = null,
                material = "format_quote",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "code-block",
                localizationPath = "editor.toolbar.codeBlock",
                text = null,
                material = "code",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "bullet-list",
                localizationPath = "editor.toolbar.bulletList",
                text = null,
                material = "format_list_bulleted",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "ordered-list",
                localizationPath = "editor.toolbar.orderedList",
                text = null,
                material = "format_list_numbered",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "task-list",
                localizationPath = "editor.toolbar.taskList",
                text = null,
                material = "checklist",
                onlyInContainer = false,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "outdent",
                localizationPath = "editor.toolbar.outdent",
                text = null,
                material = "format_indent_decrease",
                onlyInContainer = true,
                action = ToolbarItemAction.Exec,
            ),
            ToolbarItemSpec(
                id = "indent",
                localizationPath = "editor.toolbar.indent",
                text = null,
                material = "format_indent_increase",
                onlyInContainer = true,
                action = ToolbarItemAction.Exec,
            ),
        ),
        listOf(
            ToolbarItemSpec(
                id = "camera",
                localizationPath = "editor.toolbar.takePhoto",
                text = null,
                material = "photo_camera",
                onlyInContainer = false,
                action = ToolbarItemAction.PickImage(source = "camera"),
            ),
            ToolbarItemSpec(
                id = "image",
                localizationPath = "editor.toolbar.chooseFromLibrary",
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
        localizationPath = "editor.toolbar.dismissKeyboard",
        text = null,
        material = "keyboard_hide",
        onlyInContainer = false,
        action = ToolbarItemAction.Dismiss,
    )
}
