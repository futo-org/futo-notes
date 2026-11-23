import UIKit

// The open cell carries the note's own
// keyboard toolbar: its own accessory on the note's toolbar state and handler. The cell is on
// the same engine session, so Undo, Redo, bold, italic, strikethrough and link run on the
// cell's selection; the field follows the engine afterwards. Block items and pictures cannot
// go in a cell: the engine does not dim them there, so the host does (`cellDisabledItems`).
// The hide-keyboard item leaves the cell.

extension TextFirstEditorController {
    /// Toolbar ids dimmed while a cell is open, on top of what the engine dims.
    static let cellDisabledItems: Set<String> = [
        "heading-1", "heading-2", "heading-3", "quote", "code-block", "bullet-list",
        "ordered-list", "task-list", "indent", "outdent", "camera", "image",
    ]

    /// Whether a cell is open (the toolbar dims block items).
    var cellOpen: Bool { cellEditor.map { !$0.isFinished } ?? false }
}

extension TextFirstCellEditor {
    func installToolbar() {
        let localization = controller.linkLocalization ?? Localization.system()
        field.inputAccessoryView = EditorToolbarAccessory(
            state: controller.toolbarState, localization: localization,
            hiding: TextFirstEditorController.hiddenToolbarItems
        ) { [weak self] item in self?.toolbar(item) }
    }

    private func toolbar(_ item: ToolbarItemSpec) {
        guard !isFinished, !grips.menuShowing else { return }
        switch item.action {
        case .dismiss:
            // UIKit hands first responder to the note's text view (the field's superview)
            // when the field resigns; the keyboard goes only if that one resigns too.
            let textView = controller.textView
            finish()
            textView.resignFirstResponder()
            DispatchQueue.main.async { textView.resignFirstResponder() }
        case .pickImage:
            break  // dimmed in a cell
        case .exec:
            if TextFirstEditorController.cellDisabledItems.contains(item.id) { return }
            // The item acts on text, not on a composition: make marked text real first.
            finishComposition()
            if item.id == "link" {
                editLink()
                return
            }
            controller.toolbar(item)
            refresh()
        }
    }

    /// The note's link prompt on the cell's selection. The prompt takes the keyboard; the cell
    /// stays open behind it and takes it back when the prompt closes.
    private func editLink() {
        holding = true
        controller.presentLinkPrompt(
            localization: controller.linkLocalization ?? Localization.system()
        ) { [weak self] in
            guard let self else { return }
            self.holding = false
            guard !self.isFinished else { return }
            self.field.becomeFirstResponder()
            self.refresh()
        }
    }
}
