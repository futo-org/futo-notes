#if FUTO_DEBUG_BUILD
    import UIKit

    // MARK: drawing

    extension TextFirstLayoutFragment {
        /// This fragment's first UTF-16 offset in the note, and its length.
        var absoluteRange: NSRange? {
            guard let manager = textLayoutManager else { return nil }
            let start = manager.offset(
                from: manager.documentRange.location, to: rangeInElement.location)
            let length = manager.offset(
                from: rangeInElement.location, to: rangeInElement.endLocation)
            return NSRange(location: start, length: length)
        }

        /// The marks overlapping this fragment's text.
        func findMarks() -> (base: Int, marks: [(range: NSRange, current: Bool)]) {
            guard let own = absoluteRange, let host else { return (0, []) }
            let marks = MainActor.assumeIsolated {
                host.find.marks(from: own.location, to: NSMaxRange(own))
            }
            return (own.location, marks)
        }

        /// Paint the text marks (and the image marks) behind this paragraph's glyphs.
        func drawFindMarks(at point: CGPoint, in context: CGContext) {
            let (base, marks) = findMarks()
            // A grid draws its own marks inside its cells.
            guard !marks.isEmpty, tableRuns.isEmpty else { return }
            for (range, current) in marks {
                context.setFillColor(TextFirstFindColors.fill(current: current).cgColor)
                if let image = imageRuns.first(where: {
                    NSIntersectionRange(
                        NSRange(location: base + $0.range.location, length: $0.range.length), range
                    ).length > 0
                }) {
                    // The image's spelling is hidden: mark the picture.
                    if let rect = imageRect(image)?.offsetBy(dx: point.x, dy: point.y) {
                        context.addPath(UIBezierPath(roundedRect: rect, cornerRadius: 6).cgPath)
                        context.fillPath()
                    }
                    continue
                }
                for line in textLineFragments {
                    let local = NSRange(location: range.location - base, length: range.length)
                    let shared = NSIntersectionRange(local, line.characterRange)
                    guard shared.length > 0 else { continue }
                    let origin = lineOrigin(line)
                    let x1 = origin + line.locationForCharacter(at: shared.location).x
                    let x2 =
                        NSMaxRange(shared) >= NSMaxRange(line.characterRange)
                        ? origin + line.typographicBounds.width
                        : origin + line.locationForCharacter(at: NSMaxRange(shared)).x
                    context.fill(
                        CGRect(
                            x: point.x + x1, y: point.y + line.typographicBounds.minY,
                            width: max(1, x2 - x1), height: line.typographicBounds.height))
                }
            }
        }

        /// The marks inside one table row's cells: a cell is a grid slot, so each mark is placed by
        /// laying the cell's text out the way it is drawn.
        func tableMarks(for run: (range: NSRange, span: TextFirstTableRowSpan)) -> [(
            column: Int, rects: [CGRect], current: Bool
        )] {
            let (base, marks) = findMarks()
            guard !marks.isEmpty else { return [] }
            var out: [(Int, [CGRect], Bool)] = []
            for cell in run.span.cells {
                let start = base + run.range.location + cell.rowOffset
                let content = NSRange(location: start, length: cell.range.length)
                for (range, current) in marks {
                    let shared = NSIntersectionRange(content, range)
                    guard shared.length > 0 || (range.length == 0 && range.location == start)
                    else { continue }
                    let local = NSRange(location: shared.location - start, length: shared.length)
                    out.append(
                        (
                            cell.column,
                            TextFirstTableMetrics.markRects(
                                in: cell, range: local, header: run.span.header), current
                        ))
                }
            }
            return out
        }

        /// The x a line's text starts at (its own origin plus the paragraph's head indent).
        func lineOrigin(_ line: NSTextLineFragment) -> CGFloat {
            let style =
                line.attributedString.attribute(.paragraphStyle, at: 0, effectiveRange: nil)
                as? NSParagraphStyle
            let indent =
                (line.characterRange.location == 0 ? style?.firstLineHeadIndent : style?.headIndent)
                ?? 0
            return line.typographicBounds.minX + indent
        }
    }

    extension TextFirstTableMetrics {
        /// Where `range` of a cell's text lands inside the cell's padded text box, laid out as the
        /// grid draws it (width, font, alignment); rects are relative to that box's origin.
        static func markRects(
            in cell: TextFirstTableRowSpan.Cell, range: NSRange, header: Bool
        ) -> [CGRect] {
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment =
                cell.alignment == .right ? .right : cell.alignment == .center ? .center : .natural
            let storage = NSTextStorage(
                string: cell.text,
                attributes: [.font: font(header: header), .paragraphStyle: paragraph])
            let manager = NSLayoutManager()
            let container = NSTextContainer(
                size: CGSize(width: cellWidth - padding * 2, height: .greatestFiniteMagnitude))
            container.lineFragmentPadding = 0
            manager.addTextContainer(container)
            storage.addLayoutManager(manager)
            let glyphs = manager.glyphRange(
                forCharacterRange: NSIntersectionRange(
                    range, NSRange(location: 0, length: storage.length)),
                actualCharacterRange: nil)
            var rects: [CGRect] = []
            manager.enumerateEnclosingRects(
                forGlyphRange: glyphs,
                withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                in: container
            ) { rect, _ in rects.append(rect) }
            return rects
        }
    }
#endif
