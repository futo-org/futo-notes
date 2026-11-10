#if DEBUG
    import Foundation
    import Testing
    import UIKit
    import SwiftUI

    @testable import FutoNotesNative

    /// Serves `https://example.test/<name>` from a table, for the remote-image tests.
    final class StubImageProtocol: URLProtocol, @unchecked Sendable {
        nonisolated(unsafe) static var responses: [String: (Int, Data)] = [:]
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            let key = request.url?.absoluteString ?? ""
            let (status, data) = Self.responses[key] ?? (404, Data())
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    @Suite @MainActor
    struct TextFirstImageTests {
        @Test func aFullScreenPickerKeepsTheOriginatingEditorAttached() async throws {
            let h = TextFirstHarness("camera target")
            _ = await h.controller.close()
            let store = NotesStore(
                notesRoot: h.root, searchIndex: h.root.appendingPathComponent("search"))
            #expect(await h.until { store.hasBootstrapped })
            let host = UIHostingController(
                rootView:
                    TextFirstNoteScreen(
                        noteId: "note", autoFocus: false, navPath: .constant([.note("note")])
                    )
                    .environmentObject(store))
            let scene = try #require(
                UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
            window.rootViewController = host
            window.makeKeyAndVisible()
            window.layoutIfNeeded()
            host.view.layoutIfNeeded()
            func editor(in view: UIView) -> TextFirstTextView? {
                if let tv = view as? TextFirstTextView { return tv }
                return view.subviews.lazy.compactMap { editor(in: $0) }.first
            }
            #expect(await h.until { editor(in: host.view)?.controller != nil })
            let controller = try #require(editor(in: host.view)?.controller)
            let claim = try #require(controller.beginImageInsertion())
            let picker = UIViewController()
            picker.modalPresentationStyle = .fullScreen
            await withCheckedContinuation { done in
                host.present(picker, animated: false) { done.resume() }
            }
            #expect(!controller.isClosed)
            await withCheckedContinuation { done in
                picker.dismiss(animated: false) { done.resume() }
            }
            #expect(
                await controller.insertImage(
                    data: TextFirstHarness.png(6, 6), ext: "png", claim: claim))
            #expect(try controller.session.sourceText().contains("![](image-"))
            _ = await controller.close()
            window.isHidden = true
        }

        @Test func aFullWidthPhotoOccupiesOneVisualLine() async {
            let h = TextFirstHarness(
                "![](wide-line.png)\n\nafter",
                files: ["wide-line.png": TextFirstHarness.png(1800, 2400)])
            #expect(await h.until { self.lineHeight(h, at: 0) > 400 })
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            let fragment = manager.textLayoutFragment(for: manager.documentRange.location)!
            #expect(
                fragment.textLineFragments.count == 1,
                "\(fragment.textLineFragments.map { $0.typographicBounds })")
            #expect(fragment.layoutFragmentFrame.height < lineHeight(h, at: 0) + 40)
        }

        @Test func enteringAfterAPhotoDoesNotCarryItsHeightOrKern() async {
            let h = TextFirstHarness(
                "![](tall.png)\n", files: ["tall.png": TextFirstHarness.png(900, 1800)])
            #expect(await h.until { self.lineHeight(h, at: 0) > 400 })
            h.select(13, 13)
            h.type("\nafter")
            let at = (h.tv.text as NSString).range(of: "after").location
            #expect(at != NSNotFound)
            if at != NSNotFound {
                #expect(lineHeight(h, at: at) < 30)
                #expect(kern(h, at: at) == 0)
                #expect(
                    h.controller.storage.attribute(.tfImage, at: at, effectiveRange: nil) == nil)
            }
            #expect(h.controller.divergences.isEmpty)
        }

        private func spans(_ h: TextFirstHarness) -> [(NSRange, TextFirstImageSpan)] {
            var out: [(NSRange, TextFirstImageSpan)] = []
            let all = NSRange(location: 0, length: h.controller.storage.length)
            h.controller.storage.enumerateAttribute(.tfImage, in: all) { v, r, _ in
                if let s = v as? TextFirstImageSpan { out.append((r, s)) }
            }
            return out
        }

        private func kern(_ h: TextFirstHarness, at i: Int) -> CGFloat {
            var range = NSRange()
            guard
                h.controller.storage.attribute(
                    .tfImage, at: i, longestEffectiveRange: &range,
                    in: NSRange(location: 0, length: h.controller.storage.length)) != nil
            else { return 0 }
            let kern =
                h.controller.storage.attribute(.kern, at: i, effectiveRange: nil) as? CGFloat ?? 0
            let spelling = (h.tv.text as NSString).substring(with: range)
            return kern + TextFirstImageMetrics.textAdvance(spelling)
        }

        private func lineHeight(_ h: TextFirstHarness, at i: Int) -> CGFloat {
            (h.controller.storage.attribute(.paragraphStyle, at: i, effectiveRange: nil)
                as? NSParagraphStyle)?
                .minimumLineHeight ?? 0
        }

        @Test func anImageKeepsItsSpellingAndIsDrawnAsOneHiddenUnit() async {
            let h = TextFirstHarness(
                "before ![alt text](pic.png) after\n",
                files: ["pic.png": TextFirstHarness.png(200, 100)])
            #expect(h.display.hasPrefix("before ![alt text](pic.png) after"))
            let found = spans(h)
            #expect(found.count == 1)
            let (run, span) = found[0]
            #expect(run == NSRange(location: 7, length: 20))
            #expect(span.atom.destination == "pic.png" && span.atom.vault && !span.atom.remote)
            // Placeholder first: content width wide, 48 pt tall.
            // 200 x 100 pixels at the screen's scale.
            let scale = h.tv.traitCollection.displayScale
            #expect(await h.until { span.atom.image != nil })
            _ = await h.until { self.kern(h, at: 7) == 200 / scale }
            #expect(kern(h, at: 7) == 200 / scale)
            #expect(lineHeight(h, at: 7) == (100 / scale).rounded())
            let font = h.controller.storage.attribute(.font, at: 10, effectiveRange: nil) as! UIFont
            #expect(font.pointSize < 1)
            // Opening and styling changed no bytes.
            #expect(h.source == "before ![alt text](pic.png) after")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func aWideImageIsScaledToTheContentWidthKeepingItsAspect() async {
            let h = TextFirstHarness(
                "![](wide.png)\n", files: ["wide.png": TextFirstHarness.png(2000, 1000)])
            let width = h.controller.images.containerWidth
            #expect(width > 300)
            #expect(
                await h.until {
                    self.kern(h, at: 0) == width
                        && self.lineHeight(h, at: 0) == (width / 2).rounded()
                })
            #expect(kern(h, at: 0) == width)
            #expect(lineHeight(h, at: 0) == (width / 2).rounded())
        }

        @Test func aMissingOrOutsideFileShowsAPlaceholderAndEditingStaysUsable() async {
            let h = TextFirstHarness("![a](gone.png) ![b](../escape.png)\n")
            #expect(await h.until { self.spans(h).allSatisfy { $0.1.atom.failed } })
            #expect(spans(h).count == 2)
            #expect(lineHeight(h, at: 0) == TextFirstImageMetrics.failedHeight)
            h.select(h.tv.text.utf16.count - 1, h.tv.text.utf16.count - 1)
            h.type("x")
            #expect(h.source.contains("![b](../escape.png)x"))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func theLoaderResolvesOnlyImagesInsideTheVault() {
            let h = TextFirstHarness("x")
            let loader = h.controller.images.loader
            #expect(loader.resolve("a.png") != nil)
            #expect(loader.resolve("sub/a%20b.PNG")?.lastPathComponent == "a b.PNG")
            #expect(loader.resolve("../a.png") == nil)
            #expect(loader.resolve("sub/../../a.png") == nil)
            #expect(loader.resolve("/etc/passwd.png") == nil)
            #expect(loader.resolve("note.md") == nil)
        }

        @Test func anHttpsImageLoadsAndOfflineLeavesThePlaceholder() async {
            StubImageProtocol.responses = [
                "https://example.test/p.png": (200, TextFirstHarness.png(120, 60)),
                "https://example.test/bad.png": (500, Data()),
            ]
            let h = TextFirstHarness(
                "![](https://example.test/p.png)\n\n![](https://example.test/bad.png)\n",
                imageProtocols: [StubImageProtocol.self])
            let all = spans(h)
            #expect(all.count == 2)
            #expect(all.allSatisfy { $0.1.atom.remote && !$0.1.atom.vault })
            #expect(await h.until { all[0].1.atom.image != nil && all[1].1.atom.failed })
            // The Markdown is never rewritten.
            #expect(h.source.hasPrefix("![](https://example.test/p.png)"))
            h.select(0, 0)
            h.type("a")
            #expect(h.source.hasPrefix("a![](https://example.test/p.png)"))
        }

        @Test func caretStopsAreOnlyAtAnImagesEnds() {
            let h = TextFirstHarness("a ![x](p.png) b\n")
            // The image is characters 2..<13.
            h.select(5, 5)
            #expect(h.tv.selectedRange == NSRange(location: 2, length: 0))
            h.select(11, 11)
            #expect(h.tv.selectedRange == NSRange(location: 13, length: 0))
            // One step in from an end (an arrow key) crosses the whole image.
            h.select(2, 2)
            h.tv.selectedRange = NSRange(location: 3, length: 0)
            #expect(h.tv.selectedRange == NSRange(location: 13, length: 0))
            h.tv.selectedRange = NSRange(location: 12, length: 0)
            #expect(h.tv.selectedRange == NSRange(location: 2, length: 0))
            // A range ending inside the image ends at its nearer end.
            h.select(0, 4)
            #expect(h.tv.selectedRange == NSRange(location: 0, length: 2))
            h.select(0, 11)
            #expect(h.tv.selectedRange == NSRange(location: 0, length: 13))
        }

        @Test func aTapOnAnImageHitsItsRectAndEnterActsAfterIt() async {
            let h = TextFirstHarness(
                "![](p.png)\n", files: ["p.png": TextFirstHarness.png(150, 90)])
            let span = spans(h)[0].1
            // 150 x 90 pixels: 50 x 30 points at scale 3, drawn from the line's top-left.
            let scale = h.tv.traitCollection.displayScale
            let wide = 150 / scale
            let tall = (90 / scale).rounded()
            #expect(await h.until { self.lineHeight(h, at: 0) == tall })
            h.tv.layoutIfNeeded()
            let inset = h.tv.textContainerInset
            let hit = h.controller.imageHit(
                at: CGPoint(x: inset.left + wide / 2, y: inset.top + tall / 2))
            #expect(hit == NSRange(location: 0, length: 10))
            #expect(
                h.controller.imageHit(
                    at: CGPoint(x: inset.left + wide + 40, y: inset.top + tall / 2)) == nil)
            _ = span
            // Selected as one object, Enter keeps it and moves below.
            h.select(0, 10)
            _ = h.tv.delegate?.textView?(
                h.tv, shouldChangeTextIn: h.tv.selectedRange, replacementText: "\n")
            #expect(h.source.hasPrefix("![](p.png)"))
            #expect(h.source.count > "![](p.png)\n".count - 1)
            #expect(h.tv.selectedRange.length == 0 && h.tv.selectedRange.location >= 10)
        }

        @Test func aPhotoStoredSidewaysIsDecodedUpright() async {
            // 200 x 100 pixels with EXIF "rotate 90": 100 wide, 200 tall once turned.
            let h = TextFirstHarness(
                "![](photo.jpg)\n", files: ["photo.jpg": TextFirstHarness.rotatedJpeg(200, 100)])
            let span = spans(h)[0].1
            #expect(await h.until { span.atom.image != nil })
            let image = span.atom.image!
            #expect(image.size.height == image.size.width * 2)
        }

        @Test func aNarrowerViewRelaysOutAndReusesTheBitmap() async {
            let h = TextFirstHarness(
                "![](w.png)\n", files: ["w.png": TextFirstHarness.png(1000, 500)])
            let span = spans(h)[0].1
            #expect(await h.until { span.atom.image != nil })
            _ = await h.until { self.kern(h, at: 0) > 300 }
            let wide = kern(h, at: 0)
            h.window.frame.size.width = 300
            h.tv.frame = h.window.bounds
            h.tv.layoutIfNeeded()
            #expect(kern(h, at: 0) < wide)
            #expect(kern(h, at: 0) == h.controller.images.containerWidth)
        }

        @Test func backspaceDeletesTheWholeImageAndTextTypedAfterItIsPlain() {
            let h = TextFirstHarness("a ![](p.png) b\n")
            // Selected as one object: Backspace removes exactly it.
            h.select(2, 12)
            h.tv.deleteBackward()
            #expect(h.source == "a  b\n" || h.source == "a  b")
            #expect(spans(h).isEmpty)
            // A caret after an image: Backspace removes it whole too.
            let again = TextFirstHarness("a ![](p.png) b\n")
            again.select(12, 12)
            again.tv.deleteBackward()
            #expect(!again.source.contains("p.png"), "\(again.source.debugDescription)")
            #expect(again.controller.divergences.isEmpty && h.controller.divergences.isEmpty)
            // A forward Delete from before an image does the same; elsewhere it is not an image delete.
            let forward = TextFirstHarness("a ![](p.png) b\n")
            forward.select(2, 2)
            #expect(forward.controller.paragraphKey(.delete))
            #expect(!forward.source.contains("p.png"))
            // Typing right after an image gives plain text, not the image's hidden glyph look.
            let typed = TextFirstHarness("a ![](p.png) b\n")
            typed.select(12, 12)
            typed.type("z")
            #expect(typed.source.contains("![](p.png)z b"))
            let font =
                typed.controller.storage.attribute(.font, at: 12, effectiveRange: nil) as? UIFont
            #expect(font?.pointSize == 17)
            #expect(typed.controller.storage.attribute(.kern, at: 12, effectiveRange: nil) == nil)
        }

        // The Image and Camera items and a pasted image take a claim, save, then present it.
        @Test func aSavedImageIsInsertedAtTheCaretAndRefusedOnesAreDeleted() async throws {
            let h = TextFirstHarness("one two\n")
            h.select(4, 4)
            let claim = try #require(h.controller.beginImageInsertion())
            #expect(
                await h.controller.insertImage(
                    data: TextFirstHarness.png(8, 8), ext: "png", claim: claim))
            #expect(h.source.hasPrefix("one ![](image-"))
            #expect(h.source.contains(".png)two"))
            let vault = try FileManager.default.contentsOfDirectory(atPath: h.root.path)
            #expect(vault.filter { $0.hasPrefix("image-") }.count == 1)
            // A claim from another session is stale: nothing inserted, the file removed.
            let other = TextFirstHarness("other\n", id: "other")
            let foreign = try #require(other.controller.beginImageInsertion())
            let before = h.source
            #expect(
                !(await h.controller.insertImage(
                    data: TextFirstHarness.png(8, 8), ext: "png", claim: foreign)))
            #expect(h.source == before)
            let after = try FileManager.default.contentsOfDirectory(atPath: h.root.path)
            #expect(after.filter { $0.hasPrefix("image-") }.count == 1)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func anImageInsertedInsideCodeIsRefusedWithoutAFile() async throws {
            let h = TextFirstHarness("```\ncode\n```\n")
            h.select(5, 5)
            let claim = try #require(h.controller.beginImageInsertion())
            #expect(
                !(await h.controller.insertImage(
                    data: TextFirstHarness.png(4, 4), ext: "png", claim: claim)))
            #expect(h.source.hasPrefix("```\ncode\n```"))
            let vault = try FileManager.default.contentsOfDirectory(atPath: h.root.path)
            #expect(vault.allSatisfy { !$0.hasPrefix("image-") })
        }

        @Test func aPastedImageInsertsLikeAPickedOneButTextPasteIsUnchanged() async throws {
            let h = TextFirstHarness("one two\n")
            h.select(4, 4)
            UIPasteboard.general.image = UIImage(data: TextFirstHarness.png(6, 6))
            #expect(UIPasteboard.general.hasImages)
            #expect(h.controller.pasteImageFromPasteboard())
            #expect(await h.until { h.source.contains("![](image-") })
            #expect(h.source.hasPrefix("one ![](image-"))
            UIPasteboard.general.string = "plain"
            #expect(!h.controller.pasteImageFromPasteboard())
        }
    }
#endif
