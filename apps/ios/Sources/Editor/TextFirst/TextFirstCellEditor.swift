import UIKit

/// A cell-sized field on the SAME engine session as the note. Typing works as in the note
/// (`+Input.swift`): UIKit applies the key, the change is reported to the engine afterwards in
/// display coordinates (the field's anchor plus the field's offset), and the field's text is
/// rewritten only when what the engine holds over the field's extent differs from what it shows.
/// The field keeps the spaces typed at the cell's edges (the engine's cell content excludes
/// them). Paste, cut, Undo, toolbar formats and table commands are the engine's; the field
/// follows. The toolbar's hide-keyboard item returns to the note.
final class TextFirstCellField: UITextView {
    weak var editor: TextFirstCellEditor?
    private lazy var engineUndo = TextFirstCellUndoManager(field: self)
    override var undoManager: UndoManager? { engineUndo }
    override func copy(_ sender: Any?) { editor?.copy() }
    override func cut(_ sender: Any?) { editor?.cut() }
    override func paste(_ sender: Any?) { editor?.paste() }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) { return UIPasteboard.general.hasStrings }
        return super.canPerformAction(action, withSender: sender)
    }
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let key = presses.first?.key, key.keyCode == .keyboardTab, markedTextRange == nil,
            editor?.tab(back: key.modifierFlags.contains(.shift)) == true
        {
            return
        }
        super.pressesBegan(presses, with: event)
    }
}

/// The field placed over the tapped cell (a subview of the note's text view, so it scrolls with
/// the note). Tapping the note outside it, or hiding the keyboard, returns to the note.
@MainActor
final class TextFirstCellEditor: NSObject, UITextViewDelegate {
    let controller: TextFirstEditorController
    let field = TextFirstCellField()
    /// The cell content's range in the note's display (UTF-16), as the engine last said.
    private(set) var cellStart = 0
    private(set) var cellEnd = 0
    /// The display offset the field's first character stands for. Usually `cellStart`; it
    /// stays put while spaces typed at the cell's start move the engine's content start.
    private(set) var anchor = 0
    /// The engine's row and column of the cell the field stands for.
    private(set) var cell: (row: UInt32, column: UInt32)?
    /// The field's text as last agreed with the engine.
    private var synced = ""
    var applying = 0
    private var pending: (range: NSRange, text: String)?
    private(set) var header = false
    private var fontHeader: Bool?
    /// The inline styling last set on the field (`styleInline`).
    var styled = ""
    /// The inline runs last read for the field (link hit test).
    var linkRuns: [TextFirstCellRun] = []
    private var finished = false
    var isFinished: Bool { finished }
    /// A prompt (the link item's) has the keyboard: the field resigned on purpose.
    var holding = false
    /// the row and column grips (TextFirstTableGrips.swift).
    lazy var grips = TextFirstTableGrips(editor: self)

    init(controller: TextFirstEditorController) {
        self.controller = controller
        super.init()
    }

