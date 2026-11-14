import UIKit

/// Owns the image atoms of one open note: interned per destination so a restyle finds a
/// loaded bitmap, loads them, and writes their geometry (the glyph kern and the baseline lift
/// that makes the image's own line as tall as the image) into the text storage.
@MainActor
final class TextFirstImages {
    weak var controller: TextFirstEditorController?
    let loader: TextFirstImageLoader
    private var atoms: [String: TextFirstImageAtom] = [:]
    private var dirty = Set<ObjectIdentifier>()
    private var flushPending = false
    private(set) var lastWidth: CGFloat = 0
    /// A failed load is tried again after this long (a synced file may arrive; a remote may return).
    static let vaultRetry: TimeInterval = 10
    static let remoteRetry: TimeInterval = 30

    init(controller: TextFirstEditorController, root: URL, protocols: [AnyClass]? = nil) {
        self.controller = controller
        loader = TextFirstImageLoader(
            root: root, scale: controller.textView.traitCollection.displayScale,
            protocols: protocols)
    }

    func shutdown() { loader.cancel() }

    /// Whether the note has had an image in it: only then is a line's geometry worth asking.
    var hasImages: Bool { !atoms.isEmpty }

    // MARK: sizes

    /// The width a line of text may use (the container's, before any list or quote indent).
    var containerWidth: CGFloat {
        guard let tv = controller?.textView else { return 320 }
        let w = tv.bounds.width - tv.textContainerInset.left - tv.textContainerInset.right
        return w > 40 ? w : 320
    }

    private var scale: CGFloat { controller?.textView.traitCollection.displayScale ?? 2 }
    private var pixelWidth: Int { Int((containerWidth * scale).rounded()) }

    private func available(at paragraph: NSRange, in storage: NSTextStorage) -> CGFloat {
        var indent: CGFloat = 0
        if let block = storage.attribute(.tfBlock, at: paragraph.location, effectiveRange: nil)
            as? TextFirstBlockAttribute
        {
            indent = TextFirstMetrics.quoteIndent(depth: block.quoteDepth)
            indent += block.listIndent
        }
        return max(40, containerWidth - indent)
    }

    // MARK: atoms

    private func atom(_ destination: String, _ alt: String, _ vault: Bool, _ remote: Bool)
        -> TextFirstImageAtom
    {
        if let known = atoms[destination], known.vault == vault, known.remote == remote {
            return known
        }
        let made = TextFirstImageAtom(
            destination: destination, alt: alt, vault: vault, remote: remote)
        if let hit = loader.cached(made, pixelWidth: pixelWidth) {
            made.image = hit.image
            made.decodedPixelWidth = Int(hit.image.size.width * hit.image.scale)
            made.naturalPixelWidth = hit.natural
        }
        atoms[destination] = made
        return made
    }

    /// Style one image atom: hide its glyphs, tag them, size its line, and start its load.
    func style(
        _ storage: NSTextStorage, _ r: NSRange, destination: String, alt: String, vault: Bool,
        remote: Bool
    ) {
        let atom = atom(destination, alt, vault, remote)
        let span = TextFirstImageSpan(atom)
        storage.addAttributes(
            [
                .tfImage: span, .font: TextFirstImageMetrics.hiddenFont,
                .foregroundColor: UIColor.clear,
                .underlineStyle: 0, .strikethroughStyle: 0, .backgroundColor: UIColor.clear,
            ], range: r)
        layoutParagraph(storage, containing: r)
        request(atom)
    }

    /// Write every image of `r`'s paragraph into its glyphs: the kern that gives the hidden
    /// spelling the image's width, and the baseline lift that makes the image's own line as
    /// tall as the image. The height is the run's, not the paragraph's, so the text sharing
    /// the paragraph (before the image, or wrapped after it) keeps ordinary lines.
    func layoutParagraph(_ storage: NSTextStorage, containing r: NSRange) {
        let paragraph = (storage.string as NSString).paragraphRange(for: r)
        let room = available(at: paragraph, in: storage)
        storage.enumerateAttribute(.tfImage, in: paragraph) { value, run, _ in
            guard let span = value as? TextFirstImageSpan else { return }
            let size = TextFirstImageMetrics.size(of: span.atom, available: room)
            span.size = size
            // The hidden spelling still has a small advance. Reserving the entire image
            // width in addition to it wraps a full-width photo onto a second, equally tall line.
            let spelling = (storage.string as NSString).substring(with: run)
            storage.addAttributes(
                [
                    .kern: max(0, size.width - TextFirstImageMetrics.textAdvance(spelling)),
                    .baselineOffset: size.height,
                ], range: NSRange(location: run.location, length: 1))
        }
    }

