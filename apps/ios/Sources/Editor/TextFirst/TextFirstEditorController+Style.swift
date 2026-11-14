import UIKit

// Styling from the engine's projection: the first screen at once, the rest of a long note in
// slices, and one window per accepted change (the change's own reparsed window).

extension TextFirstEditorController {
    private static let firstSlice = 6_000
    private static let laterSlice = 12_000

    func styleFirstScreen() {
        styleSlice(units: Self.firstSlice)
        scheduleNextSlice()
    }

    /// Style the next `units` UTF-16 units from `styledThrough`.
    private func styleSlice(units: Int) {
        guard !closed, !engineBusy, styledThrough < mirrorLength else { return }
        let from = styledThrough
        do {
            // The engine's rule for a slice's end (a blank line, so no table is cut in two:
            // the engine reports a table only from the slice it starts in).
            let to = Int(try mirror.sliceEnd(from: UInt64(from), chars: UInt64(units)))
            let startByte = try mirror.utf16ToByte(unit: UInt64(from))
            let endByte = try mirror.utf16ToByte(unit: UInt64(to))
            let specs = try session.stylePlan(
                expected: rev, range: EditorByteRange(start: startByte, end: endByte))
            TextFirstStyler.apply(
                specs, to: storage, window: NSRange(location: from, length: to - from),
                images: images)
            styleCodeLanguages(
                try session.project(
                    expected: rev, range: EditorByteRange(start: startByte, end: endByte)))
            styledThrough = to
        } catch {
            print("text-first: style plan failed: \(error)")
            styledThrough = mirrorLength
        }
    }

    /// A slice waits while a finger is on the note or its edit menu shows (the platform hides
    /// the menu and handles on a text change), and never follows another without a gap, so
    /// touches, scrolling and drawing run between slices.
    var renderHeld: Bool { textView.fingerIsDown || menuVisible }
    private static let sliceGap = 0.008

    func renderHoldChanged() {
        if !renderHeld { scheduleNextSlice() }
    }

