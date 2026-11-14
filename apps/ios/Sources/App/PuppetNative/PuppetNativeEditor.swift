#if DEBUG
    import UIKit

    /// Debug inspection of the native renderer. It borrows the screen's controller; it never
    /// owns an editor attachment or creates the retired WebView. Reads run only on request.
    @MainActor
    final class PuppetNativeEditor {
        static let shared = PuppetNativeEditor()
        weak var controller: TextFirstEditorController?
        private var title: (() -> String)?
        var clipboard: String?
        var snapshotId = 0
        var pendingTrace: Snapshot?
        var lastTrace: [String: Any]?

        func attach(_ controller: TextFirstEditorController, title: @escaping () -> String) {
            self.controller = controller
            self.title = title
        }

        func clear(_ expected: TextFirstEditorController) {
            guard controller === expected else { return }
            controller = nil
            title = nil
        }

        var ready: Bool {
            guard let c = controller else { return false }
            return !c.closed && !c.engineBusy && c.textView.window != nil
        }

        private static weak var versionController: TextFirstEditorController?
        private static var versionRevision: UInt64?
        private static var serial = UInt64.random(in: (1 << 32)...(1 << 52))

        static func version(_ c: TextFirstEditorController) -> UInt64 {
            if versionController !== c || versionRevision != c.rev {
                serial += 1
                versionController = c
                versionRevision = c.rev
            }
            return serial
        }

        var unsavedId: String? {
            guard let c = controller, !c.closed else { return nil }
            let pending = c.engineBusy ? c.dirty : (try? c.session.saveDelay()) != nil
            return pending || c.saveModel.failed || c.engineComposing ? c.noteId : nil
        }

        func recordCopy(_ text: String) {
            clipboard = text
            PuppetVerbs.shared.recordCopy(text)
        }

        func state(note: String?) -> [String: Any] {
            guard let c = controller, !c.closed, note == nil || c.noteId == note else {
                return [
                    "surface": "native", "ready": false, "loading": true,
                    "note": note ?? NSNull(),
                ]
            }
            let document = Document(c)
            let range = c.effectiveSelection
            let line = document.line(at: range.location)
            let selected = document.visibleText(in: range)
            let disabled: Set<String>
            let active: Set<String>
            if !c.engineBusy, range.length < TextFirstEditorController.heavySelection,
                let highlights = try? c.session.toolbarHighlights()
            {
                disabled = Set(highlights.disabled)
                active = Set(highlights.active)
            } else {
                disabled = c.toolbarState.disabledFormats
                active = c.toolbarState.activeFormats
            }
            return [
                "surface": "native", "ready": ready, "loading": c.engineBusy,
                "note": c.noteId, "title": title?() ?? c.noteId,
                "docVersion": Self.version(c), "onScreen": document.onScreen ?? NSNull(),
                "focused": c.textView.isFirstResponder
                    || c.cellEditor?.field.isFirstResponder == true,
                "composing": c.engineComposing || c.textView.markedTextRange != nil,
                "selection": [
                    "anchor": range.location, "head": NSMaxRange(range),
                    "from": range.location, "to": NSMaxRange(range),
                    "empty": range.length == 0, "text": String(selected.prefix(80)),
                    "line": line.number, "col": range.location - line.range.location + 1,
                    "formats": Array(active).sorted(),
                ],
                "find": [
                    "open": c.findModel.visible, "query": c.findModel.query,
                    "current": c.findModel.current, "total": c.findModel.total,
                ],
                "clipboard": clipboard.map { String($0.prefix(80)) } ?? NSNull(),
                "canUndo": !disabled.contains("undo"), "canRedo": !disabled.contains("redo"),
            ]
        }

        func requireController() throws -> TextFirstEditorController {
            guard let c = controller, !c.closed, ready else {
                throw PuppetVerbRefusal(
                    503, "the native editor is still loading or applying a command")
            }
            guard Document(c).canReach else {
                throw PuppetVerbRefusal(
                    409, "the native editor is covered; answer the dialog or GoBack first")
            }
            return c
        }

        func checkpoint() async -> Bool {
            guard let c = controller, !c.closed else { return true }
            guard ready else { return false }
            await withCheckedContinuation { done in c.checkpoint { done.resume() } }
            return !c.dirty && !c.saveModel.failed
        }

        func query(_ command: String, arguments: [String: Any]) throws -> [String: Any] {
            if command == "clipboard" {
                if arguments["clear"] as? Bool == true { clipboard = nil }
                if let text = arguments["text"] as? String { clipboard = text }
                return ["clipboard": clipboard.map { ["text": $0, "html": ""] } ?? NSNull()]
            }
            if command == "events" { return ["last": 0, "events": [Any]()] }
            if command == "trace" {
                if arguments["begin"] as? Bool == true {
                    pendingTrace = snapshot()
                    return ["eventCursor": 0, "before": pendingTrace!.id]
                }
                if arguments["end"] as? Bool == true {
                    let before = pendingTrace ?? snapshot()
                    pendingTrace = nil
                    let after = snapshot()
                    let record: [String: Any] = [
                        "kind": "gesture", "before": before.id,
                        "after": after.id, "events": [0, 0], "diff": diff(before, after),
                    ]
                    lastTrace = record
                    return record
                }
                throw PuppetVerbRefusal(400, "trace needs {\"begin\":true} or {\"end\":true}")
            }
            if command == "diff" { return lastTrace ?? ["diff": [String: Any]()] }
            let c = try requireController()
            let document = Document(c)
            switch command {
            case "state": return ["editor": state(note: c.noteId)]
            case "observe":
                return [
                    "editor": state(note: c.noteId), "lines": document.rows(),
                    "elements": [Any](), "actions": actions(c),
                ]
            case "actions": return ["actions": actions(c)]
            case "elements": return ["elements": [Any](), "scroll": [Any]()]
            case "doc": return try document.doc(arguments)
            case "show": return try document.show(arguments)
            case "at": return try document.at(arguments)
            default: throw PuppetVerbRefusal(404, "the native editor has no query \(command)")
            }
        }

        func reply(_ command: String, arguments: [String: Any]) -> PuppetReply {
            do {
                return (200, PuppetServerContract.json(try query(command, arguments: arguments)))
            } catch let e as PuppetVerbRefusal {
                return PuppetServerContract.refusal(e.status, e.message)
            } catch {
                return PuppetServerContract.refusal(500, "native editor query failed: \(error)")
            }
        }
    }
#endif
