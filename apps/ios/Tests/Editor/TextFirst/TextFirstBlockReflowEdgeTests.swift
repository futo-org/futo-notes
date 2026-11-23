#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview at its edges (#448 review): a gap the layout opens under a
    /// still finger, landings of a line that starts with a photo, of a subtree running below the
    /// screen and beside an empty last task, the gap judged against blocks still sliding, the
    /// hand-over while sliding home, a capped card's drawing, an image decoding at its
    /// placeholder's height, a small photo's line in the gap, and a landing interrupted.
    @Suite @MainActor
    struct TextFirstBlockReflowEdgeTests {
        @Test func aGapTheLayoutOpensUnderAStillFingerIsShownBeforeARelease() async throws {
            // `c` lifts while the photo above it is still loading; once it has its height the
            // still finger is over the photo, above `c`'s new place.
            let h = TextFirstHarness(
                "a\n![](pic.png)\nb\nc\nd\ne", files: ["pic.png": TextFirstHarness.png(900, 900)],
                focused: false)
            #expect(h.lineHeights(at: h.lineStarts[1]).allSatisfy { $0 < 100 })
            let drag = try begin(h, at: h.point(line: 3))
            let preview = try #require(drag.preview)
            #expect(await h.until { h.lineHeights(at: h.lineStarts[1]).contains { $0 > 100 } })
            #expect(drag.slot != nil, "the gap moved under the finger")
            // A release lands only where the preview shows the block landing.
            #expect(preview.isOpen && preview.curtain.superview != nil)
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aLineStartingWithAPhotoLandsWhole() async throws {
            // A press on `caption`, wrapped below the photo, lifts the whole line.
            let h = TextFirstHarness(
                "one\n![](pic.png) caption\nthree",
                files: ["pic.png": TextFirstHarness.png(900, 600)], focused: false)
            #expect(await h.until { h.lineHeights(at: h.lineStarts[1]).contains { $0 > 100 } })
            let drag = try begin(h, at: h.point(line: 1, x: 40, fraction: 0.95))
            #expect(!drag.lift.book.alonePhoto)
            drag.follow(h.point(line: 0, fraction: 0.2))
            #expect(drag.slot?.offset == 0)
            try await land(h, drag, after: "![](pic.png) caption\none\nthree", "photo-first")
        }

        @Test func aSubtreeRunningBelowTheScreenLandsWhole() async throws {
            let children = (1...60).map { "  - child \($0)" }.joined(separator: "\n")
            let h = TextFirstHarness("intro\nalpha\n- top\n\(children)\nafter", focused: false)
            let drag = try begin(h, at: h.point(line: 2))
            #expect(drag.lift.block.length > 400, "the item lifts with its children")
            drag.follow(h.point(line: 1, fraction: 0.3))
            #expect(drag.slot?.offset == h.lineStarts[1])
        }

        @Test func aPhotoBeforeAnEmptyLastTaskOpensItsGapsWhereTheyLand() async throws {
            // The task is its marker unit alone, the note's last character, on its own row.
            let h = TextFirstHarness(
                "first\nHere![](pic.png)\n- [ ] ",
                files: ["pic.png": TextFirstHarness.png(900, 600)],
                focused: false)
            #expect(await h.until { h.lineHeights(at: h.lineStarts[1]).contains { $0 > 100 } })
            let photo = try #require(h.controller.imageAt(h.point(line: 1, x: 70, fraction: 0.7)))
            let drag = try begin(h, at: CGPoint(x: photo.frame.midX, y: photo.frame.midY))
            #expect(drag.lift.book.alonePhoto)
            // Carried below the task's row as it is drawn (the photo's own line is taller than
            // the row it leaves, so the task is drawn lower): the gap opens after the task.
            let end = try #require(drag.lift.targets.slots.first { $0.slot.end }).y
            drag.follow(CGPoint(x: 60, y: end - 3))
            #expect(
                drag.slot
                    == TextFirstBlockSlot(offset: h.controller.storage.length - 1, end: false))
            drag.follow(CGPoint(x: 60, y: end + 30))
            #expect(drag.slot?.end == true)
            let preview = try #require(drag.preview)
            let copy = preview.copyFrame
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source != "first\nHere![](pic.png)\n- [ ] ")
            #expect(await h.until(1) { preview.curtain.superview == nil })
            // The photo's own line is the note's last now; it was drawn where it landed.
            let landed = h.point(line: h.lineStarts.count - 1, fraction: 0).y
            #expect(abs(landed - copy.minY) < 5, "\(landed) vs \(copy.minY)")
        }

        @Test func theGapIsJudgedAgainstBlocksWhereTheyAreDrawnMidSlide() async throws {
            let h = TextFirstHarness("alpha\nbravo\ncharlie\ndelta\necho", focused: false)
            func y(_ line: Int, _ fraction: CGFloat) -> CGFloat {
                h.point(line: line, fraction: fraction).y
            }
            let drag = try begin(h, at: h.point(line: 0))
            // The gap opens below `bravo` and everything settles.
            #expect(drag.follow(CGPoint(x: 60, y: y(1, 0.5) + 1)))
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(drag.slot?.offset == h.lineStarts[2])
            // Past `charlie`'s middle the gap moves below it, and `charlie` starts sliding up;
            // on the next move, before it has moved, the finger is back just above its middle
            // as drawn: the gap goes back above it.
            let middle = y(2, 0.5)
            #expect(drag.follow(CGPoint(x: 60, y: middle + 1)))
            #expect(drag.slot?.offset == h.lineStarts[3])
            drag.follow(CGPoint(x: 60, y: middle - 2))
            #expect(drag.slot?.offset == h.lineStarts[2])
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aLandingAboveTwoEmptyTasksAtTheEndDrawsTheLastBox() async throws {
            // The last task's box is drawn below the fragment TextKit lays it out in.
            let h = TextFirstHarness("alpha\nbravo\ncharlie\n- [ ] \n- [ ] ", focused: false)
            let drag = try begin(h, at: h.point(line: 0))
            drag.follow(h.point(line: 1, fraction: 0.6))
            #expect(drag.slot?.offset == h.lineStarts[2])
            try await land(h, drag, after: "bravo\nalpha\ncharlie\n- [ ] \n- [ ] ", "tasks")
        }

        @Test func aCappedCardShowsItsBlock() throws {
            let tall = Array(repeating: "a paragraph taller than the screen", count: 60)
                .joined(separator: " ")
            let h = TextFirstHarness("first\n\(tall)\nlast", focused: false)
            let p = CGPoint(x: 60, y: h.tv.bounds.midY)
            let lift = try #require(h.controller.liftPlan(at: p))
            let card = h.controller.blockCard(lift, finger: p)
            #expect(card.frame.height < lift.frame.height, "capped")
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: card.bounds.size, format: format).image {
                UIColor.white.setFill()
                $0.fill(card.bounds)
                card.layer.render(in: $0.cgContext)
            }
            let ink = TextFirstBlockReflowTests.ink(
                image.cgImage!, rows: 0..<(card.bounds.height / 2), scale: 1)
            #expect(ink[1] > 0, "the card's top half shows the block's words")
        }

        @Test func anImageDecodingAtItsPlaceholdersHeightIsDrawnDecoded() async throws {
            // Decoded, the photo is exactly as tall as its loading placeholder.
            let h = TextFirstHarness(
                "first\nsecond\n![](pic.png)\nfourth",
                files: ["pic.png": TextFirstHarness.png(1050, 144)], focused: false)
            let at = h.lineStarts[2]
            func loaded() -> Bool {
                (h.controller.storage.attribute(.tfImage, at: at, effectiveRange: nil)
                    as? TextFirstImageSpan)?.atom.image != nil
            }
            #expect(!loaded())
            let drag = try begin(h, at: h.point(line: 0))
            drag.follow(h.point(line: 1, fraction: 0.6))
            let preview = try #require(drag.preview)
            #expect(preview.isOpen)
            #expect(await h.until { loaded() })
            try await Task.sleep(nanoseconds: 200_000_000)
            // The photo's slice did not move: it is drawn decoded where it is.
            let photo = try #require(h.controller.imageAt(h.point(line: 2, x: 100)))
            let curtain = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            let real = TextFirstBlockReflowTests.screen(h)
            let rows = (photo.frame.minY - h.tv.bounds.minY)..<(photo.frame.maxY - h.tv.bounds.minY)
            let differing = TextFirstBlockReflowTests.differing(curtain, real, rows: rows)
            #expect(differing == 0, "\(differing) pixels differ")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aSmallPhotoLandsAsALineOfItsOwnWhereTheGapShowedIt() async throws {
            // A small icon shares a row with a tall narrow photo; lifted alone and carried
            // below `next`, it takes a line of its own, as tall as the icon.
            let h = TextFirstHarness(
                "Hi ![](tall.png)![](icon.png)\nnext\nmore\nlast",
                files: [
                    "tall.png": TextFirstHarness.png(300, 1200),
                    "icon.png": TextFirstHarness.png(60, 60),
                ], focused: false)
            let icon = (h.display as NSString).range(of: "![](icon.png)")
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 150 } })
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(icon, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            #expect(drag.lift.block == icon)
            // Below its own line the icon's line pushes `next` down by its height: carried past
            // `next` as drawn there.
            drag.follow(CGPoint(x: 60, y: h.point(line: 1, fraction: 0.5).y + 40))
            let preview = try #require(drag.preview)
            let slot = try #require(drag.slot)
            let gap = try #require(preview.plan.boundary(of: slot))
            // Where `more` is drawn below the gap, and where the copy is.
            let more = preview.plan.top(gap, gap: gap)
            let copy = preview.copyFrame
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == "Hi ![](tall.png)\nnext\n![](icon.png)\nmore\nlast")
            #expect(await h.until(1) { preview.curtain.superview == nil })
            #expect(abs(h.point(line: 3, fraction: 0).y - more) < 5, "more")
            #expect(abs(h.point(line: 2, fraction: 0).y - copy.minY) < 5, "copy top")
            #expect(copy.minX < rect.minX, "at the text's margin, not the old row's x")
        }

        @Test func aLayoutChangeWhileADropSettlesTakesThePreviewDown() throws {
            let h = TextFirstHarness("alpha\nbravo\ncharlie\ndelta", focused: false)
            let drag = try begin(h, at: h.point(line: 0))
            drag.follow(h.point(line: 2, fraction: 0.6))
            let preview = try #require(drag.preview)
            h.controller.endBlockDrag(dropping: true)
            #expect(preview.curtain.superview != nil, "settling")
            h.window.frame.size = CGSize(width: 800, height: 390)
            h.tv.frame = h.window.bounds
            h.tv.layoutIfNeeded()
            #expect(preview.curtain.superview == nil)
            #expect(h.controller.liftPlan(at: h.point(line: 0)) != nil, "lifts again at once")
        }

        @Test func aDropSettlingWhenItsEditorGoesAwayLeavesNothingOnTheView() async throws {
            let h = TextFirstHarness("one\ntwo\nthree\nfour", focused: false)
            _ = try h.controller.session.detach()
            var editor: TextFirstEditorController? = try TextFirstEditorController(
                noteId: "note", session: try h.store.openEditor(id: "note"), imageRoot: h.root)
            let view = try #require(editor?.textView)
            h.tv.removeFromSuperview()
            view.frame = h.window.bounds
            h.window.addSubview(view)
            view.layoutIfNeeded()
            let p = CGPoint(x: 60, y: 4 + 24.3 * 1.5)
            #expect(editor?.liftShouldBegin(at: p) == true)
            editor?.beginBlockDrag(at: p)
            editor?.followBlockDrag(to: CGPoint(x: 60, y: 4 + 24.3 * 3.6))
            #expect(editor?.blockDrag?.preview?.isOpen == true)
            editor?.endBlockDrag(dropping: true)
            #expect(editor?.reflowLanding != nil)
            editor = nil
            try await Task.sleep(nanoseconds: 50_000_000)
            #expect(view.subviews.count(where: { !$0.isUserInteractionEnabled }) == 0)
        }

        // MARK: helpers

        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }

        /// Release `drag`: the note is `after`, and the preview's settled picture is the note.
        private func land(
            _ h: TextFirstHarness, _ drag: TextFirstBlockDrag, after: String, _ name: String
        ) async throws {
            let preview = try #require(drag.preview)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == after)
            let settled = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            let real = TextFirstBlockReflowTests.screen(h)
            let differing = TextFirstBlockReflowTests.differing(settled, real)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(settled, real, name))")
        }
    }
#endif
