#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    // Seeded random sequences of the input-shape suite's UITextInput calls, mixed with Enter,
    // toolbar commands, undo, redo, paste and cut, on a note holding every block kind
    // (TextFirstRandomInput.swift). After every operation (TextFirstRandomRun.swift) the view's
    // text and selection must equal the engine's, the divergence check stays silent, the engine
    // holds no composition the view does not, and no engine call was refused. An engine refusal
    // that is an open next-steps item is recorded as a known issue and stepped over.
    //
    // A failing seed prints its operations, shortened to the fewest that still fail, as a Swift
    // literal: paste it into `RandomInputRows` as a named row. Explore other seeds with
    //   TEST_RUNNER_FUTO_RANDOM_FIRST=301 TEST_RUNNER_FUTO_RANDOM_SEEDS=500 \
    //     TEST_RUNNER_FUTO_RANDOM_OPS=150 just test-ios-native TextFirstRandomInputTests

    /// Shortened sequences the random runs found, each kept as its own test.
    struct RandomInputRow: Sendable, CustomTestStringConvertible {
        let name: String
        let ops: [RandomOp]
        /// The next-steps item that owns the fix, while the bug is open.
        var knownIssue: String?
        var testDescription: String { name }
    }

    enum RandomInputRows {
        static let all: [RandomInputRow] = [
            // Fixed in this lane: a refused commit left the engine composing, and every later
            // key was taken as committing it and refused too (the editor stopped taking input).
            RandomInputRow(
                name: "a refused composition commit does not leave the engine composing",
                ops: [
                    .input(.select(2, 108), .keyboard),
                    .compose(["k", "か"], .unmark, .keyboard),
                    .input(.insert("日"), .keyboard),
                ]),
            // Fixed in this lane: after a refused edit the view kept the caret where the dropped
            // edit left it (here inside the emoji), so the next key named an invalid range.
            RandomInputRow(
                name: "a refused edit puts back the engine's selection",
                ops: [
                    .input(.replace(27, 44, "- "), .bare), .enter,
                    .input(.select(7, 20), .keyboard), .input(.insert("😀"), .keyboard),
                    .tool("code-block"), .input(.select(7, 44), .keyboard),
                    .input(.insert("w"), .keyboard), .enter,
                ]),
            // The rows below that once carried a next-steps item pass on the core (#423).
            RandomInputRow(
                name: "typing over a selection from a paragraph into a list",
                ops: [.input(.select(69, 108), .keyboard), .input(.insert("."), .keyboard)]),
            RandomInputRow(
                name: "Enter over a selection from a paragraph into a list",
                ops: [.input(.select(69, 108), .keyboard), .enter]),
            RandomInputRow(
                name: "pasting over a selection from a paragraph into a list",
                ops: [.input(.select(69, 108), .keyboard), .paste("plain")]),
            // Fixed in the engine (a selection across a code block's boundary keeps the code
            // lines it leaves; docs/spec/editor/portable-core/interpretation-and-input.md).
            RandomInputRow(
                name: "typing over a selection that ends inside a code block",
                ops: [.input(.select(71, 176), .keyboard), .input(.insert("d"), .keyboard)]),
            RandomInputRow(
                name: "Enter over a selection that ends inside a code block",
                ops: [.input(.select(71, 176), .keyboard), .enter]),
            RandomInputRow(
                name: "Backspace over a selection that ends inside a code block",
                ops: [.input(.select(71, 176), .keyboard), .input(.backspace, .keyboard)]),
            RandomInputRow(
                name: "pasting over a selection that ends inside a code block",
                ops: [.input(.select(71, 176), .keyboard), .paste("plain")]),
            RandomInputRow(
                name: "a composition committed over a selection that ends inside a code block",
                ops: [
                    .input(.select(71, 176), .keyboard),
                    .compose(["k", "か"], .unmark, .keyboard),
                ]),
            RandomInputRow(
                name: "cutting a selection that ends inside a code block",
                ops: [.input(.select(71, 176), .keyboard), .cut]),
            // A key over a selection goes to the text service's replacement, which keeps a
            // letter the selection holds ("e" of "text") as a run of its own; the run after it
            // ended at the code line's end and took that line's break (re-check R1 of !634).
            // The ops make R1's note: the suite note (display 246) cut, R1's bytes pasted,
            // the heading the cut left turned back into text.
            RandomInputRow(
                name: "typing a letter the selection holds over prose and a code line",
                ops: [
                    .input(.select(0, 246), .keyboard), .cut,
                    .paste("Some text\n\n```\nlet value = 1\nreturn value\n```\n"),
                    .input(.select(0, 0), .keyboard), .input(.backspace, .keyboard),
                    .input(.select(5, 24), .keyboard), .input(.insert("e"), .keyboard),
                ]),
            // Fixed by main's engine (merged into ios-text-first 2026-11-09).
            RandomInputRow(
                name: "pasting a link after a collapsed Bold at a line start",
                ops: [.tool("bold"), .paste("[l](https://e.x)")]),
            // Fixed by main's engine (merged into ios-text-first 2026-11-09).
            RandomInputRow(
                name: "pasting two lines right after a pasted link",
                ops: [.paste("[l](https://e.x)"), .paste("line1\nline2")]),
            // Fixed in the engine along with the selections above: the Backspace deletes the
            // blank line's break, and the block's first line joins it as a quote's does.
            RandomInputRow(
                name: "Backspace at a code block's first line below a blank line",
                ops: [.enter, .tool("code-block"), .input(.backspace, .keyboard)]),
            RandomInputRow(
                name: "Backspace on the line an Enter split out of a link",
                ops: [
                    .input(.select(55, 151), .keyboard), .enter,
                    .input(.insert(" "), .keyboard), .input(.backspace, .keyboard),
                ]),
            // Fixed by main's engine (merged into ios-text-first 2026-11-09).
            RandomInputRow(
                name: "Enter in a task item holding a pasted code block",
                ops: [.tool("task-list"), .paste("```\ncode\n```"), .enter]),
            RandomInputRow(
                name: "Enter after Backspace in a numbered item holding a pasted quote",
                ops: [
                    .tool("ordered-list"), .paste("> q"), .input(.backspace, .keyboard), .enter,
                ]),
            RandomInputRow(
                name: "dictation after a list marker typed over a selection",
                ops: [
                    .input(.dictation([" spoken", " words"]), .keyboard),
                    .input(.replace(32, 46, "1. "), .keyboard),
                    .input(.dictation([" spoken", " words"]), .keyboard),
                ]),
            RandomInputRow(
                name: "replacing a word below a task item holding a pasted code block",
                ops: [
                    .tool("task-list"), .enter, .enter, .paste("```\ncode\n```"),
                    .input(.replace(48, 52, "hello"), .keyboard),
                ]),
            RandomInputRow(
                name: "pasting a list at the start of a table row",
                ops: [.input(.select(203, 203), .keyboard), .paste("- a\n- b")]),
            RandomInputRow(
                name: "Enter over a list item's line break before lazy text",
                ops: [
                    .input(.select(0, 12), .keyboard), .tool("ordered-list"),
                    .input(.insert("é"), .bare), .input(.insert(" "), .keyboard),
                    .input(.select(1, 3), .keyboard), .enter,
                ]),
            RandomInputRow(
                name: "a composition committed at a caret after an undo",
                ops: [
                    .input(.select(31, 42), .keyboard), .input(.insert("u"), .keyboard),
                    .input(.insert("-"), .keyboard), .input(.insert("the"), .keyboard), .undo,
                    .input(.insert("😀"), .keyboard), .input(.select(40, 40), .keyboard),
                    .input(.backspace, .keyboard), .compose(["k"], .unmark, .keyboard),
                ]),
        ]

        /// The open bug (a next-steps item) a failed check is an instance of, if any. Each is an
        /// engine refusal: the editor shows the engine's text again, so the run goes on.
        static func knownIssue(
            _ failure: RandomRun.Failure, _ before: (text: String, target: NSRange),
            _ op: RandomOp
        ) -> String? {
            // Only the engine's own refusal of a well-formed call. A stale revision, a composition
            // left open, or a range that splits a character is the host's bug and never known.
            guard failure.kind == "refused", let first = failure.refusals.first else { return nil }
            let text = before.text as NSString
            func boundary(_ p: Int) -> Bool {
                p == text.length || text.rangeOfComposedCharacterSequence(at: p).location == p
            }
            // InvalidRange only in the two shapes the engine itself answers so (reproduced in Rust);
            // the host's own mismatch is `ReconcileMismatch`, never this.
            if failure.refusals == ["paste: InvalidRange"]
                || failure.refusals == ["paragraph key: InvalidRange"]
            {
                let t = before.target
                let shape: Bool
                switch op {
                case .paste: shape = first.hasPrefix("paste:")
                case .enter: shape = first.hasPrefix("paragraph key:")
                default: shape = false
                }
                return shape && boundary(t.location) && boundary(NSMaxRange(t)) ? invalidRange : nil
            }
            guard failure.refusals.allSatisfy({ $0.hasSuffix(": UnrepresentableFormat") }) else {
                return nil
            }
            let context = first.prefix { $0 != ":" }
            let caret = before.target.length == 0
            let replaced = text.substring(with: before.target)
            switch op {
            case .input(.backspace, _) where caret:
                return context == "paragraph key" ? backspace : nil
            case .input(.insert, _), .input(.dictation, _), .input(.replace, _),
                .input(.replaceBefore, _), .input(.backspace, _), .compose, .enter, .paste, .cut:
                if replaced.contains("\n") { return crossBlock }
            default:
                return nil
            }
            switch (op, context) {
            case (.paste, "paste"): return paste
            case (.compose, "commit") where caret: return commit
            case (.input(.insert, _), "input") where caret,
                (.input(.dictation, _), "input") where caret,
                (.enter, "paragraph key") where caret:
                return atCaret
            case (.input(.replace, _), "input") where !caret,
                (.input(.replaceBefore, _), "input") where !caret,
                (.input(.insert, _), "input") where !caret,
                (.input(.backspace, _), "input") where !caret:
                return word
            default: return nil
            }
        }

        static let crossBlock =
            "next-steps 3: replacing a selection from a heading or paragraph into a list is refused about half the time, and one across a code block where the edit would change a line outside it (or leave a closed code block as the note's last block)"
        static let paste =
            "next-steps 3: some pastes are refused (a link after a collapsed Bold at a line start or beside a heading's inline spans; two lines after a link)"
        static let backspace =
            "next-steps 3: Backspace at a caret is refused on a line an Enter split out of a link"
        static let atCaret =
            "next-steps 3: a key, Enter or dictation at a caret is refused (seen in a list item holding a pasted code block or quote, and after a list marker typed over a selection)"
        static let word =
            "next-steps 3: replacing or deleting text inside one line is refused (a text service's word replacement, or a key or Backspace over a selection; seen near formatting and below a task item holding a pasted code block)"
        static let invalidRange =
            "next-steps 3: the engine answers InvalidRange for a valid range (paste at a table row's edge; Enter over a list item's line break before lazy text)"
        static let commit =
            "next-steps 3: a composition committed at a caret after an undo is refused (iOS sequence only; no engine repro yet)"
    }

    @Suite @MainActor
    struct TextFirstRandomInputTests {
        @Test(arguments: RandomInput.seeds)
        func randomSequence(_ seed: UInt64) {
            let ops = RandomInput.ops(seed: seed, count: RandomInput.opsPerSeed)
            let outcome = RandomRun.run(ops)
            for (issue, example) in outcome.known.sorted(by: { $0.key < $1.key }) {
                withKnownIssue(Comment(rawValue: issue)) {
                    Issue.record("seed \(seed): \(example)")
                }
            }
            guard let failure = outcome.failure else { return }
            let (short, steps) = RandomRun.shorten(ops, kind: failure.kind)
            Issue.record(
                """
                seed \(seed): \(failure)
                shortened to \(steps.count) operations: \(short)
                [\(steps.map(\.description).joined(separator: ",\n "))]
                """)
        }

        @Test func keyboardWindowPreservesTableDelimitersAfterFocusChanges() {
            let activator = RandomRun()
            let restoreActivator = activator.focusWindow()
            restoreActivator()
            var run = RandomRun()
            let restoreWindow = run.focusWindow()
            defer { restoreWindow() }
            #expect(run.h.window.isKeyWindow)
            // This sequence rewrote unrelated --- delimiters to U+2014 when the fixture
            // inherited keyboard traits from the app's key window instead of its editor.
            let ops = RandomInput.ops(seed: 23, count: RandomInput.opsPerSeed)
            for (index, op) in ops.prefix(10).enumerated() {
                run.apply(op)
                if let failure = run.check(step: index + 1) {
                    Issue.record(Comment(rawValue: failure.description))
                }
            }
            #expect(run.h.source.contains("|---|---|"))
        }

        /// A row with `knownIssue` must still fail (the item is open); any other row must pass
        /// apart from the known refusals it steps over.
        @Test(arguments: RandomInputRows.all)
        func foundSequence(_ row: RandomInputRow) {
            let outcome = RandomRun.run(row.ops)
            if let issue = row.knownIssue {
                withKnownIssue(Comment(rawValue: issue)) {
                    for found in outcome.known.values { Issue.record(Comment(rawValue: found)) }
                    if let failure = outcome.failure { Issue.record("\(failure)") }
                }
                return
            }
            for (issue, example) in outcome.known.sorted(by: { $0.key < $1.key }) {
                withKnownIssue(Comment(rawValue: issue)) {
                    Issue.record(Comment(rawValue: example))
                }
            }
            if let failure = outcome.failure { Issue.record("\(failure)") }
        }
    }
#endif
