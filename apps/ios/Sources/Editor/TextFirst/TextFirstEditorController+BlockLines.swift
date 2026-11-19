import UIKit

// The note's lines as a block drag reads them (#449): where lines start and end as the engine
// counts them, and what TextKit has laid out of them.

extension NSString {
    /// The note's line holding UTF-16 `offset`, its line feed included, as the engine counts
    /// lines: a line ends only at a line feed (Linedown). Foundation's `lineRange` also ends
    /// lines at U+2028, U+2029, U+0085 and a lone return, which the engine keeps inside a line.
    func noteLine(at offset: Int) -> NSRange {
        let at = min(max(offset, 0), length)
        let before =
            at == 0
            ? NSNotFound
            : range(
                of: "\n", options: [.literal, .backwards], range: NSRange(location: 0, length: at)
            )
            .location
        let start = before == NSNotFound ? 0 : before + 1
        let after = range(
            of: "\n", options: .literal, range: NSRange(location: at, length: length - at)
        ).location
        return NSRange(location: start, length: (after == NSNotFound ? length : after + 1) - start)
    }
}

extension TextFirstEditorController {
    /// The UTF-16 start of display line `k`, counting from the line start `base`; nil past the
    /// text's end.
    func lineStart(_ k: Int, from base: Int) -> Int? {
        let starts = lineStarts(from: base, through: storage.length, lines: k + 1)
        return k < starts.count ? starts[k] : nil
    }

    /// The UTF-16 starts of the display lines from the line start `base` to `through`, at most
    /// `lines` of them.
    func lineStarts(from base: Int, through: Int, lines: Int = .max) -> [Int] {
        let text = storage.string as NSString
        var starts = [base]
        var at = base
        while at < min(through, text.length), starts.count < lines {
            let found = text.range(
                of: "\n", options: .literal,
                range: NSRange(location: at, length: min(through, text.length) - at))
            guard found.location != NSNotFound else { break }
            at = NSMaxRange(found)
            starts.append(at)
        }
        return starts
    }

    /// Have TextKit lay out the lines of UTF-16 `range` now.
    func ensureLayout(_ range: NSRange) {
        guard let manager = textView.textLayoutManager, let content = manager.textContentManager,
            let a = content.location(manager.documentRange.location, offsetBy: range.location),
            let b = content.location(
                manager.documentRange.location,
                offsetBy: min(NSMaxRange(range) + 1, storage.length)),
            let lines = NSTextRange(location: a, end: b)
        else { return }
        manager.ensureLayout(for: lines)
    }

    /// The stretch of the note TextKit has laid out (text view coordinates), unbounded at the
    /// note's ends: what is drawn there beyond its fragments (the box of an empty last task)
    /// is laid out too.
    func laidOutBand() -> CGRect? {
        guard let manager = textView.textLayoutManager,
            let viewport = manager.textViewportLayoutController.viewportRange,
            let first = manager.textLayoutFragment(for: viewport.location),
            let end = manager.textContentManager?.location(viewport.endLocation, offsetBy: -1),
            let last = manager.textLayoutFragment(for: end)
        else { return nil }
        let document = manager.documentRange
        let far: CGFloat = 1e7
        let top =
            viewport.location.compare(document.location) == .orderedDescending
            ? inset.top + first.layoutFragmentFrame.minY : -far
        let bottom =
            viewport.endLocation.compare(document.endLocation) == .orderedAscending
            ? inset.top + max(last.layoutFragmentFrame.maxY, first.layoutFragmentFrame.maxY) : far
        return CGRect(x: 0, y: top, width: textView.bounds.width, height: bottom - top)
    }
}