    // MARK: loading

    func request(_ atom: TextFirstImageAtom) {
        // Until the view has a width, a decode would be sized for a guess; widthChanged asks.
        guard !atom.loading, controller?.textView.bounds.width ?? 0 > 40 else { return }
        let wanted = pixelWidth
        if atom.image != nil {
            // Decoded smaller than a wider view now shows (rotation): decode again.
            guard atom.decodedPixelWidth + 2 < min(atom.naturalPixelWidth, wanted) else {
                return
            }
        } else if let failed = atom.failedAt {
            let wait = atom.vault ? Self.vaultRetry : Self.remoteRetry
            guard Date().timeIntervalSince(failed) > wait else { return }
        }
        atom.loading = true
        loader.load(atom, pixelWidth: wanted) { [weak self] image, natural in
            MainActor.assumeIsolated { self?.loaded(atom, image, natural) }
        }
    }

    private func loaded(_ atom: TextFirstImageAtom, _ image: UIImage?, _ natural: Int) {
        atom.loading = false
        guard controller?.isClosed == false else { return }
        if let image {
            atom.image = image
            atom.decodedPixelWidth = Int(image.size.width * image.scale)
            atom.naturalPixelWidth = natural
            atom.failedAt = nil
        } else if atom.image == nil {
            atom.failedAt = Date()
        }
        dirty.insert(ObjectIdentifier(atom))
        guard !flushPending else { return }
        flushPending = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    /// Re-lay out every occurrence of the atoms whose state changed, in one edit.
    private func flush() {
        flushPending = false
        let changed = dirty
        dirty = []
        guard let controller, !controller.isClosed else { return }
        relayout(controller) { span in changed.contains(ObjectIdentifier(span.atom)) }
    }

    /// The view's width changed: sizes follow it, and a wider view may want a larger decode.
    func widthChanged() {
        let width = containerWidth
        guard abs(width - lastWidth) > 0.5, let controller, !controller.isClosed else { return }
        lastWidth = width
        relayout(controller) { _ in true }
        for atom in atoms.values { request(atom) }
    }

    private func relayout(
        _ controller: TextFirstEditorController, matching: (TextFirstImageSpan) -> Bool
    ) {
        let storage = controller.storage
        let styled = NSRange(location: 0, length: min(controller.styledThrough, storage.length))
        var hits: [NSRange] = []
        storage.enumerateAttribute(.tfImage, in: styled) { value, run, _ in
            if let span = value as? TextFirstImageSpan, matching(span) { hits.append(run) }
        }
        guard !hits.isEmpty else { return }
        let held = controller.captureScrollAnchor()
        storage.beginEditing()
        for run in hits { layoutParagraph(storage, containing: run) }
        storage.endEditing()
        if let manager = controller.textView.textLayoutManager,
            let content = manager.textContentManager
        {
            for run in hits {
                if let from = content.location(
                    manager.documentRange.location, offsetBy: run.location),
                    let to = content.location(from, offsetBy: run.length),
                    let range = NSTextRange(location: from, end: to)
                {
                    manager.invalidateLayout(for: range)
                }
            }
        }
        controller.restoreScrollAnchor(held)
        controller.textView.setNeedsDisplay()
    }
}

extension TextFirstEditorController {
    var isClosed: Bool { closed }

