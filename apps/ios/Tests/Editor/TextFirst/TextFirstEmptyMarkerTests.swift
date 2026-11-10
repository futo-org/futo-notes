#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// An empty line of a block still draws what makes it that block (a list's bullet, number or
    /// box; a code block's background), where it will sit once text is typed: applied from the
    /// toolbar, made by Enter in a list, or already in the note. The line at the end of the note
    /// (the one TextKit lays out as its extra line fragment) is the one that had none.
    @Suite @MainActor
    struct TextFirstEmptyMarkerTests {
        private enum Action {
            case toolbar(String)
            case enter
            case none
        }

        private struct Row {
            let name: String
            let source: String
            /// Where the caret goes (in the display text) before the action; nil = end.
            let at: @Sendable (String) -> Int
            let action: Action
            var code = false
            /// Which band of ink the row is: negative counts from the last.
            var band = -1
            /// The engine itself re-lays the note out on the first keystroke (it puts the blank
            /// line between a quote and a list there), so a marker may only be checked for.
            var reflows = false
        }

        private nonisolated static let toolbar = ["bullet-list", "ordered-list", "task-list"]
        private nonisolated static let end: @Sendable (String) -> Int = { ($0 as NSString).length }
        /// The end of the last line's text, before its line ending.
        private nonisolated static let textEnd: @Sendable (String) -> Int = {
            let text = $0 as NSString
            var n = text.length
            while n > 0, [10, 13].contains(text.character(at: n - 1)) { n -= 1 }
            return n
        }

        private nonisolated static func rows() -> [Row] {
            var rows: [Row] = []
            for id in toolbar {
                rows += [
                    Row(
                        name: "\(id) on the empty last line", source: "abc\n", at: end,
                        action: .toolbar(id)),
                    Row(
                        name: "\(id) at the end of a note", source: "abc", at: textEnd,
                        action: .toolbar(id)),
                    Row(name: "\(id) in an empty note", source: "", at: end, action: .toolbar(id)),
                    Row(
                        name: "\(id) on an empty middle line", source: "abc\n\ndef",
                        at: { ($0 as NSString).range(of: "\n\n").location + 1 },
                        action: .toolbar(id),
                        band: 1),
                    Row(
                        name: "\(id) on an empty line in a quote", source: "> abc\n> ",
                        at: end, action: .toolbar(id), reflows: true),
                    Row(
                        name: "\(id) after a quote", source: "> abc\n", at: end,
                        action: .toolbar(id), reflows: true),
                    Row(
                        name: "\(id) at the end of a quote", source: "> abc", at: textEnd,
                        action: .toolbar(id)),
                ]
            }
            rows += [
                Row(name: "enter in a bullet", source: "- one", at: textEnd, action: .enter),
                Row(name: "enter in a number", source: "1. one", at: textEnd, action: .enter),
                Row(name: "enter in a task", source: "- [ ] one", at: textEnd, action: .enter),
                Row(
                    name: "enter in a nested bullet", source: "- one\n  - two", at: textEnd,
                    action: .enter),
                Row(
                    name: "enter in a bullet in a middle", source: "- one\n\nafter",
                    at: { ($0 as NSString).range(of: "one").upperBound }, action: .enter, band: 1),
                Row(
                    name: "enter in a CRLF task", source: "- [ ] one\r\n- [ ] two", at: textEnd,
                    action: .enter),
                Row(
                    name: "an empty CRLF task in the middle",
                    source: "- [ ] a\r\n- [ ] \r\n- [ ] b",
                    at: { ($0 as NSString).range(of: "\r\n\r\n").location + 2 }, action: .none,
                    band: 1),
                Row(
                    name: "an empty CRLF task at the end", source: "- [ ] a\r\n- [ ] ",
                    at: { ($0 as NSString).range(of: "\r\n\r\n").location + 2 }, action: .none),
                Row(
                    name: "code block on the empty last line", source: "abc\n", at: end,
                    action: .toolbar("code-block"), code: true),
                Row(
                    name: "code block in an empty note", source: "", at: end,
                    action: .toolbar("code-block"), code: true),
                Row(
                    name: "code block on an empty middle line", source: "abc\n\ndef",
                    at: { ($0 as NSString).range(of: "\n\n").location + 1 },
                    action: .toolbar("code-block"), code: true),
                // On a new line below the block: at the note's end the caret is on the code
                // (fenced-code.md), where Code block takes it out of the fence.
                Row(
                    name: "code block after a code block", source: "```\nx\n```\n\n", at: end,
                    action: .toolbar("code-block"), code: true),
            ]
            return rows
        }

        @Test(arguments: rows().map(\.name))
        func theBlockIsDrawnBeforeAnyTypingAndDoesNotMove(name: String) async {
            let row = Self.rows().first { $0.name == name }!
            let h = TextFirstHarness(row.source)
            h.controller.installToolbar(localization: Localization.system())
            let caret = row.at(h.tv.text ?? "")
            h.select(caret, caret)
            switch row.action {
            case .toolbar(let id):
                let item = ToolbarSpec.groups.flatMap { $0 }.first { $0.id == id }!
                h.controller.toolbar(item)
            case .enter: h.type("\n")
            case .none: break
            }
            // Straight after the command: no run-loop turn in between.
            let immediate = drawn(h, code: row.code, band: row.band)
            #expect(immediate != nil, "\(name): nothing drawn straight after the command")
            _ = await h.until(0.5) { false }
            let settled = drawn(h, code: row.code, band: row.band)
            #expect(settled != nil, "\(name): nothing drawn after the restyle settled")
            h.type("H")
            let typed = drawn(h, code: row.code, band: row.band)
            #expect(typed != nil, "\(name): nothing drawn once typed into")
            for (label, early) in [("immediately", immediate), ("settled", settled)] {
                guard !row.reflows, let early, let typed else { continue }
                withKnownIssue(
                    "next-steps 2: an empty code block on the last line below another code block draws its background 4 pt taller until typed into"
                ) {
                    #expect(
                        abs(early.0 - typed.0) < 0.5 && abs(early.1 - typed.1) < 0.5,
                        "\(name): moved \(label) \(early) -> \(typed)")
                } when: {
                    name == "code block after a code block"
                }
            }
            #expect(h.controller.divergences.isEmpty)
        }

        /// The vertical extent, in points, of what the row draws, or nil when it draws nothing:
        /// the marker's ink left of the text (top = bottom = its center), or for a code line the
        /// background's top and bottom. Measured on rendered pixels; the render's origin is not the
        /// text layout's, so the row is found as the `band`-th band of ink (negative counts from
        /// the last), or the last stretch of code background, and only its x comes from layout.
        private func drawn(_ h: TextFirstHarness, code: Bool, band: Int) -> (CGFloat, CGFloat)? {
            h.tv.tintColor = .clear  // the caret is ink too
            h.tv.layoutIfNeeded()
            let selection = h.tv.selectedRange
            let text = h.tv.text as NSString
            let lineStart = text.lineRange(
                for: NSRange(location: min(selection.location, text.length), length: 0)
            ).location
            let position = h.tv.position(from: h.tv.beginningOfDocument, offset: lineStart)!
            let textX = h.tv.caretRect(for: position).minX
            let scale: CGFloat = 4
            let format = UIGraphicsImageRendererFormat()
            format.scale = scale
            let image = UIGraphicsImageRenderer(size: h.tv.bounds.size, format: format).image { c in
                UIColor.white.setFill()
                c.fill(h.tv.bounds)
                h.tv.drawHierarchy(in: h.tv.bounds, afterScreenUpdates: true)
            }
            let cg = image.cgImage!
            var pixels = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
            let context = CGContext(
                data: &pixels, width: cg.width, height: cg.height, bitsPerComponent: 8,
                bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            func pixel(_ x: Int, _ y: Int) -> [UInt8] {
                let i = (y * cg.width + x) * 4
                return Array(pixels[i..<i + 3])
            }
            /// Consecutive rows of `ys` where `hit` holds.
            func runs(_ hit: (Int) -> Bool) -> [Range<Int>] {
                var out: [Range<Int>] = []
                var open: Int?
                for y in 0..<cg.height {
                    if hit(y), open == nil { open = y }
                    if !hit(y), let from = open {
                        out.append(from..<y)
                        open = nil
                    }
                }
                return out
            }
            if code {
                // The text view's own background is the reference; a code line fills past it.
                let x = cg.width / 2
                let reference = pixel(x, 0)
                guard let run = runs({ pixel(x, $0) != reference }).last else { return nil }
                return (CGFloat(run.lowerBound) / scale, CGFloat(run.upperBound) / scale)
            }
            // A marker lives in the 30 points left of its text; the bands are the rows of ink right
            // of that, so a quote's bar does not join them.
            let from = max(0, Int((textX - 30) * scale))
            let markerEnd = max(from, Int((textX - 1) * scale))
            func isInk(_ x: Int, _ y: Int) -> Bool {
                let i = (y * cg.width + x) * 4
                return Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 3 * 200
            }
            let bands = runs { y in (from..<cg.width).contains { isInk($0, y) } }
            let index = band < 0 ? bands.count + band : band
            guard bands.indices.contains(index) else { return nil }
            let inked = bands[index].filter { y in (from..<markerEnd).contains { isInk($0, y) } }
            guard let first = inked.first, let last = inked.last else { return nil }
            let center = CGFloat(first + last + 1) / 2 / scale
            return (center, center)
        }
    }
#endif
