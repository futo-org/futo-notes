#if DEBUG
    import UIKit

    /// The native editor's `do` verbs: direct edits through the Rust editor session, never
    /// stand-ins for typing. Real keys are the CLI's top-level `type` and `press`, real touches
    /// its `tap`; the verb map (.claude/skills/puppet/references/commands/verb-map.md) is the
    /// contract these follow.
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
                entry("SelectAll"),
                entry("Copy"), entry("Cut"), entry("Paste"),
                entry("ScrollToLine", ["line"], [], ["line"], convenience: true),
                entry(
                    "Insert", ["text"], ["at", "after", "before", "docVersion"],
                    ["at", "docVersion"], convenience: true),
                entry(
                    "Replace", ["text"], ["find", "from", "to", "expect", "docVersion"],
                    ["from", "to", "docVersion"], convenience: true),
                entry("ReplaceLine", ["line", "text"], [], ["line"], convenience: true),
                entry(
                    "ToggleTask", [], ["find", "line", "docVersion"], ["line", "docVersion"],
                    convenience: true),
                entry("OpenLink", ["find"], convenience: true),
            ]
            if c.completionModel.completion?.candidates.isEmpty == false {
                all.append(
                    entry("AcceptSuggestion", [], ["index", "text"], ["index"], convenience: true))
            }
            if focused(c) { all += toolbarItems.map { entry(toolbarName($0.id)) } }
            return all
        }

        func focused(_ c: TextFirstEditorController) -> Bool {
            c.textView.isFirstResponder || c.cellEditor?.field.isFirstResponder == true
        }

        /// Runs one editor verb. A refusal before the note changed is retryable as usual (409,
        /// 503); once the note has changed nothing answers with one: a later failure is a
        /// non-retryable 500 carrying the new `docVersion`. So is a command still running on the
        /// engine's queue after `settle` seconds (a toolbar command over a huge selection): it
        /// lands later, and a retry would apply it twice.
        func perform(_ verb: String, arguments args: [String: Any], settle: TimeInterval = 5)
            async -> PuppetReply
        {
            let c: TextFirstEditorController
            do { c = try requireController() } catch let error as PuppetVerbRefusal {
                return PuppetServerContract.refusal(error.status, error.message)
            } catch { return PuppetServerContract.refusal(500, "\(error)") }
            let before = snapshot()
            let versionBefore = Self.version(c)
            var reported: [String: Any] = [:]
            do {
                reported = try await run(verb, args, in: c)
            } catch let error as PuppetVerbRefusal {
                return failure(verb, error.status, error.message, c, before: before.source)
            } catch {
                return failure(
                    verb, 500, "native \(verb) failed: \(error)", c, before: before.source)
            }
            let deadline = Date().addingTimeInterval(settle)
            while c.commandRunning && Date() < deadline { await Task.yield() }
            if c.commandRunning { return stillRunning(verb, c) }
            let after = snapshot()
            let source = c.closed ? nil : try? c.session.sourceText()
            var receipt: [String: Any] = [
                "ok": true, "verb": verb,
                "docVersion": ["before": versionBefore, "after": Self.version(c)],
                "changed": source.map { $0 != before.source } ?? false,
                "selection": c.closed ? NSNull() : selection(c),
                "diff": diff(before, after), "editor": state(note: c.noteId),
            ]
            receipt.merge(reported) { _, value in value }
            lastTrace = receipt
            return (200, PuppetServerContract.json(receipt))
        }

        private func failure(
            _ verb: String, _ status: Int, _ message: String, _ c: TextFirstEditorController,
            before: String?
        ) -> PuppetReply {
            // A job on the engine's queue holds the session, and may be this verb's own edit.
            if c.commandRunning { return stillRunning(verb, c) }
            let now = c.closed || c.engineBusy ? nil : try? c.session.sourceText()
            guard let now, now != before else {
                return PuppetServerContract.refusal(status, message)
            }
            return (
                500,
                PuppetServerContract.json([
                    "ok": false, "changed": true, "retryable": false,
                    "docVersion": Self.version(c),
                    "error":
                        "\(message), after \(verb) had already changed the note: do not retry; read doc and go on from there",
                ])
            )
        }

        /// A command still on the engine's queue: it changes the note when it lands.
        private func stillRunning(_ verb: String, _ c: TextFirstEditorController) -> PuppetReply {
            (
                500,
                PuppetServerContract.json([
                    "ok": false, "pending": true, "retryable": false,
                    "docVersion": Self.version(c),
                    "error":
                        "\(verb) is still running in the editor and changes the note when it lands: do not retry; wait until state.editor.loading is false, then read doc",
                ])
            )
        }

        /// The selection a receipt reports: its direction only when puppet's own `Select` set it
        /// (a caret has none), `"unknown"` for any other non-empty selection.
        func selection(_ c: TextFirstEditorController) -> [String: Any] {
            let range = c.effectiveSelection
            var result: [String: Any] = [
                "from": range.location, "to": NSMaxRange(range), "empty": range.length == 0,
            ]
            if range.length > 0 {
                result["direction"] =
                    selectedBy === c && selectedRange == range
                        && selectedAt == c.selectionChanges ? "forward" : "unknown"
            }
            return result
        }

        private func run(_ verb: String, _ args: [String: Any], in c: TextFirstEditorController)
            async throws -> [String: Any]
        {
            let document = Document(c)
            switch verb {
            case "Select", "PlaceCaret":
                let range: NSRange
                if verb == "PlaceCaret" {
                    guard let at = args["at"] as? Int else {
                        throw PuppetVerbRefusal(400, "PlaceCaret needs an integer at")
                    }
                    range = NSRange(location: at, length: 0)
                    try document.requireRange(range, version: args["docVersion"])
                } else {
                    range = try document.range(args)
                }
                c.selectInCell(range)
                _ =
                    c.cellEditor?.field.becomeFirstResponder()
                    ?? c.textView.becomeFirstResponder()
                if verb == "Select", range.length > 0 {
                    selectedBy = c
                    selectedRange = c.effectiveSelection
                    selectedAt = c.selectionChanges
                }
                return ["selected": state(note: c.noteId)["selection"] ?? NSNull()]
            case "SelectAll":
                if let cell = c.cellEditor, cell.field.isFirstResponder {
                    cell.field.selectAll(nil)
                } else {
                    c.textView.selectAll(nil)
                }
                return [:]
            case "Copy", "Cut":
                let range = c.effectiveSelection
                guard range.length > 0 else {
                    throw PuppetVerbRefusal(409, "nothing is selected: Select first")
                }
                try document.requireRangeBounds(range)
                let text =
                    verb == "Copy" ? try c.selectionMarkdown(range) : try c.cutMarkdown(range)
                recordCopy(text)
                return [:]
            case "Paste":
                guard let text = clipboard else {
                    throw PuppetVerbRefusal(409, "the clipboard is empty: Copy first")
                }
                try document.requireRangeBounds(c.effectiveSelection)
                try c.pasteMarkdown(text, range: c.effectiveSelection)
                return [:]
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
                return [:]
            case "Insert", "Replace", "ReplaceLine":
                return try write(verb, args, document, c)
            case "ToggleTask":
                return try toggleTask(args, document, c)
            case "OpenLink":
                return try openLink(args, document, c)
            case "AcceptSuggestion":
                return try acceptSuggestion(args, c)
            default:
                guard let item = toolbarItems.first(where: { toolbarName($0.id) == verb }) else {
                    throw PuppetVerbRefusal(
                        404, "the native editor does not offer \(verb); actions lists its verbs")
                }
                guard focused(c) else {
                    throw PuppetVerbRefusal(409, "the keyboard toolbar is hidden: PlaceCaret first")
                }
                guard !c.toolbarState.disabledFormats.contains(item.id) else {
                    throw PuppetVerbRefusal(409, "\(verb) is disabled for this selection")
                }
                c.toolbar(item)
                return [:]
            }
        }

        private func write(
            _ verb: String, _ args: [String: Any], _ document: Document,
            _ c: TextFirstEditorController
        ) throws -> [String: Any] {
            guard let text = args["text"] as? String else {
                throw PuppetVerbRefusal(400, "\(verb) requires text")
            }
            let range: NSRange
            if verb == "ReplaceLine", let number = args["line"] as? Int {
                range = try document.requireLine(number).range
            } else if verb == "Insert" {
                if let after = args["after"] as? String {
                    range = NSRange(location: NSMaxRange(try document.match(after)), length: 0)
                } else if let before = args["before"] as? String {
                    range = NSRange(location: try document.match(before).location, length: 0)
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
            return [
                "wrote": [
                    "from": range.location, "to": NSMaxRange(range), "removed": removed,
                    "inserted": text,
                ]
            ]
        }

        /// What a tap on the task's checkbox does (TextFirstEditorController+Taps): the engine
        /// toggles the line, and the caret stays where it was.
        private func toggleTask(
            _ args: [String: Any], _ document: Document, _ c: TextFirstEditorController
        ) throws -> [String: Any] {
            try document.requireRangeBounds(
                NSRange(location: 0, length: 0), version: args["docVersion"])
            let line: Document.Line
            if let number = args["line"] as? Int {
                line = try document.requireLine(number)
            } else if let find = args["find"] as? String {
                line = document.line(at: try document.match(find).location)
            } else {
                throw PuppetVerbRefusal(400, #"ToggleTask needs {"find":"…"} or {"line":N}"#)
            }
            guard let task = document.task(line) else {
                throw PuppetVerbRefusal(409, "line \(line.number) is not a task")
            }
            c.toggleTask(atLineOffset: line.range.location, keeping: c.textView.selectedRange)
            return ["task": ["line": line.number, "was": task.checked ? "checked" : "unchecked"]]
        }

        /// What a tap on a link's glyphs does: the note or the page opens, the caret untouched.
        private func openLink(
            _ args: [String: Any], _ document: Document, _ c: TextFirstEditorController
        ) throws -> [String: Any] {
            guard let find = args["find"] as? String else {
                throw PuppetVerbRefusal(400, #"OpenLink needs {"find":"<the link's text>"}"#)
            }
            let range = try document.match(find)
            if document.cell(containing: range) != nil {
                throw PuppetVerbRefusal(
                    409, "\(find.debugDescription) is in a table cell, where a tap edits the cell")
            }
            guard
                let link = document.links().first(where: {
                    NSIntersectionRange($0.range, range).length > 0
                })
            else {
                throw PuppetVerbRefusal(409, "\(find.debugDescription) is not a link")
            }
            guard let target = link.target else {
                throw PuppetVerbRefusal(
                    409, "\(find.debugDescription) is a link that opens nothing")
            }
            c.open(target)
            return ["opened": Document.describe(target)]
        }

        /// What a tap on a wikilink suggestion does.
        private func acceptSuggestion(_ args: [String: Any], _ c: TextFirstEditorController)
            throws -> [String: Any]
        {
            guard let found = c.completionModel.completion, !found.candidates.isEmpty else {
                throw PuppetVerbRefusal(409, "no wikilink suggestions are showing: type [[ first")
            }
            let candidates = found.candidates
            let chosen: EditorWikilinkCandidate
            if let index = args["index"] as? Int {
                guard candidates.indices.contains(index) else {
                    throw PuppetVerbRefusal(
                        400,
                        "index is 0 to \(candidates.count - 1): \(candidates.count) suggestions show"
                    )
                }
                chosen = candidates[index]
            } else if let text = args["text"] as? String {
                let matches = candidates.filter { $0.label == text || $0.noteId == text }
                guard matches.count == 1 else {
                    let shown = candidates.map { $0.label.debugDescription }.joined(separator: ", ")
                    throw PuppetVerbRefusal(
                        409,
                        "\(matches.count) suggestions are \(text.debugDescription); showing: \(shown)"
                    )
                }
                chosen = matches[0]
            } else {
                throw PuppetVerbRefusal(400, #"AcceptSuggestion needs {"index":N} or {"text":"…"}"#)
            }
            c.acceptCompletion(noteId: chosen.noteId)
            return ["accepted": chosen.noteId]
        }
    }
#endif
