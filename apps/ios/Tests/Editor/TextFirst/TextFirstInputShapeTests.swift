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

    /// One UITextInput call, as a keyboard or a system text service makes it.
    enum InputCall: Sendable {
        case select(Int, Int)
        case insert(String)  // insertText
        /// setMarkedText; `whole` = the clause is selected (a conversion candidate).
        case mark(String, whole: Bool = false)
        case unmark  // unmarkText
        case replace(Int, Int, String)  // replace(_:withText:)
        /// replace(_:withText:) over the n characters before the caret.
        case replaceBefore(Int, String)
        case backspace  // deleteBackward
        /// insertDictationResultPlaceholder, the result, removeDictationResultPlaceholder.
        case dictation([String])
        case dictationRemoveFirst([String])  // placeholder, remove(willInsertResult: true), result
        case textPlaceholder(String)  // insertTextPlaceholder(with:), remove(_:), insertText
    }

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

    enum Asking: Sendable, CaseIterable { case keyboard, bare }

    /// A dictation result phrase (UIKit only hands these out; the test makes its own).
    private final class Phrase: UIDictationPhrase {
        private let value: String
        init(_ value: String) {
            self.value = value
            super.init()
        }
        override var text: String { value }
    }

    /// Makes `InputCall`s on a view as the keyboard (delegate asked first) or a bare system
    /// service would. The random input suite drives the same calls.
    @MainActor
    struct InputDriver {
        let asking: Asking

        private func nsRange(_ tv: UITextView, _ a: Int, _ b: Int) -> UITextRange {
            tv.textRange(
                from: tv.position(from: tv.beginningOfDocument, offset: a)!,
                to: tv.position(from: tv.beginningOfDocument, offset: b)!)!
        }

        /// The range a keyboard names when it asks the delegate: the marked text, else the selection.
        private func current(_ tv: UITextView) -> NSRange {
            guard let m = tv.markedTextRange else { return tv.selectedRange }
            let s = tv.offset(from: tv.beginningOfDocument, to: m.start)
            return NSRange(location: s, length: tv.offset(from: m.start, to: m.end))
        }

        /// True when UIKit goes on to insert (the delegate may take the key itself, as Enter is).
        @discardableResult
        func ask(_ tv: UITextView, _ range: NSRange, _ text: String) -> Bool {
            guard asking == .keyboard else { return true }
            return tv.delegate?.textView?(tv, shouldChangeTextIn: range, replacementText: text)
                ?? true
        }

        /// The result as UIKit's dictation delivers it: through insertDictationResult(_:) when the
        /// view has one (UITextView has none, and calling it raises), else insertText of the phrases.
        private func insertResult(_ phrases: [String], _ tv: UITextView) {
            guard tv.responds(to: #selector(UITextInput.insertDictationResult(_:))) else {
                if ask(tv, current(tv), phrases.joined()) { tv.insertText(phrases.joined()) }
                return
            }
            tv.insertDictationResult(phrases.map(Phrase.init))
        }

        func apply(_ call: InputCall, to tv: UITextView) {
            switch call {
            case .select(let a, let b):
                tv.selectedRange = NSRange(location: a, length: b - a)
            case .insert(let t):
                if ask(tv, current(tv), t) { tv.insertText(t) }
            case .mark(let t, let whole):
                ask(tv, current(tv), t)
                let n = (t as NSString).length
                tv.setMarkedText(
                    t,
                    selectedRange: whole
                        ? NSRange(location: 0, length: n) : NSRange(location: n, length: 0))
            case .unmark:
                tv.unmarkText()
            case .replace(let a, let b, let t):
                if ask(tv, NSRange(location: a, length: b - a), t) {
                    tv.replace(nsRange(tv, a, b), withText: t)
                }
            case .replaceBefore(let n, let t):
                let caret = tv.selectedRange.location
                if ask(tv, NSRange(location: caret - n, length: n), t) {
                    tv.replace(nsRange(tv, caret - n, caret), withText: t)
                }
            case .backspace:
                tv.deleteBackward()
            case .dictation(let phrases):
                let p: Any = tv.insertDictationResultPlaceholder
                insertResult(phrases, tv)
                tv.removeDictationResultPlaceholder(p, willInsertResult: false)
            case .dictationRemoveFirst(let phrases):
                let p: Any = tv.insertDictationResultPlaceholder
                tv.removeDictationResultPlaceholder(p, willInsertResult: true)
                insertResult(phrases, tv)
            case .textPlaceholder(let t):
                let p = tv.insertTextPlaceholder(with: CGSize(width: 40, height: 20))
                tv.remove(p)
                if ask(tv, current(tv), t) { tv.insertText(t) }
            }
        }
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
                name: "dictation into a list item", before: "- item", caret: 4,
                calls: [.dictation([" more"])], source: "- item more"),
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
