import UIKit

// Table grips: while a
// cell is open, a row grip at its row's left edge and a column grip on the table's top edge
// above its column. Each is a button whose tap opens a short native menu anchored to it, built
// when it opens from the engine's `inspect_table` controls; the keyboard and the cell stay up.
// The six row/column items are the engine's `table_command`s (shown disabled where it forbids
// them); Delete table is done at the host. Strings are hard-coded English.
//
// Launch with `-FUTOProtoShowGripHitAreas YES` to tint each grip's hit area.

/// One grip: a hit area with a smaller six-dot pill drawn at `pillCenter` (the hit area
/// reaches outward from the cell, the pill stays on the table's edge).
final class TextFirstTableGripControl: UIButton {
    let pill = UIView()
    var drawn = CGSize(width: 16, height: 28)
    /// Where the pill's centre sits, in the control's own coordinates.
    var pillCenter: CGPoint?
    /// Six dots, `across` columns of them (2 for the row grip, 3 for the column grip).
    var across = 2
    private let dotLayer = CAShapeLayer()
    /// Told when this grip's menu opens (true) and closes (false).
    var onMenuShowing: ((Bool) -> Void)?

    init(id: String) {
        super.init(frame: .zero)
        accessibilityIdentifier = id
        pill.isUserInteractionEnabled = false
        pill.layer.cornerRadius = 6
        pill.backgroundColor = UIColor(Theme.primary)
        addSubview(pill)
        dotLayer.fillColor = UIColor.white.cgColor
        pill.layer.addSublayer(dotLayer)
        showsMenuAsPrimaryAction = true
        // The menu opens upward or downward as space allows: keep the items in written order.
        preferredMenuElementOrder = .fixed
        if UserDefaults.standard.bool(forKey: "FUTOProtoShowGripHitAreas") {
            backgroundColor = UIColor.systemPink.withAlphaComponent(0.22)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let c = pillCenter ?? CGPoint(x: bounds.midX, y: bounds.midY)
        pill.frame = CGRect(
            x: c.x - drawn.width / 2, y: c.y - drawn.height / 2,
            width: drawn.width, height: drawn.height)
        let down = 6 / across
        let r: CGFloat = 1.6
        let gap: CGFloat = 5
        let path = UIBezierPath()
        let w = CGFloat(across - 1) * gap
        let h = CGFloat(down - 1) * gap
        for i in 0..<across {
            for j in 0..<down {
                let p = CGPoint(
                    x: pill.bounds.midX - w / 2 + CGFloat(i) * gap,
                    y: pill.bounds.midY - h / 2 + CGFloat(j) * gap)
                path.append(
                    UIBezierPath(
                        arcCenter: p, radius: r, startAngle: 0, endAngle: .pi * 2,
                        clockwise: true))
            }
        }
        dotLayer.frame = pill.bounds
        dotLayer.path = path.cgPath
    }

    override var isHighlighted: Bool {
        didSet { pill.alpha = isHighlighted ? 0.5 : 1 }
    }

    /// The menu is anchored at the drawn pill, not the middle of the larger hit area.
    override func menuAttachmentPoint(for configuration: UIContextMenuConfiguration) -> CGPoint {
        pill.center
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willDisplayMenuFor configuration: UIContextMenuConfiguration,
        animator: UIContextMenuInteractionAnimating?
    ) {
        super.contextMenuInteraction(
            interaction, willDisplayMenuFor: configuration, animator: animator)
        onMenuShowing?(true)
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willEndFor configuration: UIContextMenuConfiguration,
        animator: UIContextMenuInteractionAnimating?
    ) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        onMenuShowing?(false)
    }

    // No targeted preview: with one, UIKit hides the grip while the menu morphs out of it and
    // shows it again only when the dismiss animation's spring settles, 1.5 s or more later.
    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
    ) -> UITargetedPreview? { nil }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration
    ) -> UITargetedPreview? { nil }
}

