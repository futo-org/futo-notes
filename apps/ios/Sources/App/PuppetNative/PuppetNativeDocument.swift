#if DEBUG
    import UIKit

    extension PuppetNativeEditor {
        /// Positions are the native display's UTF-16 units, not Markdown byte offsets. This
        /// index describes the view; Markdown meaning always comes from the engine/styler.
        @MainActor struct Document {
            struct Line {
                let number: Int
                let range: NSRange
            }
            let controller: TextFirstEditorController
            let text: NSString
            let lines: [Line]
            let visible: NSRange
            let frame: CGRect

            init(_ c: TextFirstEditorController) {
                controller = c
                let string = c.storage.string as NSString
                text = string
                var entries: [Line] = []
                var offset = 0
                while offset < string.length {
                    var start = 0
                    var end = 0
                    var contents = 0
                    string.getLineStart(
                        &start, end: &end, contentsEnd: &contents,
                        for: NSRange(location: offset, length: 0))
                    entries.append(
                        Line(
                            number: entries.count + 1,
                            range: NSRange(location: start, length: contents - start)))
                    offset = max(offset + 1, end)
                }
                if entries.isEmpty
                    || offset == string.length && string.length > 0
                        && (UnicodeScalar(string.character(at: string.length - 1)).map {
                            CharacterSet.newlines.contains($0)
                        } ?? false)
                {
                    entries.append(
                        Line(
                            number: entries.count + 1,
                            range: NSRange(location: string.length, length: 0)))
                }
                lines = entries
                let tv = c.textView
                // Flush only viewport layout, never editor composition or saves.
                tv.window?.layoutIfNeeded()
                tv.layoutIfNeeded()
                tv.textLayoutManager?.textViewportLayoutController.layoutViewport()
                var shown =
                    tv.window.map { tv.convert(tv.bounds, to: $0.screen.coordinateSpace) } ?? .zero
                var parent = tv.superview
                while let view = parent {
                    if let window = view.window {
                        shown = shown.intersection(
                            view.convert(view.bounds, to: window.screen.coordinateSpace))
                    }
                    parent = view.superview
                }
                let viewport = shown.isNull ? CGRect.zero : shown
                frame = viewport
                func at(_ x: CGFloat, _ y: CGFloat) -> Int {
                    guard let window = tv.window,
                        let p = tv.closestPosition(
                            to: tv.convert(
                                CGPoint(x: x, y: y), from: window.screen.coordinateSpace
                            ))
                    else { return 0 }
                    return tv.offset(from: tv.beginningOfDocument, to: p)
                }
                let first = max(
                    0,
                    min(
                        string.length,
                        at(viewport.minX + tv.textContainerInset.left + 1, viewport.minY + 1)))
                let last = max(
                    first,
                    min(
                        string.length,
                        at(viewport.maxX - tv.textContainerInset.right - 1, viewport.maxY - 1)))
                visible = NSRange(location: first, length: last - first)
            }

            var shown: [Line] {
                guard canReach else { return [] }
                return lines.filter {
                    NSMaxRange($0.range) >= visible.location
                        && $0.range.location <= NSMaxRange(visible)
                }
            }
            var canReach: Bool {
                guard frame.width > 0, frame.height > 0, let window = controller.textView.window,
                    let scene = window.windowScene
                else { return false }
                let reader = PuppetScreenReader.Reader(scene)
                for y in [frame.minY + 2, frame.midY, frame.maxY - 2] {
                    if let hit = reader.hit(CGPoint(x: frame.midX, y: y)),
                        hit === controller.textView || hit.isDescendant(of: controller.textView)
                    {
                        return true
                    }
                }
                return false
            }
            var onScreen: [String: Int]? {
                guard let first = shown.first, let last = shown.last else { return nil }
                return ["first": first.number, "last": last.number]
            }
            func line(at offset: Int) -> Line {
                lines.last { $0.range.location <= offset } ?? lines[0]
            }
            func visibleText(in range: NSRange) -> String {
                let pieces = shown.compactMap { line -> String? in
                    let r = NSIntersectionRange(NSIntersectionRange(line.range, visible), range)
                    return r.length > 0 ? rendered(r) : nil
                }
                return pieces.joined(separator: "\n")
            }
            func rendered(_ range: NSRange) -> String {
                var out = ""
                controller.storage.enumerateAttribute(.tfImage, in: range) { value, run, _ in
                    if let image = value as? TextFirstImageSpan {
                        out += "[image \(image.atom.destination)]"
                    } else {
                        out += text.substring(with: run)
                    }
                }
                return out
            }
            func containsVisibleText(_ range: NSRange) -> Bool {
                var hidden = false
                controller.storage.enumerateAttributes(in: range) { attributes, _, _ in
                    if attributes[.tfImage] != nil || attributes[.tfTableDelimiter] != nil {
                        hidden = true
                    }
                }
                return !hidden
            }
            func requireLine(_ number: Int, visibleOnly: Bool = true) throws -> Line {
                guard number > 0, number <= lines.count else {
                    throw PuppetVerbRefusal(400, "no line \(number) in the native document")
                }
                let found = lines[number - 1]
                if visibleOnly, !shown.contains(where: { $0.number == number }) {
                    throw PuppetVerbRefusal(
                        409,
                        "line \(number) is off screen; do ScrollToLine '{\"line\":\(number)}' first"
                    )
                }
                return found
            }
            func requireRangeBounds(_ range: NSRange, version: Any? = nil) throws {
                if let version = version as? NSNumber,
                    version.uint64Value != PuppetNativeEditor.version(controller)
                {
                    throw PuppetVerbRefusal(409, "docVersion is stale; read doc before editing")
                }
                guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= text.length,
                    (try? controller.mirror.utf16ToByte(unit: UInt64(range.location))) != nil,
                    (try? controller.mirror.utf16ToByte(unit: UInt64(NSMaxRange(range)))) != nil
                else {
                    throw PuppetVerbRefusal(
                        400, "range is outside the display or splits a Unicode character")
                }
            }
            func requireRange(_ range: NSRange, version: Any? = nil) throws {
                try requireRangeBounds(range, version: version)
                guard canReach, range.location >= visible.location,
                    NSMaxRange(range) <= NSMaxRange(visible)
                else {
                    throw PuppetVerbRefusal(409, "range is off screen; scroll or Find first")
                }
            }
            func range(_ args: [String: Any]) throws -> NSRange {
                if let version = args["docVersion"] as? NSNumber,
                    version.uint64Value != PuppetNativeEditor.version(controller)
                {
                    throw PuppetVerbRefusal(409, "docVersion is stale; read doc before editing")
                }
                if let find = args["find"] as? String { return try match(find) }
                guard let from = args["from"] as? Int, let to = args["to"] as? Int, to >= from
                else {
                    throw PuppetVerbRefusal(
                        400, "Select needs {\"find\":\"…\"} or integer from and to")
                }
                let range = NSRange(location: from, length: to - from)
                try requireRange(range, version: args["docVersion"])
                if let expected = args["expect"] as? String, text.substring(with: range) != expected
                {
                    throw PuppetVerbRefusal(
                        409, "expect does not match the display; read doc before editing")
                }
                return range
            }
            func match(_ needle: String) throws -> NSRange {
                guard !needle.isEmpty else {
                    throw PuppetVerbRefusal(400, "text must not be empty")
                }
                var hits: [NSRange] = []
                if canReach {
                    var remaining = visible
                    while remaining.length > 0 {
                        let found = text.range(of: needle, range: remaining)
                        if found.location == NSNotFound { break }
                        if containsVisibleText(found) { hits.append(found) }
                        let next = NSMaxRange(found)
                        remaining = NSRange(location: next, length: NSMaxRange(visible) - next)
                    }
                }
                guard hits.count == 1 else {
                    throw PuppetVerbRefusal(
                        409,
                        hits.isEmpty
                            ? "no visible text matches \(needle.debugDescription); scroll or Find first"
                            : "\(hits.count) visible matches for \(needle.debugDescription); extend the text"
                    )
                }
                return hits[0]
            }
            func row(_ original: Line) -> [String: Any] {
                let start = max(original.range.location, visible.location)
                let end = min(NSMaxRange(original.range), NSMaxRange(visible))
                let line = Line(
                    number: original.number,
                    range: NSRange(location: start, length: max(0, end - start)))
                let c = controller
                let attributes =
                    line.range.location < text.length
                    ? c.storage.attributes(at: line.range.location, effectiveRange: nil) : [:]
                let block = attributes[.tfBlock] as? TextFirstBlockAttribute
                let heading = attributes[.tfHeading] as? Int ?? block?.heading ?? 0
                let kind =
                    heading > 0
                    ? "heading\(heading)"
                    : block.map { b in
                        b.heading > 0
                            ? "heading\(b.heading)"
                            : b.code
                                ? "code"
                                : b.divider
                                    ? "divider"
                                    : b.list != nil
                                        ? "list" : b.quoteDepth > 0 ? "quote" : "paragraph"
                    } ?? "paragraph"
                var result: [String: Any] = [
                    "line": line.number, "at": line.range.location,
                    "end": NSMaxRange(line.range), "kind": kind,
                    "text": rendered(line.range),
                ]
                if let indent = block?.list?.indent, indent > 0 { result["indent"] = indent }
                if let table = attributes[.tfTable] as? TextFirstTableRowSpan {
                    result["kind"] = "table"
                    result["text"] = table.cells.map(\.text).joined(separator: " | ")
                    result["cells"] = table.cells.map { cell in
                        let r = table.contentRange(of: cell, row: line.range)
                        return [
                            "column": cell.column, "text": cell.text, "from": r.location,
                            "to": NSMaxRange(r),
                        ] as [String: Any]
                    }
                }
                if attributes[.tfTableDelimiter] != nil {
                    result["kind"] = "table-delimiter"
                    result["text"] = ""
                }
                if !c.engineBusy, !c.engineComposing, c.textView.markedTextRange == nil,
                    let bytes = try? c.byteRange(line.range),
                    let projection = try? c.session.project(expected: c.rev, range: bytes)
                {
                    result["runs"] = projection.runs.compactMap { run -> [String: Any]? in
                        guard
                            let r = try? c.session.displayToUtf16(expected: c.rev, range: run.range)
                        else { return nil }
                        let range = NSIntersectionRange(
                            line.range,
                            NSRange(location: Int(r.start), length: Int(r.end - r.start)))
                        guard range.length > 0 else { return nil }
                        return [
                            "from": range.location, "to": NSMaxRange(range),
                            "text": rendered(range),
                            "formats": run.formats.map {
                                $0 == .strike ? "strikethrough" : String(describing: $0)
                            },
                        ]
                    }
                }
                // copyMarkdown is an &self engine read; unlike a checkpoint it cannot settle IME.
                if !c.engineBusy, !c.engineComposing, c.textView.markedTextRange == nil,
                    let bytes = try? c.byteRange(line.range),
                    let markdown = try? c.session.copyMarkdown(expected: c.rev, range: bytes),
                    markdown != result["text"] as? String
                {
                    result["md"] = markdown
                }
                return result
            }
            func rows() -> [[String: Any]] { shown.map(row) }
            func doc(_ args: [String: Any]) throws -> [String: Any] {
                guard args.keys.allSatisfy({ $0 == "line" }) else {
                    throw PuppetVerbRefusal(400, "doc takes {} or {\"line\":N}")
                }
                if let n = args["line"] as? Int {
                    var result = row(try requireLine(n))
                    result["docVersion"] = PuppetNativeEditor.version(controller)
                    return result
                }
                return [
                    "docVersion": PuppetNativeEditor.version(controller),
                    "onScreen": onScreen ?? NSNull(),
                    "more": [
                        "above": visible.location > 0,
                        "below": NSMaxRange(visible) < text.length,
                    ], "lines": rows(),
                ]
            }
            func cell(containing range: NSRange) -> TextFirstEditorController.TableCellHit? {
                guard range.location < text.length else { return nil }
                let row = text.paragraphRange(for: NSRange(location: range.location, length: 0))
                guard
                    let span = controller.storage.attribute(
                        .tfTable, at: range.location,
                        effectiveRange: nil) as? TextFirstTableRowSpan,
                    let cell = span.cells.first(where: {
                        let content = span.contentRange(of: $0, row: row)
                        return range.location >= content.location
                            && NSMaxRange(range) <= NSMaxRange(content)
                    })
                else { return nil }
                return TextFirstEditorController.TableCellHit(
                    row: row, span: span, cell: cell,
                    range: span.contentRange(of: cell, row: row))
            }
            func rect(_ range: NSRange) -> CGRect? {
                let tv = controller.textView
                guard let window = tv.window,
                    let start = tv.position(from: tv.beginningOfDocument, offset: range.location),
                    let end = tv.position(from: start, offset: range.length),
                    let selected = tv.textRange(from: start, to: end)
                else { return nil }
                let local: CGRect
                if let cell = cell(containing: range),
                    let drawn = controller.cellFrame(start: cell.range.location)
                {
                    local = drawn
                } else {
                    local =
                        range.length == 0 ? tv.caretRect(for: start) : tv.firstRect(for: selected)
                }
                let screen = tv.convert(local, to: window.screen.coordinateSpace).intersection(
                    frame)
                return screen.isNull || screen.isEmpty ? nil : screen
            }
            static func box(_ rect: CGRect) -> [String: Int] {
                [
                    "x": Int(rect.minX.rounded()), "y": Int(rect.minY.rounded()),
                    "w": Int(rect.width.rounded()), "h": Int(rect.height.rounded()),
                ]
            }
            func show(_ args: [String: Any]) throws -> [String: Any] {
                guard let needle = args["text"] as? String else {
                    throw PuppetVerbRefusal(
                        400, "native show needs {\"text\":\"…\"}; elements lists native refs")
                }
                let found = try match(needle)
                guard let box = rect(found) else {
                    throw PuppetVerbRefusal(409, "the text is not drawn on screen")
                }
                let line = line(at: found.location)
                return [
                    "text": needle, "from": found.location, "to": NSMaxRange(found),
                    "line": line.number, "col": found.location - line.range.location + 1,
                    "rect": Self.box(box),
                ]
            }
            func at(_ args: [String: Any]) throws -> [String: Any] {
                guard let x = args["x"] as? Double, let y = args["y"] as? Double,
                    frame.contains(CGPoint(x: x, y: y)), let window = controller.textView.window,
                    let p = controller.textView.closestPosition(
                        to: controller.textView.convert(
                            CGPoint(x: x, y: y), from: window.screen.coordinateSpace))
                else {
                    throw PuppetVerbRefusal(409, "at needs a point in the visible native editor")
                }
                let offset = controller.textView.offset(
                    from: controller.textView.beginningOfDocument, to: p)
                return [
                    "x": x, "y": y, "native": true, "position": offset,
                    "line": line(at: offset).number, "handlers": [Any](),
                ]
            }
        }
    }
#endif