    /// `range` with each end moved out of an image's glyphs (nearest end; a one-glyph step
    /// from one end, an arrow key, jumps across the whole image).
    func clampedOutOfImages(_ range: NSRange) -> NSRange {
        let previous = engineSelection
        func clamp(_ p: Int, before: Int?) -> Int {
            guard p > 0, p < storage.length else { return p }
            var run = NSRange()
            let paragraph = (storage.string as NSString).paragraphRange(
                for: NSRange(location: p, length: 0))
            let isAtom =
                storage.attribute(.tfImage, at: p, longestEffectiveRange: &run, in: paragraph)
                is TextFirstImageSpan
                || storage.attribute(
                    .tfTable, at: p, longestEffectiveRange: &run, in: paragraph)
                    is TextFirstTableRowSpan
            guard isAtom, p > run.location else { return p }
            if before == run.location, p == run.location + 1 { return NSMaxRange(run) }
            if before == NSMaxRange(run), p == NSMaxRange(run) - 1 { return run.location }
            return p - run.location <= NSMaxRange(run) - p ? run.location : NSMaxRange(run)
        }
        if range.length == 0 {
            let p = clamp(
                range.location, before: previous.length == 0 ? previous.location : nil)
            return NSRange(location: p, length: 0)
        }
        let a = clamp(range.location, before: nil)
        let b = clamp(NSMaxRange(range), before: nil)
        return NSRange(location: a, length: max(0, b - a))
    }

    /// The image whose last glyph is just before `offset`, with the glyph run it covers.
    private func image(endingAt offset: Int) -> (range: NSRange, span: TextFirstImageSpan)? {
        guard offset > 0, offset <= storage.length,
            storage.attribute(.tfImage, at: offset - 1, effectiveRange: nil)
                is TextFirstImageSpan
        else { return nil }
        var run = NSRange()
        let paragraph = (storage.string as NSString).paragraphRange(
            for: NSRange(location: offset - 1, length: 0))
        guard
            let span = storage.attribute(
                .tfImage, at: offset - 1, longestEffectiveRange: &run, in: paragraph)
                as? TextFirstImageSpan,
            NSMaxRange(run) == offset
        else { return nil }
        return (run, span)
    }

    /// A caret just after an image is offered the hidden spelling's attributes (0.01 pt, clear,
    /// widened by the image's kern), and UIKit drops the `.tfImage` key from them, so they
    /// cannot be recognised by it. Marked text (an IME's composition, dictation) is drawn with
    /// them until it is committed, so it is invisible. The look is the image's, never the text's.
    func syncImageTypingAttributes() {
        let caret = textView.selectedRange
        guard caret.length == 0, image(endingAt: caret.location) != nil else { return }
        textView.typingAttributes = Self.withoutImageSpelling(textView.typingAttributes)
    }

    /// `attributes` without what hides an image's spelling; anything else (a toolbar toggle's
    /// bold, a paragraph's indent) is kept.
    static func withoutImageSpelling(_ attributes: [NSAttributedString.Key: Any])
        -> [NSAttributedString.Key: Any]
    {
        var plain = attributes
        if let font = plain[.font] as? UIFont, font.pointSize <= 1 {
            plain[.font] = bodyFont
        }
        if (plain[.foregroundColor] as? UIColor) == UIColor.clear {
            plain[.foregroundColor] = baseAttributes[.foregroundColor]
        }
        plain[.kern] = nil
        plain[.baselineOffset] = nil
        plain[.tfImage] = nil
        return plain
    }

    /// A text-height rect standing on the baseline of the image-bearing line that holds the
    /// text view's `rect`: UIKit sizes carets, selection rects and handles to the line, which
    /// is as tall as its tallest image. Nil when that line has no image.
    func onImageLine(_ rect: CGRect) -> CGRect? {
        guard images.hasImages, let manager = textView.textLayoutManager else { return nil }
        let y = rect.midY - inset.top
        guard
            let f = manager.textLayoutFragment(for: CGPoint(x: 0, y: y))
                as? TextFirstLayoutFragment,
            !f.imageRuns.isEmpty,
            let baseline = f.imageLineBaseline(atY: y - f.layoutFragmentFrame.minY)
        else { return nil }
        return Self.textRect(rect, baseline: baseline + f.layoutFragmentFrame.minY + inset.top)
    }

    /// `rect` as tall as a line of body text, standing on `baseline` (text view coordinates).
    private static func textRect(_ rect: CGRect, baseline: CGFloat) -> CGRect {
        let ascent = ceil(bodyFont.ascender)
        return CGRect(
            x: rect.minX, y: baseline - ascent, width: rect.width,
            height: ceil(bodyFont.lineHeight))
    }