    /// Build the field over the cell the engine's selection is in and start editing.
    func install() {
        field.editor = self
        field.delegate = self
        field.isScrollEnabled = false
        field.textContainerInset = UIEdgeInsets(
            top: TextFirstTableMetrics.padding, left: TextFirstTableMetrics.padding,
            bottom: TextFirstTableMetrics.padding, right: TextFirstTableMetrics.padding)
        field.textContainer.lineFragmentPadding = 0
        field.layer.borderWidth = 2
        applyColors()
        field.registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (field: TextFirstCellField, _) in field.editor?.applyColors()
        }
        field.autocorrectionType = .yes
        field.autocapitalizationType = .sentences
        field.spellCheckingType = .no
        field.inlinePredictionType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.accessibilityIdentifier = "text-first-cell-field"
        installToolbar()
        installLinkTap()
        controller.textView.addSubview(field)
        controller.onAccepted = { [weak self] in self?.refresh() }
        refresh()
        field.becomeFirstResponder()
        controller.syncToolbar()
    }

    /// Return to the note: the field goes, the engine selection stays on the cell.
    func finish() {
        guard !finished else { return }
        finished = true
        controller.finishComposition()
        controller.onAccepted = nil
        if controller.cellEditor === self { controller.cellEditor = nil }
        field.resignFirstResponder()
        field.removeFromSuperview()
        grips.remove()
        controller.syncToolbar()
    }

    func textViewDidEndEditing(_ tv: UITextView) {
        // The link prompt took the keyboard; the cell stays open behind it.
        if holding { return }
        finish()
    }

    /// Put the field over its cell: the drawn row's position, this table's scroll, the row height.
    func reposition() {
        guard !finished, let frame = controller.cellFrame(start: cellStart) else { return }
        if field.frame != frame { field.frame = frame }
        clipToTable()
        grips.layout()
    }

    /// The grid is drawn clipped to the note's text column; a field over a cell scrolled partly
    /// past either side is masked at the same edges. Sideways only, and only while it overhangs:
    /// a mask also cuts off the selection handles, which reach above and below the field.
    private func clipToTable() {
        let left = controller.inset.left
        let right = left + controller.images.containerWidth
        let frame = field.frame
        guard frame.minX < left - 0.5 || frame.maxX > right + 0.5 else {
            field.layer.mask = nil
            return
        }
        let mask = field.layer.mask ?? CALayer()
        mask.backgroundColor = UIColor.black.cgColor
        let from = max(frame.minX, left) - frame.minX
        let to = min(frame.maxX, right) - frame.minX
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        mask.frame = CGRect(
            x: from, y: -frame.height, width: max(0, to - from), height: frame.height * 3)
        CATransaction.commit()
        field.layer.mask = mask
    }

    private func slice(_ from: Int, _ to: Int) -> String? {
        guard from >= 0, from <= to, to <= controller.mirrorLength else { return nil }
        return try? controller.mirror.sliceUtf16(start: UInt64(from), end: UInt64(to))
    }

    private static func blank(_ s: String) -> Bool {
        s.unicodeScalars.allSatisfy { $0 == " " || $0 == "\t" }
    }

    /// Show the cell the engine's selection is in; leave when it is in none. The field keeps
    /// its text (and its edge spaces) while the engine holds exactly that over the field's
    /// extent for the same cell; otherwise it is rewritten from the engine's cell content.
    func refresh() {
        guard !controller.isClosed, !controller.engineComposing, field.markedTextRange == nil,
            let view = try? controller.session.cellView(
                expected: controller.rev,
                selection: TextFirstEditorController.range(controller.engineSelection))
        else {
            if !controller.engineComposing, field.markedTextRange == nil { finish() }
            return
        }
        let start = Int(view.start)
        let end = Int(view.end)
        let shown = field.text ?? ""
        let length = (shown as NSString).length
        let same = cell.map { $0.row == view.row && $0.column == view.column } ?? false
        let keep: Bool = {
            guard same, anchor <= start, end <= anchor + length,
                slice(anchor, anchor + length) == shown,
                let lead = slice(anchor, start), Self.blank(lead),
                let trail = slice(end, anchor + length), Self.blank(trail)
            else { return false }
            return true
        }()
        cellStart = start
        cellEnd = end
        cell = (view.row, view.column)
        applying += 1
        if !keep {
            // The engine rewrote the cell (Undo, a format, a paste): keep the spaces at its
            // edges that the field showed, or that the engine's caret stands in, while the
            // display still has them there (one column padding space aside), so a letter typed
            // next lands where the caret is.
            var from = start
            var to = end
            if same {
                let units = Array(shown.utf16)
                let isBlank: (UInt16) -> Bool = { $0 == 0x20 || $0 == 0x09 }
                let trail = units.reversed().prefix(while: isBlank).count
                let lead = trail == units.count ? 0 : units.prefix(while: isBlank).count
                let caret = controller.engineSelection
                let left = max(lead, start - caret.location)
                let right = max(trail, NSMaxRange(caret) - end)
                if left > 0, let s = slice(start - left - 1, start), Self.blank(s) {
                    from = start - left
                }
                if right > 0, let s = slice(end, end + right + 1), Self.blank(s) {
                    to = end + right
                }
            }
            anchor = from
            let text = slice(from, to) ?? ""
            if shown != text {
                // The keyboard reads the text around the caret (autocapitalisation): tell it
                // this is a change the app made, not a key.
                field.inputDelegate?.textWillChange(field)
                field.text = text
                field.inputDelegate?.textDidChange(field)
                styled = ""
            }
        }
        synced = field.text ?? ""
        let total = (synced as NSString).length
        let selection = controller.engineSelection
        let from = min(max(0, selection.location - anchor), total)
        let local = NSRange(
            location: from, length: min(selection.length, total - from))
        if field.selectedRange != local || !same {
            field.inputDelegate?.selectionWillChange(field)
            if field.selectedRange != local { field.selectedRange = local }
            field.inputDelegate?.selectionDidChange(field)
        }
        applying -= 1
        if let (span, content) = controller.tableCell(at: cellStart) {
            // Setting the font restyles all the text: only when the cell's kind changes.
            if fontHeader != span.header {
                fontHeader = span.header
                header = span.header
                applyColors()
                field.font = TextFirstTableMetrics.font(header: span.header)
                styled = ""
            }
            header = span.header
            field.textAlignment =
                content.alignment == .right
                ? .right : content.alignment == .center ? .center : .natural
        }
        styleInline()
        reposition()
        if !same { revealColumn() }
    }

    func shifted(_ r: NSRange) -> NSRange {
        NSRange(location: r.location + anchor, length: r.length)
    }

    // MARK: UITextViewDelegate

    func textView(
        _ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String
    ) -> Bool {
        guard applying == 0, !finished else { return true }
        if tv.markedTextRange != nil || controller.engineComposing {
            pending = (range, text)
            return true
        }
        if text == "\n" {
            pending = nil
            move(.enter)
            return false
        }
        pending = (range, text)
        return true
    }

    func textViewDidChange(_ tv: UITextView) {
        guard applying == 0, !finished else { return }
        if let marked = tv.markedTextRange {
            let text = tv.text(in: marked) ?? ""
            controller.composeInCell(
                range: shifted(pending?.range ?? tv.selectedRange), text: text)
        } else if controller.engineComposing {
            controller.commitCellComposition(committed: pending?.text)
            pending = nil
            refresh()
        } else {
            reportPlatformChange()
        }
    }

    /// UIKit has applied a key: tell the engine what changed. A delegate-announced edit whose
    /// length adds up is reported as announced; anything else (smart delete's extra space, a
    /// text service that skipped the delegate) is found by diffing against the synced text.
    private func reportPlatformChange() {
        let edit = pending
        pending = nil
        let now = (field.text ?? "") as NSString
        let before = synced as NSString
        let range: NSRange
        let text: String
        if let edit,
            now.length == before.length - edit.range.length + (edit.text as NSString).length,
            NSMaxRange(edit.range) <= before.length
        {
            (range, text) = (edit.range, edit.text)
        } else {
            var prefix = 0
            let most = min(before.length, now.length)
            while prefix < most, before.character(at: prefix) == now.character(at: prefix) {
                prefix += 1
            }
            if prefix > 0, UTF16.isLeadSurrogate(before.character(at: prefix - 1)) { prefix -= 1 }
            var suffix = 0
            while suffix < most - prefix,
                before.character(at: before.length - 1 - suffix)
                    == now.character(at: now.length - 1 - suffix)
            { suffix += 1 }
            if suffix > 0, UTF16.isTrailSurrogate(before.character(at: before.length - suffix)) {
                suffix -= 1
            }
            range = NSRange(location: prefix, length: before.length - prefix - suffix)
            text = now.substring(
                with: NSRange(location: prefix, length: now.length - prefix - suffix))
        }
        guard range.length > 0 || !text.isEmpty else { return }
        let rev = controller.rev
        controller.replaceInCell(range: shifted(range), text: text)
        // Refused (no engine change): the field goes back to the engine's text.
        if controller.rev == rev { refresh() }
    }

    func textViewDidChangeSelection(_ tv: UITextView) {
        controller.selectionChanges += 1
        // A key UIKit has applied but not yet reported moves the caret first: wait for it.
        guard applying == 0, !finished, tv.markedTextRange == nil, !controller.engineComposing,
            pending == nil, (tv.text ?? "") == synced
        else { return }
        let selected = shifted(tv.selectedRange)
        if selected != controller.engineSelection {
            controller.selectInCell(selected)
        }
    }

    func copy() { controller.copySelection(shifted(field.selectedRange)) }
    func cut() {
        controller.cutSelection(shifted(field.selectedRange))
        refresh()
    }
    func paste() {
        controller.pasteFromPasteboard(shifted(field.selectedRange))
        refresh()
    }

    func history(redo: Bool) {
        redo ? controller.redo() : controller.undo()
        refresh()
    }

    /// Tab and Shift-Tab (a hardware keyboard) move between cells; true when the engine took it.
    func tab(back: Bool) -> Bool { move(back ? .shiftTab : .tab) }

    /// A table key (Tab, Shift-Tab, Enter): the engine moves to (or makes) the next cell; the
    /// caret lands at the end of that cell's text with nothing selected.
    @discardableResult
    func move(_ key: EditorTableKey) -> Bool {
        let moved = controller.tableKey(key)
        if moved, !finished,
            let view = try? controller.session.cellView(
                expected: controller.rev,
                selection: TextFirstEditorController.range(controller.engineSelection))
        {
            controller.selectInCell(NSRange(location: Int(view.end), length: 0))
        }
        refresh()
        if let (span, content) = controller.tableCell(at: cellStart) {
            let line = (controller.storage.string as NSString).paragraphRange(
                for: NSRange(location: cellStart, length: 0))
            controller.revealCell(content, in: span, row: line)
        }
        if let frame = controller.cellFrame(start: cellStart) {
            controller.textView.scrollRectToVisible(frame.insetBy(dx: 0, dy: -60), animated: true)
        }
        return moved
    }

    /// Put the caret where the field was touched (`p` in the note's text view coordinates).
    func placeCaret(at p: CGPoint) {
        guard !finished else { return }
        field.layoutIfNeeded()
        let local = controller.textView.convert(p, to: field)
        guard let position = field.closestPosition(to: local) else { return }
        let offset = field.offset(from: field.beginningOfDocument, to: position)
        controller.selectInCell(NSRange(location: anchor + offset, length: 0))
        refresh()
    }
}
