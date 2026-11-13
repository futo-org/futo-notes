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
            editor.install()
            #expect(editor.field.text == "日本")
            // Typing, then a pipe (written as typed: the row gains a cell), are the engine's edits.
            _ = editor.textView(
                editor.field, shouldChangeTextIn: NSRange(location: 2, length: 0),
                replacementText: "z")
            #expect(editor.field.text == "日本z")
            #expect(h.source.contains("| 日本z | b |"))
            _ = editor.textView(
                editor.field, shouldChangeTextIn: NSRange(location: 3, length: 0),
                replacementText: "|")
            #expect(h.source.contains("| 日本z| | b |"))
            #expect(editor.field.text == "")
            // The grid shows the new text and the new cell.
            #expect(rows(h)[0].1.cells.map(\.text) == ["日本z", "", "b"])
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
            editor.install()
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

        /// iOS sim, Tables rows 9-10: a `|` typed at a cell's end gives the row a new cell and
        /// puts the caret in it; the field stayed over the old cell showing the new one's text.
        @Test func aTypedPipeMovesTheCellFieldOverTheNewCell() throws {
            let h = TextFirstHarness("| a | b |\n|---|---|\n| c | d |\n")
            let hit = try #require(h.controller.tableCellHit(at: point(h, row: 1, column: 0)))
            h.controller.selectInCell(hit.cell.range)
            let editor = TextFirstCellEditor(controller: h.controller)
            editor.install()
            #expect(editor.field.text == "c")
            let old = editor.field.frame
            _ = editor.textView(
                editor.field, shouldChangeTextIn: NSRange(location: 1, length: 0),
                replacementText: "|")
            #expect(h.source.contains("| c| | d |"), "\(h.source.debugDescription)")
            #expect(editor.field.text == "")
            let column = try #require(h.controller.tableCell(at: editor.cellStart)).1.column
            #expect(column == 1)
            let scroll = h.controller.tableScroll.values.first ?? 0
            let x = h.tv.textContainerInset.left + TextFirstTableMetrics.cellWidth - scroll
            #expect(abs(editor.field.frame.minX - x) < 0.5, "\(old) -> \(editor.field.frame)")
            #expect(editor.field.frame.minY == old.minY)
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

        // MARK: windowed tables (the engine restyles only the rows an edit meets)

        /// `rowCount` body rows `| r000 | v |`, under a header, between a paragraph and a tail.
        private func longTable(_ rowCount: Int, tail: String = "\nafter\n") -> String {
            var text = "intro\n\n| head | v |\n| --- | --- |\n"
            for i in 0..<rowCount { text += "| r\(String(format: "%03d", i)) | v |\n" }
            return text + tail
        }

        /// The text a cell's content range names in the storage as it is now.
        private func text(_ h: TextFirstHarness, _ range: NSRange) -> String {
            (h.controller.storage.string as NSString).substring(with: range)
        }

        /// A note long enough that an edit's restyle window does not reach the far rows (the engine
        /// reparses a few KB around an edit), with every slice already styled.
        private func settledLongTable(_ rows: Int = 4000) async -> TextFirstHarness {
            let h = TextFirstHarness(longTable(rows))
            _ = await h.until { h.controller.styledThrough >= h.controller.mirrorLength }
            return h
        }

        /// Type `text` at the start of body row `index`'s first cell.
        private func typeInRow(_ h: TextFirstHarness, _ index: Int, _ text: String) {
            let (row, span) = rows(h)[index]
            let at = NSRange(location: row.location + span.cells[0].rowOffset, length: 0)
            h.controller.selectInCell(at)
            h.controller.replaceInCell(range: at, text: text)
        }

        @Test func aCellsRangeFollowsItsRowAfterAnEditAboveTheTable() async throws {
            // 3,000 filler lines keep the edit's restyle window clear of the table.
            let filler = String(repeating: "filler line\n", count: 3000)
            let h = TextFirstHarness(filler + "\n" + longTable(4000))
            _ = await h.until { h.controller.styledThrough >= h.controller.mirrorLength }
            h.select(0, 0)
            h.type("zz")
            // Rows far below the edit's window keep their old spans (and stale absolute ranges).
            let (row, span) = rows(h)[3990]
            let cell = try #require(span.cells.first)
            let range = span.contentRange(of: cell, row: row)
            #expect(text(h, range) == cell.text)
            #expect(h.controller.tableCell(at: range.location)?.1.text == cell.text)
            // A tap on that row selects exactly the cell's text.
            let hit = TextFirstEditorController.TableCellHit(
                row: row, span: span, cell: cell, range: range)
            h.controller.openCellEditor(hit)
            #expect(h.tv.selectedRange == range)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func aCellBelowAnEditInsideALongTableStillSelectsItsOwnText() async throws {
            let h = await settledLongTable()
            typeInRow(h, 100, "WW")
            let after = rows(h)
            let (row, span) = after[after.count - 1]
            let cell = try #require(span.cells.first)
            let range = span.contentRange(of: cell, row: row)
            #expect(text(h, range) == "r3999")
            #expect(h.controller.tableCell(at: range.location)?.1.text == "r3999")
        }

        @Test func restyledBodyRowsKeepTheScrollKeyOfTheRowsAboveThem() async {
            // 3,000 filler lines keep the header out of the first edit's restyle window.
            let filler = String(repeating: "filler line\n", count: 3000)
            let h = TextFirstHarness(filler + "\n" + longTable(4000))
            _ = await h.until { h.controller.styledThrough >= h.controller.mirrorLength }
            // An edit above the table moves it; its rows are not restyled and keep their key.
            h.select(0, 0)
            h.type("zz")
            typeInRow(h, 2000, "W")
            let keys = Set(rows(h).map(\.1.tableStart))
            #expect(keys.count == 1, "one table scrolls as one: \(keys.count) keys")
        }

        @Test func rowsThatLeaveATableAfterTheWindowAreRestyledBySlices() async {
            let h = await settledLongTable()
            // `> ` before a middle row ends the table there; the rows below the edit's window
            // were gridded and must stop being so, as in a fresh open of the same text.
            let (row, _) = rows(h)[2000]
            h.select(row.location, row.location)
            h.type("> ")
            let fresh = TextFirstHarness(h.source)
            _ = await fresh.until {
                fresh.controller.styledThrough >= fresh.controller.mirrorLength
            }
            let expected = rows(fresh).count
            #expect(expected < 4001)
            #expect(await h.until(30) { self.rows(h).count == expected })
        }

        @Test func pipeLinesThatJoinATableAfterTheWindowAreGriddedBySlices() async {
            // A blank line between a table and 400 more pipe lines; deleting it makes them rows.
            // The rows are far past the edit's window and were plain text a moment ago.
            var joined = ""
            for i in 0..<400 { joined += "| j\(String(format: "%03d", i)) | w |\n" }
            let h = TextFirstHarness(longTable(400, tail: "\n" + joined))
            _ = await h.until { h.controller.styledThrough >= h.controller.mirrorLength }
            let before = rows(h).count
            let join = (h.controller.storage.string as NSString).range(of: "| j000").location
            h.select(join, join)
            h.tv.deleteBackward()
            let fresh = TextFirstHarness(h.source)
            _ = await fresh.until {
                fresh.controller.styledThrough >= fresh.controller.mirrorLength
            }
            let expected = rows(fresh).count
            #expect(expected == before + 400)
            #expect(await h.until(30) { self.rows(h).count == expected })
        }

        /// A scroll view lays itself out on every scroll step. The rows' geometry follows the
        /// view's width, which a scroll does not change, so scrolling leaves the text alone.
        @Test func scrollingPastATableLeavesTheTextStorageAlone() async {
            let filler = (1...80).map { "line \($0)" }.joined(separator: "\n\n")
            let h = TextFirstHarness(Self.note + "\n" + filler)
            _ = await h.until { h.controller.styledThrough >= h.controller.mirrorLength }
            #expect(!rows(h).isEmpty)
            h.tv.layoutIfNeeded()
            final class Count { var edits = 0 }
            let count = Count()
            let token = NotificationCenter.default.addObserver(
                forName: NSTextStorage.didProcessEditingNotification,
                object: h.controller.storage, queue: nil
            ) { _ in count.edits += 1 }
            defer { NotificationCenter.default.removeObserver(token) }
            for step in 1...10 {
                h.tv.contentOffset = CGPoint(x: 0, y: CGFloat(step) * 30)
                h.tv.layoutIfNeeded()
            }
            #expect(count.edits == 0, "\(count.edits) text storage edits while scrolling")
        }
    }
#endif