    func scheduleNextSlice(after gap: Double = 0) {
        guard !styleSlicePending, !engineBusy, !renderHeld, styledThrough < mirrorLength
        else { return }
        styleSlicePending = true
        let work = { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.styleSlicePending = false
                guard !self.renderHeld else { return }  // renderHoldChanged() resumes
                var took = 0.0
                // Typing and composing come first; a slice waits for the next turn.
                if !self.engineComposing, self.textView.markedTextRange == nil {
                    let began = CACurrentMediaTime()
                    self.styleSlice(units: Self.laterSlice)
                    took = CACurrentMediaTime() - began
                }
                self.scheduleNextSlice(after: max(Self.sliceGap, took))
            }
        }
        if gap > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + gap, execute: work)
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    /// Code language is user-authored metadata from the engine's projection. Keep its
    /// drawing on the first code row, without interpreting the fence in the native shell.
    func styleCodeLanguages(_ projection: EditorProjection) {
        let hiddenStarts = Set(
            projection.correspondence.lazy.filter {
                $0.kind == .hidden
            }.map { $0.display.start })
        for line in projection.blocks where line.code {
            guard let start = try? mirror.byteToUtf16(byte: line.range.start) else { continue }
            let at = Int(start)
            let block =
                at < storage.length
                ? storage.attribute(.tfBlock, at: at, effectiveRange: nil)
                    as? TextFirstBlockAttribute
                : trailingBlock
            let previous =
                at > 0
                ? storage.attribute(.tfBlock, at: at - 1, effectiveRange: nil)
                    as? TextFirstBlockAttribute : nil
            let startsBlock = hiddenStarts.contains(line.range.start)
            block?.codeLanguage = previous?.code != true || startsBlock ? line.language : nil
        }
    }

    /// Keep the styled prefix in step with an edit inside it. An edit that starts exactly where
    /// the prefix ends (typing or inserting at the end of the note) is inside it too: `restyle`
    /// styles that window at once, and everything keyed to the prefix (an image's re-layout
    /// when its bitmap arrives, the table pass) has to reach it.
    func adjustStyled(for edit: EditorMirrorEdit) {
        guard Int(edit.start) <= styledThrough else { return }
        styledThrough = max(
            Int(edit.start),
            min(
                mirrorLength,
                styledThrough + Int(edit.insertedUtf16) - Int(edit.end - edit.start)))
    }

    /// The engine plans only the table rows an edit's window meets. A line just past the window
    /// that is a table row where the window's last line is not (or the reverse) was drawn
    /// under the old table shape: hand the rest of the text back to the slices, from there.
    /// A plain keystroke never changes the grid state at the window's end, so it stays
    /// window-sized. `specs` is the plan just applied: the engine plans a row that starts
    /// exactly at `to` (windows are closed intervals), so that line is the window's last.
    private func continueStylingIfTheGridChangesAt(_ to: Int, specs: [EditorStyleSpan]) {
        let text = storage.string as NSString
        guard to < text.length, to <= styledThrough else { return }
        // The window ends at a line start (the line at `to` was not restyled, unless the plan
        // holds a row that starts there) or mid-line (that line is the window's last).
        let atLineStart =
            text.paragraphRange(for: NSRange(location: to, length: 0)).location == to
        let planned = specs.contains {
            if case .tableRow(let start, _, _, _, _, _) = $0 { return Int(start) == to }
            return false
        }
        let last = text.paragraphRange(
            for: NSRange(
                location: atLineStart && !planned ? max(0, to - 1) : to, length: 0))
        guard NSMaxRange(last) < text.length else { return }
        let next = text.paragraphRange(for: NSRange(location: NSMaxRange(last), length: 0))
        guard
            !text.substring(with: next).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        func inGrid(_ line: NSRange) -> Bool {
            storage.attribute(.tfTable, at: line.location, effectiveRange: nil) != nil
                || storage.attribute(.tfTableDelimiter, at: line.location, effectiveRange: nil)
                    != nil
        }
        guard inGrid(last) != inGrid(next) else { return }
        styledThrough = min(styledThrough, next.location)
        scheduleNextSlice()
    }

    /// The empty last line's block, from the plan that reached the end of the note. The layout
    /// fragment of the last paragraph draws it in the extra line fragment, and the typing
    /// attributes make that line the height and indent the typed line will be.
    func setTrailingBlock(_ block: TextFirstBlockAttribute?) {
        guard block != nil || trailingBlock != nil else { return }
        let wasSet = trailingBlock != nil
        let wasHeading = (trailingBlock?.heading ?? 0) > 0
        trailingBlock = block
        if block != nil {
            _ = assertTrailingTypingAttributes()
        } else if wasSet {
            // The empty heading is gone because it has characters now (the caret is still in
            // the heading: its next character is the heading's), or because it stopped being
            // a heading (body again); the style sync below carries only the paragraph style.
            if wasHeading, caretIsAtEnd {
                textView.typingAttributes[.font] =
                    caretHeadingLevel.map(TextFirstStyler.headingFont) ?? Self.bodyFont
            }
            syncEmptyLineTypingAttributes()
        }
        invalidateLastParagraph()
    }

    /// A caret on an empty line starts the line it types: UIKit offers the previous line's
    /// attributes there, so a line that has just stopped being a list item or quote (Enter or
    /// Backspace on its empty marker) would draw its caret, and start its first character, at
    /// the old head indent. The line's own paragraph style is the one its `\n` carries; the
    /// note's empty last line has none, and is a plain paragraph unless `trailingBlock` says
    /// otherwise. Only the block's attributes change, so a toolbar toggle (bold) stays.
    func syncEmptyLineTypingAttributes() {
        let caret = textView.selectedRange
        guard caret.length == 0, !(caret.location == storage.length && trailingBlock != nil)
        else { return }
        let text = storage.string as NSString
        func isBreak(_ i: Int) -> Bool { [10, 13].contains(text.character(at: i)) }
        guard caret.location == 0 || isBreak(caret.location - 1),
            caret.location == text.length || isBreak(caret.location)
        else { return }
        let line =
            caret.location == text.length
            ? Self.baseAttributes
            : storage.attributes(at: caret.location, effectiveRange: nil)
        var typing = textView.typingAttributes
        let style = line[.paragraphStyle] as? NSParagraphStyle
        guard
            (typing[.paragraphStyle] as? NSParagraphStyle) != style
                || (typing[.tfBlock] != nil && line[.tfBlock] == nil)
        else { return }
        typing[.paragraphStyle] = style
        typing[.tfBlock] = line[.tfBlock]
        textView.typingAttributes = typing
    }

    private var caretIsAtEnd: Bool {
        textView.selectedRange == NSRange(location: storage.length, length: 0)
    }

    /// UIKit offers the previous line's attributes when the caret lands on the empty last line;
    /// its layout and the first character follow the block's instead. True when that changed
    /// the line's shape.
    @discardableResult
    func assertTrailingTypingAttributes() -> Bool {
        guard let block = trailingBlock, caretIsAtEnd else { return false }
        let wanted = TextFirstStyler.typingAttributes(for: block)
        let current = textView.typingAttributes
        let same =
            (current[.paragraphStyle] as? NSParagraphStyle)
            == (wanted[.paragraphStyle] as? NSParagraphStyle)
            && (current[.font] as? UIFont) == (wanted[.font] as? UIFont)
        textView.typingAttributes = wanted
        return !same
    }

    func invalidateLastParagraph() {
        guard let manager = textView.textLayoutManager,
            let content = manager.textContentManager
        else { return }
        let text = storage.string as NSString
        let start =
            text.length == 0
            ? 0
            : text.paragraphRange(for: NSRange(location: text.length - 1, length: 0)).location
        if let from = content.location(manager.documentRange.location, offsetBy: start),
            let range = NSTextRange(location: from, end: manager.documentRange.endLocation)
        {
            manager.invalidateLayout(for: range.isEmpty ? manager.documentRange : range)
        }
    }

    /// Restyle the window the engine reparsed for `change`.
    func restyle(_ change: EditorViewChange) {
        guard !closed else { return }
        do {
            let range = change.projection.range
            let from = Int(try mirror.byteToUtf16(byte: range.start))
            let to = Int(try mirror.byteToUtf16(byte: range.end))
            // A window past the styled prefix is styled by the slices, from the current text.
            guard from <= styledThrough else { return }
            if to - from > Self.restyleAtOnce {
                restyleProgressively(from: from, to: to)
                return
            }
            let specs = try session.stylePlan(expected: rev, range: range)
            TextFirstStyler.apply(
                specs, to: storage, window: NSRange(location: from, length: to - from),
                images: images)
            styleCodeLanguages(change.projection)
            continueStylingIfTheGridChangesAt(to, specs: specs)
        } catch {
            print("text-first: restyle failed: \(error)")
        }
    }
}
