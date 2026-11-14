import UIKit

// Select All on a long note. UIKit highlights a selection by laying out its rectangles, and for
// all of a 2.3 MB note (230,000 lines) that held the main thread for 2.3 s at once and 7.8 s
// again after each restyle (sampled 2026-11-06: `UITextSelectionDisplayInteraction
// _updateSelectionIfNeeded` under every viewport layout). So the engine selects the whole note
// at once, which is what copy, cut, typing, commands and saves use, while the view's selection
// is the stretch around the viewport and follows it as the note scrolls. Android: "Select All
// selects the complete canonical note immediately while its visible prefix continues loading".

extension TextFirstEditorController {
    /// A selection longer than this (UTF-16 units) is shown clipped to the viewport's neighbourhood.
    static let clipSelectionAbove = 60_000
    /// How far past the viewport a clipped selection reaches.
    private static let clipMargin = 20_000

    /// The engine's selection when the view shows only part of it, else the view's.
    var effectiveSelection: NSRange {
        selectAllClipped ? engineSelection : textView.selectedRange
    }

    /// Select the whole note through the engine. False when UIKit should (a short note, or the
    /// engine is not available).
    @discardableResult
    func selectAll() -> Bool {
        guard !closed, !engineBusy, !engineComposing, textView.markedTextRange == nil,
            mirrorLength > Self.clipSelectionAbove, storage.length == mirrorLength
        else { return false }
        reportSelection(NSRange(location: 0, length: mirrorLength))
        presentSelectionMenu()
        return true
    }

    /// The part of `range` the view highlights: around the viewport, on character boundaries.
    func clippedWindow(of range: NSRange) -> NSRange {
        let visible = visibleUnits()
        var low = max(range.location, visible.lowerBound - Self.clipMargin)
        var high = min(NSMaxRange(range), visible.upperBound + Self.clipMargin)
        if high <= low {
            low = range.location
            high = min(NSMaxRange(range), low + 2 * Self.clipMargin)
        }
        let text = storage.string as NSString
        let aligned = text.rangeOfComposedCharacterSequences(
            for: NSRange(location: low, length: high - low))
        return NSIntersectionRange(aligned, range)
    }

    /// The viewport moved: keep the highlighted stretch around it.
    func viewportMoved() {
        guard selectAllClipped, applying == 0 else { return }
        let visible = visibleUnits()
        let shown = textView.selectedRange
        let covered =
            shown.location <= max(visible.lowerBound, engineSelection.location)
            && NSMaxRange(shown) >= min(visible.upperBound, NSMaxRange(engineSelection))
        guard !covered else { return }
        let window = clippedWindow(of: engineSelection)
        applying += 1
        textView.selectedRange = window
        applying -= 1
    }

    /// The floating Cut, Copy and Paste menu UIKit shows after its own Select All.
    private func presentSelectionMenu() {
        let interaction: UIEditMenuInteraction
        if let selectionMenu {
            interaction = selectionMenu
        } else {
            interaction = UIEditMenuInteraction(delegate: self)
            textView.addInteraction(interaction)
            selectionMenu = interaction
        }
        let point = CGPoint(
            x: textView.bounds.midX, y: textView.contentOffset.y + textView.bounds.height / 3)
        interaction.presentEditMenu(
            with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }
}

extension TextFirstEditorController: UIEditMenuInteractionDelegate {
    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration,
        suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        UIMenu(children: suggestedActions)
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        willPresentMenuFor configuration: UIEditMenuConfiguration,
        animator: any UIEditMenuInteractionAnimating
    ) {
        menuVisible = true
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        willDismissMenuFor configuration: UIEditMenuConfiguration,
        animator: any UIEditMenuInteractionAnimating
    ) {
        menuVisible = false
        renderHoldChanged()
    }
}
