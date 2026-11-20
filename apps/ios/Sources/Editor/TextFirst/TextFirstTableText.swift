import UIKit

// A table cell's inline styling. The engine reports
// bold, italic, strikethrough, code, link and wikilink spans over a cell's text exactly as over a
// paragraph; they are kept per cell as runs, and the closed grid, the row height, the find
// marks, the link hit test and the open field all build their text from the same runs.

enum TextFirstCellLink: Equatable {
    case url(String)
    /// A wikilink: the note id it resolves to, nil when it does not resolve.
    case wiki(String?)
}

struct TextFirstCellRun {
    var range: NSRange
    var bold = false, italic = false, strike = false, code = false
    var link: TextFirstCellLink?
}

extension TextFirstTableMetrics {
    /// The styled spans of the window being styled (`TextFirstStyler.apply`), for the cells of
    /// the table rows it meets.
    nonisolated(unsafe) static var windowSpecs: [EditorStyleSpan] = []

    /// The runs of `specs` that fall in `[origin, origin + length)`, relative to `origin`.
    static func runs(from specs: [EditorStyleSpan], origin: Int, length: Int) -> [TextFirstCellRun]
    {
        func clip(_ s: UInt64, _ e: UInt64) -> NSRange? {
            let from = max(Int(s), origin) - origin
            let to = min(Int(e), origin + length) - origin
            return from < to ? NSRange(location: from, length: to - from) : nil
        }
        var out: [TextFirstCellRun] = []
        for spec in specs {
            switch spec {
            case .inline(let s, let e, let bold, let italic, let strike, let code):
                if let r = clip(s, e) {
                    out.append(
                        TextFirstCellRun(
                            range: r, bold: bold, italic: italic, strike: strike, code: code))
                }
            case .link(let s, let e, let destination):
                if let r = clip(s, e) { out.append(TextFirstCellRun(range: r, link: .url(destination))) }
            case .wikilink(let s, let e, _, let noteId):
                if let r = clip(s, e) { out.append(TextFirstCellRun(range: r, link: .wiki(noteId))) }
            default: break
            }
        }
        return out
    }

    /// Reset `text` to the base look of a cell and apply `runs` (used for the grid and the field).
    static func style(_ text: NSMutableAttributedString, runs: [TextFirstCellRun], header: Bool) {
        let base = font(header: header)
        let all = NSRange(location: 0, length: text.length)
        text.addAttributes([.font: base, .foregroundColor: UIColor.label], range: all)
        text.removeAttribute(.strikethroughStyle, range: all)
        text.removeAttribute(.underlineStyle, range: all)
        text.removeAttribute(.backgroundColor, range: all)
        for run in runs {
            let r = NSIntersectionRange(run.range, all)
            guard r.length > 0 else { continue }
            if run.bold || run.italic || run.code {
                var traits = base.fontDescriptor.symbolicTraits
                if run.bold { traits.insert(.traitBold) }
                if run.italic { traits.insert(.traitItalic) }
                var face = base
                if run.code { face = .monospacedSystemFont(ofSize: base.pointSize - 2, weight: .regular) }
                let descriptor = face.fontDescriptor.withSymbolicTraits(traits) ?? face.fontDescriptor
                text.addAttribute(
                    .font, value: UIFont(descriptor: descriptor, size: face.pointSize), range: r)
            }
            if run.strike {
                text.addAttribute(
                    .strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: r)
            }
            if run.code {
                text.addAttribute(.backgroundColor, value: UIColor.tertiarySystemFill, range: r)
            }
            switch run.link {
            case .url:
                text.addAttributes(
                    [
                        .foregroundColor: UIColor(Theme.primary),
                        .underlineStyle: NSUnderlineStyle.single.rawValue,
                    ], range: r)
            case .wiki(let id):
                text.addAttribute(
                    .foregroundColor, value: id == nil ? UIColor.secondaryLabel : UIColor(Theme.primary),
                    range: r)
            case nil: break
            }
        }
    }

    /// The cell's text as the grid draws and measures it.
    static func styled(_ cell: TextFirstTableRowSpan.Cell, header: Bool) -> NSAttributedString {
        let text = NSMutableAttributedString(string: cell.text)
        style(text, runs: cell.runs, header: header)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment =
            cell.alignment == .right ? .right : cell.alignment == .center ? .center : .natural
        text.addAttribute(
            .paragraphStyle, value: paragraph, range: NSRange(location: 0, length: text.length))
        return text
    }

    /// The cell's text laid out in its padded text box.
    static func layout(
        _ cell: TextFirstTableRowSpan.Cell, header: Bool, columns: Int
    ) -> (NSTextStorage, NSLayoutManager, NSTextContainer) {
        let storage = NSTextStorage(attributedString: styled(cell, header: header))
        let manager = NSLayoutManager()
        let container = NSTextContainer(
            size: CGSize(
                width: cellWidth(columns: columns) - padding * 2,
                height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        return (storage, manager, container)
    }
}

extension TextFirstEditorController {
    /// The link a point `p` (text view coordinates) is on inside a table cell, with the cell.
    func tableLinkHit(at p: CGPoint) -> (hit: TableCellHit, target: TextFirstLinkTarget)? {
        guard let hit = tableCellHit(at: p), hit.cell.runs.contains(where: { $0.link != nil }),
            let manager = textView.textLayoutManager,
            let f = manager.textLayoutFragment(
                for: CGPoint(x: p.x - inset.left, y: p.y - inset.top)) as? TextFirstLayoutFragment,
            let run = f.tableRuns.first(where: { $0.span === hit.span }),
            let rect = f.tableRect(run)
        else { return nil }
        let scroll = tableScroll[hit.span.tableID] ?? 0
        let width = TextFirstTableMetrics.cellWidth(columns: hit.span.columns)
        let pad = TextFirstTableMetrics.padding
        let local = CGPoint(
            x: p.x - inset.left - (CGFloat(hit.cell.column) * width - scroll) - pad,
            y: p.y - inset.top - f.layoutFragmentFrame.minY - rect.minY - pad)
        guard
            let target = linkTarget(
                inCell: hit.cell, header: hit.span.header, columns: hit.span.columns, local: local)
        else { return nil }
        return (hit, target)
    }

    /// The link under `local` (relative to the cell's padded text box) when the cell's text is
    /// laid out as the grid draws it.
    func linkTarget(
        inCell cell: TextFirstTableRowSpan.Cell, header: Bool, columns: Int, local: CGPoint
    ) -> TextFirstLinkTarget? {
        let (storage, layout, container) = TextFirstTableMetrics.layout(
            cell, header: header, columns: columns)
        defer { withExtendedLifetime(storage) {} }
        for run in cell.runs {
            guard let link = run.link else { continue }
            let glyphs = layout.glyphRange(forCharacterRange: run.range, actualCharacterRange: nil)
            var on = false
            layout.enumerateEnclosingRects(
                forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                in: container
            ) { r, _ in if r.contains(local) { on = true } }
            guard on else { continue }
            switch link {
            case .url(let raw):
                if let target = linkTarget(forDestination: raw) { return target }
            case .wiki(let id):
                if let id { return .note(id) }
            }
        }
        return nil
    }
}
