import UIKit

// A hold on a list item's marker while the note is edited selects the marker alone, as the one
// character it is, with UIKit's handles and the Cut and Copy menu. A held checkbox is selected
// and not ticked. With the keyboard down a hold lifts the block instead (+BlockDrag), and a tap
// on a bullet or number is UIKit's: the caret goes to the nearer side of the marker. A double tap
// on either half of a bullet's or number's column selects the marker as a hold does; UIKit's own
// double tap took the word on the side the point is nearer, the item's first word on the right.

/// The double tap on a bullet's or number's column. It receives only touches there and
/// recognises beside UIKit's, then replaces UIKit's word selection with the marker.
final class TextFirstMarkerDoubleTap: UITapGestureRecognizer {}

extension TextFirstEditorController {
    func installMarkerHold() {
        let hold = UILongPressGestureRecognizer(
            target: self, action: #selector(handleMarkerHold(_:)))
        hold.delegate = self
        textView.addGestureRecognizer(hold)
        markerHoldRecognizer = hold
        let double = TextFirstMarkerDoubleTap(
            target: self, action: #selector(handleMarkerDoubleTap(_:)))
        double.numberOfTapsRequired = 2
        double.delegate = self
        textView.addGestureRecognizer(double)
    }

    /// Whether a touch at `p` may be a marker double tap's: on a bullet's or number's column.
    /// A checkbox keeps its taps (each one ticks).
    func isMarkerDoubleTapTouch(at p: CGPoint) -> Bool {
        markerUnitFragment(at: p) != nil && checkboxFragment(at: p) == nil
    }

    @objc func handleMarkerDoubleTap(_ g: UITapGestureRecognizer) {
        guard g.state == .ended else { return }
        let p = g.location(in: textView)
        // After UIKit's own double tap has selected its word.
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { _ = self?.selectMarkerUnit(at: p) }
        }
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
