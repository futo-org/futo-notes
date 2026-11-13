#if FUTO_DEBUG_BUILD
    import UIKit

    // Bullets, numbers, checkboxes, quote bars, code backgrounds and dividers, drawn by
    // NSTextLayoutFragment subclasses from the block facts the engine sent. None of these are
    // characters in the text: the display holds only the words.

    extension NSAttributedString.Key {
        /// `TextFirstBlockAttribute` on every character of a drawn line (including its newline).
        static let tfBlock = NSAttributedString.Key("futo.tf.block")
        /// A heading's level (Int) on its drawn characters, so whether the caret's line is a heading
        /// does not depend on which toolbar highlight is lit (the toolbar lights only H1 to H3).
        static let tfHeading = NSAttributedString.Key("futo.tf.heading")
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
        /// The heading level of an empty last line (0 elsewhere: a heading's own characters carry
        /// its font), so the line starts as the heading it is.
        var heading = 0
        /// A list line, or an indented plain line (`.plain`): the line's own indent in columns
        /// and its marker as typed, as the engine reports them.
        var list: TextFirstListRow?
        /// False on a row's later lines (a loose list's blank line): they indent but draw no marker.
        var showsMarker = true

        /// Where the line's text starts after its indent and marker gutter.
        var listIndent: CGFloat { list.map(TextFirstMetrics.listIndent) ?? 0 }
        /// A list item, which draws a marker (an indented plain line draws only its indent).
        var isItem: Bool { list.map { $0.marker != .plain } ?? false }
    }

    typealias TextFirstListRow = (
        indent: Int, marker: EditorListMarker, text: String, checked: Bool
    )

    enum TextFirstMetrics {
        /// One column of a line's own leading whitespace (space 1, tab 4).
        static let column: CGFloat = 12
        /// The text's leading edge: the indent's columns, then a marker's gutter. Nothing here
        /// works out nesting: uneven indents draw unevenly.
        static func listIndent(_ row: TextFirstListRow) -> CGFloat {
            (row.marker == .plain ? 0 : 30) + CGFloat(row.indent) * column
        }
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

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override var renderingSurfaceBounds: CGRect {
            // Gutter art lives left of the text and code backgrounds span the full width. The
            // empty last line's art may run a line's spacing past the frame TextKit measured.
            let spill: CGFloat =
                MainActor.assumeIsolated { host?.trailingBlock } == nil ? 0 : 8
            return super.renderingSurfaceBounds.union(
                CGRect(
                    x: -layoutFragmentFrame.minX - 24, y: 0,
                    width: max(containerWidth, layoutFragmentFrame.width) + 60,
                    height: layoutFragmentFrame.height + spill))
        }

        var containerWidth: CGFloat {
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

        /// A line the block art is drawn against, in the fragment's coordinates: the vertical
        /// extent the art fills, the baseline a marker hangs from, and the font its capitals come
        /// from.
        private struct Row {
            let top: CGFloat
            let height: CGFloat
            let baseline: CGFloat
            let font: UIFont
        }

        /// The paragraph's own block, over its first line and the whole fragment except the
        /// note's empty last line, which TextKit lays out at the end of the last paragraph's
        /// fragment: that line is not this paragraph's (its block, if any, is `trailingBlock`).
        private var ownRow: Row {
            let font =
                textLineFragments.first.flatMap { line in
                    line.attributedString.length > 0
                        ? line.attributedString.attribute(.font, at: 0, effectiveRange: nil)
                            as? UIFont
                        : nil
                } ?? MainActor.assumeIsolated { TextFirstEditorController.bodyFont }
            var height = layoutFragmentFrame.height
            if textLineFragments.count > 1, let last = textLineFragments.last,
                last.characterRange.length == 0
            {
                height = last.typographicBounds.minY
            }
            return Row(top: 0, height: height, baseline: firstBaseline, font: font)
        }

        /// The empty last line of the note: TextKit lays it out as a zero-length line fragment at
        /// the end of the last paragraph (or as the only one of an empty note), with no text
        /// element of its own. It takes the typing attributes' height and indent.
        private func trailingRow(of trailing: TextFirstBlockAttribute) -> Row? {
            guard let line = textLineFragments.last, line.characterRange.length == 0 else {
                return nil
            }
            let bounds = line.typographicBounds
            let font = MainActor.assumeIsolated {
                trailing.code ? TextFirstStyler.mono : TextFirstEditorController.bodyFont
            }
            // Typed below another paragraph, a line of a block that is not a list carries the
            // paragraph's line spacing above its text (a list's minimum line height already
            // includes it), and its block art fills it. The first line of a note has none.
            let spacing =
                !trailing.isItem && textLineFragments.count > 1
                ? MainActor.assumeIsolated {
                    (TextFirstEditorController.baseAttributes[.paragraphStyle]
                        as? NSParagraphStyle)?.lineSpacing ?? 0
                } : 0
            return Row(
                top: bounds.minY, height: bounds.height + spacing,
                baseline: bounds.minY + line.glyphOrigin.y, font: font)
        }

        /// Where a bullet or box is centered: the middle of the row's capital letters.
        private func markerCenterY(_ row: Row) -> CGFloat { row.baseline - row.font.capHeight / 2 }

        /// Adjacent fragments share pixel edges, so the block reads as one surface even at
        /// fractional text baselines. An opaque fill avoids darker overlapping edges.
        private func decorationRect(at point: CGPoint, row: Row, x: CGFloat, width: CGFloat)
            -> CGRect
        {
            let scale =
                MainActor.assumeIsolated { host?.textView.traitCollection.displayScale } ?? 2
            let top = ((point.y + row.top) * scale).rounded(.down) / scale
            let bottom = ((point.y + row.top + row.height) * scale).rounded(.up) / scale
            return CGRect(x: x, y: top, width: width, height: bottom - top)
        }

        /// The leading edge of the list text, in container coordinates.
        private func textIndent(of block: TextFirstBlockAttribute) -> CGFloat {
            guard block.list != nil else { return 0 }
            return TextFirstMetrics.quoteIndent(depth: block.quoteDepth) + block.listIndent
        }

        private func checkboxRect(of block: TextFirstBlockAttribute, row: Row) -> CGRect? {
            guard let list = block.list, block.showsMarker, list.marker == .task else { return nil }
            let side = TextFirstMetrics.checkboxSide
            return CGRect(
                x: textIndent(of: block) - side - 8, y: markerCenterY(row) - side / 2, width: side,
                height: side)
        }

        /// The checkbox's rect: x in container coordinates, y relative to the fragment.
        var checkboxRect: CGRect? { checkboxRect(of: block, row: ownRow) }

        /// The marker's gutter, in the fragment's coordinates, when the selection covers the whole
        /// row (so the highlight reaches the rendered bullet, number or box); nil for a caret or a
        /// partial selection.
        var highlightedMarkerRect: CGRect? {
            guard block.isItem, block.showsMarker, let host, let manager = textLayoutManager,
                MainActor.assumeIsolated({ host.selectionRange(for: self, in: manager) }) != nil
            else { return nil }
            let line = firstLine
            return CGRect(
                x: textIndent(of: block) - 26, y: line.minY, width: 26, height: line.height)
        }

        override func draw(at pointIn: CGPoint, in context: CGContext) {
            let point = CGPoint(x: pointIn.x - layoutFragmentFrame.minX, y: pointIn.y)
            drawBlockArt(block, row: ownRow, at: point, in: context)
            if let marker = highlightedMarkerRect {
                (MainActor.assumeIsolated { host?.textView.tintColor } ?? accent)
                    .withAlphaComponent(0.2).setFill()
                context.fill(marker.offsetBy(dx: point.x, dy: point.y))
            }
            // The empty last line's own block, which no paragraph carries.
            if let trailing = MainActor.assumeIsolated({ host?.trailingBlock }),
                let row = trailingRow(of: trailing)
            {
                drawBlockArt(trailing, row: row, at: point, in: context)
            }
            drawFindMarks(at: point, in: context)
            super.draw(at: pointIn, in: context)
            drawImages(at: point, in: context)
            drawTables(at: point, in: context)
        }

        /// A block's code background, divider, quote bars and list marker against `row`.
        private func drawBlockArt(
            _ block: TextFirstBlockAttribute, row: Row, at point: CGPoint, in context: CGContext
        ) {
            if block.code {
                UIColor.secondarySystemBackground.setFill()
                context.fill(
                    decorationRect(at: point, row: row, x: point.x - 4, width: containerWidth + 8))
            }
            if block.divider {
                let y = point.y + row.top + row.height / 2
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
                    context.fill(decorationRect(at: point, row: row, x: x, width: 3))
                }
            }
            if let list = block.list, block.isItem, block.showsMarker {
                drawListMarker(list, of: block, row: row, at: point, in: context)
            }
        }

        private func drawListMarker(
            _ list: TextFirstListRow,
            of block: TextFirstBlockAttribute, row: Row, at point: CGPoint, in context: CGContext
        ) {
            switch list.marker {
            case .task:
                guard let box = checkboxRect(of: block, row: row) else { return }
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
                    string: list.text,
                    attributes: [.font: font, .foregroundColor: UIColor.secondaryLabel])
                let size = text.size()
                text.draw(
                    at: CGPoint(
                        x: point.x + textIndent(of: block) - size.width - 6,
                        y: point.y + row.baseline - font.ascender))
            case .bullet:
                let d: CGFloat = 6
                let r = CGRect(
                    x: point.x + textIndent(of: block) - 14 - d / 2,
                    y: point.y + markerCenterY(row) - d / 2,
                    width: d, height: d)
                UIColor.secondaryLabel.setFill()
                context.fillEllipse(in: r)
            case .plain:
                break
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
            // An empty paragraph is the whole of an empty note: its line is the empty last line.
            if let paragraph = textElement as? NSTextParagraph {
                let text = paragraph.attributedString
                let block =
                    text.length > 0
                    ? text.attribute(.tfBlock, at: 0, effectiveRange: nil)
                        as? TextFirstBlockAttribute
                    : nil
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
