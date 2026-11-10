#if FUTO_DEBUG_BUILD
    import UIKit

    // The keyboard toolbar: the engine's selection state lights and dims the manifest's items
    // (Rust `toolbar_highlights` names them), and a tap is a name map onto an engine command.

    extension TextFirstEditorController {
        /// The text-first toolbar has no Text control: H1-H3 toggle back to a paragraph.
        static let hiddenToolbarItems: Set<String> = ["paragraph"]

        func installToolbar(localization: Localization) {
            linkLocalization = localization
            let accessory = EditorToolbarAccessory(
                state: toolbarState, localization: localization, hiding: Self.hiddenToolbarItems
            ) { [weak self] item in self?.toolbar(item) }
            textView.inputAccessoryView = accessory
            toolbarInstalled = true
            syncToolbar()
        }

        /// Push the engine's state into the toolbar (only what changed, to spare redraws).
        func syncToolbar() {
            guard toolbarInstalled, !closed, !engineBusy else { return }
            if engineSelection.length >= Self.heavySelection {
                syncToolbarInBackground()
                return
            }
            guard let highlights = try? session.toolbarHighlights() else { return }
            applyToolbar(highlights)
        }

        func applyToolbar(_ highlights: EditorToolbarHighlights) {
            let active = Set(highlights.active)
            let disabled = Set(highlights.disabled)
            if toolbarState.activeFormats != active { toolbarState.activeFormats = active }
            if toolbarState.disabledFormats != disabled { toolbarState.disabledFormats = disabled }
            // Keep the controls in place; the engine dims them where they cannot run (and
            // enables indentation inside code as well as lists and quotes).
            if toolbarState.inContainer != true { toolbarState.inContainer = true }
            updateTypingAttributes(active)
        }

        /// The heading level the caret's line is drawn as, or nil: the styler's tag on the line's
        /// first character, or the empty last line's block (an empty line has no character to
        /// carry it). The line is `lineRange`'s own, which also ends at U+2028, U+2029 and U+0085:
        /// an empty one (the caret at the end of the text after a line ending, or in an empty
        /// note) has no character to read.
        var caretHeadingLevel: Int? {
            let text = storage.string as NSString
            let caret = textView.selectedRange.location
            guard caret <= text.length else { return nil }
            let line = text.lineRange(for: NSRange(location: caret, length: 0))
            guard line.length > 0 else {
                return (trailingBlock?.heading ?? 0) > 0 ? trailingBlock?.heading : nil
            }
            return storage.attribute(.tfHeading, at: line.location, effectiveRange: nil) as? Int
        }

        /// A collapsed toggle changes what the next character will be before any text exists.
        private func updateTypingAttributes(_ active: Set<String>) {
            guard textView.selectedRange.length == 0 else { return }
            var attributes = textView.typingAttributes
            // After an image the view offers its hidden glyphs' attributes; text typed there is plain.
            attributes = Self.withoutImageSpelling(attributes)
            let base = (attributes[.font] as? UIFont) ?? Self.bodyFont
            var traits = base.fontDescriptor.symbolicTraits
            if active.contains("bold") {
                traits.insert(.traitBold)
            } else if caretHeadingLevel == nil {
                // A heading is drawn bold at every level, so its next character stays bold.
                traits.remove(.traitBold)
            }
            if active.contains("italic") {
                traits.insert(.traitItalic)
            } else {
                traits.remove(.traitItalic)
            }
            if let descriptor = base.fontDescriptor.withSymbolicTraits(traits) {
                attributes[.font] = UIFont(descriptor: descriptor, size: base.pointSize)
            }
            // Strike is not a font trait: the next character must carry it as typed, or only the
            // first one (restyled after the engine answers) is struck.
            if active.contains("strikethrough") {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            } else {
                attributes[.strikethroughStyle] = nil
            }
            textView.typingAttributes = attributes
        }

        func toolbar(_ item: ToolbarItemSpec) {
            switch item.action {
            case .dismiss: textView.resignFirstResponder()
            case .pickImage(let source): pickImage(source: source)
            case .exec: run(toolbarCommand: item.id)
            }
        }

        private func run(toolbarCommand id: String) {
            guard !closed, !engineBusy else { return }
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
            case "link": presentLinkPrompt(localization: linkLocalization ?? Localization.system())
            default: break  // camera and image (M5)
            }
        }

        func format(_ format: EditorInlineFormat) {
            runCommand("format") { session, expected in
                try session.toggleFormat(expected: expected, format: format)
            }
        }

        func block(_ command: EditorBlockCommand) {
            let range = Self.range(effectiveSelection)
            runCommand("block command") { session, expected in
                try session.blockCommandUtf16(expected: expected, range: range, command: command)
            }
        }
    }
#endif
