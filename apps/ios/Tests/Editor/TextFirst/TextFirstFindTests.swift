#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstFindTests {
        static let note = "日本 bold **Bo**ld\n\nBOLD\n"

        private func ranges(of needle: String, in text: String) -> [NSRange] {
            var out: [NSRange] = []
            var from = 0
            let ns = text as NSString
            while true {
                let r = ns.range(
                    of: needle, options: .caseInsensitive,
                    range: NSRange(location: from, length: ns.length - from))
                if r.location == NSNotFound { return out }
                out.append(r)
                from = NSMaxRange(r)
            }
        }

        @Test func marksAreTheEnginesMatchesInViewUnitsAndNeverTouchTheNote() throws {
            let h = TextFirstHarness(Self.note)
            let before = try h.controller.session.sourceText()
            h.controller.openFind()
            h.controller.setFindQuery("bold")
            // The Bo**ld spelling matches across its hidden marks: the display text is "Bold".
            let display = h.controller.storage.string
            let found = ranges(of: "bold", in: display)
            #expect(found.count == 3)
            #expect(h.controller.find.marks == found)
            #expect(h.controller.findModel.total == 3 && h.controller.findModel.current == 1)
            #expect(h.controller.find.current == 0)
            // Find edits nothing: bytes and history are untouched.
            #expect(try h.controller.session.sourceText() == before)
            #expect(try h.controller.session.revision() == 0)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func theFirstPressLandsAndLaterOnesStepWithWrap() {
            let h = TextFirstHarness(Self.note)
            h.controller.openFind()
            h.controller.setFindQuery("bold")
            let found = h.controller.find.marks
            // First press lands on the current (first) match, then 2, 3, wrap to 1.
            var seen: [Int] = []
            for _ in 0..<4 {
                h.controller.stepFind(forward: true)
                seen.append(h.controller.findModel.current)
                #expect(h.controller.engineSelection == found[h.controller.find.current])
            }
            #expect(seen == [1, 2, 3, 1])
            h.controller.stepFind(forward: false)
            #expect(h.controller.findModel.current == 3)
            // No matches: a press does nothing.
            h.controller.setFindQuery("zzz")
            h.controller.stepFind(forward: true)
            #expect(h.controller.findModel.total == 0 && h.controller.find.marks.isEmpty)
        }

        @Test func editsKeepTheBarOpenAndMarksFollowTheText() async {
            let h = TextFirstHarness(Self.note)
            h.controller.openFind()
            h.controller.setFindQuery("bold")
            h.select(0, 0)
            h.type("xx ")
            let target = ranges(of: "bold", in: h.controller.storage.string)
            #expect(await h.until { h.controller.find.marks == target })
            h.type("bold ")
            let more = ranges(of: "bold", in: h.controller.storage.string)
            #expect(await h.until { h.controller.find.marks == more && more.count == 4 })
            #expect(h.controller.findModel.total == 4)
        }

        @Test func closingClearsMarksAndPutsTheSelectionBack() {
            let h = TextFirstHarness(Self.note)
            h.select(3, 3)
            h.controller.openFind()
            h.controller.setFindQuery("bold")
            h.controller.stepFind(forward: true)
            h.controller.stepFind(forward: true)
            #expect(h.controller.engineSelection != NSRange(location: 3, length: 0))
            h.controller.closeFind()
            #expect(h.controller.find.marks.isEmpty && !h.controller.find.open)
            #expect(!h.controller.findModel.visible)
            #expect(h.controller.engineSelection == NSRange(location: 3, length: 0))
        }

        // MARK: tables and images

        private func gridFragment(_ h: TextFirstHarness, row: Int) -> TextFirstLayoutFragment {
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            var frames: [TextFirstLayoutFragment] = []
            manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [])
            { f in
                if let f = f as? TextFirstLayoutFragment, !f.tableRuns.isEmpty { frames.append(f) }
                return true
            }
            return frames[row]
        }

        @Test func aMatchInsideATableCellIsMarkedInThatCellAndStopsAtItsEdges() {
            let h = TextFirstHarness("intro\n\n| cat | b |\n|---|---|\n| x | a cat |\n")
            h.controller.openFind()
            h.controller.setFindQuery("cat")
            #expect(h.controller.findModel.total == 2)
            let header = gridFragment(h, row: 0)
            let body = gridFragment(h, row: 1)
            let first = header.tableMarks(for: header.tableRuns[0])
            #expect(first.map(\.column) == [0] && first[0].current && !first[0].rects.isEmpty)
            let second = body.tableMarks(for: body.tableRuns[0])
            #expect(second.map(\.column) == [1] && !second[0].current)
            // The second cell's mark starts after "a ".
            #expect(second[0].rects[0].minX > 5)
            // Stepping to a cell match scrolls its column into view.
            let wide = TextFirstHarness(
                "| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | needle |\n")
            wide.controller.openFind()
            wide.controller.setFindQuery("needle")
            wide.controller.stepFind(forward: true)
            let span =
                wide.controller.storage.attribute(
                    .tfTable, at: wide.controller.find.marks[0].location, effectiveRange: nil)
                as! TextFirstTableRowSpan
            #expect((wide.controller.tableScroll[span.tableStart] ?? 0) > 0)
        }

        @Test func cellMarksSurviveAnEditAboveTheTable() async {
            let h = TextFirstHarness("intro\n\n| cat | b |\n|---|---|\n| x | cat |\n")
            h.controller.openFind()
            h.controller.setFindQuery("cat")
            h.select(0, 0)
            h.type("more ")
            let expected = ranges(of: "cat", in: h.controller.storage.string)
            #expect(await h.until { h.controller.find.marks == expected })
            let body = gridFragment(h, row: 1)
            #expect(body.tableMarks(for: body.tableRuns[0]).map(\.column) == [1])
        }

        @Test func aMatchInAnImagesAltTextMarksThePicture() {
            let h = TextFirstHarness(
                "see ![a cat](find-pic.png) end\n", files: ["find-pic.png": TextFirstHarness.png(80, 40)])
            h.controller.openFind()
            h.controller.setFindQuery("cat")
            #expect(h.controller.findModel.total == 1)
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            var found = false
            manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [])
            { f in
                if let f = f as? TextFirstLayoutFragment, !f.imageRuns.isEmpty {
                    found = !f.findMarks().marks.isEmpty
                }
                return true
            }
            #expect(found)
        }

        // MARK: pixels

        @Test func theCurrentMatchIsPaintedOrangeBehindTheText() {
            let h = TextFirstHarness("plain bold text\n")
            h.controller.openFind()
            h.controller.setFindQuery("bold")
            h.tv.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: h.tv.bounds).image { _ in
                h.tv.drawHierarchy(in: h.tv.bounds, afterScreenUpdates: true)
            }
            #expect(containsOrange(image))
            h.controller.closeFind()
            h.tv.layoutIfNeeded()
            let after = UIGraphicsImageRenderer(bounds: h.tv.bounds).image { _ in
                h.tv.drawHierarchy(in: h.tv.bounds, afterScreenUpdates: true)
            }
            #expect(!containsOrange(after))
        }

        private func containsOrange(_ image: UIImage) -> Bool {
            guard let cg = image.cgImage, let data = cg.dataProvider?.data,
                let bytes = CFDataGetBytePtr(data)
            else { return false }
            let bpp = cg.bitsPerPixel / 8
            var hits = 0
            for y in stride(from: 0, to: cg.height, by: 2) {
                for x in stride(from: 0, to: cg.width, by: 2) {
                    let p = bytes + y * cg.bytesPerRow + x * bpp
                    let (a, b, c) = (Int(p[0]), Int(p[1]), Int(p[2]))
                    // Orange over white: red above green above blue (the grey text and blue caret are not).
                    for (r, g, bl) in [(a, b, c), (c, b, a)]
                    where r > g && g > bl && r - bl > 35 { hits += 1 }
                }
            }
            // A painted word is hundreds of pixels; antialiasing fringes are a few.
            return hits > 200
        }
    }
#endif
