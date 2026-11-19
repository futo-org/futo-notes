import UIKit

// The drawing behind a block drag's live preview (#448, #447's prototype): a stretch of the note
// drawn by the editor's own layout fragments, exactly as the text view draws it, so a slice can
// be drawn for text that is not on screen and matches the screen pixel for pixel. Two rules make
// it match: each fragment is placed on the pixel row its own view is (its position rounded
// down to the pixel), and each slice is a whole number of pixels tall.

@MainActor
struct TextFirstSlicePainter {
    let textView: UITextView

    var scale: CGFloat { textView.traitCollection.displayScale }

    /// The editor's surface colour, which shows behind the text (the text view itself is clear).
    var surface: UIColor { UIColor(Theme.background).resolvedColor(with: textView.traitCollection) }

    /// `y` rounded down to the device pixel, as UIKit places a fragment's view.
    func pixel(_ y: CGFloat) -> CGFloat { Self.pixel(y, scale) }

    static func pixel(_ y: CGFloat, _ scale: CGFloat) -> CGFloat {
        (y * scale + 0.001).rounded(.down) / scale
    }

    /// `rect` (text view coordinates) as the text view draws it: every layout fragment that
    /// meets it, laid out where it is not yet, at its pixel row. Drawing starts a line above
    /// the one drawn at the rect's top (fragments spill a little past their frames), or, where
    /// nothing is laid out there yet, a line above `from` (a UTF-16 line start at or above the
    /// rect's top); never further back, where it would lay out text far off screen. Over the
    /// surface colour when `opaque`, else over nothing (the card's text over its see-through
    /// background). `erasing` (text view coordinates) is left blank: a photo drawn apart. Rows
    /// are cut on the pixel grid, from `rect`'s top rounded down. Not `layingOut`, only what is
    /// laid out is drawn: laying out more can move what is.
    func paint(
        _ rect: CGRect, from: Int? = nil, opaque: Bool = true, erasing: CGRect? = nil,
        layingOut: Bool = true
    ) -> CGImage? {
        guard let manager = textView.textLayoutManager,
            let content = manager.textContentManager
        else { return nil }
        let above = manager.textLayoutFragment(
            for: CGPoint(x: 1, y: max(0, rect.minY - textView.textContainerInset.top - 1)))
        let start =
            above.flatMap { f in
                content.location(f.rangeInElement.location, offsetBy: -1)
                    ?? f.rangeInElement.location
            }
            ?? from.flatMap {
                content.location(manager.documentRange.location, offsetBy: max(0, $0 - 1))
            }
        let first = start.flatMap { manager.textLayoutFragment(for: $0) }?.rangeInElement.location
        return draw(
            rect, opaque: opaque, erasing: erasing,
            fragments: { visit in
                manager.enumerateTextLayoutFragments(
                    from: first ?? manager.documentRange.location,
                    options: layingOut ? [.ensuresLayout] : []
                ) { layingOut || $0.state == .layoutAvailable ? visit($0) : true }
            })
    }

    /// `rect` drawn from the fragments `fragments` hands out in order (each `visit` returns
    /// false once a fragment starts below the rect), positioned as in the text view, or
    /// `shift` lower.
    func draw(
        _ rect: CGRect, opaque: Bool = true, erasing: CGRect? = nil, shift: CGFloat = 0,
        fragments: (_ visit: (NSTextLayoutFragment) -> Bool) -> Void
    ) -> CGImage? {
        let top = pixel(rect.minY)
        // A whole number of rows: 73.0000001 is 73, never 74 (the layer would squeeze it).
        let rows = ((rect.maxY - top) * scale).rounded()
        guard rect.width > 0, rows > 0 else { return nil }
        let size = CGSize(width: (rect.width * scale).rounded() / scale, height: rows / scale)
        let format = UIGraphicsImageRendererFormat(for: textView.traitCollection)
        format.opaque = opaque
        let inset = textView.textContainerInset
        let background = surface
        var image: UIImage?
        textView.traitCollection.performAsCurrent {
            image = UIGraphicsImageRenderer(size: size, format: format).image { ui in
                let context = ui.cgContext
                if opaque {
                    background.setFill()
                    context.fill(CGRect(origin: .zero, size: size).insetBy(dx: -1, dy: -1))
                }
                let band = CGRect(x: rect.minX, y: top, width: size.width, height: size.height)
                fragments { f in
                    let origin = CGPoint(
                        x: inset.left + f.layoutFragmentFrame.minX,
                        y: inset.top + f.layoutFragmentFrame.minY + shift)
                    if origin.y > band.maxY { return false }
                    let surface = f.renderingSurfaceBounds.offsetBy(dx: origin.x, dy: origin.y)
                    guard surface.intersects(band) else { return true }
                    context.saveGState()
                    f.draw(
                        at: CGPoint(x: origin.x - band.minX, y: pixel(origin.y) - band.minY),
                        in: context)
                    context.restoreGState()
                    return true
                }
                if let erasing {
                    let blank = erasing.offsetBy(dx: -band.minX, dy: -band.minY)
                    if opaque {
                        background.setFill()
                        context.fill(blank)
                    } else {
                        context.clear(blank)
                    }
                }
            }
        }
        return image?.cgImage
    }
}
