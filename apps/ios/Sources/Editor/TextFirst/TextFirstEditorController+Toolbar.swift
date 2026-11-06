#if FUTO_DEBUG_BUILD
    import UIKit

    // The keyboard toolbar: the engine's selection state lights and dims the manifest's items
    // (Rust `toolbar_highlights` names them), and a tap is a name map onto an engine command.

    extension TextFirstEditorController {
        /// The text-first toolbar has no Text control: H1-H3 toggle back to a paragraph.
        static let hiddenToolbarItems: Set<String> = ["paragraph"]

        func installToolbar(localization: Localization) {
            let accessory = EditorToolbarAccessory(
                state: toolbarState, localization: localization, hiding: Self.hiddenToolbarItems
            ) { [weak self] item in self?.toolbar(item) }
            textView.inputAccessoryView = accessory
            toolbarInstalled = true
            syncToolbar()
        }

        /// Push the engine's state into the toolbar (only what changed, to spare redraws).
        func syncToolbar() {
            guard toolbarInstalled, !closed else { return }
            guard let highlights = try? session.toolbarHighlights() else { return }
            let active = Set(highlights.active)
            let disabled = Set(highlights.disabled)
            if toolbarState.activeFormats != active { toolbarState.activeFormats = active }
            if toolbarState.disabledFormats != disabled { toolbarState.disabledFormats = disabled }
            // Indent and Outdent show in a list or quote.
            let inContainer =
                active.contains("quote") || active.contains("bullet-list")
                || active.contains("ordered-list") || active.contains("task-list")
            if toolbarState.inContainer != inContainer { toolbarState.inContainer = inContainer }
            updateTypingAttributes(active)
        }

        /// A collapsed toggle changes what the next character will be before any text exists.
        private func updateTypingAttributes(_ active: Set<String>) {
            guard textView.selectedRange.length == 0 else { return }
            var attributes = textView.typingAttributes
            let base = (attributes[.font] as? UIFont) ?? Self.bodyFont
            var traits = base.fontDescriptor.symbolicTraits
            if active.contains("bold") { traits.insert(.traitBold) } else if !active.contains("heading-1")
                && !active.contains("heading-2") && !active.contains("heading-3")
            { traits.remove(.traitBold) }
            if active.contains("italic") { traits.insert(.traitItalic) } else { traits.remove(.traitItalic) }
            if let descriptor = base.fontDescriptor.withSymbolicTraits(traits) {
                attributes[.font] = UIFont(descriptor: descriptor, size: base.pointSize)
            }
            textView.typingAttributes = attributes
        }

        func toolbar(_ item: ToolbarItemSpec) {
            switch item.action {
            case .dismiss: textView.resignFirstResponder()
            case .pickImage: break  // M5
            case .exec: run(toolbarCommand: item.id)
            }
        }

        private func run(toolbarCommand id: String) {
            guard !closed else { return }
            finishComposition()
            switch id {
            case "undo": undo()
            case "redo": redo()
            case "bold": format(.bold)
            case "italic": format(.italic)
            case "strikethrough": format(.strike)
            case "heading-1": block(.toggleHeading(level: 1))
            case "heading-2": block(.toggleHeading(level: 2))
            case "heading-3": block(.toggleHeading(level: 3))
            case "quote": block(.quote)
            case "code-block": block(.wrapCodeBlock)
            case "bullet-list": block(.bulletList)
            case "ordered-list": block(.orderedList)
            case "task-list": block(.taskList)
            case "indent": block(.indent)
            case "outdent": block(.outdent)
            default: break  // link (M4), camera and image (M5)
            }
        }

        func format(_ format: EditorInlineFormat) {
            do {
                if let change = try session.toggleFormat(expected: rev, format: format) {
                    try accept(change)
                } else {
                    syncToolbar()  // a collapsed toggle only changes the carried format
                }
            } catch EditorSessionError.UnrepresentableFormat {
                syncToolbar()
            } catch { recover(error, context: "format") }
        }

        func block(_ command: EditorBlockCommand) {
            do {
                if let change = try session.blockCommandUtf16(
                    expected: rev, range: Self.range(textView.selectedRange), command: command)
                {
                    try accept(change)
                }
            } catch EditorSessionError.UnrepresentableFormat {
                syncToolbar()
            } catch { recover(error, context: "block command") }
        }
    }
#endif
