#if DEBUG
    import UIKit

    /// The editor's read queries over a `Document`: `doc`, `show` and `at`. None of them
    /// changes the editor: no composition settles, no selection moves, nothing saves.
    extension PuppetNativeEditor.Document {
        /// One line as `doc` reports it, clipped to its part on screen (receipts). Given
        /// `whole` (the numbers of the lines on screen), the whole line instead: one off
        /// screen carries its text and kind but no runs or markdown, which `source` holds.
        func row(_ original: Line, whole shownLines: Set<Int>? = nil) -> [String: Any] {
            let onScreen = shownLines?.contains(original.number) ?? true
            let line: Line
            if shownLines == nil {
                let start = max(original.range.location, visible.location)
                let end = min(NSMaxRange(original.range), NSMaxRange(visible))
                line = Line(
                    number: original.number,
                    range: NSRange(location: start, length: max(0, end - start)))
            } else {
                line = original
            }
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
            if !onScreen {
                result["offscreen"] = true
                return result
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
        func rows() -> [[String: Any]] { shown.map { row($0) } }
        func doc(_ args: [String: Any]) throws -> [String: Any] {
            guard args.keys.allSatisfy({ $0 == "line" }) else {
                throw PuppetVerbRefusal(400, "doc takes {} or {\"line\":N}")
            }
            if let n = args["line"] as? Int {
                var result = row(
                    try requireLine(n, visibleOnly: false), whole: Set(shown.map(\.number)))
                result["docVersion"] = PuppetNativeEditor.version(controller)
                return result
            }
            // The whole note, never a prefix: `text` is the display whose UTF-16 offsets
            // every position names, `source` the Markdown the engine holds (a pure read: it
            // settles no composition), `visible` the part on screen a real tap can reach.
            let reachable = canReach
            let shownLines = Set(shown.map(\.number))
            return [
                "docVersion": PuppetNativeEditor.version(controller),
                "text": text as String,
                "source": (try? controller.session.sourceText()) ?? NSNull(),
                "visible": reachable
                    ? ["from": visible.location, "to": NSMaxRange(visible)] : NSNull(),
                "onScreen": onScreen ?? NSNull(),
                "more": [
                    "above": reachable && visible.location > 0,
                    "below": !reachable || NSMaxRange(visible) < text.length,
                ], "lines": lines.map { row($0, whole: shownLines) },
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
            guard let x = args["x"] as? Double, let y = args["y"] as? Double else {
                throw PuppetVerbRefusal(400, #"at needs {"x":…,"y":…} in screen points"#)
            }
            let point = CGPoint(x: x, y: y)
            // A point over the keyboard toolbar or the suggestions, which overlap the text
            // view's frame, names the control a touch there reaches.
            if !frame.contains(point)
                || reachable(
                    CGRect(origin: point, size: .zero)
                        .insetBy(dx: -0.5, dy: -0.5)) == nil
            {
                return try element(at: point)
            }
            guard let window = controller.textView.window,
                let p = controller.textView.closestPosition(
                    to: controller.textView.convert(
                        CGPoint(x: x, y: y), from: window.screen.coordinateSpace))
            else {
                throw PuppetVerbRefusal(409, "at needs a point in the visible native editor")
            }
            let offset = controller.textView.offset(
                from: controller.textView.beginningOfDocument, to: p)
            var result: [String: Any] = [
                "x": x, "y": y, "native": true, "position": offset,
                "line": line(at: offset).number, "handlers": [Any](),
            ]
            if let control = control(atScreen: CGPoint(x: x, y: y)) {
                result["control"] = control
            }
            return result
        }
        /// The topmost on-screen element (`/tree`'s rows) under `point`, as `at` reports it.
        func element(at point: CGPoint) throws -> [String: Any] {
            let nodes = (PuppetScreenReader.tree()["nodes"] as? [[String: Any]] ?? [])
            let hit = nodes.last { node in
                guard let x = node["x"] as? Int, let y = node["y"] as? Int,
                    let w = node["w"] as? Int, let h = node["h"] as? Int
                else { return false }
                return CGRect(x: x, y: y, width: w, height: h).contains(point)
            }
            guard let hit else {
                throw PuppetVerbRefusal(
                    409, "nothing a touch reaches is at \(point.x),\(point.y)")
            }
            return [
                "x": point.x, "y": point.y, "native": true,
                "element": hit.filter {
                    ["role", "text", "x", "y", "w", "h", "section"].contains($0.key)
                },
            ]
        }
    }
#endif
