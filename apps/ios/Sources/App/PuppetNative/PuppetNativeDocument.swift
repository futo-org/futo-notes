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
            /// The range's text as shown: an image as its destination, a list item's marker unit
            /// left out (the line's `kind` and the checkbox targets report the marker).
            func rendered(_ range: NSRange) -> String {
                var out = ""
                let storage = controller.storage
                storage.enumerateAttribute(.tfImage, in: range) { value, run, _ in
                    if let image = value as? TextFirstImageSpan {
                        out += "[image \(image.atom.destination)]"
                        return
                    }
                    storage.enumerateAttribute(.tfListMarker, in: run) { marker, piece, _ in
                        if marker == nil { out += text.substring(with: piece) }
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
                // A character a person sees as one (an emoji with its modifier or joiners, a letter
                // with combining marks, a flag) is never split, whatever its UTF-16 length.
                func whole(_ at: Int) -> Bool {
                    at == text.length
                        || text.rangeOfComposedCharacterSequence(at: at).location == at
                }
                guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= text.length,
                    whole(range.location), whole(NSMaxRange(range)),
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
        }
    }
#endif
