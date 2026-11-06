#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstTableTests {
        static let note = "intro\n\n| 日本 | b |\n|:--|--:|\n| x | yy |\n\nafter\n"

        private func rows(_ h: TextFirstHarness) -> [(NSRange, TextFirstTableRowSpan)] {
            var out: [(NSRange, TextFirstTableRowSpan)] = []
            let all = NSRange(location: 0, length: h.controller.storage.length)
            h.controller.storage.enumerateAttribute(.tfTable, in: all) { v, r, _ in
                if let s = v as? TextFirstTableRowSpan { out.append((r, s)) }
            }
            return out
        }

        /// The point (in text view coordinates) in row `index`'s column `column`.
        private func point(_ h: TextFirstHarness, row index: Int, column: Int) -> CGPoint {
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            var frames: [CGRect] = []
            manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [])
            { f in
                if let f = f as? TextFirstLayoutFragment, !f.tableRuns.isEmpty {
                    frames.append(f.layoutFragmentFrame)
                }
                return true
            }
            let inset = h.tv.textContainerInset
            let frame = frames[index]
            return CGPoint(
                x: inset.left + CGFloat(column) * TextFirstTableMetrics.cellWidth + 20,
                y: inset.top + frame.minY + 15)
        }

        @Test func tableRowsAreHiddenGlyphsDrawnAsAGridFromTheEnginesCells() {
            let h = TextFirstHarness(Self.note)
            let found = rows(h)
            #expect(found.count == 2)
            #expect(found[0].1.header && !found[1].1.header)
            #expect(found[0].1.columns == 2)
            #expect(found[0].1.cells.map(\.text) == ["日本", "b"])
            #expect(found[0].1.cells.map(\.alignment) == [.left, .right])
            #expect(found[1].1.cells.map(\.text) == ["x", "yy"])
            // The display keeps the row's spelling; it is hidden, not removed.
            #expect(h.display.contains("| 日本 | b |"))
            let storage = h.controller.storage
            let font =
                storage.attribute(.font, at: found[0].0.location + 3, effectiveRange: nil)
                as! UIFont
            #expect(font.pointSize < 1)
            let style =
                storage.attribute(.paragraphStyle, at: found[0].0.location, effectiveRange: nil)
                as! NSParagraphStyle
            #expect(style.minimumLineHeight == TextFirstTableMetrics.minimumRow)
            let kern =
                storage.attribute(.kern, at: found[0].0.location, effectiveRange: nil) as? CGFloat
            #expect(kern == h.controller.images.containerWidth - 1)
            // The delimiter line is a hairline.
            let delimiter = (h.display as NSString).range(of: "|:--|--:|").location
            let hair =
                storage.attribute(.paragraphStyle, at: delimiter, effectiveRange: nil)
                as! NSParagraphStyle
            #expect(hair.maximumLineHeight < 1)
            #expect(
                h.source == Self.note.trimmingCharacters(in: .newlines)
                    || h.source.hasPrefix("intro"))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func aTapHitsTheCellUnderTheFingerAndColumnsScrollTogether() {
            let wide = "| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n"
            let h = TextFirstHarness(wide)
            let first = h.controller.tableCellHit(at: point(h, row: 0, column: 0))
            #expect(first?.cell.text == "a")
            #expect(h.controller.tableCellHit(at: point(h, row: 1, column: 1))?.cell.text == "2")
            let hit = first!
            h.controller.scrollTable(
                startingAt: hit.span.tableStart, columns: 4, to: 200, around: hit.row)
            // Both rows follow the one scroll; the cell under the same point is further right.
            let width = h.controller.images.containerWidth
            let scroll = min(200, 4 * TextFirstTableMetrics.cellWidth - width)
            #expect(h.controller.tableScroll[hit.span.tableStart] == scroll)
            let after = h.controller.tableCellHit(at: point(h, row: 1, column: 0))
            #expect(after?.cell.text != "1")
            // Never past the last column.
            h.controller.scrollTable(
                startingAt: hit.span.tableStart, columns: 4, to: 9999, around: hit.row)
            #expect(
                h.controller.tableScroll[hit.span.tableStart] == 4 * TextFirstTableMetrics.cellWidth
                    - width)
        }

        @Test func theCaretNeverStopsInsideATableRow() {
            let h = TextFirstHarness(Self.note)
            let row = rows(h)[0].0
            h.select(row.location + 4, row.location + 4)
            let p = h.tv.selectedRange.location
            #expect(p == row.location || p == NSMaxRange(row))
        }

        @Test func aCellFieldEditsThroughTheEngineInTheNotesOwnCoordinates() throws {
            let h = TextFirstHarness(Self.note)
            let hit = try #require(h.controller.tableCellHit(at: point(h, row: 0, column: 0)))
            h.controller.selectInCell(hit.cell.range)
            let editor = TextFirstCellEditor(controller: h.controller)
            editor.loadViewIfNeeded()
            #expect(editor.field.text == "日本")
            // Typing, then a pipe (written as \|), are the engine's edits.
            _ = editor.textView(
                editor.field, shouldChangeTextIn: NSRange(location: 2, length: 0),
                replacementText: "z")
            #expect(editor.field.text == "日本z")
            #expect(h.source.contains("| 日本z | b |"))
            _ = editor.textView(
                editor.field, shouldChangeTextIn: NSRange(location: 3, length: 0),
                replacementText: "|")
            #expect(h.source.contains("| 日本z\\| | b |"))
            #expect(editor.field.text == "日本z|")
            // The grid shows the new text.
            #expect(rows(h)[0].1.cells[0].text == "日本z|")
            // Undo is the engine's: two steps back.
            h.controller.undo()
            editor.refresh()
            h.controller.undo()
            editor.refresh()
            #expect(h.source.contains("| 日本 | b |"))
            #expect(editor.field.text == "日本")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func enterTabAndPasteInACellFollowTheEngine() throws {
            let h = TextFirstHarness(Self.note)
            let hit = try #require(h.controller.tableCellHit(at: point(h, row: 0, column: 0)))
            h.controller.selectInCell(hit.cell.range)
            let editor = TextFirstCellEditor(controller: h.controller)
            editor.loadViewIfNeeded()
            // Enter selects the cell below.
            _ = editor.textView(
                editor.field, shouldChangeTextIn: NSRange(location: 0, length: 0),
                replacementText: "\n")
            #expect(editor.field.text == "x")
            // Tab moves right; a cell holds one line, so pasted breaks become spaces.
            #expect(editor.tab(back: false))
            #expect(editor.field.text == "yy")
            UIPasteboard.general.string = "p\nq"
            editor.field.selectedRange = NSRange(location: 2, length: 0)
            editor.paste()
            #expect(h.source.contains("| x | yyp q |"))
            #expect(editor.field.text == "yyp q")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func imageContentIsRefusedInsideACell() throws {
            let h = TextFirstHarness(Self.note)
            let hit = try #require(h.controller.tableCellHit(at: point(h, row: 0, column: 0)))
            h.controller.selectInCell(hit.cell.range)
            #expect(h.controller.beginImageInsertion() == nil)
            h.select(0, 0)
            #expect(h.controller.beginImageInsertion() != nil)
        }
    }
#endif
