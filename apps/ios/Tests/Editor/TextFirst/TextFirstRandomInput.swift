#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    // The operations the random input suite drives (TextFirstRandomInputTests.swift) and the
    // seeded generator that picks them.

    /// How a composition ends.
    enum CompositionEnd: Sendable {
        case unmark
        case commit(String)  // insertText of a candidate
        case cancel  // the marked text deleted, then unmarked
    }

    /// One operation. Offsets are reduced to the text at the time (`RandomRun.resolve`), so any
    /// subsequence of a failing run still replays.
    enum RandomOp: Sendable, CustomStringConvertible {
        case input(InputCall, Asking)
        case compose([String], CompositionEnd, Asking)
        case enter
        case tool(String)
        case undo
        case redo
        case paste(String)
        case cut

        var description: String {
            switch self {
            case .input(let call, let asking): ".input(\(Self.literal(call)), .\(asking))"
            case .compose(let marks, let end, let asking):
                ".compose(\(marks.debugDescription), \(Self.literal(end)), .\(asking))"
            case .enter: ".enter"
            case .tool(let id): ".tool(\(id.debugDescription))"
            case .undo: ".undo"
            case .redo: ".redo"
            case .paste(let text): ".paste(\(text.debugDescription))"
            case .cut: ".cut"
            }
        }

        private static func literal(_ end: CompositionEnd) -> String {
            switch end {
            case .unmark: ".unmark"
            case .commit(let t): ".commit(\(t.debugDescription))"
            case .cancel: ".cancel"
            }
        }

        private static func literal(_ call: InputCall) -> String {
            switch call {
            case .select(let a, let b): ".select(\(a), \(b))"
            case .insert(let t): ".insert(\(t.debugDescription))"
            case .mark(let t, let whole): ".mark(\(t.debugDescription), whole: \(whole))"
            case .unmark: ".unmark"
            case .replace(let a, let b, let t): ".replace(\(a), \(b), \(t.debugDescription))"
            case .replaceBefore(let n, let t): ".replaceBefore(\(n), \(t.debugDescription))"
            case .backspace: ".backspace"
            case .dictation(let p): ".dictation(\(p.debugDescription))"
            case .dictationRemoveFirst(let p): ".dictationRemoveFirst(\(p.debugDescription))"
            case .textPlaceholder(let t): ".textPlaceholder(\(t.debugDescription))"
            }
        }
    }

    /// SplitMix64: a fixed seed gives the same operations on every machine.
    struct SeededGenerator: RandomNumberGenerator {
        private var state: UInt64
        init(_ seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    enum RandomInput {
        /// Every block kind: headings, lists (nested), a task list, a quote, a code block, a
        /// table, an image, a link and a wikilink.
        static let note = """
            # Heading one

            Intro with **bold**, *italic*, ~~strike~~, `code`, a [link](https://example.com) and [[Other note]].

            ## Lists

            - bullet one
            - bullet two
            \t- nested
            1. first
            2. second

            - [ ] task open
            - [x] task done

            > a quote
            > second line

            ```
            let x = 1
            ```

            | A | B |
            |---|---|
            | 1 | 2 |

            ![img](img.png)

            Tail paragraph.
            """

        @MainActor static func harness() -> TextFirstHarness {
            let h = TextFirstHarness(
                note, files: ["img.png": TextFirstHarness.png(60, 40)])
            h.controller.installToolbar(localization: Localization.system())
            return h
        }

        static let characters: [String] =
            Array("abcdefghijklmnopqrstuvwxyz").map(String.init)
            + [
                " ", " ", " ", "*", "_", "`", "#", "-", "[", "]", "(", ")", "|", ">", "!", "1",
                ".", "~", "\t", "日", "é", "😀", "한",
            ]
        static let words = ["hello", "the", "ok ", "**", "- ", "1. ", "> ", "# ", "[[", "]]"]
        static let pastes = [
            "plain", "**x**", "- a\n- b", "| a |\n| - |\n| b |", "`c`", "# H", "line1\nline2",
            "[l](https://e.x)", "[[Note]]", "```\ncode\n```", "> q",
        ]
        static let tools = [
            "bold", "italic", "strikethrough", "heading-1", "heading-2", "heading-3", "quote",
            "code-block", "bullet-list", "ordered-list", "task-list", "indent", "outdent",
        ]
        /// Marked-text runs real keyboards make (Japanese romaji to kanji, Korean jamo).
        static let compositions: [([String], String)] = [
            (["n", "に", "にh", "にほ", "にほn", "にほん", "日本"], "日本"),
            (["k", "か"], "か"),
            (["ㅎ", "하", "한"], "한"),
            (["ㄱ", "그", "글"], "글"),
        ]

        static func op<G: RandomNumberGenerator>(_ g: inout G) -> RandomOp {
            let asking: Asking = Int.random(in: 0..<5, using: &g) == 0 ? .bare : .keyboard
            let roll = Int.random(in: 0..<100, using: &g)
            let pos = { (g: inout G) in Int.random(in: 0..<10_000, using: &g) }
            switch roll {
            case 0..<30: return .input(.insert(characters.randomElement(using: &g)!), asking)
            case 30..<33: return .input(.insert(words.randomElement(using: &g)!), asking)
            case 33..<45: return .input(.backspace, .keyboard)
            case 45..<57:
                let a = pos(&g)
                let b = Int.random(in: 0..<4, using: &g) == 0 ? a : pos(&g)
                return .input(.select(a, b), .keyboard)
            case 57..<62:
                return .input(
                    .replace(pos(&g), pos(&g), words.randomElement(using: &g)!), asking)
            case 62..<65:
                return .input(
                    .replaceBefore(
                        Int.random(in: 1...3, using: &g), characters.randomElement(using: &g)!),
                    asking)
            case 65..<71:
                let (marks, word) = compositions.randomElement(using: &g)!
                let length = Int.random(in: 1...marks.count, using: &g)
                let end: CompositionEnd =
                    switch Int.random(in: 0..<3, using: &g) {
                    case 0: .unmark
                    case 1: .commit(word)
                    default: .cancel
                    }
                return .compose(Array(marks.prefix(length)), end, asking)
            case 71..<79: return .enter
            case 79..<88: return .tool(tools.randomElement(using: &g)!)
            case 88..<92: return .undo
            case 92..<94: return .redo
            case 94..<97: return .paste(pastes.randomElement(using: &g)!)
            case 97..<99: return .cut
            default: return .input(.dictation([" spoken", " words"]), asking)
            }
        }

        static func ops(seed: UInt64, count: Int) -> [RandomOp] {
            var g = SeededGenerator(seed)
            return (0..<count).map { _ in op(&g) }
        }

        static func environment(_ name: String) -> Int? {
            ProcessInfo.processInfo.environment[name].flatMap(Int.init)
        }

        /// Fixed seeds in the ordinary run; others with FUTO_RANDOM_FIRST and FUTO_RANDOM_SEEDS.
        static var seeds: [UInt64] {
            let first = UInt64(environment("FUTO_RANDOM_FIRST") ?? 1)
            return (0..<UInt64(environment("FUTO_RANDOM_SEEDS") ?? 24)).map { first + $0 }
        }
        static var opsPerSeed: Int { environment("FUTO_RANDOM_OPS") ?? 120 }
    }
#endif
