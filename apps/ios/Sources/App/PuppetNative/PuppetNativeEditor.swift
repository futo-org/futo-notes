#if DEBUG
    import UIKit

    /// Debug inspection of the native renderer. It borrows the screen's controller; it never
    /// owns an editor attachment. Reads run only on request.
    @MainActor
    final class PuppetNativeEditor {
        static let shared = PuppetNativeEditor()
        weak var controller: TextFirstEditorController?
        private var title: (() -> String)?
        var clipboard: String?
        var snapshotId = 0
        var pendingTrace: Snapshot?
        var lastTrace: [String: Any]?
        /// The controller and range of puppet's own last `Select`: the one selection whose
        /// direction is known (forward). Any other non-empty selection reports `"unknown"`.
        weak var selectedBy: TextFirstEditorController?
        var selectedRange: NSRange?
        /// The controller's `selectionChanges` once that `Select` settled: any later change,
        /// even back to the same range, means puppet no longer knows the direction.
        var selectedAt = 0

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
                "selection": selection(c).merging([
                    "text": String(selected.prefix(80)),
                    "line": line.number, "col": range.location - line.range.location + 1,
                    "formats": Array(active).sorted(),
                ]) { _, new in new },
                "find": [
                    "open": c.findModel.visible, "query": c.findModel.query,
                    "current": c.findModel.current, "total": c.findModel.total,
                ],
                "clipboard": clipboard.map { String($0.prefix(80)) } ?? NSNull(),
                "canUndo": !disabled.contains("undo"), "canRedo": !disabled.contains("redo"),
                "blockDrag": blockDrag(c, document) ?? NSNull(),
                // A drag's live preview (or a drop settling under it) covers the note.
                "dragPreview": c.blockDrag?.preview?.isOpen == true || c.reflowLanding != nil,
                // How long the last drop's preview covered the note after the release.
                "lastLanding": c.lastLanding ?? NSNull(),
                // The scroll offset and the offset of the note's foot (#449 review).
                "scroll": [
                    "y": Double(c.textView.contentOffset.y),
                    "foot": Double(
                        c.textView.contentSize.height + c.textView.adjustedContentInset.bottom
                            - c.textView.bounds.height),
                ],
            ]
        }

        /// The block drag in progress, so a test can hold a real finger and still see where a
        /// release would land: the display line it lifted, how it shows the move (`preview`:
        /// "reflow" or "dropLine"), the slot a release lands on (`lands`: the line it would land
        /// above, or the note's end; null for none), and what is drawn, in screen points: the
        /// drop line's y (null while hidden, and always with the preview), the card, the
        /// scroll, and the preview's gap (`reflow`: whether its curtain shows and where the
        /// copy of the block is drawn); the slot ticks so far (`ticks`) and the autoscroll's
        /// cost over its last second (`autoscroll`, `TextFirstDragMeter`).
        private func blockDrag(_ c: TextFirstEditorController, _ document: Document)
            -> [String: Any]?
        {
            guard let drag = c.blockDrag, let window = c.textView.window else { return nil }
            let lands: Any =
                drag.slot.map { slot -> [String: Any] in
                    slot.end ? ["end": true] : ["before": document.line(at: slot.offset).number]
                } ?? NSNull()
            let screen = window.screen.coordinateSpace
            // Where the slot a release lands on is laid out now, read in this same request.
            let landsY: Any =
                drag.slot.flatMap { slot in
                    c.laidOutRange().flatMap { c.boundaryY(slot, in: $0) }
                }.map { Double(c.textView.convert(CGPoint(x: 0, y: $0), to: screen).y) }
                ?? NSNull()
            let reflow: Any =
                drag.preview.map { preview -> [String: Any] in
                    [
                        "open": preview.isOpen,
                        "copy": Document.box(c.textView.convert(preview.copyFrame, to: screen)),
                    ]
                } ?? NSNull()
            return [
                "line": document.line(at: drag.lift.block.location).number,
                "preview": drag.preview == nil ? "dropLine" : "reflow", "lands": lands,
                "dropLine": drag.preview == nil ? lands : NSNull(),
                "dropLineY": drag.dropLine.isHidden
                    ? NSNull() : Double(c.textView.convert(drag.dropLine.center, to: screen).y),
                "card": Document.box(c.textView.convert(drag.card.frame, to: screen)),
                "scrollY": Double(c.textView.contentOffset.y), "reflow": reflow,
                "landsY": landsY, "ticks": c.dragHaptics.ticks,
                "autoscroll": drag.autoscroller.meter.report,
                "previewUnavailable": drag.previewUnavailable ?? NSNull(),
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