@MainActor
final class TextFirstTableGrips: NSObject {
    weak var editor: TextFirstCellEditor?
    private var installed = false
    private var cached: (rev: UInt64, selection: NSRange, table: EditorTableDescription)?

    /// A grip's smallest hit height (the row grip is as tall as its row).
    static let hit: CGFloat = 44
    /// How far a hit area reaches past its drawn pill or the table's edge.
    static let reach: CGFloat = 4
    /// The row grip's reach into the first column (the pill's right edge is 7 in).
    static let rowReach: CGFloat = 8
    static let columnHitWidth: CGFloat = 80

    let rowGrip = TextFirstTableGripControl(id: "table-grip-row")
    let columnGrip = TextFirstTableGripControl(id: "table-grip-column")
    private var all: [TextFirstTableGripControl] { [rowGrip, columnGrip] }
    /// A grip's menu is showing: the keyboard toolbar behind it is inert.
    private(set) var menuShowing = false

    init(editor: TextFirstCellEditor) {
        self.editor = editor
        super.init()
        rowGrip.drawn = CGSize(width: 14, height: 26)
        rowGrip.across = 2
        // Three-by-two dots, lying down: the column grip is the row grip turned.
        columnGrip.drawn = CGSize(width: 26, height: 14)
        columnGrip.across = 3
        for grip in [rowGrip, columnGrip] {
            grip.onMenuShowing = { [weak self] showing in self?.menuShowing = showing }
        }
        rowGrip.accessibilityLabel = "Row actions"
        columnGrip.accessibilityLabel = "Column actions"
        rowGrip.menu = UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] done in done(self?.menu(row: true) ?? []) }
        ])
        columnGrip.menu = UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] done in
                done(self?.menu(row: false) ?? [])
            }
        ])
    }

    private var controller: TextFirstEditorController? { editor?.controller }

    func remove() {
        all.forEach { $0.removeFromSuperview() }
        installed = false
    }

    /// The engine's view of the open cell's table (focus, controls, rows), cached per revision
    /// and selection: layout runs on every sideways scroll step.
    private func describe() -> EditorTableDescription? {
        guard let c = controller, !c.isClosed, !c.engineBusy else { return nil }
        let selection = c.engineSelection
        if let cached, cached.rev == c.rev, cached.selection == selection { return cached.table }
        do {
            let start = try c.mirror.utf16ToByte(unit: UInt64(selection.location))
            let end = try c.mirror.utf16ToByte(unit: UInt64(NSMaxRange(selection)))
            guard
                let table = try c.session.inspectTable(
                    expected: c.rev, range: EditorByteRange(start: start, end: end))
            else { return nil }
            cached = (c.rev, selection, table)
            return table
        } catch {
            return nil
        }
    }

    private func utf16(_ byte: UInt64) -> Int? {
        guard let c = controller, let unit = try? c.mirror.byteToUtf16(byte: byte) else {
            return nil
        }
        return Int(unit)
    }

    /// Place both grips from the same geometry the cell field uses (hit areas: see `layout`).
    func layout() {
        guard let editor, let c = controller, let table = describe(), table.focus != nil,
            let field = c.cellFrame(start: editor.cellStart),
            let (span, _) = c.tableCell(at: editor.cellStart),
            let firstCell = table.rows.first?.first,
            let firstStart = utf16(firstCell.content.start),
            let top = c.cellFrame(start: firstStart)?.minY
        else {
            all.forEach { $0.isHidden = true }
            return
        }
        if !installed {
            all.forEach { c.textView.addSubview($0) }
            installed = true
        }
        let left = c.inset.left
        let width = c.images.containerWidth
        let scroll = c.tableScroll[span.tableStart] ?? 0
        let tableRight = left - scroll + CGFloat(table.columns)
            * TextFirstTableMetrics.cellWidth(columns: Int(table.columns))
        let visibleRight = min(tableRight, left + width)

        // Row grip: the whole margin from the screen's edge to the table's edge, and only
        // `Self.rowReach` into the cell (its text starts 10 pt in), as tall as the open row.
        let rowH = max(Self.hit, field.height)
        rowGrip.frame = CGRect(
            x: 0, y: field.midY - rowH / 2, width: left + Self.rowReach, height: rowH)
        rowGrip.pillCenter = CGPoint(x: left, y: rowH / 2)

        let colMin = max(field.minX, left)
        let colMax = min(field.maxX, visibleRight)
        // The pair belongs to the open cell: both go while less than 20 pt of it is in view
        // (scrolled sideways past either edge of the table), so neither sits by nothing.
        all.forEach { $0.isHidden = colMax - colMin < 20 }
        // Column grip: wide, but only `Self.reach` taller than its pill, so it leaves the line
        // above the table and the header's text to the caret. It sits on the table's top edge;
        // the text view clips anything above the top of what shows, so the pill is pushed down
        // until it fits whole: at the content's top for a table that starts the note, and,
        // once the header has scrolled up past the top of the view, sticking to the top of
        // the visible part of the table over the open cell's column. A stuck grip must not
        // cover the open cell's own text (its text starts `padding` into the cell), so it
        // goes while the open cell is that close to the top, or out of view.
        let contentTop = -c.textView.adjustedContentInset.top
        let visibleTop = max(contentTop, c.textView.bounds.minY)
        let pillHalf = columnGrip.drawn.height / 2
        let pillY = max(top, visibleTop + pillHalf + 1)
        let colY = max(visibleTop, pillY - pillHalf - Self.reach)
        let colH = pillY + pillHalf + Self.reach - colY
        if visibleTop > contentTop + 0.5, pillY > top,
            field.minY + TextFirstTableMetrics.padding < colY + colH
                || field.maxY < visibleTop || field.minY > c.textView.bounds.maxY
        {
            columnGrip.isHidden = true
        }
        columnGrip.frame = CGRect(
            x: (colMin + colMax) / 2 - Self.columnHitWidth / 2, y: colY,
            width: Self.columnHitWidth, height: colH)
        columnGrip.pillCenter = CGPoint(x: Self.columnHitWidth / 2, y: pillY - colY)
        all.forEach { $0.setNeedsLayout() }
        // Above the field (never move the field itself: it is the first responder).
        all.forEach { c.textView.bringSubviewToFront($0) }
    }

    // MARK: menus

    /// The grip's menu, built as it opens: three engine commands, then Delete table.
    private func menu(row: Bool) -> [UIMenuElement] {
        let can = describe()?.controls
        func item(
            _ title: String, _ symbol: String, _ command: EditorTableCommand, _ enabled: Bool?,
            destructive: Bool = false
        ) -> UIAction {
            let action = UIAction(title: title, image: UIImage(systemName: symbol)) {
                [weak self] _ in self?.run(command)
            }
            action.accessibilityIdentifier = "table-menu-\(title)"
            if enabled != true { action.attributes.insert(.disabled) }
            if destructive { action.attributes.insert(.destructive) }
            return action
        }
        let commands =
            row
            ? [
                item("Add above", "arrow.up.to.line", .insertRowAbove, can?.insertRowAbove),
                item("Add below", "arrow.down.to.line", .insertRowBelow, can?.insertRowBelow),
                item("Delete row", "trash", .deleteRow, can?.deleteRow, destructive: true),
            ]
            : [
                item(
                    "Add to left", "arrow.left.to.line", .insertColumnLeft, can?.insertColumnLeft
                ),
                item(
                    "Add to right", "arrow.right.to.line", .insertColumnRight,
                    can?.insertColumnRight),
                item(
                    "Delete column", "trash", .deleteColumn, can?.deleteColumn,
                    destructive: true),
            ]
        let delete = UIAction(
            title: "Delete table", image: UIImage(systemName: "trash"),
            attributes: can == nil ? [.destructive, .disabled] : [.destructive]
        ) { [weak self] _ in self?.deleteTable() }
        delete.accessibilityIdentifier = "table-menu-Delete table"
        return [
            UIMenu(options: .displayInline, children: commands),
            UIMenu(options: .displayInline, children: [delete]),
        ]
    }

    /// One engine table command at the engine's selection; the field follows the engine onto
    /// the cell it leaves selected, scrolled into view.
    private func run(_ command: EditorTableCommand) {
        guard let editor, let c = controller, !c.isClosed, !c.engineBusy, !c.engineComposing
        else { return }
        do {
            let start = try c.mirror.utf16ToByte(unit: UInt64(c.engineSelection.location))
            let end = try c.mirror.utf16ToByte(unit: UInt64(NSMaxRange(c.engineSelection)))
            if let change = try c.session.tableCommand(
                expected: c.rev, range: EditorByteRange(start: start, end: end), command: command)
            {
                try c.accept(change)
            }
        } catch {
            c.recover(error, context: "table command")
        }
        editor.refresh()
        if let (span, content) = c.tableCell(at: editor.cellStart) {
            let line = (c.storage.string as NSString).paragraphRange(
                for: NSRange(location: editor.cellStart, length: 0))
            c.revealCell(content, in: span, row: line)
        }
        if let frame = c.cellFrame(start: editor.cellStart) {
            c.textView.scrollRectToVisible(frame.insetBy(dx: 0, dy: -60), animated: true)
        }
        if !editor.isFinished, !editor.field.isFirstResponder {
            editor.field.becomeFirstResponder()
        }
    }

    /// No engine command: delete the table's lines and their line break, plus one adjoining blank
    /// separator line where that is safe, as ONE edit through the ordinary replace path, then
    /// return to the note with the caret where the table was.
    ///
    /// The replace works in display coordinates, where a block marker (`# `, `- `, a fence line)
    /// is hidden: a range ENDING at the start of the next line also swallows that line's hidden
    /// marker. So the range never ends at the start of a line that is not blank in the SOURCE
    /// (`sourceText`, where the marker is visible); to remove a blank line it reaches back over
    /// the blank line before the table instead.
    private func deleteTable() {
        guard let editor, let c = controller, let table = describe(),
            let table0 = try? c.mirror.byteToUtf16(byte: table.display.start),
            let to = try? c.mirror.byteToUtf16(byte: table.display.end)
        else { return }
        var start = Int(table0)
        var end = Int(to)
        let text = c.storage.string as NSString
        func newline(_ at: Int) -> Bool { at >= 0 && at < text.length && text.character(at: at) == 0x0A }
        if let source = try? c.session.sourceText() {
            let src = Array(source.utf8)
            let s0 = Int(table.source.start), s1 = Int(table.source.end)
            func isNewline(_ at: Int) -> Bool { at >= 0 && at < src.count && src[at] == 0x0A }
            // The line after the table's line break is empty or blank in the source (or there is none).
            func blankFrom(_ at: Int) -> Bool {
                var i = at
                while i < src.count, src[i] == 0x20 || src[i] == 0x09 { i += 1 }
                return i >= src.count || src[i] == 0x0A
            }
            let hasBreak = isNewline(s1) && newline(end)
            let breakIsSafe = hasBreak && (s1 + 1 >= src.count || blankFrom(s1 + 1))
            // The line before the table is empty: its line break sits right before the table's.
            let blankBefore =
                s0 >= 1 && isNewline(s0 - 1) && newline(start - 1) && (s0 == 1 || isNewline(s0 - 2))
            if breakIsSafe {
                end += 1  // lands on a blank line (or the end), never on a marker
                if blankBefore { start -= 1 }
            } else if blankBefore, s0 >= 2, newline(start - 2) {
                start -= 2  // the table's own break stays: it ends the previous line
            } else if !blankBefore, s0 >= 1, isNewline(s0 - 1), newline(start - 1) {
                start -= 1
            }
        }
        editor.finish()
        c.replaceInCell(range: NSRange(location: start, length: end - start), text: "")
        c.textView.becomeFirstResponder()
    }
}
