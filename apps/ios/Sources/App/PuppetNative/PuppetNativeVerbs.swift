#if DEBUG
    import UIKit

    extension PuppetNativeEditor {
        var toolbarItems: [ToolbarItemSpec] {
            ToolbarSpec.groups.flatMap { $0 }.filter {
                $0.action == .exec && !TextFirstEditorController.hiddenToolbarItems.contains($0.id)
            }
        }
        func toolbarName(_ id: String) -> String {
            id.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
        }
        func actions(_ c: TextFirstEditorController) -> [[String: Any]] {
            guard ready else { return [] }
            func entry(
                _ name: String, _ required: [String] = [], _ optional: [String] = [],
                _ integers: [String] = [], convenience: Bool = false
            ) -> [String: Any] {
                var result: [String: Any] = [
                    "name": name,
                    "schema": PuppetServerContract.schema(
                        required, optional: optional, integers: integers),
                ]
                if convenience { result["convenience"] = true }
                return result
            }
            var all = [
                entry(
                    "Select", [], ["find", "from", "to", "expect", "docVersion"],
                    ["from", "to", "docVersion"]),
                entry("PlaceCaret", ["at"], ["docVersion"], ["at", "docVersion"]),
                entry("Type", ["text"]), entry("Press", ["key"], ["count"], ["count"]),
                entry("Copy"), entry("Cut"), entry("Paste"),
                entry("ScrollToLine", ["line"], [], ["line"], convenience: true),
                entry(
                    "Insert", ["text"], ["at", "after", "before", "docVersion"],
                    ["at", "docVersion"], convenience: true),
                entry(
                    "Replace", ["text"], ["find", "from", "to", "expect", "docVersion"],
                    ["from", "to", "docVersion"], convenience: true),
                entry("ReplaceLine", ["line", "text"], [], ["line"], convenience: true),
            ]
            if c.textView.isFirstResponder || c.cellEditor?.field.isFirstResponder == true {
                all += toolbarItems.map { entry(toolbarName($0.id)) }
            }
            return all
        }

        func perform(_ verb: String, arguments args: [String: Any]) async -> PuppetReply {
            do {
                let c = try requireController()
                let before = snapshot()
                let document = Document(c)
                var reported: [String: Any] = [:]
                switch verb {
                case "Select", "PlaceCaret":
                    let range: NSRange
                    if verb == "PlaceCaret", let at = args["at"] as? Int {
                        range = NSRange(location: at, length: 0)
                        try document.requireRange(range, version: args["docVersion"])
                    } else {
                        range = try document.range(args)
                    }
                    c.selectInCell(range)
                    _ =
                        c.cellEditor?.field.becomeFirstResponder()
                        ?? c.textView.becomeFirstResponder()
                    reported["selected"] = state(note: c.noteId)["selection"]
                case "Type":
                    guard let text = args["text"] as? String else {
                        throw PuppetVerbRefusal(400, "Type requires text")
                    }
                    try document.requireRangeBounds(c.effectiveSelection)
                    type(text, into: c)
                case "Press":
                    guard let key = args["key"] as? String else {
                        throw PuppetVerbRefusal(400, "Press requires key")
                    }
                    let count = args["count"] as? Int ?? 1
                    guard count > 0 else { throw PuppetVerbRefusal(400, "count must be positive") }
                    try document.requireRangeBounds(c.effectiveSelection)
                    for _ in 0..<count { try press(key, in: c) }
                case "Copy", "Cut":
                    let range = c.effectiveSelection
                    guard range.length > 0 else {
                        throw PuppetVerbRefusal(409, "nothing is selected: Select first")
                    }
                    try document.requireRangeBounds(range)
                    if verb == "Copy" {
                        clipboard = try c.selectionMarkdown(range)
                    } else {
                        clipboard = try c.cutMarkdown(range)
                    }
                    recordCopy(clipboard ?? "")
                case "Paste":
                    guard let text = clipboard else {
                        throw PuppetVerbRefusal(409, "the clipboard is empty: Copy first")
                    }
                    try document.requireRangeBounds(c.effectiveSelection)
                    try c.pasteMarkdown(text, range: c.effectiveSelection)
                case "ScrollToLine":
                    guard let number = args["line"] as? Int else {
                        throw PuppetVerbRefusal(400, "ScrollToLine requires line")
                    }
                    let line = try document.requireLine(number, visibleOnly: false)
                    c.textView.scrollRangeToVisible(line.range)
                    c.textView.layoutIfNeeded()
                    let deadline = Date().addingTimeInterval(3)
                    while !Document(c).shown.contains(where: { $0.number == number })
                        && Date() < deadline
                    {
                        await Task.yield()
                    }
                    guard Document(c).shown.contains(where: { $0.number == number }) else {
                        throw PuppetVerbRefusal(409, "line \(number) did not come on screen")
                    }
                case "Insert", "Replace", "ReplaceLine":
                    guard let text = args["text"] as? String else {
                        throw PuppetVerbRefusal(400, "\(verb) requires text")
                    }
                    let range: NSRange
                    if verb == "ReplaceLine", let number = args["line"] as? Int {
                        range = try document.requireLine(number).range
                    } else if verb == "Insert" {
                        if let after = args["after"] as? String {
                            range = NSRange(
                                location: NSMaxRange(try document.match(after)), length: 0)
                        } else if let before = args["before"] as? String {
                            range = NSRange(
                                location: try document.match(before).location, length: 0)
                        } else if let at = args["at"] as? Int {
                            range = NSRange(location: at, length: 0)
                        } else {
                            throw PuppetVerbRefusal(400, "Insert needs at, after, or before")
                        }
                    } else {
                        range = try document.range(args)
                    }
                    try document.requireRange(range, version: args["docVersion"])
                    let removed = document.visibleText(in: range)
                    try c.pasteMarkdown(text, range: range)
                    reported["wrote"] = [
                        "from": range.location, "to": NSMaxRange(range),
                        "removed": removed, "inserted": text,
                    ]
                default:
                    guard let item = toolbarItems.first(where: { toolbarName($0.id) == verb })
                    else {
                        throw PuppetVerbRefusal(
                            404, "the native editor does not offer \(verb); actions lists its verbs"
                        )
                    }
                    guard
                        c.textView.isFirstResponder || c.cellEditor?.field.isFirstResponder == true
                    else {
                        throw PuppetVerbRefusal(
                            409, "the keyboard toolbar is hidden: PlaceCaret first")
                    }
                    guard !c.toolbarState.disabledFormats.contains(item.id) else {
                        throw PuppetVerbRefusal(409, "\(verb) is disabled for this selection")
                    }
                    c.toolbar(item)
                }
                let deadline = Date().addingTimeInterval(5)
                while c.commandRunning && Date() < deadline { await Task.yield() }
                let after = snapshot()
                var receipt: [String: Any] = [
                    "ok": true, "verb": verb, "before": before.id,
                    "after": after.id, "events": [0, 0], "diff": diff(before, after),
                    "editor": state(note: c.noteId),
                ]
                receipt.merge(reported) { _, value in value }
                lastTrace = receipt
                return (200, PuppetServerContract.json(receipt))
            } catch let error as PuppetVerbRefusal {
                return PuppetServerContract.refusal(error.status, error.message)
            } catch { return PuppetServerContract.refusal(500, "native \(verb) failed: \(error)") }
        }

        func type(_ text: String, into c: TextFirstEditorController) {
            for character in text {
                let tv: UITextView =
                    c.cellEditor?.field.isFirstResponder == true
                    ? c.cellEditor!.field : c.textView
                _ = tv.becomeFirstResponder()
                let key = String(character)
                if key == "\t", let cell = c.cellEditor, cell.field === tv, cell.tab(back: false) {
                    continue
                }
                if key == "\t", tv === c.textView, c.paragraphKey(.tab, onlyIfChanged: true) {
                    continue
                }
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: key) ?? true
                {
                    tv.insertText(key)
                }
            }
        }
        func press(_ key: String, in c: TextFirstEditorController) throws {
            let tv: UITextView =
                c.cellEditor?.field.isFirstResponder == true ? c.cellEditor!.field : c.textView
            switch key {
            case "Enter", "Return", "Shift-Enter": type("\n", into: c)
            case "Tab": type("\t", into: c)
            case "Shift-Tab":
                if let cell = c.cellEditor, cell.field.isFirstResponder {
                    _ = cell.tab(back: true)
                } else {
                    _ = c.paragraphKey(.shiftTab, onlyIfChanged: true)
                }
            case "Backspace":
                let selection = tv.selectedRange
                let deleted =
                    selection.length > 0
                    ? selection
                    : NSRange(
                        location: max(0, selection.location - 1), length: min(1, selection.location)
                    )
                if tv.delegate?.textView?(tv, shouldChangeTextIn: deleted, replacementText: "")
                    ?? true
                {
                    tv.deleteBackward()
                }
            case "Delete":
                guard tv === c.textView else {
                    throw PuppetVerbRefusal(400, "use real press for forward Delete inside a cell")
                }
                _ = c.paragraphKey(.delete)
            case "Mod-z": c.undo()
            case "Mod-Shift-z", "Mod-y": c.redo()
            case "Mod-a": tv.selectAll(nil)
            case "Mod-b": c.format(.bold)
            case "Mod-i": c.format(.italic)
            case "Escape": tv.resignFirstResponder()
            case "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End":
                let range = tv.selectedRange
                let at = key == "ArrowLeft" ? range.location : NSMaxRange(range)
                guard let from = tv.position(from: tv.beginningOfDocument, offset: at) else {
                    return
                }
                let target: UITextPosition?
                if key == "Home" || key == "End" {
                    let line =
                        tv === c.textView
                        ? Document(c).line(at: at).range
                        : (tv.text as NSString).lineRange(for: NSRange(location: at, length: 0))
                    target = tv.position(
                        from: tv.beginningOfDocument,
                        offset: key == "Home" ? line.location : NSMaxRange(line))
                } else {
                    let direction: UITextLayoutDirection =
                        key == "ArrowLeft"
                        ? .left : key == "ArrowRight" ? .right : key == "ArrowUp" ? .up : .down
                    target = tv.position(from: from, in: direction, offset: 1)
                }
                if let target { tv.selectedTextRange = tv.textRange(from: target, to: target) }
            default:
                if key.count == 1 {
                    type(key, into: c)
                } else {
                    throw PuppetVerbRefusal(
                        400, "unsupported native key \(key); use real press for platform chords")
                }
            }
        }
    }
#endif
