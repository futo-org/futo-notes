#if FUTO_DEBUG_BUILD
    import UIKit

    /// Owns the image atoms of one open note: interned per destination so a restyle finds a
    /// loaded bitmap, loads them, and writes their geometry (the glyph kern and the paragraph's
    /// minimum line height) into the text storage.
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
                if let list = block.list {
                    indent += TextFirstMetrics.listIndent(depth: list.depth)
                }
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
            if let hit = TextFirstImageLoader.cached(destination, pixelWidth: pixelWidth) {
                made.image = hit
                made.decodedPixelWidth = Int(hit.size.width * hit.scale)
                made.naturalPixelWidth = made.decodedPixelWidth
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

        /// Write every image of `r`'s paragraph into its glyphs and line height.
        func layoutParagraph(_ storage: NSTextStorage, containing r: NSRange) {
            let paragraph = (storage.string as NSString).paragraphRange(for: r)
            let room = available(at: paragraph, in: storage)
            var height: CGFloat = 0
            storage.enumerateAttribute(.tfImage, in: paragraph) { value, run, _ in
                guard let span = value as? TextFirstImageSpan else { return }
                let size = TextFirstImageMetrics.size(of: span.atom, available: room)
                span.size = size
                height = max(height, size.height)
                storage.addAttribute(
                    .kern, value: size.width, range: NSRange(location: run.location, length: 1))
            }
            guard height > 0 else { return }
            let old =
                storage.attribute(.paragraphStyle, at: paragraph.location, effectiveRange: nil)
                as? NSParagraphStyle
            let style =
                (old?.mutableCopy() as? NSMutableParagraphStyle) ?? NSMutableParagraphStyle()
            style.minimumLineHeight = height
            storage.addAttribute(.paragraphStyle, value: style, range: paragraph)
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

        /// The whole image a caret's Backspace (or forward Delete) would otherwise cut into: the
        /// engine's Backspace removes one grapheme, which here is the last glyph of the spelling
        /// and would leave plain text behind. Removes that image in one edit and returns true.
        func deleteImage(adjacentTo caret: Int, forward: Bool) -> Bool {
            let probe = forward ? caret : caret - 1
            guard !closed, probe >= 0, probe < storage.length else { return false }
            let paragraph = (storage.string as NSString).paragraphRange(
                for: NSRange(location: probe, length: 0))
            var run = NSRange()
            guard
                storage.attribute(.tfImage, at: probe, longestEffectiveRange: &run, in: paragraph)
                    is TextFirstImageSpan,
                forward ? run.location == caret : NSMaxRange(run) == caret
            else { return false }
            return paragraphKey(forward ? .delete : .backspace, range: run)
        }

        /// `range` with each end moved out of an image's glyphs (nearest end; a one-glyph step
        /// from one end, an arrow key, jumps across the whole image).
        func clampedOutOfImages(_ range: NSRange) -> NSRange {
            let previous = engineSelection
            func clamp(_ p: Int, before: Int?) -> Int {
                guard p > 0, p < storage.length else { return p }
                var run = NSRange()
                let paragraph = (storage.string as NSString).paragraphRange(
                    for: NSRange(location: p, length: 0))
                guard
                    storage.attribute(.tfImage, at: p, longestEffectiveRange: &run, in: paragraph)
                        is TextFirstImageSpan, p > run.location
                else { return p }
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

        /// The first visible line and how far into view it was, so an image that grows above
        /// the screen does not push what the reader is looking at.
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
            let offset = manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            return ScrollAnchor(offset: offset, delta: top - fragment.layoutFragmentFrame.minY)
        }

        func restoreScrollAnchor(_ anchor: ScrollAnchor?) {
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
            guard let fragment = manager.textLayoutFragment(for: location) else { return }
            let y =
                fragment.layoutFragmentFrame.minY + anchor.delta + textView.textContainerInset.top
            if abs(y - textView.contentOffset.y) > 0.5 {
                textView.contentOffset.y = max(0, y)
            }
        }
    }
#endif
