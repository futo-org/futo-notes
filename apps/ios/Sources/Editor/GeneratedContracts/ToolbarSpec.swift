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
    let localizationPath: String
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
                localizationPath: "editor.toolbar.undo",
                text: nil,
                sfSymbol: "arrow.uturn.backward",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "redo",
                localizationPath: "editor.toolbar.redo",
                text: nil,
                sfSymbol: "arrow.uturn.forward",
                onlyInContainer: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "bold",
                localizationPath: "editor.toolbar.bold",
                text: nil,
                sfSymbol: "bold",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "italic",
                localizationPath: "editor.toolbar.italic",
                text: nil,
                sfSymbol: "italic",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "strikethrough",
                localizationPath: "editor.toolbar.strikethrough",
                text: nil,
                sfSymbol: "strikethrough",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "link",
                localizationPath: "editor.toolbar.link",
                text: nil,
                sfSymbol: "link",
                onlyInContainer: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "paragraph",
                localizationPath: "editor.toolbar.paragraph",
                text: "Text",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "heading-1",
                localizationPath: "editor.toolbar.headingOne",
                text: "H1",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "heading-2",
                localizationPath: "editor.toolbar.headingTwo",
                text: "H2",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "heading-3",
                localizationPath: "editor.toolbar.headingThree",
                text: "H3",
                sfSymbol: "textformat.size",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "quote",
                localizationPath: "editor.toolbar.blockQuote",
                text: nil,
                sfSymbol: "text.quote",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "code-block",
                localizationPath: "editor.toolbar.codeBlock",
                text: nil,
                sfSymbol: "chevron.left.forwardslash.chevron.right",
                onlyInContainer: false,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "bullet-list",
                localizationPath: "editor.toolbar.bulletList",
                text: nil,
                sfSymbol: "list.bullet",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "ordered-list",
                localizationPath: "editor.toolbar.orderedList",
                text: nil,
                sfSymbol: "list.number",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "task-list",
                localizationPath: "editor.toolbar.taskList",
                text: nil,
                sfSymbol: "checklist",
                onlyInContainer: false,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "outdent",
                localizationPath: "editor.toolbar.outdent",
                text: nil,
                sfSymbol: "decrease.indent",
                onlyInContainer: true,
                action: .exec
            ),
            ToolbarItemSpec(
                id: "indent",
                localizationPath: "editor.toolbar.indent",
                text: nil,
                sfSymbol: "increase.indent",
                onlyInContainer: true,
                action: .exec
            ),
        ],
        [
            ToolbarItemSpec(
                id: "camera",
                localizationPath: "editor.toolbar.takePhoto",
                text: nil,
                sfSymbol: "camera",
                onlyInContainer: false,
                action: .pickImage(source: "camera")
            ),
            ToolbarItemSpec(
                id: "image",
                localizationPath: "editor.toolbar.chooseFromLibrary",
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
        localizationPath: "editor.toolbar.dismissKeyboard",
        text: nil,
        sfSymbol: "keyboard.chevron.compact.down",
        onlyInContainer: false,
        action: .dismiss
    )
}
