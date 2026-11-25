#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview where it can go wrong without care (#449, !719 review):
    /// lines the engine and Foundation split differently, a release that has spent its time,
    /// photos far too tall or loaded off screen, drawings cropped or rebuilt away from their
    /// text, every way a drag ends leaving the note within its scroll, and what stays behind.
    @Suite @MainActor
    struct TextFirstBlockReflowHazardTests {
        private static let lines = (0..<300).map { "line \($0)" }.joined(separator: "\n")

        @Test func aPhotoWhoseAltBreaksALineForFoundationLiftsAndLands() async throws {
            // U+2028 ends a line for Foundation, never for the engine (only a line feed does).
            let h = TextFirstHarness(
                "cap ![a\u{2028}b](pic.png)\nsecond\nthird",
                files: ["pic.png": TextFirstHarness.png(600, 300)], focused: false)
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 60 } })
            let photo = (h.display as NSString).range(of: "![a\u{2028}b](pic.png)")
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(photo, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            #expect(drag.lift.block == photo)
            #expect(drag.preview != nil, "\(drag.previewUnavailable ?? "")")
            drag.follow(h.point(line: 2, fraction: 0.6))
            #expect(drag.slot != nil)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source.hasPrefix("cap"))
            #expect(h.source.contains("second\n![a\u{2028}b](pic.png)\nthird"), "\(h.source)")
        }

        @Test func aReleaseThatSpentItsTimeComesDownAtOnceWithoutASlide() async throws {
            let h = TextFirstHarness("one\ntwo\nthree\nfour", focused: false)
            h.controller.debugLandingCap = 0
            let drag = try begin(h, at: h.point(line: 0))
            drag.follow(h.point(line: 2, fraction: 0.6))
            let preview = try #require(drag.preview)
            try await Task.sleep(nanoseconds: 300_000_000)
            let released = CACurrentMediaTime()
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == "two\nthree\none\nfour")
            #expect(preview.curtain.superview == nil && h.controller.reflowLanding == nil)
            #expect(preview.slidesEnd < released, "nothing was set sliding")
        }

        @Test func aReleaseThatSpentItsTimeStillHoldsWhatShows() async throws {
            let lines = (0..<300).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            h.controller.debugLandingCap = 0
            let drag = try begin(h, at: h.point(line: 3))
            drag.follow(h.point(line: 8))
            for _ in 0..<4 {
                h.tv.contentOffset.y += h.tv.bounds.height / 2
                h.tv.layoutIfNeeded()
                h.controller.remeasureBlockDrag()
            }
            hold(h, at: h.tv.bounds.height / 2)
            try await Task.sleep(nanoseconds: 300_000_000)
            // A line above the gap that shows whole, and where it is on screen.
            let slot = try #require(drag.slot)
            let gapLine = try #require(h.lineStarts.firstIndex(of: slot.offset))
            let watched = gapLine - 4
            // Where the preview draws it: pulled up by the block's leaving from above.
            let preview = try #require(drag.preview)
            let before =
                h.point(line: watched, fraction: 0).y - h.tv.bounds.minY - preview.plan.left
            h.controller.endBlockDrag(dropping: true)
            #expect(h.controller.reflowLanding == nil, "down at once")
            // The block left from above it: its text is a line further up the note.
            let after = h.point(line: watched - 1, fraction: 0).y - h.tv.bounds.minY
            #expect(abs(after - before) < 0.5, "drawn at \(before), then \(after)")
        }

        @Test func aNarrowPhotoTallerThanTheScreenIsDrawnOnlyWhereItCanShow() async throws {
            let h = TextFirstHarness(
                "cap ![](tall.png)\n" + Self.lines,
                files: ["tall.png": TextFirstHarness.png(30, 6000)], focused: false)
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 2000 } })
            let photo = (h.display as NSString).range(of: "![](tall.png)")
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(photo, in: laidOut))
            let shown = rect.intersection(h.tv.bounds)
            let drag = try begin(h, at: CGPoint(x: shown.midX, y: shown.midY))
            #expect(drag.lift.book.alonePhoto)
            hold(h, at: h.tv.bounds.height - 30)
            #expect(await h.until(4) { drag.slot != nil && h.tv.contentOffset.y > 200 })
            hold(h, at: h.tv.bounds.height / 2)
            let preview = try #require(drag.preview)
            let copy = try #require(preview.copyDrawing)
            let limit = 2 * h.tv.bounds.height * TextFirstSlicePainter(textView: h.tv).scale
            #expect(CGFloat(copy.height) <= limit, "\(copy.width)x\(copy.height)")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aPhotoThatLoadsOnceItsLineHasScrolledAwayTakesItsRealHeight() async throws {
            let h = TextFirstHarness(
                "caption ![](pic.png)\n" + Self.lines,
                files: ["pic.png": TextFirstHarness.png(900, 900)], focused: false)
            let photo = (h.display as NSString).range(of: "![](pic.png)")
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(photo, in: laidOut))
            func loaded() -> Bool {
                (h.controller.storage.attribute(.tfImage, at: photo.location, effectiveRange: nil)
                    as? TextFirstImageSpan)?.atom.image != nil
            }
            #expect(!loaded(), "lifted while still loading")
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            drag.follow(h.point(line: 3))
            let preview = try #require(drag.preview)
            let placeholder = preview.plan.room
            h.tv.contentOffset.y += 3 * h.tv.bounds.height
            h.tv.layoutIfNeeded()
            h.controller.remeasureBlockDrag()
            #expect(preview.plan.closing == nil, "its line has scrolled away")
            #expect(await h.until { loaded() })
            try await Task.sleep(nanoseconds: 200_000_000)
            #expect(
                preview.plan.room > placeholder + 100, "\(placeholder) then \(preview.plan.room)")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aCopyRebuiltAwayFromItsBlockIsDrawnFromItsOwnWords() async throws {
            var lines = (0..<300).map { "line \($0)" }
            lines[3] = "lifted ██████████"
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            let drag = try begin(h, at: h.point(line: 3))
            drag.follow(h.point(line: 6))
            let preview = try #require(drag.preview)
            for _ in 0..<6 {
                h.tv.contentOffset.y += h.tv.bounds.height / 2
                h.tv.layoutIfNeeded()
                h.controller.remeasureBlockDrag()
            }
            // Narrower: the copy is drawn again.
            for view in [h.window, h.tv] as [UIView] { view.frame.size.width = 300 }
            h.tv.layoutIfNeeded()
            h.controller.remeasureBlockDrag()
            let copy = try #require(preview.copyDrawing)
            let alone = TextFirstHarness("line\nlifted ██████████\nafter", focused: false)
            for view in [alone.window, alone.tv] as [UIView] { view.frame.size.width = 300 }
            alone.tv.layoutIfNeeded()
            let painter = TextFirstSlicePainter(textView: alone.tv)
            let top = painter.pixel(alone.point(line: 1, fraction: 0).y)
            let own = try #require(
                painter.paint(
                    CGRect(
                        x: 0, y: top, width: alone.tv.bounds.width,
                        height: CGFloat(copy.height) / painter.scale), from: 5))
            let differing = TextFirstBlockReflowTests.differing(copy, own)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(copy, own, "rebuilt"))"
            )
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aDragInterruptedPastTheNotesFootLeavesItWithinItsScroll() async throws {
            let h = TextFirstHarness(
                (0..<60).map { "line \($0)" }.joined(separator: "\n")
                    + "\nHi ![](tall.png)![](icon.png)\nlast",
                files: [
                    "tall.png": TextFirstHarness.png(300, 1200),
                    "icon.png": TextFirstHarness.png(60, 60),
                ], focused: false)
            func foot() -> CGFloat {
                h.tv.contentSize.height + h.tv.adjustedContentInset.bottom - h.tv.bounds.height
            }
            h.tv.contentOffset.y = foot()
            h.tv.layoutIfNeeded()
            #expect(await h.until { h.lineHeights(at: h.lineStarts[60]).contains { $0 > 150 } })
            h.tv.contentOffset.y = foot()
            h.tv.layoutIfNeeded()
            let icon = (h.display as NSString).range(of: "![](icon.png)")
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(icon, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            hold(h, at: h.tv.bounds.height - 10)
            #expect(await h.until(3) { h.tv.contentOffset.y > foot() + 20 })
            // The app leaves the foreground with the finger still down.
            h.controller.blockDragInterrupted()
            #expect(drag.preview?.curtain.superview == nil)
            #expect(h.tv.contentOffset.y <= foot() + 0.5, "back within the note's scroll")
        }

        @Test func aDragWhoseEditorGoesAwayPastTheFootLeavesItWithinItsScroll() async throws {
            let h = TextFirstHarness(Self.lines, focused: false)
            _ = try h.controller.session.detach()
            var editor: TextFirstEditorController? = try TextFirstEditorController(
                noteId: "note", session: try h.store.openEditor(id: "note"), imageRoot: h.root)
            let view = try #require(editor?.textView)
            h.tv.removeFromSuperview()
            view.frame = h.window.bounds
            h.window.addSubview(view)
            func foot() -> CGFloat {
                view.contentSize.height + view.adjustedContentInset.bottom - view.bounds.height
            }
            view.contentOffset.y = foot()
            view.layoutIfNeeded()
            let p = CGPoint(x: 60, y: view.bounds.midY)
            #expect(editor?.liftShouldBegin(at: p) == true)
            editor?.beginBlockDrag(at: p)
            editor?.followBlockDrag(to: CGPoint(x: 60, y: p.y - 100))
            #expect(editor?.blockDrag?.preview?.isOpen == true)
            // Past the foot, as the preview's extra height may take it.
            view.contentOffset.y = foot() + 40
            view.layoutIfNeeded()
            editor = nil
            try await Task.sleep(nanoseconds: 100_000_000)
            #expect(view.contentOffset.y <= foot() + 0.5, "back within the note's scroll")
        }

        @Test func aDragLeavesNoSecondLayoutBehind() async throws {
            let children = (1...200).map { "  - child \($0)" }.joined(separator: "\n")
            let h = TextFirstHarness("intro\n- top\n\(children)\nafter", focused: false)
            for dropping in [false, true] {
                let drag = try begin(h, at: h.point(line: 1))
                drag.follow(h.point(line: 0, fraction: 0.3))
                #expect(h.controller.liftedLayout != nil, "laid out on its own for its height")
                h.controller.endBlockDrag(dropping: dropping)
                #expect(await h.until(1) { h.controller.reflowLanding == nil })
                #expect(h.controller.liftedLayout == nil)
                if dropping { h.controller.undo() }
            }
        }

        @Test func aTextFieldWithFocusAnywhereInTheWindowHoldsTheLift() async throws {
            // As the note list's search field does beside the note on a two-page Duo.
            let h = TextFirstHarness("one\ntwo", focused: false)
            #expect(h.controller.mayLift)
            let search = UITextField(frame: CGRect(x: 0, y: 0, width: 100, height: 30))
            h.window.addSubview(search)
            #expect(search.becomeFirstResponder())
            #expect(!h.controller.mayLift)
            search.resignFirstResponder()
            #expect(h.controller.mayLift)
        }

        // MARK: helpers

        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }

        private func hold(_ h: TextFirstHarness, at y: CGFloat) {
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.tv.bounds.minY + y))
        }
    }
#endif
