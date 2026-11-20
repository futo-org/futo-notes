import UIKit

// A hold on a list item's marker while the note is edited selects the marker alone, as the one
// character it is, with UIKit's handles and the Cut and Copy menu. A held checkbox is selected
// and not ticked. With the keyboard down a hold lifts the block instead (+BlockDrag), and a tap
// on a bullet or number is UIKit's: the caret goes to the nearer side of the marker.

extension TextFirstEditorController {
    func installMarkerHold() {
        let hold = UILongPressGestureRecognizer(
            target: self, action: #selector(handleMarkerHold(_:)))
        hold.delegate = self
        textView.addGestureRecognizer(hold)
        markerHoldRecognizer = hold
    }

    @objc func handleMarkerHold(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began else { return }
        selectMarkerUnit(at: g.location(in: textView))
    }

    /// Select the list marker unit under `p` (text view coordinates) alone and show the menu;
    /// false when there is none.
    @discardableResult
    func selectMarkerUnit(at p: CGPoint) -> Bool {
        guard !closed, !engineBusy, let f = markerUnitFragment(at: p),
            let unit = f.markerUnit, let manager = textView.textLayoutManager
        else { return false }
        // The touch is the hold's: a checkbox under it is selected, not ticked.
        touchHitCheckbox = false
        suppressFocus = false
        let start = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        textView.selectedRange = NSRange(location: start, length: 1)
        let rect = unit.rect.offsetBy(dx: inset.left, dy: f.layoutFragmentFrame.minY + inset.top)
        presentSelectionMenu(at: CGPoint(x: rect.midX, y: rect.minY))
        return true
    }
}
