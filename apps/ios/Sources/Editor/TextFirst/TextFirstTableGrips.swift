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

    private let localization: Localization

    init(editor: TextFirstCellEditor) {
        self.editor = editor
        localization = editor.controller.linkLocalization ?? Localization.system()
        super.init()
        rowGrip.drawn = CGSize(width: 14, height: 26)
        rowGrip.across = 2
        // Three-by-two dots, lying down: the column grip is the row grip turned.
        columnGrip.drawn = CGSize(width: 26, height: 14)
        columnGrip.across = 3
        for grip in [rowGrip, columnGrip] {
            grip.onMenuShowing = { [weak self] showing in self?.menuShowing = showing }
        }
        rowGrip.accessibilityLabel = localization.localizedText(
            "editor.tableGrips.rowOptionsAccessibilityLabel")
        columnGrip.accessibilityLabel = localization.localizedText(
            "editor.tableGrips.columnOptionsAccessibilityLabel")
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
        for grip in all { grip.removeFromSuperview() }
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
            for grip in all { grip.isHidden = true }
            return
        }
        if !installed {
            for grip in all { c.textView.addSubview(grip) }
            installed = true
        }
        let left = c.inset.left
        let width = c.images.containerWidth
        let scroll = c.tableScroll[span.tableID] ?? 0
        let tableRight =
            left - scroll + CGFloat(table.columns)
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
        for grip in all { grip.isHidden = colMax - colMin < 20 }
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
        // Above the field (never move the field itself: it is the first responder).
        for grip in all {
            grip.setNeedsLayout()
            c.textView.bringSubviewToFront(grip)
        }
    }

    // MARK: menus

    /// The grip's menu, built as it opens: three engine commands, then Delete table.
    private func menu(row: Bool) -> [UIMenuElement] {
        let can = describe()?.controls
        func text(_ key: String) -> String { localization.localizedText("editor.table.\(key)") }
        // The identifier stays English (puppet and UI tests find a menu item by it).
        func item(
            _ key: String, _ id: String, _ symbol: String, _ command: EditorTableCommand,
            _ enabled: Bool?, destructive: Bool = false
        ) -> UIAction {
            let action = UIAction(title: text(key), image: UIImage(systemName: symbol)) {
                [weak self] _ in self?.run(command)
            }
            action.accessibilityIdentifier = "table-menu-\(id)"
            if enabled != true { action.attributes.insert(.disabled) }
            if destructive { action.attributes.insert(.destructive) }
            return action
        }
        let commands =
            row
            ? [
                item(
                    "addRowAbove", "Add above", "arrow.up.to.line", .insertRowAbove,
                    can?.insertRowAbove),
                item(
                    "addRowBelow", "Add below", "arrow.down.to.line", .insertRowBelow,
                    can?.insertRowBelow),
                item(
                    "deleteRow", "Delete row", "trash", .deleteRow, can?.deleteRow,
                    destructive: true),
            ]
            : [
                item(
                    "addColumnLeft", "Add to left", "arrow.left.to.line", .insertColumnLeft,
                    can?.insertColumnLeft),
                item(
                    "addColumnRight", "Add to right", "arrow.right.to.line", .insertColumnRight,
                    can?.insertColumnRight),
                item(
                    "deleteColumn", "Delete column", "trash", .deleteColumn, can?.deleteColumn,
                    destructive: true),
            ]
        let delete = UIAction(
            title: text("deleteTable"), image: UIImage(systemName: "trash"),
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

    /// Backspace over every cell lets the engine remove the table as one edit.
    func deleteTable() {
        guard let editor, let c = controller, !c.engineComposing, let table = describe(),
            let first = table.rows.first?.first, let last = table.rows.last?.last
        else { return }
        // A selection inside a single cell edits its text. Include the leading pipe
        // when the header's only cell is the entire table.
        let oneCell = table.rows.count == 1 && table.rows[0].count == 1
        guard let start = utf16(oneCell ? table.display.start : first.content.start),
            let end = utf16(last.content.end)
        else { return }
        editor.finish()
        c.paragraphKey(.backspace, range: NSRange(location: start, length: end - start))
        c.textView.becomeFirstResponder()
    }
}
