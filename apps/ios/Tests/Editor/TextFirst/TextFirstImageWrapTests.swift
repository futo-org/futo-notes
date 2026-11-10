#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Where the lines of a paragraph break around an image (#404): the text before a photo stays
    /// on as few lines as it needs and a photo too wide to share the line moves down on its own.
    /// The image's `![` spelling is one unbreakable run with the word before it unless the
    /// typesetter is told it may break there, so these assert the laid-out lines, not attributes.
    @Suite @MainActor
    struct TextFirstImageWrapTests {
        static let files = [
            "w.png": TextFirstHarness.png(1800, 2400),
            "s.png": TextFirstHarness.png(60, 40),
        ]

        /// Open `source`, show it at `width`, and wait for every image to load and the lines to settle.
        private func open(_ source: String, width: CGFloat = 390) async -> TextFirstHarness {
            let h = TextFirstHarness(source, files: Self.files)
            await settle(h)
            if width != 390 {
                // Resized once the first decode is done, as a rotation is: a wider view decodes again.
                resize(h, width)
                await settle(h)
            }
            return h
        }

        private func resize(_ h: TextFirstHarness, _ width: CGFloat) {
            h.window.frame.size.width = width
            h.tv.frame = h.window.bounds
            h.tv.layoutIfNeeded()
        }

        /// Every image is decoded as wide as the view now wants it (a wider view decodes again).
        private func settle(_ h: TextFirstHarness) async {
            let pixels = Int(h.controller.images.containerWidth * h.tv.traitCollection.displayScale)
            _ = await h.until {
                var pending = false
                let all = NSRange(location: 0, length: h.controller.storage.length)
                h.controller.storage.enumerateAttribute(.tfImage, in: all) { v, _, _ in
                    guard let span = v as? TextFirstImageSpan else { return }
                    let atom = span.atom
                    if atom.image == nil
                        || atom.decodedPixelWidth + 2 < min(atom.naturalPixelWidth, pixels)
                    {
                        pending = true
                    }
                }
                return !pending
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
            h.tv.layoutIfNeeded()
        }

        /// The lines' text with the image spelling shown as `<img>`.
        private func shape(_ h: TextFirstHarness, at i: Int = 0) -> [String] {
            h.visualLines(at: i).map { line in
                let text = line.text.replacingOccurrences(of: "\n", with: "")
                let tall = line.height > 40
                return (tall ? "tall:" : "") + text
            }
        }

        private let wide = "![](w.png)"

        @Test func textBeforeAFullWidthPhotoStaysOnOneLine() async {
            let h = await open("Hello world\(wide)\n")
            #expect(shape(h) == ["Hello world", "tall:\(wide)"], "\(h.visualLines())")
        }

        @Test func aSpaceBeforeTheFullWidthPhotoChangesNothing() async {
            let h = await open("Hello world \(wide)\n")
            #expect(shape(h) == ["Hello world ", "tall:\(wide)"], "\(h.visualLines())")
        }

        @Test func textBeforeAFullWidthPhotoStaysOnOneLineWhenTheViewIsWide() async {
            let h = await open("Hello world\(wide)\n", width: 700)
            #expect(shape(h) == ["Hello world", "tall:\(wide)"], "\(h.visualLines())")
        }

        @Test func aPhotoInsertedAfterTypedTextLandsOnTheNextLine() async throws {
            let h = TextFirstHarness("\n", files: Self.files)
            h.select(0, 0)
            h.type("Hello world")
            let claim = try #require(h.controller.beginImageInsertion())
            #expect(
                await h.controller.insertImage(
                    data: TextFirstHarness.png(1800, 2400), ext: "png", claim: claim))
            #expect(h.source.hasPrefix("Hello world![](image-"))
            await settle(h)
            let lines = shape(h)
            #expect(lines.count == 2, "\(lines)")
            #expect(lines.first == "Hello world", "\(lines)")
            #expect(lines.last?.hasPrefix("tall:![](image-") == true, "\(lines)")
        }

        @Test func aPhotoAloneOnItsLineIsUnchanged() async {
            let h = await open("\(wide)\n")
            #expect(shape(h) == ["tall:\(wide)"], "\(h.visualLines())")
        }

        @Test func aPhotoFirstInTheNoteKeepsOrdinaryTextAfterIt() async {
            let h = await open("\(wide) a caption long enough to wrap onto more lines than one\n")
            let lines = shape(h)
            #expect(lines.first?.hasPrefix("tall:\(wide)") == true, "\(lines)")
            #expect(
                lines.dropFirst().allSatisfy { !$0.hasPrefix("tall:") && !$0.isEmpty }, "\(lines)")
            #expect(lines.count >= 2, "\(lines)")
        }

        @Test func aPhotoLastInTheNoteWithTextBeforeIt() async {
            let h = await open("one two three four five six seven eight nine ten\(wide)")
            let lines = shape(h)
            #expect(lines.last == "tall:\(wide)", "\(lines)")
            #expect(lines.dropLast().allSatisfy { !$0.hasPrefix("tall:") }, "\(lines)")
            #expect(
                lines.dropLast().joined() == "one two three four five six seven eight nine ten",
                "\(lines)")
        }

        @Test func textOnBothSidesOfAPhoto() async {
            let h = await open("Hello world\(wide) and then some more words after it\n")
            let lines = shape(h)
            #expect(lines.first == "Hello world", "\(lines)")
            #expect(lines.filter { $0.hasPrefix("tall:") }.count == 1, "\(lines)")
            #expect(lines.joined(separator: "").contains("after it"), "\(lines)")
        }

        @Test func twoPhotosOnOneLineEachGetTheirOwn() async {
            let h = await open("Hello world\(wide)\(wide)\n")
            #expect(
                shape(h) == ["Hello world", "tall:\(wide)", "tall:\(wide)"], "\(h.visualLines())")
        }

        @Test func aSmallPhotoThatFitsStaysBesideTheText() async {
            let h = await open("Hello world![](s.png) there\n")
            #expect(h.visualLines().count == 1, "\(h.visualLines())")
            #expect(h.visualLines()[0].height < 60, "\(h.visualLines())")
        }

        @Test func twoSmallPhotosShareOneLine() async {
            let h = await open("a![](s.png)![](s.png)b\n")
            #expect(h.visualLines().count == 1, "\(h.visualLines())")
        }

        @Test func aSmallPhotoTooWideForTheRestOfTheLineMovesDownWithoutSplittingTheText() async {
            let h = await open(
                "Hello world and a few more words on the line![](s.png)\n", width: 300)
            let lines = h.visualLines()
            // The text before it wraps like text; the photo shares the last of its lines.
            #expect(
                lines.map(\.text).joined()
                    == "Hello world and a few more words on the line![](s.png)\n")
            #expect(lines.filter { $0.height > 30 }.count <= 1, "\(lines)")
        }

        @Test func aPhotoInAListItemQuoteAndHeading() async {
            for (prefix, name) in [("- ", "list"), ("> ", "quote"), ("# ", "heading")] {
                let h = await open("\(prefix)Hello world\(wide)\n")
                let lines = shape(h)
                #expect(lines == ["Hello world", "tall:\(wide)"], "\(name): \(h.visualLines())")
            }
        }

        @Test func aWidthChangeAfterLayoutKeepsTheTextTogether() async {
            let h = await open("Hello world\(wide)\n")
            for width in [300.0, 700.0, 390.0] {
                resize(h, width)
                await settle(h)
                #expect(
                    shape(h) == ["Hello world", "tall:\(wide)"], "@\(width): \(h.visualLines())")
            }
        }

        /// The kern is sized for a spelling that starts with `!`; the character the typesetter is
        /// shown instead must not be wider, or a full-width photo's line would overflow by the
        /// difference and its last characters wrap onto a line of their own.
        @Test func theBreakCharacterIsNoWiderThanTheBangItStandsFor() {
            let shown = TextFirstImageBreakDelegate.breakBefore
            #expect((shown as NSString).length == 1)
            #expect(
                TextFirstImageMetrics.textAdvance(shown) <= TextFirstImageMetrics.textAdvance("!"))
        }

        /// The fix changes what the typesetter is shown, not the note: the display text, the
        /// offsets and the caret all stay as they were.
        @Test func theDisplayTextAndItsOffsetsAreUnchanged() async {
            let source = "Hello world\(wide)after\n"
            let h = await open(source)
            #expect(h.tv.text == source)
            #expect(h.controller.storage.string == source)
            let length = (source as NSString).length
            let lines = h.visualLines()
            #expect(lines.map(\.range.length).reduce(0, +) == length - 1 + 1, "\(lines)")
            var next = 0
            for line in lines {
                #expect(line.range.location == next, "\(lines)")
                next = NSMaxRange(line.range)
            }
            // Offsets outside the spelling round-trip through UITextInput; one inside it snaps to
            // an end of the image, as it always did.
            for offset in 0...(length - 1) {
                h.select(offset, offset)
                if (11...21).contains(offset) && offset != 11 && offset != 21 {
                    #expect([11, 21].contains(h.tv.selectedRange.location), "offset \(offset)")
                } else {
                    #expect(
                        h.tv.selectedRange == NSRange(location: offset, length: 0),
                        "offset \(offset)")
                }
                let position = h.tv.position(from: h.tv.beginningOfDocument, offset: offset)!
                #expect(h.tv.offset(from: h.tv.beginningOfDocument, to: position) == offset)
            }
            // "world" is selected on the first line, left of the photo.
            let selection = h.tv.selectionRects(
                for: h.tv.textRange(
                    from: h.tv.position(from: h.tv.beginningOfDocument, offset: 6)!,
                    to: h.tv.position(from: h.tv.beginningOfDocument, offset: 11)!)!)
            #expect(selection.allSatisfy { $0.rect.minY < 40 }, "\(selection.map(\.rect))")
        }
    }
#endif
