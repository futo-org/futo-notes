#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// An empty list or quote line left for a plain paragraph (Enter on the empty item, or
    /// Backspace on it) puts the caret where a plain empty paragraph has it, at once: not indented
    /// as if the marker were still there until the first character is typed.
    @Suite @MainActor
    struct TextFirstExitCaretTests {
        private struct Row {
            let name: String
            let source: String
            /// Where the caret goes in the display text before the keys.
            let at: @Sendable (String) -> Int
            let keys: [String]
        }

        private nonisolated static let textEnd: @Sendable (String) -> Int = {
            let text = $0 as NSString
            var n = text.length
            while n > 0, [10, 13].contains(text.character(at: n - 1)) { n -= 1 }
            return n
        }
        private nonisolated static let end: @Sendable (String) -> Int = { ($0 as NSString).length }
        private nonisolated static let backspace = "\u{8}"

        private nonisolated static func rows() -> [Row] {
            var rows: [Row] = []
            let kinds = [
                ("task", "- [ ] one", "- [ ] ", "task-list"),
                ("bullet", "- one", "- ", "bullet-list"),
                ("number", "1. one", "1. ", "ordered-list"),
                ("quote", "> one", "> ", "quote"),
            ]
            for (kind, line, marker, tool) in kinds {
                rows += [
                    Row(
                        name: "enter twice in a \(kind) at the end of the note", source: line,
                        at: textEnd, keys: ["\n", "\n"]),
                    Row(
                        name: "enter twice in a \(kind) mid-note", source: "\(line)\n\nafter",
                        at: { ($0 as NSString).range(of: "one").upperBound }, keys: ["\n", "\n"]),
                    Row(
                        name: "backspace on an empty \(kind) alone in the note", source: marker,
                        at: { _ in 0 }, keys: [backspace]),
                    Row(
                        name: "backspace on an empty \(kind) mid-note",
                        source: "intro\n\n\(marker)\n\nafter",
                        at: { ($0 as NSString).range(of: "\n\n").location + 2 },
                        keys: [backspace]),
                    Row(
                        name: "toolbar \(kind), typed, enter twice in an empty note", source: "",
                        at: end, keys: ["toolbar:\(tool)", "a", "\n", "\n"]),
                    Row(
                        name: "toolbar \(kind), typed, enter twice after a paragraph",
                        source: "abc\n", at: end, keys: ["toolbar:\(tool)", "a", "\n", "\n"]),
                    Row(
                        name: "two typed \(kind)s, enter twice after a paragraph", source: "abc\n",
                        at: end,
                        keys: ["toolbar:\(tool)", "a", "\n", "b", "\n", "\n"]),
                ]
            }
            return rows
        }

        /// The x of the caret on a plain empty last line.
        private func plainX() -> CGFloat {
            let h = TextFirstHarness("abc\n")
            h.select(4, 4)
            return caretX(h)
        }

        private func caretX(_ h: TextFirstHarness) -> CGFloat {
            h.tv.layoutIfNeeded()
            return h.tv.caretRect(for: h.tv.selectedTextRange!.start).minX
        }

        @Test(arguments: rows().map(\.name))
        func theCaretIsAtThePlainParagraphBeforeAnyTyping(name: String) async {
            let row = Self.rows().first { $0.name == name }!
            let plain = plainX()
            let h = TextFirstHarness(row.source)
            let caret = row.at(h.tv.text ?? "")
            h.select(caret, caret)
            h.controller.installToolbar(localization: Localization.system())
            for key in row.keys {
                if key.hasPrefix("toolbar:") {
                    let id = String(key.dropFirst("toolbar:".count))
                    h.controller.toolbar(
                        ToolbarSpec.groups.flatMap { $0 }.first { $0.id == id }!)
                } else if key == Self.backspace {
                    h.tv.deleteBackward()
                } else {
                    h.type(key)
                }
            }
            func check(_ when: String) {
                let style = h.tv.typingAttributes[.paragraphStyle] as? NSParagraphStyle
                #expect(
                    (style?.headIndent ?? 0) == 0 && (style?.firstLineHeadIndent ?? 0) == 0,
                    "\(name) (\(when)): typing attributes carry a head indent")
                let x = caretX(h)
                #expect(abs(x - plain) < 0.5, "\(name) (\(when)): caret at \(x), plain \(plain)")
            }
            check("immediately")
            _ = await h.until(0.5) { false }
            check("settled")
            #expect(h.controller.divergences.isEmpty)
        }
    }
#endif
