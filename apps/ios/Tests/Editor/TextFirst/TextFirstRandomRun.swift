#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// One fresh editor driven through a list of operations, checked after each.
    @MainActor
    struct RandomRun {
        let h = RandomInput.harness()
        /// The operations as applied, offsets reduced to the text they met.
        var applied: [RandomOp] = []
        /// The view's text before the latest operation, and the range that operation replaces
        /// (the selection, unless it names a range of its own).
        var before = (text: "", target: NSRange(location: 0, length: 0))
        /// The note's source before the latest operation (an engine repro needs the bytes).
        var beforeSource = ""
        /// Known issues met and stepped over (the engine's text was shown again), by item.
        var known: [String: String] = [:]

        /// A failed check: `kind` groups failures for shortening (the same bug, not any bug).
        struct Failure: Error, CustomStringConvertible {
            let kind: String
            let detail: String
            let step: Int
            var before = ""
            /// The refused calls, as `recover` recorded them ("context: error").
            var refusals: [String] = []
            var description: String { "\(kind) after step \(step): \(detail)\(before)" }
        }

        private var text: NSString { (h.tv.text ?? "") as NSString }

        /// A caret stop: a composed character's start, inside the text.
        private func stop(_ raw: Int) -> Int {
            let length = text.length
            let p = raw % (length + 1)
            return p < length ? text.rangeOfComposedCharacterSequence(at: p).location : p
        }

        private func resolve(_ call: InputCall) -> InputCall {
            switch call {
            case .select(let a, let b):
                let (x, y) = (stop(a), stop(b))
                return .select(min(x, y), max(x, y))
            case .replace(let a, let b, let t):
                let (x, y) = (stop(a), stop(b))
                return .replace(min(x, y), max(x, y), t)
            case .replaceBefore(let n, let t):
                // `n` UTF-16 units back, widened to a character's start (a resolved call is unchanged).
                let caret = h.tv.selectedRange.location
                var start = max(0, caret - n)
                if start < caret {
                    start = text.rangeOfComposedCharacterSequence(at: start).location
                }
                return .replaceBefore(caret - start, t)
            default:
                return call
            }
        }

        mutating func apply(_ op: RandomOp) {
            let tv = h.tv
            before = (tv.text ?? "", tv.selectedRange)
            beforeSource = (try? h.controller.session.sourceText()) ?? ""
            switch op {
            case .input(let call, let asking):
                let call = resolve(call)
                applied.append(.input(call, asking))
                if case .replace(let a, let b, _) = call {
                    before.target = NSRange(location: a, length: b - a)
                } else if case .replaceBefore(let n, _) = call {
                    before.target = NSRange(location: tv.selectedRange.location - n, length: n)
                }
                if case .replaceBefore(0, _) = call { return }
                InputDriver(asking: asking).apply(call, to: tv)
            case .compose(let marks, let end, let asking):
                applied.append(op)
                let driver = InputDriver(asking: asking)
                for (i, mark) in marks.enumerated() {
                    // A converted candidate is shown selected.
                    let whole =
                        i == marks.count - 1
                        && (0x4E00...0x9FFF).contains(mark.unicodeScalars.first!.value)
                    driver.apply(.mark(mark, whole: whole), to: tv)
                }
                switch end {
                case .unmark: driver.apply(.unmark, to: tv)
                case .commit(let word): driver.apply(.insert(word), to: tv)
                case .cancel:
                    driver.apply(.mark(""), to: tv)
                    driver.apply(.unmark, to: tv)
                }
            case .enter:
                applied.append(op)
                InputDriver(asking: .keyboard).apply(.insert("\n"), to: tv)
            case .tool(let id):
                applied.append(op)
                h.controller.toolbar(ToolbarSpec.groups.flatMap { $0 }.first { $0.id == id }!)
            case .undo:
                applied.append(op)
                tv.undoManager?.undo()
            case .redo:
                applied.append(op)
                tv.undoManager?.redo()
            case .paste(let text):
                applied.append(op)
                UIPasteboard.general.string = text
                tv.paste(nil)
            case .cut:
                applied.append(op)
                if tv.selectedRange.length > 0 { tv.cut(nil) }
            }
        }

        func check(step: Int) -> Failure? {
            let c = h.controller
            let context =
                "\n  before: target \(before.target) in \(before.text.debugDescription)"
                + "\n  source: \(beforeSource.debugDescription)"
            if !c.divergences.isEmpty {
                return Failure(
                    kind: "divergence",
                    detail:
                        "\(c.divergences)\n  view: \((h.tv.text ?? "").debugDescription)\n  engine: \(((try? c.session.displayText()) ?? "<none>").debugDescription)",
                    step: step, before: context)
            }
            // After a refusal the editor must still agree with the engine; those checks come first.
            if h.tv.markedTextRange == nil, let failure = agreement(step: step, context: context) {
                return failure
            }
            if !c.recoveries.isEmpty {
                return Failure(
                    kind: "refused", detail: "\(c.recoveries)", step: step, before: context,
                    refusals: c.recoveries)
            }
            return nil
        }

        /// The view's text and selection are the engine's, and only the view's marked text can
        /// leave the engine composing.
        private func agreement(step: Int, context: String) -> Failure? {
            let c = h.controller
            if h.isComposing {
                return Failure(
                    kind: "composing", detail: "the engine composes; the view has no marked text",
                    step: step, before: context)
            }
            let engine = (try? c.session.displayText()) ?? "<no display>"
            let view = h.tv.text ?? ""
            if view != engine {
                return Failure(
                    kind: "text",
                    detail: "view \(view.debugDescription)\n  engine \(engine.debugDescription)",
                    step: step, before: context)
            }
            if h.tv.selectedRange != c.engineSelection {
                return Failure(
                    kind: "selection",
                    detail:
                        "view \(h.tv.selectedRange) engine \(c.engineSelection) in \(view.debugDescription)",
                    step: step, before: context)
            }
            return nil
        }

        /// What a run met: the first failed check that is not a known issue (with the
        /// operations up to it), and the known issues stepped over on the way.
        struct Outcome {
            var failure: Failure?
            var ops: [RandomOp] = []
            var known: [String: String] = [:]
        }

        /// UITextInput's keyboard traits belong to the key window. With a non-key fixture,
        /// UIKit can use another field's default typography and rewrite existing Markdown.
        func focusWindow() -> () -> Void {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .first
            let previous = scene?.windows.first(where: \.isKeyWindow)
            if let scene { h.window.windowScene = scene }
            h.window.makeKeyAndVisible()
            _ = h.tv.becomeFirstResponder()
            return { [h] in
                h.tv.resignFirstResponder()
                h.window.isHidden = true
                previous?.makeKey()
            }
        }

        /// Run `ops` on a fresh editor. A known refusal is noted and stepped over: the editor has
        /// already shown the engine's text again.
        static func run(_ ops: [RandomOp]) -> Outcome {
            var run = RandomRun()
            let restoreWindow = run.focusWindow()
            defer { restoreWindow() }
            if let failure = run.check(step: 0) { return Outcome(failure: failure) }
            for (i, op) in ops.enumerated() {
                run.apply(op)
                guard let failure = run.check(step: i + 1) else { continue }
                guard let issue = RandomInputRows.knownIssue(failure, run.before, op) else {
                    return Outcome(failure: failure, ops: run.applied, known: run.known)
                }
                run.known[issue] = run.known[issue] ?? "\(failure)"
                run.h.controller.recoveries.removeAll()
            }
            return Outcome(ops: run.applied, known: run.known)
        }

        /// Drop operations while the same kind of failure remains (delta debugging), within a
        /// budget of replays.
        static func shorten(_ ops: [RandomOp], kind: String, budget: Int = 400) -> (
            Failure, [RandomOp]
        ) {
            let first = run(ops)
            var best = (first.failure!, first.ops)
            var replays = 0
            var chunk = max(1, best.1.count / 2)
            while chunk >= 1, replays < budget {
                var start = 0
                var removed = false
                while start < best.1.count, replays < budget {
                    var candidate = best.1
                    candidate.removeSubrange(start..<min(start + chunk, candidate.count))
                    replays += 1
                    let outcome = run(candidate)
                    if let failure = outcome.failure, failure.kind == kind {
                        best = (failure, outcome.ops)
                        removed = true
                    } else {
                        start += chunk
                    }
                }
                if !removed { chunk /= 2 }
            }
            return best
        }
    }
#endif