    /// Where the caret at `offset` is drawn when its line has an image: as tall as a line of
    /// text, level with the text on the baseline the images stand on. Just after an image it is
    /// against the image's trailing edge. Only the drawing: the position is the one UIKit
    /// reports. Nil when the line has no image or is not laid out.
    func imageLineCaret(at offset: Int, proposed: CGRect) -> CGRect? {
        if let (x, baseline) = imageTrailingEdge(at: offset) {
            return Self.textRect(
                CGRect(x: x, y: 0, width: proposed.width, height: 0), baseline: baseline)
        }
        return onImageLine(proposed)
    }

    /// The trailing edge of the image that ends at `offset` and its line's baseline, in text
    /// view coordinates. Nil when `offset` is not the end of an image or its line is not laid out.
    private func imageTrailingEdge(at offset: Int) -> (x: CGFloat, baseline: CGFloat)? {
        guard let (run, span) = image(endingAt: offset),
            let manager = textView.textLayoutManager,
            let content = manager.textContentManager,
            let at = content.location(manager.documentRange.location, offsetBy: run.location),
            let end = content.location(at, offsetBy: 1),
            let glyph = NSTextRange(location: at, end: end)
        else { return nil }
        // After the keyboard moves the viewport the image's line may not be laid out yet.
        manager.ensureLayout(for: glyph)
        guard let f = manager.textLayoutFragment(for: at) as? TextFirstLayoutFragment
        else { return nil }
        let start = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        guard
            let hit = f.imageRuns.first(where: {
                $0.span === span && $0.range.location == run.location - start
            }), let rect = f.imageRect(hit)
        else { return nil }
        return (
            rect.maxX + inset.left, rect.maxY + f.layoutFragmentFrame.minY + inset.top
        )
    }

    /// The first visible line and how far into view it was, so an image that grows above
    /// the screen, or a new width, does not push what the reader is looking at. The anchor is
    /// the line's first character, not its fragment: a new width re-wraps a paragraph, and a
    /// point offset into a paragraph that is now a different height means a different line.
    struct ScrollAnchor {
        let offset: Int
        let delta: CGFloat
    }

    func captureScrollAnchor() -> ScrollAnchor? {
        guard let manager = textView.textLayoutManager, textView.contentOffset.y > 1 else {
            return nil
        }
        let top = textView.contentOffset.y - textView.textContainerInset.top
        guard let fragment = manager.textLayoutFragment(for: CGPoint(x: 0, y: top)) else {
            return nil
        }
        let start = manager.offset(
            from: manager.documentRange.location, to: fragment.rangeInElement.location)
        let lines = fragment.textLineFragments
        let line =
            lines.first {
                fragment.layoutFragmentFrame.minY + $0.typographicBounds.maxY > top
            } ?? lines.last
        guard let line else {
            return ScrollAnchor(offset: start, delta: top - fragment.layoutFragmentFrame.minY)
        }
        return ScrollAnchor(
            offset: start + line.characterRange.location,
            delta: top - (fragment.layoutFragmentFrame.minY + line.typographicBounds.minY))
    }

    func restoreScrollAnchor(_ anchor: ScrollAnchor?, widthChange: Bool = false) {
        guard let anchor, let manager = textView.textLayoutManager,
            let content = manager.textContentManager,
            let location = content.location(
                manager.documentRange.location, offsetBy: anchor.offset)
        else { return }
        if let end = content.location(location, offsetBy: 1),
            let r = NSTextRange(location: location, end: end)
        {
            manager.ensureLayout(for: r)
        }
        var relocated: CGFloat?
        if widthChange {
            relocated = manager.textViewportLayoutController.relocateViewport(to: location)
        }
        guard let fragment = manager.textLayoutFragment(for: location) else { return }
        let within =
            anchor.offset
            - manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
        let lineTop =
            fragment.textLineFragments.last { $0.characterRange.location <= within }?
            .typographicBounds.minY ?? 0
        let y =
            (relocated ?? fragment.layoutFragmentFrame.minY) + lineTop + anchor.delta
            + textView.textContainerInset.top
        if abs(y - textView.contentOffset.y) > 0.5 {
            textView.contentOffset.y = max(0, y)
        }
    }
}
