#if FUTO_DEBUG_BUILD
    import UIKit

    // Bullets, numbers, checkboxes, quote bars, code backgrounds and dividers, drawn by
    // NSTextLayoutFragment subclasses from the block facts the engine sent. None of these are
    // characters in the text: the display holds only the words.

    extension NSAttributedString.Key {
        /// `TextFirstBlockAttribute` on every character of a drawn line (including its newline).
        static let tfBlock = NSAttributedString.Key("futo.tf.block")
        /// An external link's destination, on its glyphs.
        static let tfLinkURL = NSAttributedString.Key("futo.tf.linkURL")
        /// A resolved wikilink's note id, on its glyphs.
        static let tfWikilink = NSAttributedString.Key("futo.tf.wikilink")
    }

    /// What the engine said about one line that draws something besides text.
    final class TextFirstBlockAttribute: NSObject {
        var quoteDepth = 0
        var code = false
        var divider = false
        var list: (depth: Int, marker: EditorListMarker, number: UInt64?, checked: Bool)?
        /// False on a row's later lines (a loose list's blank line): they indent but draw no marker.
        var showsMarker = true
    }

    enum TextFirstMetrics {
        static func listIndent(depth: Int) -> CGFloat { 30 + CGFloat(depth) * 24 }
        static func quoteIndent(depth: Int) -> CGFloat {
            depth > 0 ? 14 + CGFloat(depth - 1) * 14 : 0
        }
        static let checkboxSide: CGFloat = 18
    }

    final class TextFirstLayoutFragment: NSTextLayoutFragment {
        let block: TextFirstBlockAttribute
        var accent: UIColor = UIColor(Theme.primary)
        /// The controller whose selection decides whether the marker is highlighted.
        weak var host: TextFirstEditorController?
        /// The images of this paragraph: where their glyphs start in it, and the span.
        let imageRuns: [(range: NSRange, span: TextFirstImageSpan)]
        /// The table rows of this paragraph (one, for a row line).
        let tableRuns: [(range: NSRange, span: TextFirstTableRowSpan)]

        init(
            block: TextFirstBlockAttribute, element: NSTextElement, range: NSTextRange?,
            host: TextFirstEditorController?
        ) {
            self.block = block
            self.host = host
            var runs: [(NSRange, TextFirstImageSpan)] = []
            var rows: [(NSRange, TextFirstTableRowSpan)] = []
            if let paragraph = element as? NSTextParagraph {
                let text = paragraph.attributedString
                let all = NSRange(location: 0, length: text.length)
                text.enumerateAttribute(.tfImage, in: all) { value, run, _ in
                    if let span = value as? TextFirstImageSpan { runs.append((run, span)) }
                }
                text.enumerateAttribute(.tfTable, in: all) { value, run, _ in
                    if let span = value as? TextFirstTableRowSpan { rows.append((run, span)) }
                }
            }
            imageRuns = runs
            tableRuns = rows
            super.init(textElement: element, range: range)
        }

        /// An image's rect in this fragment's coordinates (x in container coordinates).
        func imageRect(_ run: (range: NSRange, span: TextFirstImageSpan)) -> CGRect? {
            guard
                let line = textLineFragments.first(where: {
                    NSLocationInRange(run.range.location, $0.characterRange)
                })
            else { return nil }
            // The line's own x excludes the paragraph's head indent (list, quote).
            let style =
                line.attributedString.attribute(
                    .paragraphStyle,
                    at: line.characterRange.location - line.characterRange.location,
                    effectiveRange: nil) as? NSParagraphStyle
            let indent =
                (line.characterRange.location == 0 ? style?.firstLineHeadIndent : style?.headIndent)
                ?? 0
            let x =
                line.typographicBounds.minX + indent
                + line.locationForCharacter(at: run.range.location).x
            let size = run.span.size
            return CGRect(
                x: x, y: line.typographicBounds.minY, width: size.width, height: size.height)
        }

        /// A table row's grid rect in this fragment's coordinates (x in container coordinates).
        func tableRect(_ run: (range: NSRange, span: TextFirstTableRowSpan)) -> CGRect? {
            guard
                let line = textLineFragments.first(where: {
                    NSLocationInRange(run.range.location, $0.characterRange)
                })
            else { return nil }
            return CGRect(
                x: 0, y: line.typographicBounds.minY, width: containerWidth, height: run.span.height
            )
        }

        private func drawTables(at point: CGPoint, in context: CGContext) {
            UIGraphicsPushContext(context)
            defer { UIGraphicsPopContext() }
            for run in tableRuns {
                guard let rect = tableRect(run)?.offsetBy(dx: point.x, dy: point.y) else {
                    continue
                }
                let span = run.span
                let scroll = MainActor.assumeIsolated { host?.tableScroll[span.tableStart] } ?? 0
                context.saveGState()
                context.clip(to: rect)
                if span.header {
                    UIColor.tertiarySystemFill.setFill()
                    context.fill(rect)
                }
                let width = TextFirstTableMetrics.cellWidth
                let pad = TextFirstTableMetrics.padding
                let marks = tableMarks(for: run)
                for column in 0..<span.columns {
                    let cell = CGRect(
                        x: rect.minX - scroll + CGFloat(column) * width, y: rect.minY, width: width,
                        height: rect.height)
                    if cell.maxX < rect.minX || cell.minX > rect.maxX { continue }
                    for mark in marks where mark.column == column {
                        TextFirstFindColors.fill(current: mark.current).setFill()
                        for r in mark.rects {
                            context.fill(r.offsetBy(dx: cell.minX + pad, dy: cell.minY + pad))
                        }
                    }
                    UIColor.separator.setStroke()
                    context.setLineWidth(1)
                    context.stroke(cell.insetBy(dx: 0.5, dy: 0.5))
                    guard let content = span.cell(atColumn: column), !content.text.isEmpty else {
                        continue
                    }
                    let paragraph = NSMutableParagraphStyle()
                    paragraph.alignment =
                        content.alignment == .right
                        ? .right : content.alignment == .center ? .center : .natural
                    (content.text as NSString).draw(
                        in: cell.insetBy(dx: pad, dy: pad),
                        withAttributes: [
                            .font: TextFirstTableMetrics.font(header: span.header),
                            .foregroundColor: UIColor.label, .paragraphStyle: paragraph,
                        ])
                }
                context.restoreGState()
            }
        }

        private func drawImages(at point: CGPoint, in context: CGContext) {
            UIGraphicsPushContext(context)
            defer { UIGraphicsPopContext() }
            for run in imageRuns {
                guard let rect = imageRect(run)?.offsetBy(dx: point.x, dy: point.y) else {
                    continue
                }
                let atom = run.span.atom
                if let image = atom.image {
                    image.draw(in: rect)
                    continue
                }
                let path = UIBezierPath(roundedRect: rect, cornerRadius: 6)
                UIColor.tertiarySystemFill.setFill()
                path.fill()
                if atom.failed {
                    let label = NSAttributedString(
                        string: atom.alt.isEmpty ? atom.destination : atom.alt,
                        attributes: [
                            .font: UIFont.systemFont(ofSize: 13),
                            .foregroundColor: UIColor.secondaryLabel,
                        ])
                    let box = rect.insetBy(dx: 8, dy: 0)
                    let size = label.boundingRect(
                        with: CGSize(width: box.width, height: rect.height), options: [],
                        context: nil)
                    label.draw(
                        in: CGRect(
                            x: box.minX, y: rect.midY - size.height / 2, width: box.width,
                            height: size.height + 1))
                }
            }
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override var renderingSurfaceBounds: CGRect {
            // Gutter art lives left of the text and code backgrounds span the full width.
            super.renderingSurfaceBounds.union(
                CGRect(
                    x: -layoutFragmentFrame.minX - 24, y: 0,
                    width: max(containerWidth, layoutFragmentFrame.width) + 60,
                    height: layoutFragmentFrame.height))
        }

        private var containerWidth: CGFloat {
            textLayoutManager?.textContainer?.size.width
                ?? (layoutFragmentFrame.width + layoutFragmentFrame.minX)
        }

        private var firstLine: CGRect {
            textLineFragments.first?.typographicBounds ?? CGRect(x: 0, y: 0, width: 0, height: 20)
        }

        /// The first line's baseline in the fragment's coordinates. An empty paragraph and a typed
        /// one place their glyph origin alike, so a marker hung from it does not move when the
        /// first character arrives.
        private var firstBaseline: CGFloat {
            guard let line = textLineFragments.first else { return 16 }
            return line.typographicBounds.minY + line.glyphOrigin.y
        }

        /// Where a bullet or box is centered: the middle of the first line's capital letters.
        var markerCenterY: CGFloat {
            let font =
                textLineFragments.first.flatMap { line in
                    line.attributedString.length > 0
                        ? line.attributedString.attribute(.font, at: 0, effectiveRange: nil)
                            as? UIFont
                        : nil
                } ?? MainActor.assumeIsolated { TextFirstEditorController.bodyFont }
            return firstBaseline - font.capHeight / 2
        }

        /// Adjacent fragments share pixel edges, so the block reads as one surface even at
        /// fractional text baselines. An opaque fill avoids darker overlapping edges.
        private func decorationRect(at point: CGPoint, x: CGFloat, width: CGFloat) -> CGRect {
            let scale =
                MainActor.assumeIsolated { host?.textView.traitCollection.displayScale } ?? 2
            let top = (point.y * scale).rounded(.down) / scale
            let bottom = ((point.y + layoutFragmentFrame.height) * scale).rounded(.up) / scale
            return CGRect(x: x, y: top, width: width, height: bottom - top)
        }

        /// The leading edge of the list text, in container coordinates.
        private var textIndent: CGFloat {
            guard let list = block.list else { return 0 }
            return TextFirstMetrics.quoteIndent(depth: block.quoteDepth)
                + TextFirstMetrics.listIndent(depth: list.depth)
        }

        /// The checkbox's rect: x in container coordinates, y relative to the fragment.
        var checkboxRect: CGRect? {
            guard let list = block.list, block.showsMarker, list.marker == .task else { return nil }
            let side = TextFirstMetrics.checkboxSide
            return CGRect(
                x: textIndent - side - 8, y: markerCenterY - side / 2, width: side, height: side)
        }

        /// The marker's gutter, in the fragment's coordinates, when the selection covers the whole
        /// row (so the highlight reaches the rendered bullet, number or box); nil for a caret or a
        /// partial selection.
        var highlightedMarkerRect: CGRect? {
            guard block.list != nil, block.showsMarker, let host, let manager = textLayoutManager,
                MainActor.assumeIsolated({ host.selectionRange(for: self, in: manager) }) != nil
            else { return nil }
            let line = firstLine
            return CGRect(x: textIndent - 26, y: line.minY, width: 26, height: line.height)
        }

        override func draw(at pointIn: CGPoint, in context: CGContext) {
            let point = CGPoint(x: pointIn.x - layoutFragmentFrame.minX, y: pointIn.y)
            if block.code {
                UIColor.secondarySystemBackground.setFill()
                context.fill(decorationRect(at: point, x: point.x - 4, width: containerWidth + 8))
            }
            if block.divider {
                let y = point.y + layoutFragmentFrame.height / 2
                UIColor.opaqueSeparator.setStroke()
                context.setLineWidth(1)
                context.move(to: CGPoint(x: point.x, y: y))
                context.addLine(to: CGPoint(x: point.x + containerWidth, y: y))
                context.strokePath()
            }
            if block.quoteDepth > 0 {
                UIColor.opaqueSeparator.setFill()
                for i in 0..<block.quoteDepth {
                    let x = point.x + 2 + CGFloat(i) * 14
                    context.fill(decorationRect(at: point, x: x, width: 3))
                }
            }
            if let marker = highlightedMarkerRect {
                (MainActor.assumeIsolated { host?.textView.tintColor } ?? accent)
                    .withAlphaComponent(0.2).setFill()
                context.fill(marker.offsetBy(dx: point.x, dy: point.y))
            }
            if let list = block.list, block.showsMarker {
                drawListMarker(list, at: point, in: context)
            }
            drawFindMarks(at: point, in: context)
            super.draw(at: pointIn, in: context)
            drawImages(at: point, in: context)
            drawTables(at: point, in: context)
        }

        private func drawListMarker(
            _ list: (depth: Int, marker: EditorListMarker, number: UInt64?, checked: Bool),
            at point: CGPoint, in context: CGContext
        ) {
            switch list.marker {
            case .task:
                guard let box = checkboxRect else { return }
                let r = box.offsetBy(dx: point.x, dy: point.y)
                let path = UIBezierPath(roundedRect: r, cornerRadius: 4)
                context.saveGState()
                if list.checked {
                    accent.setFill()
                    path.fill()
                    UIColor.white.setStroke()
                    let tick = UIBezierPath()
                    tick.move(to: CGPoint(x: r.minX + 4.5, y: r.midY + 0.5))
                    tick.addLine(to: CGPoint(x: r.minX + 7.7, y: r.maxY - 5))
                    tick.addLine(to: CGPoint(x: r.maxX - 4, y: r.minY + 5))
                    tick.lineWidth = 2
                    tick.lineCapStyle = .round
                    tick.lineJoinStyle = .round
                    tick.stroke()
                } else {
                    UIColor.secondaryLabel.setStroke()
                    path.lineWidth = 1.5
                    path.stroke()
                }
                context.restoreGState()
            case .ordered:
                let font = UIFont.monospacedDigitSystemFont(ofSize: 17, weight: .regular)
                let text = NSAttributedString(
                    string: "\(list.number ?? 1).",
                    attributes: [.font: font, .foregroundColor: UIColor.secondaryLabel])
                let size = text.size()
                text.draw(
                    at: CGPoint(
                        x: point.x + textIndent - size.width - 6,
                        y: point.y + firstBaseline - font.ascender))
            case .bullet:
                // Disc, ring, square by depth.
                let d: CGFloat = 6
                let r = CGRect(
                    x: point.x + textIndent - 14 - d / 2,
                    y: point.y + markerCenterY - d / 2,
                    width: d, height: d)
                UIColor.secondaryLabel.setFill()
                UIColor.secondaryLabel.setStroke()
                switch list.depth % 3 {
                case 0: context.fillEllipse(in: r)
                case 1:
                    context.setLineWidth(1.2)
                    context.strokeEllipse(in: r.insetBy(dx: 0.6, dy: 0.6))
                default: context.fill(r)
                }
            }
        }
    }

    /// Hands TextKit a `TextFirstLayoutFragment` for every paragraph that draws something.
    final class TextFirstLayoutDelegate: NSObject, NSTextLayoutManagerDelegate {
        weak var host: TextFirstEditorController?

        func textLayoutManager(
            _ textLayoutManager: NSTextLayoutManager,
            textLayoutFragmentFor location: NSTextLocation,
            in textElement: NSTextElement
        ) -> NSTextLayoutFragment {
            if let paragraph = textElement as? NSTextParagraph,
                paragraph.attributedString.length > 0
            {
                let text = paragraph.attributedString
                let block =
                    text.attribute(.tfBlock, at: 0, effectiveRange: nil) as? TextFirstBlockAttribute
                // Every paragraph: a find mark can land on any of them, and a fragment already laid
                // out is not rebuilt when the first mark arrives.
                return TextFirstLayoutFragment(
                    block: block ?? TextFirstBlockAttribute(), element: textElement,
                    range: textElement.elementRange, host: host)
            }
            return NSTextLayoutFragment(textElement: textElement, range: textElement.elementRange)
        }
    }
#endif
