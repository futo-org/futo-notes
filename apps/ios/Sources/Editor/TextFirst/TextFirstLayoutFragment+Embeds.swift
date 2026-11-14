import UIKit

// The embedded content a layout fragment draws over its text: image bitmaps and table grids.

extension TextFirstLayoutFragment {
    /// The baseline of the line holding the fragment-local vertical position `y`, when that
    /// line has an image on it: the text on the line sits on it, and so does every image.
    func imageLineBaseline(atY y: CGFloat) -> CGFloat? {
        guard
            let line = textLineFragments.first(where: {
                $0.typographicBounds.minY <= y && y < $0.typographicBounds.maxY
            }) ?? textLineFragments.last,
            imageRuns.contains(where: {
                NSLocationInRange($0.range.location, line.characterRange)
            })
        else { return nil }
        return line.typographicBounds.minY + line.glyphOrigin.y
    }

    /// An image's rect in this fragment's coordinates (x in container coordinates). It stands
    /// on its line's baseline, with the text; the tallest image's top is the line's top.
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
        let baseline = line.typographicBounds.minY + line.glyphOrigin.y
        return CGRect(
            x: x, y: baseline - size.height, width: size.width, height: size.height)
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

    func drawTables(at point: CGPoint, in context: CGContext) {
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

    /// The selection's colour over an image the selection covers whole: the system's own
    /// highlight is drawn under the bitmap, where it cannot be seen.
    private func tintIfSelected(
        _ run: (range: NSRange, span: TextFirstImageSpan), rect: CGRect, in context: CGContext
    ) {
        guard let host, let manager = textLayoutManager,
            MainActor.assumeIsolated({ host.selectionCovers(run.range, in: self, manager) })
        else { return }
        (MainActor.assumeIsolated { host.textView.tintColor } ?? accent)
            .withAlphaComponent(0.35).setFill()
        context.fill(rect)
    }

    func drawImages(at point: CGPoint, in context: CGContext) {
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        for run in imageRuns {
            guard let rect = imageRect(run)?.offsetBy(dx: point.x, dy: point.y) else {
                continue
            }
            let atom = run.span.atom
            defer { tintIfSelected(run, rect: rect, in: context) }
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
}
