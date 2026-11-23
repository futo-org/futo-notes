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
        var disabled = Set(highlights.disabled)
        // block items and pictures cannot go in a table cell.
        if cellOpen { disabled.formUnion(Self.cellDisabledItems) }
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
        // After an image or a list marker the view offers its hidden glyphs' attributes; text
        // typed there is plain.
        attributes = Self.withoutAtomLook(attributes)
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
        case "bold": toolbarFormat(.bold)
        case "italic": toolbarFormat(.italic)
        case "strikethrough": toolbarFormat(.strike)
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

    /// A toolbar tap: a caret inside a word or at its start formats the whole word, so a
    /// caret on a line as long as a heavy selection runs off the main thread as one does.
    func toolbarFormat(_ format: EditorInlineFormat) {
        let selection = effectiveSelection
        let heavy =
            selection.length == 0 && lineLength(at: selection.location) >= Self.heavySelection
        runCommand("format", heavy: heavy) { session, expected in
            try session.toggleToolbarFormat(expected: expected, format: format)
        }
    }

    /// The UTF-16 length of the engine line (split at LF only) holding `location`.
    private func lineLength(at location: Int) -> Int {
        let text = textView.textStorage.string as NSString
        let start = text.range(
            of: "\n", options: .backwards, range: NSRange(location: 0, length: location))
        let from = start.location == NSNotFound ? 0 : start.location + 1
        let end = text.range(
            of: "\n", range: NSRange(location: location, length: text.length - location))
        return (end.location == NSNotFound ? text.length : end.location) - from
    }

    func block(_ command: EditorBlockCommand) {
        let range = Self.range(effectiveSelection)
        runCommand("block command") { session, expected in
            try session.blockCommandUtf16(expected: expected, range: range, command: command)
        }
    }
}
