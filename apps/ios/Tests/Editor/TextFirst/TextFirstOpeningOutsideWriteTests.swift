#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Another writer changes a long note while it opens (#392). Input made on the first screens
    /// applies to the text it was made on, never to text the user did not see, and the outside
    /// version is kept: merged into the note, or the note keeps it and a conflict copy keeps the
    /// draft (docs/spec/editor/portable-core/recovery.md).
    /// Typed text is Greek, which neither the note nor the outside write holds.
    @Suite @MainActor
    struct TextFirstOpeningOutsideWriteTests {
        typealias Opening = TextFirstOpeningTests.Opening

        struct Raced {
            /// The raced editor's draft once its engine landed.
            let draft: String
            /// The same input on an untouched open: what the draft must be.
            let control: String
            /// Every note in the raced vault after its editor closed, by file name.
            let files: [String: String]
        }

        /// Opens `source` the long way twice with the same input: once untouched, once with
        /// `before` written to the file before the engine's open and `after` once it opened but
        /// before it attached. Closes the raced editor and reads its vault.
        static func race(
            _ source: String, before: [String], after: String? = nil, _ act: (Opening) -> Void
        ) async throws -> Raced {
            let control = try Opening(source)
            act(control)
            try control.land()
            let expected = try control.controller.session.sourceText()
            _ = await control.controller.close()

            let o = try Opening(source)
            act(o)
            for text in before { try o.write(text) }
            try o.land { if let after { try o.write(after) } }
            let draft = try o.controller.session.sourceText()
            #expect(o.tv.text == (try o.controller.session.displayText()))
            _ = await o.controller.close()
            var files: [String: String] = [:]
            for name in try FileManager.default.contentsOfDirectory(atPath: o.root.path)
            where name.hasSuffix(".md") {
                files[name] = try String(
                    contentsOf: o.root.appendingPathComponent(name), encoding: .utf8)
            }
            return Raced(draft: draft, control: expected, files: files)
        }

        /// `base` with both one-stretch changes applied, when they touch separate text, as saved.
        static func composed(_ base: String, _ one: String, _ two: String) -> String? {
            let b = Array(base.utf16)
            func stretch(_ text: String) -> (start: Int, end: Int, middle: [UInt16]) {
                let x = Array(text.utf16)
                var p = 0
                while p < b.count, p < x.count, b[p] == x[p] { p += 1 }
                var s = 0
                while s < b.count - p, s < x.count - p, b[b.count - 1 - s] == x[x.count - 1 - s] {
                    s += 1
                }
                return (p, b.count - s, Array(x[p..<(x.count - s)]))
            }
            var (first, second) = (stretch(one), stretch(two))
            if second.start < first.start { swap(&first, &second) }
            guard first.end < second.start else { return nil }
            let units =
                b[..<first.start] + first.middle + b[first.end..<second.start] + second.middle
                + b[second.end...]
            let merged = String(decoding: Array(units), as: UTF16.self)
            // A save ends a nonempty note with a line ending (recovery.md).
            return merged.isEmpty || merged.hasSuffix("\n") ? merged : merged + "\n"
        }

        /// Typed input applied to what was shown, and both versions kept.
        static func expectBothKept(
            _ r: Raced, base: String, outside: String, _ label: String = "",
            sourceLocation: SourceLocation = #_sourceLocation
        ) {
            #expect(
                r.draft == r.control,
                "\(label) the input did not apply to the text it was made on: draft begins \(r.draft.prefix(40).debugDescription), expected \(r.control.prefix(40).debugDescription)",
                sourceLocation: sourceLocation)
            let note = r.files["long.md"]
            let copies = r.files.filter { $0.key != "long.md" }.map(\.value)
            if r.control == base || note == outside {
                #expect(
                    note == outside,
                    "\(label) the outside version was overwritten: \(note?.prefix(40).debugDescription ?? "nil")",
                    sourceLocation: sourceLocation)
                #expect(
                    r.control == base || copies.contains(r.control),
                    "\(label) the draft was not kept: \(r.files.keys.sorted())",
                    sourceLocation: sourceLocation)
            } else {
                let merged = composed(base, outside, r.control)
                #expect(
                    merged != nil && note == merged,
                    "\(label) neither parked nor a clean merge: note begins \(note?.prefix(40).debugDescription ?? "nil")",
                    sourceLocation: sourceLocation)
            }
        }

        static let peer = "# Peer heading\n\n"

        enum Case: String, CaseIterable, Sendable {
            case typedWord, backspace, selectionReplace, enter, compositionAndPasteBeforeEmoji
            case shrunkBelowTheCaret, emptied, secondWriteAfterTheOpen
        }

        /// Each changes the head of the note above or around where the user typed.
        @Test(arguments: Case.allCases)
        func inputMadeWhileOpeningAppliesToWhatWasShownAndTheOutsideWriteIsKept(_ c: Case)
            async throws
        {
            let source = TextFirstOpeningTests.note()
            var before = [Self.peer + source]
            var after: String?
            let act: (Opening) -> Void
            func enter(_ o: Opening) {
                _ = o.tv.delegate?.textView?(
                    o.tv, shouldChangeTextIn: o.tv.selectedRange, replacementText: "\n")
            }
            switch c {
            case .typedWord:
                act = { o in
                    o.tv.selectedRange = NSRange(location: 9, length: 0)  // after "Section 0"
                    o.type("αβγ")
                }
            case .backspace:
                act = { o in
                    o.tv.selectedRange = NSRange(location: 9, length: 0)
                    o.tv.deleteBackward()
                }
            case .selectionReplace:
                act = { o in
                    o.tv.selectedRange = NSRange(location: 0, length: 9)
                    o.type("α")
                }
            case .enter:
                act = { o in
                    o.tv.selectedRange = NSRange(location: 9, length: 0)
                    enter(o)
                }
            case .compositionAndPasteBeforeEmoji:
                // In the outside version, 6 is inside the first 😀's pair.
                before = ["# Peer 😀😀😀😀 x\n\n" + source]
                act = { o in
                    o.tv.selectedRange = NSRange(location: 6, length: 0)
                    o.tv.setMarkedText("αβ", selectedRange: NSRange(location: 2, length: 0))
                    o.tv.unmarkText()
                    _ = o.tv.delegate?.textView?(
                        o.tv, shouldChangeTextIn: NSRange(location: 6, length: 3),
                        replacementText: "γδ ε")
                }
            case .shrunkBelowTheCaret:
                before = ["# tiny\n\nshort body\n"]
                act = { o in
                    o.tv.selectedRange = NSRange(location: 5_000, length: 0)
                    o.type("αβ")
                    o.tv.deleteBackward()
                    o.type("γ")
                }
            case .emptied:
                before = [""]
                act = { o in
                    o.tv.selectedRange = NSRange(location: 700, length: 3)
                    o.type("αβ")
                    enter(o)
                    o.tv.deleteBackward()
                }
            case .secondWriteAfterTheOpen:
                after = "# Second peer\n\n" + source
                act = { o in
                    o.tv.selectedRange = NSRange(location: 9, length: 0)
                    o.type("αβ")
                }
            }
            let r = try await Self.race(source, before: before, after: after, act)
            Self.expectBothKept(r, base: source, outside: after ?? before.last!)
        }

        /// Nothing typed: the outside write shows as soon as the engine lands (its first save is
        /// due at once and follows the file), as it would in an editor that opened whole.
        @Test func aNoteChangedWhileOpeningWithNoInputShowsTheChange() async throws {
            let source = TextFirstOpeningTests.note()
            let o = try Opening(source)
            let outside = Self.peer + source
            try o.write(outside)
            try o.land()
            let shown = TextFirstHarness(outside, id: "long").tv.text
            for _ in 0..<500 where o.tv.text != shown {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            #expect(o.tv.text == shown)
            #expect(try o.controller.session.sourceText() == outside)
            #expect(o.tv.text == (try o.controller.session.displayText()))
            _ = await o.controller.close()
            #expect(try o.store.read(id: "long") == outside)
        }

        // MARK: seeded random races

        struct Rng {
            var s: UInt64
            mutating func next() -> UInt64 {
                s ^= s << 13
                s ^= s >> 7
                s ^= s << 17
                return s
            }
            mutating func int(_ n: Int) -> Int { Int(next() % UInt64(max(n, 1))) }
        }

        static func note(_ r: inout Rng) -> String {
            (0..<(600 + r.int(300))).map { i -> String in
                switch r.int(6) {
                case 0: return "Plain 😀 line \(i) 中文 here.\n\n"
                case 1: return "- item \(i) with *em*\n- next \(i)\n\n"
                default:
                    return
                        "## Section \(i)\n\nBody line \(i) with **bold** and a [link](https://example.com).\n\n"
                }
            }.joined()
        }

        static func outside(_ kind: Int, _ source: String, _ r: inout Rng) -> String {
            switch kind {
            case 0:
                return ["# Peer heading\n\n", "Peer 😀😀 para.\n\n", "- peer item\n\n"][r.int(3)]
                    + source
            case 1:
                return source.components(separatedBy: "\n\n").dropFirst(1 + r.int(3)).joined(
                    separator: "\n\n")
            case 2:
                let head = source.prefix(40)
                return head.replacingOccurrences(of: "Section 0", with: "Sect 😀 zero")
                    .replacingOccurrences(of: "line 0", with: "line zero") + source.dropFirst(40)
            case 3: return source + "\n\nPeer tail 😀.\n"
            case 4: return String(source.prefix(r.int(400)))
            case 5: return ""
            default:
                return String(repeating: "Peer grow 😀 line.\n\n", count: 200 + r.int(300)) + source
            }
        }

        enum Op {
            case tap(Int)
            case type(String)
            case backspace, enter
            case replace(NSRange, String)
            case compose(String, commit: Bool)
        }

        static func ops(_ shown: NSString, _ r: inout Rng) -> [Op] {
            func snap(_ p: Int) -> Int {
                p >= shown.length
                    ? shown.length : shown.rangeOfComposedCharacterSequence(at: p).location
            }
            let words = ["α", "βγ", "δεζ", "η θ", "ικλμ"]
            return (0..<(1 + r.int(4))).map { _ in
                switch r.int(7) {
                case 0, 1: return .tap(snap(r.int(300)))
                case 2: return .type(words[r.int(words.count)])
                case 3: return .backspace
                case 4: return .enter
                case 5:
                    let p = snap(r.int(300))
                    let e = snap(min(shown.length, p + 1 + r.int(12)))
                    return .replace(
                        NSRange(location: p, length: max(0, e - p)), words[r.int(words.count)])
                default: return .compose(words[r.int(words.count)], commit: r.int(2) == 0)
                }
            }
        }

        static func apply(_ ops: [Op], _ o: Opening) {
            for op in ops {
                switch op {
                case .tap(let p): o.tv.selectedRange = NSRange(location: p, length: 0)
                case .type(let w): o.type(w)
                case .backspace: o.tv.deleteBackward()
                case .enter:
                    _ = o.tv.delegate?.textView?(
                        o.tv, shouldChangeTextIn: o.tv.selectedRange, replacementText: "\n")
                case .replace(let range, let w):
                    o.tv.selectedRange = range
                    _ = o.tv.delegate?.textView?(
                        o.tv, shouldChangeTextIn: range, replacementText: w)
                case .compose(let w, let commit):
                    o.tv.setMarkedText(w, selectedRange: NSRange(location: 0, length: 0))
                    if commit { o.tv.unmarkText() }  // else the landing commits it
                }
            }
        }

        /// Random notes, input and outside writes (head and tail changes, shrinks, an emptied
        /// note, one or two writes before the open, sometimes one after it).
        @Test func randomRacesNeverEditTextTheUserDidNotSee() async throws {
            for seed in 1...60 {
                var r = Rng(s: UInt64(seed) &* 0x9E37_79B9_7F4A_7C15 | 1)
                let source = Self.note(&r)
                let shown = try Opening(source).tv.text ?? ""
                let ops = Self.ops(shown as NSString, &r)
                var before = [Self.outside(r.int(7), source, &r)]
                if r.int(4) == 0 { before.append(Self.outside(r.int(7), before[0], &r)) }
                let after = r.int(4) == 0 ? Self.outside(r.int(7), source, &r) : nil
                let raced = try await Self.race(source, before: before, after: after) {
                    Self.apply(ops, $0)
                }
                #expect(!raced.files.values.contains { $0.contains("\u{FFFD}") }, "seed \(seed)")
                Self.expectBothKept(
                    raced, base: source, outside: after ?? before.last!, "seed \(seed):")
            }
        }
    }
#endif
