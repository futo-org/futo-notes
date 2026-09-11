// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/toolbar.ts (@futo-notes/editor).
// Regenerate: `just toolbar-spec`. `just toolbar-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

/// What tapping a toolbar item does. `exec` dispatches
/// `FutoEditor.exec(item.id)` over the bridge into the SHARED
/// toolbarExec.ts command — the native toolbar never
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
    let label: String
    let text: String?
    let sfSymbol: String
    /// Only visible in a list or quote (cursorContext and formatState).
    let onlyInContainer: Bool
    let action: ToolbarItemAction
}

enum ToolbarSpec {
    /// The scrollable toolbar body; groups render with a separator between.
    static let groups: [[ToolbarItemSpec]] = [
        [
            ToolbarItemSpec(
                id: "undo",
                label: "Undo",
                text: nil,
                sfSymbol: "arrow.uturn.backward",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "redo",
                label: "Redo",
                text: nil,
                sfSymbol: "arrow.uturn.forward",
                onlyInContainer: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "bold",
                label: "Bold",
                text: nil,
                sfSymbol: "bold",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "italic",
                label: "Italic",
                text: nil,
                sfSymbol: "italic",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "strikethrough",
                label: "Strikethrough",
                text: nil,
                sfSymbol: "strikethrough",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "link",
                label: "Link",
                text: nil,
                sfSymbol: "link",
                onlyInContainer: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "paragraph",
                label: "Text",
                text: "Text",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "heading-1",
                label: "Heading 1",
                text: "H1",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "heading-2",
                label: "Heading 2",
                text: "H2",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "heading-3",
                label: "Heading 3",
                text: "H3",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "quote",
                label: "Block quote",
                text: nil,
                sfSymbol: "text.quote",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "code-block",
                label: "Code block",
                text: nil,
                sfSymbol: "chevron.left.forwardslash.chevron.right",
                onlyInContainer: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "bullet-list",
                label: "Bullet list",
                text: nil,
                sfSymbol: "list.bullet",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "ordered-list",
                label: "Ordered list",
                text: nil,
                sfSymbol: "list.number",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "task-list",
                label: "Task list",
                text: nil,
                sfSymbol: "checklist",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "outdent",
                label: "Outdent",
                text: nil,
                sfSymbol: "decrease.indent",
                onlyInContainer: true,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "indent",
                label: "Indent",
                text: nil,
                sfSymbol: "increase.indent",
                onlyInContainer: true,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "camera",
                label: "Take photo",
                text: nil,
                sfSymbol: "camera",
                onlyInContainer: false,
                action: .pickImage(source: "camera")
            ),
            ToolbarItemSpec(
                id: "image",
                label: "Choose from library",
                text: nil,
                sfSymbol: "photo",
                onlyInContainer: false,
                action: .pickImage(source: "library")
            ),
        ],
    ]

    /// The fixed (non-scrolling) collapse chevron at the right edge.
    static let dismiss = ToolbarItemSpec(
        id: "dismiss",
        label: "Dismiss keyboard",
        text: nil,
        sfSymbol: "keyboard.chevron.compact.down",
        onlyInContainer: false,
        action: .dismiss
    )
}
