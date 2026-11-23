import UIKit

// The open cell's colours follow the appearance.

extension TextFirstCellEditor {
    /// The field's outline and fill. The outline is a layer colour, resolved here (and again on
    /// an appearance switch); the fill is opaque (it hides the cell the grid drew), so over a
    /// header cell it is the header's grey already blended onto the note's background.
    func applyColors() {
        let header = header
        field.backgroundColor = UIColor { trait in
            let base = UIColor(Theme.background).resolvedColor(with: trait)
            guard header else { return base }
            let fill = UIColor.tertiarySystemFill.resolvedColor(with: trait)
            var br: CGFloat = 0
            var bg: CGFloat = 0
            var bb: CGFloat = 0
            var ba: CGFloat = 0
            var fr: CGFloat = 0
            var fg: CGFloat = 0
            var fb: CGFloat = 0
            var fa: CGFloat = 0
            base.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
            fill.getRed(&fr, green: &fg, blue: &fb, alpha: &fa)
            let mix = { (b: CGFloat, f: CGFloat) in b * (1 - fa) + f * fa }
            return UIColor(red: mix(br, fr), green: mix(bg, fg), blue: mix(bb, fb), alpha: 1)
        }
        field.layer.borderColor =
            UIColor(Theme.primary).resolvedColor(with: field.traitCollection).cgColor
    }
}

/// Shake, Cmd+Z and the three-finger gesture in a cell are the engine's Undo, as in the note.
final class TextFirstCellUndoManager: UndoManager {
    weak var field: TextFirstCellField?
    init(field: TextFirstCellField) {
        self.field = field
        super.init()
        disableUndoRegistration()
    }
    override var canUndo: Bool { true }
    override var canRedo: Bool { true }
    override func undo() { MainActor.assumeIsolated { field?.editor?.history(redo: false) } }
    override func redo() { MainActor.assumeIsolated { field?.editor?.history(redo: true) } }
}
