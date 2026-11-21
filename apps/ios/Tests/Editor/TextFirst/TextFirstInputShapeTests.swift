#if DEBUG
    import Testing
    import UIKit

    @testable import FutoNotesNative

    // C3b (docs/plan/text-first-editor-proof/claims.md): the UITextInput calls the simulator's
    // keyboard cannot make, sent straight to the text-first view. Every sequence also runs in a
    // control, a plain UITextView holding the same display text. The editor's display must end
    // equal to the control's text (or a row's listed conversion), the source must equal the
    // expected bytes, U+FFFC from a dictation placeholder must never reach the source, and the
    // divergence check stays silent. Each row runs twice: once with the delegate asked first, as
    // the keyboard (UIKeyboardImpl) does, and once with the bare UITextInput call, as a system
    // service that skips the delegate would make it.

    struct ShapeRow: Sendable, CustomTestStringConvertible {
        let name: String
        let before: String
        let caret: Int
        let calls: [InputCall]
        let source: String
        /// The editor's display when it differs from the control's on purpose (a conversion).
        var conversion: String?
        var testDescription: String { name }
    }

    @MainActor
    private struct ShapeRun {
        let h: TextFirstHarness
        let control: UITextView
        let driver: InputDriver
        var sourceSnapshots: [String] = []

        private let controlWindow: UIWindow
        private let caret: Int

        init(_ row: ShapeRow, _ asking: Asking) {
            h = TextFirstHarness(row.before)
            controlWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            control = UITextView(usingTextLayoutManager: true)
            control.frame = controlWindow.bounds
            control.text = h.tv.text
            controlWindow.addSubview(control)
            controlWindow.isHidden = false
            driver = InputDriver(asking: asking)
            caret = row.caret
        }

        /// The control first, then the editor: a composition must not see the other view take
        /// first responder (resigning commits marked text).
        mutating func run(_ calls: [InputCall]) {
            _ = control.becomeFirstResponder()
            control.selectedRange = NSRange(location: caret, length: 0)
            for call in calls { driver.apply(call, to: control) }
            _ = h.tv.becomeFirstResponder()
            h.select(caret, caret)
            for call in calls {
                driver.apply(call, to: h.tv)
                sourceSnapshots.append(h.source)
            }
        }
    }

    private let bold = "**bold** x"
    private let link = "[link](u) x"

    /// Japanese romaji: kana as typed, then Space converts the clause (the candidate is selected).
    private let romaji: [InputCall] = [
        .mark("n"), .mark("に"), .mark("にh"), .mark("にほ"), .mark("にほn"), .mark("にほん"),
        .mark("日本", whole: true), .mark("二本", whole: true), .mark("日本", whole: true),
    ]

    enum InputShapeRows {
        static let japanese: [ShapeRow] = [
            ShapeRow(
                name: "ja romaji to kanji, unmark, bold end", before: bold, caret: 4,
                calls: romaji + [.unmark], source: "**bold日本** x"),
            ShapeRow(
                name: "ja romaji to kanji, unmark, link end", before: link, caret: 4,
                calls: romaji + [.unmark], source: "[link日本](u) x"),
            ShapeRow(
                name: "ja candidate tapped (insertText), bold end", before: bold, caret: 4,
                calls: [.mark("に"), .mark("にほん"), .mark("日本", whole: true), .insert("日本")],
                source: "**bold日本** x"),
            ShapeRow(
                name: "ja candidate tapped (insertText), link end", before: link, caret: 4,
                calls: [.mark("に"), .mark("にほん"), .mark("日本", whole: true), .insert("日本")],
                source: "[link日本](u) x"),
            ShapeRow(
                name: "ja reconvert a committed word at a bold end", before: "**bold日本** x",
                caret: 6,
                calls: [.select(4, 6), .mark("にほん"), .mark("二本", whole: true), .unmark],
                source: "**bold二本** x"),
            ShapeRow(
                name: "ja reconvert a committed word after a link", before: "[link](u)日本 x",
                caret: 6,
                calls: [.select(4, 6), .mark("にほん"), .mark("二本", whole: true), .unmark],
                source: "[link](u)二本 x"),
            ShapeRow(
                name: "ja reconvert by candidate over the selection, bold end",
                before: "**bold日本** x", caret: 6,
                calls: [.select(4, 6), .insert("二本")], source: "**bold二本** x"),
            ShapeRow(
                name: "ja reconvert the whole bold word", before: "**日本** x", caret: 2,
                calls: [.select(0, 2), .mark("にほん"), .mark("二本", whole: true), .unmark],
                source: "**二本** x"),
            ShapeRow(
                name: "ja reconvert the whole link text", before: "[日本](u) x", caret: 2,
                calls: [.select(0, 2), .mark("にほん"), .mark("二本", whole: true), .unmark],
                source: "[二本](u) x"),
        ]

        /// 한글 and 하나 (the ㄴ moves to the next syllable), in the three shapes a Korean keyboard uses.
        static func korean(_ before: String, _ inBold: Bool) -> [ShapeRow] {
            let wrap = { (w: String) in inBold ? "**bold\(w)** x" : "[link\(w)](u) x" }
            let at = inBold ? "bold end" : "link end"
            return [
                ShapeRow(
                    name: "ko marked, each key replaces the marked syllable, \(at)", before: before,
                    caret: 4,
                    calls: [
                        .mark("ㅎ"), .mark("하"), .mark("한"), .insert("한"), .mark("ㄱ"), .mark("그"),
                        .mark("글"), .unmark,
                    ],
                    source: wrap("한글")),
                ShapeRow(
                    name: "ko marked, jamo moves to the next syllable, \(at)", before: before,
                    caret: 4,
                    calls: [.mark("ㅎ"), .mark("하"), .mark("한"), .insert("하"), .mark("나"), .unmark],
                    source: wrap("하나")),
                ShapeRow(
                    name: "ko unmarked, replace the last character, \(at)", before: before,
                    caret: 4,
                    calls: [
                        .insert("ㅎ"), .replaceBefore(1, "하"), .replaceBefore(1, "한"), .insert("ㄱ"),
                        .replaceBefore(1, "그"),
                        .replaceBefore(1, "글"),
                    ],
                    source: wrap("한글")),
                ShapeRow(
                    name: "ko unmarked, delete then insert, \(at)", before: before, caret: 4,
                    calls: [
                        .insert("ㅎ"), .backspace, .insert("하"), .backspace, .insert("한"),
                        .insert("ㄱ"), .backspace,
                        .insert("그"), .backspace, .insert("글"),
                    ],
                    source: wrap("한글")),
            ]
        }

        static let autocorrect: [ShapeRow] = [
            // The two emoji share a UTF-16 unit (the first, then the second): the change still
            // replaces whole characters, also when the service skips the delegate.
            ShapeRow(
                name: "a text service replaces an emoji sharing its first unit", before: "😀 x",
                caret: 2, calls: [.replace(0, 2, "😃")], source: "😃 x"),
            ShapeRow(
                name: "a text service replaces an emoji sharing its second unit", before: "🀀 x",
                caret: 2, calls: [.replace(0, 2, "🐀")], source: "🐀 x"),
            ShapeRow(
                name: "autocorrect a bold word at its end", before: "**teh** x", caret: 3,
                calls: [.replace(0, 3, "the")], source: "**the** x"),
            ShapeRow(
                name: "autocorrect a bold word, then the space", before: "**teh** x", caret: 3,
                calls: [.replace(0, 3, "the"), .insert(" ")], source: "**the**  x"),
            ShapeRow(
                name: "autocorrect then revert, bold", before: "**teh** x", caret: 3,
                calls: [.replace(0, 3, "the"), .replace(0, 3, "teh")], source: "**teh** x"),
            ShapeRow(
                name: "autocorrect a link text at its end", before: "[teh](u) x", caret: 3,
                calls: [.replace(0, 3, "the")], source: "[the](u) x"),
            ShapeRow(
                name: "autocorrect the end of a link text", before: "[teh](u) x", caret: 3,
                calls: [.replace(1, 3, "he")],
                source: "[the](u) x"),
            ShapeRow(
                name: "autocorrect a word after bold", before: "**bold** teh", caret: 8,
                calls: [.replace(5, 8, "the")], source: "**bold** the"),
            ShapeRow(
                name: "autocorrect a word after a link", before: "[link](u) teh", caret: 8,
                calls: [.replace(5, 8, "the")], source: "[link](u) the"),
        ]

        static let dictation: [ShapeRow] = [
            ShapeRow(
                name: "dictation result, bold end", before: bold, caret: 4,
                calls: [.dictation([" more", " words"])], source: "**bold more words** x"),
            ShapeRow(
                name: "dictation result, link end", before: link, caret: 4,
                calls: [.dictation([" more", " words"])], source: "[link more words](u) x"),
            ShapeRow(
                name: "dictation, placeholder removed first, bold end", before: bold, caret: 4,
                calls: [.dictationRemoveFirst([" more", " words"])], source: "**bold more words** x"
            ),
            ShapeRow(
                name: "dictation, placeholder removed first, link end", before: link, caret: 4,
                calls: [.dictationRemoveFirst([" more", " words"])],
                source: "[link more words](u) x"),
            ShapeRow(
                name: "dictation into a list item", before: "- item", caret: 5,
                calls: [.dictation([" more"])], source: "- item more"),
            // Typed text replaces a selected marker as typing over it does: the marker comes
            // off and the text starts the plain line. Dictation's own U+FFFC placeholder must
            // never be taken for the marker it replaces.
            ShapeRow(
                name: "typing over a selected list marker", before: "- one", caret: 0,
                calls: [.select(0, 1), .insert("x")], source: "xone"),
            ShapeRow(
                name: "dictation over a selected list marker", before: "- one", caret: 0,
                calls: [.select(0, 1), .dictation(["x"])], source: "xone"),
            ShapeRow(
                name: "dictation over a selected list marker, placeholder removed first",
                before: "- one", caret: 0,
                calls: [.select(0, 1), .dictationRemoveFirst(["x"])], source: "xone"),
            ShapeRow(
                name: "dictation over a selected task's box", before: "- [ ] one", caret: 0,
                calls: [.select(0, 1), .dictation(["x"])], source: "xone"),
            ShapeRow(
                name: "text placeholder, bold end", before: bold, caret: 4,
                calls: [.textPlaceholder(" more")], source: "**bold more** x"),
            ShapeRow(
                name: "text placeholder, link end", before: link, caret: 4,
                calls: [.textPlaceholder(" more")], source: "[link more](u) x"),
        ]

        /// What the keyboard sends with Smart Punctuation on but the view's smart quotes and dashes
        /// off: the literal characters. The conversions are the engine's (divider, table).
        static let smartPunctuation: [ShapeRow] = [
            ShapeRow(
                name: "--- alone on a line is a divider", before: "a\n\n", caret: 3,
                calls: "---".map { InputCall.insert(String($0)) },
                source: "a\n\n---", conversion: "a\n\n\u{fffc}"),
            ShapeRow(
                name: "|---|---| under a header is a table", before: "x", caret: 1,
                calls: "\n\n|a|b|\n|---|---|".map { InputCall.insert(String($0)) },
                source: "x\n\n|a|b|\n|---|---|",
                conversion: "x\n\n\u{fffc}"),
            ShapeRow(
                name: "quotes inside a code span stay straight", before: "", caret: 0,
                calls: "x `\"a\" 'b'` y".map { InputCall.insert(String($0)) },
                source: "x `\"a\" 'b'` y",
                conversion: "x \"a\" 'b' y"),
        ]

        static let all: [ShapeRow] =
            japanese + korean(bold, true) + korean(link, false) + autocorrect + dictation
            + smartPunctuation
    }

    @Suite @MainActor
    struct TextFirstInputShapeTests {
        @Test(arguments: InputShapeRows.all, Asking.allCases)
        func sequence(_ row: ShapeRow, _ asking: Asking) throws {
            var run = ShapeRun(row, asking)
            run.run(row.calls)
            let h = run.h
            let display = h.display
            let control = TextFirstHarness.trimmed(run.control.text ?? "")
            // Typing at a link's end lands inside the link: the engine's behavior on main
            // (interpretation-and-input.md). A typed `|---|` row makes a table in the engine, which
            // rewrites the rows it normalizes; the plain-UITextView control keeps what was typed, so
            // the two always differ. The table is drawn as a grid since M6.
            let engineShift = row.name.hasSuffix("is a table")
            withKnownIssue(
                "the engine normalizes a typed table; the control does not", isIntermittent: false
            ) {
                #expect(h.source == row.source, "source")
                #expect(
                    display == (row.conversion ?? control),
                    "display vs control \(control.debugDescription)")
            } when: {
                engineShift
            }
            #expect(h.tv.markedTextRange == nil && !h.isComposing)
            #expect(
                !run.sourceSnapshots.contains { $0.contains("\u{fffc}") },
                "U+FFFC reached the source")
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
            #expect(h.tv.text == (try h.controller.session.displayText()), "view vs engine display")
        }

        /// The keyboard applies Smart Punctuation only where the view asks for it: the text-first
        /// view asks for none, so `--` and quotes arrive as typed (the UI test proves it on the sim keyboard).
        @Test func theViewTurnsOffSmartPunctuation() {
            let h = TextFirstHarness("")
            #expect(h.tv.smartQuotesType == .no)
            #expect(h.tv.smartDashesType == .no)
        }
    }
#endif
