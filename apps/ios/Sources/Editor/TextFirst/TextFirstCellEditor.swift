#if FUTO_DEBUG_BUILD
    import UIKit

    /// A cell-sized field on the SAME engine session as the note: it never changes its own text.
    /// Every edit is reported to the engine in display coordinates (the cell's start plus the
    /// field's offset) and the field then shows what the engine holds, so selection, composition,
    /// single-cell paste and Undo are the engine's. Done returns to the note.
    final class TextFirstCellField: UITextView {
        weak var editor: TextFirstCellEditor?
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

    @MainActor
    final class TextFirstCellEditor: UIViewController, UITextViewDelegate {
        let controller: TextFirstEditorController
        let field = TextFirstCellField()
        /// The cell content's range in the note's display (UTF-16), as the engine last said.
        private(set) var cellStart = 0
        private(set) var cellEnd = 0
        private var applying = 0
        private var pending: (range: NSRange, text: String)?

        init(controller: TextFirstEditorController) {
            self.controller = controller
            super.init(nibName: nil, bundle: nil)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .systemBackground
            field.editor = self
            field.delegate = self
            field.font = .systemFont(ofSize: 17)
            field.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            field.backgroundColor = .secondarySystemBackground
            field.layer.cornerRadius = 10
            field.autocorrectionType = .yes
            field.autocapitalizationType = .sentences
            field.smartQuotesType = .no
            field.smartDashesType = .no
            field.accessibilityIdentifier = "text-first-cell-field"
            field.translatesAutoresizingMaskIntoConstraints = false
            let localization = controller.linkLocalization ?? Localization.system()
            let done = UIButton(type: .system)
            done.setTitle(localization.localizedText("common.actions.done"), for: .normal)
            done.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)
            let undo = UIButton(type: .system)
            undo.setImage(UIImage(systemName: "arrow.uturn.backward"), for: .normal)
            undo.accessibilityLabel = localization.localizedText("editor.toolbar.undo")
            undo.addAction(
                UIAction { [weak self] _ in
                    self?.controller.undo()
                    self?.refresh()
                }, for: .touchUpInside)
            let bar = UIStackView(arrangedSubviews: [undo, UIView(), done])
            bar.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(bar)
            view.addSubview(field)
            NSLayoutConstraint.activate([
                bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
                bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
                bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
                field.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8),
                field.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
                field.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
                field.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
                field.bottomAnchor.constraint(
                    lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
            ])
            controller.onAccepted = { [weak self] in self?.refresh() }
            refresh()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            field.becomeFirstResponder()
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            controller.onAccepted = nil
            if controller.cellEditor === self { controller.cellEditor = nil }
        }

        func finish() {
            controller.finishComposition()
            dismiss(animated: true)
        }

        /// Show the cell the engine's selection is in; leave when it is in none.
        func refresh() {
            guard !controller.isClosed, !controller.engineComposing, field.markedTextRange == nil,
                let cell = try? controller.session.cellView(
                    expected: controller.rev,
                    selection: TextFirstEditorController.range(controller.engineSelection))
            else {
                if !controller.engineComposing, field.markedTextRange == nil {
                    dismiss(animated: true)
                }
                return
            }
            cellStart = Int(cell.start)
            cellEnd = Int(cell.end)
            guard let text = try? controller.mirror.sliceUtf16(start: cell.start, end: cell.end)
            else { return }
            let selection = controller.engineSelection
            let local = NSRange(
                location: min(max(0, selection.location - cellStart), (text as NSString).length),
                length: min(selection.length, (text as NSString).length))
            applying += 1
            if field.text != text { field.text = text }
            if field.selectedRange != local { field.selectedRange = local }
            applying -= 1
        }

        private func shifted(_ r: NSRange) -> NSRange {
            NSRange(location: r.location + cellStart, length: r.length)
        }

        // MARK: UITextViewDelegate

        func textView(
            _ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String
        ) -> Bool {
            guard applying == 0 else { return true }
            if tv.markedTextRange != nil || controller.engineComposing {
                pending = (range, text)
                return true
            }
            if text == "\n" {
                controller.tableKey(.enter)
                refresh()
                return false
            }
            controller.replaceInCell(range: shifted(range), text: text)
            refresh()
            return false
        }

        func textViewDidChange(_ tv: UITextView) {
            guard applying == 0 else { return }
            if let marked = tv.markedTextRange {
                let text = tv.text(in: marked) ?? ""
                controller.composeInCell(
                    range: shifted(pending?.range ?? tv.selectedRange), text: text)
            } else if controller.engineComposing {
                controller.commitCellComposition(committed: pending?.text)
                pending = nil
                refresh()
            }
        }

        func textViewDidChangeSelection(_ tv: UITextView) {
            guard applying == 0, tv.markedTextRange == nil, !controller.engineComposing else {
                return
            }
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

        /// Tab and Shift-Tab (a hardware keyboard) move between cells; true when the engine took it.
        func tab(back: Bool) -> Bool {
            let moved = controller.tableKey(back ? .shiftTab : .tab)
            refresh()
            return moved
        }
    }

    extension TextFirstEditorController {
        /// One edit inside a cell, reported to the engine as the note's own input would be.
        func replaceInCell(range: NSRange, text: String) {
            guard !closed else { return }
            let units = Array(text.utf16)
            do {
                let change: EditorViewChange?
                if range.length > 0, !units.isEmpty {
                    change = try session.replaceOsUtf16(
                        expected: rev, range: Self.range(range), text: units, placeholders: [])
                } else {
                    change = try session.replaceUtf16Action(
                        expected: rev, range: Self.range(range), inserted: units,
                        action: units.count > 1 || range.length > 1 ? .isolated : .typing)
                }
                if let change { try accept(change) }
            } catch { recover(error, context: "cell edit") }
        }

        func selectInCell(_ range: NSRange) {
            guard !closed else { return }
            do {
                let change = try session.selectUtf16(expected: rev, range: Self.range(range))
                rev = change.revision
                let start = try mirror.byteToUtf16(byte: change.selection.start)
                let end = try mirror.byteToUtf16(byte: change.selection.end)
                setSelection(NSRange(location: Int(start), length: Int(end - start)))
            } catch { recover(error, context: "cell selection") }
        }

        func composeInCell(range: NSRange, text: String) {
            guard !closed else { return }
            if !engineComposing {
                engineComposing = true
                compositionRange = range
            }
            do {
                _ = try session.composeUtf16(
                    expected: rev, range: Self.range(compositionRange), text: Array(text.utf16))
            } catch {
                engineComposing = false
                recover(error, context: "cell compose")
            }
            lastMarked = text
        }

        func commitCellComposition(committed: String?) {
            engineComposing = false
            do {
                let text = committed.flatMap { $0 == lastMarked ? nil : Array($0.utf16) }
                if let change = try session.commitCompositionUtf16(expected: rev, text: text) {
                    try accept(change)
                }
            } catch { recover(error, context: "cell commit") }
        }

        /// A table key (Tab, Enter, ...): a selection move or one accepted edit. True when handled.
        @discardableResult
        func tableKey(_ key: EditorTableKey) -> Bool {
            guard !closed, !engineComposing else { return false }
            do {
                guard let outcome = try session.tableKey(expected: rev, key: key) else {
                    return false
                }
                if let change = outcome.edited {
                    try accept(change)
                } else if let moved = outcome.selected {
                    rev = moved.revision
                    let start = try mirror.byteToUtf16(byte: moved.selection.start)
                    let end = try mirror.byteToUtf16(byte: moved.selection.end)
                    setSelection(NSRange(location: Int(start), length: Int(end - start)))
                    onAccepted?()
                }
                return true
            } catch {
                recover(error, context: "table key")
                return true
            }
        }

        /// Open the cell's editor on this session: select its content, scroll its column into view.
        func openCellEditor(_ hit: TableCellHit) {
            guard !closed, cellEditor == nil else { return }
            finishComposition()
            revealCell(hit.cell, in: hit.span, row: hit.row)
            selectInCell(hit.cell.range)
            guard let presenter = textView.window?.rootViewController?.topmost else { return }
            let editor = TextFirstCellEditor(controller: self)
            editor.modalPresentationStyle = .pageSheet
            if let sheet = editor.sheetPresentationController { sheet.detents = [.medium()] }
            cellEditor = editor
            presenter.present(editor, animated: true)
        }
    }
#endif
