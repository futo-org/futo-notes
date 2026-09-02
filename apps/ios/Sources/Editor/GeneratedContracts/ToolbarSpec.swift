// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/toolbar.ts (@futo-notes/editor).
// Regenerate: `just toolbar-spec`. `just toolbar-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

/// What tapping a toolbar item does. `exec` dispatches
/// `FutoEditor.exec(item.id)` over the bridge into the SHARED
/// markdownToolbar.ts command (TOOLBAR_EXEC) — the native toolbar never
/// reimplements editing semantics, so behavior is identical to the web
/// toolbar by construction.
enum ToolbarItemAction: Equatable {
    case exec
    case pickImage(source: String)
    case dismiss
}

struct ToolbarItemSpec: Identifiable, Equatable {
    let id: String
    /// Accessibility label — same text as the web toolbar's aria-label.
    let localizationPath: String
    let sfSymbol: String
    /// Only visible while the cursor is on a list line (bridge cursorContext).
    let onlyOnListLine: Bool
    let action: ToolbarItemAction
}

enum ToolbarSpec {
    /// The scrollable toolbar body; groups render with a separator between.
    static let groups: [[ToolbarItemSpec]] = [
        [
            ToolbarItemSpec(
                id: "bold",
                localizationPath: "editor.toolbar.bold",
                sfSymbol: "bold",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "italic",
                localizationPath: "editor.toolbar.italic",
                sfSymbol: "italic",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "strikethrough",
                localizationPath: "editor.toolbar.strikethrough",
                sfSymbol: "strikethrough",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "link",
                localizationPath: "editor.toolbar.link",
                sfSymbol: "link",
                onlyOnListLine: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "heading",
                localizationPath: "editor.toolbar.heading",
                sfSymbol: "textformat.size",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "quote",
                localizationPath: "editor.toolbar.blockQuote",
                sfSymbol: "text.quote",
                onlyOnListLine: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "bullet-list",
                localizationPath: "editor.toolbar.bulletList",
                sfSymbol: "list.bullet",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "ordered-list",
                localizationPath: "editor.toolbar.orderedList",
                sfSymbol: "list.number",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "task-list",
                localizationPath: "editor.toolbar.taskList",
                sfSymbol: "checklist",
                onlyOnListLine: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "outdent",
                localizationPath: "editor.toolbar.outdent",
                sfSymbol: "decrease.indent",
                onlyOnListLine: true,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "indent",
                localizationPath: "editor.toolbar.indent",
                sfSymbol: "increase.indent",
                onlyOnListLine: true,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "camera",
                localizationPath: "editor.toolbar.takePhoto",
                sfSymbol: "camera",
                onlyOnListLine: false,
                action: .pickImage(source: "camera")
            ),
            ToolbarItemSpec(
                id: "image",
                localizationPath: "editor.toolbar.chooseFromLibrary",
                sfSymbol: "photo",
                onlyOnListLine: false,
                action: .pickImage(source: "library")
            ),
        ],
    ]

    /// The fixed (non-scrolling) collapse chevron at the right edge.
    static let dismiss = ToolbarItemSpec(
        id: "dismiss",
        localizationPath: "editor.toolbar.dismissKeyboard",
        sfSymbol: "keyboard.chevron.compact.down",
        onlyOnListLine: false,
        action: .dismiss
    )
}
