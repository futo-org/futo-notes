import UIKit
import XCTest

/// The block drag's live preview with real touches (#448): the drop lands where the preview
/// drew the block, the preview appears without changing a pixel of the screen, the card, and
/// the drop line with Reduce Motion on. Read through the debug build's puppet `state` while the
/// finger is held.
final class TextFirstBlockReflowUITests: XCTestCase {
    /// (note, line lifted, line carried to and where on it, note after the drop)
    private let cases: [(String, Int, Int, CGFloat, String)] = [
        // The note's first line.
        ("alpha\nbravo\ncharlie\ndelta", 3, 0, 0.2, "delta\nalpha\nbravo\ncharlie"),
        // After the note's last line.
        ("alpha\nbravo\ncharlie\ndelta", 0, 3, 0.8, "bravo\ncharlie\ndelta\nalpha"),
        // An item down its own list.
        ("intro\n- a\n- b\n- c\nend", 1, 2, 0.8, "intro\n- b\n- a\n- c\nend"),
        // Next to a heading: just above it.
        ("one\ntwo\nthree\n## Head\nfour", 0, 2, 0.8, "two\nthree\none\n## Head\nfour"),
    ]

    @MainActor
    func testTheDropLandsWhereThePreviewDrewTheBlock() throws {
        for (text, line, to, at, after) in cases {
            let note = try TextFirstDragNote.open(text)
            let target = note.screen(
                dy: 4 + (CGFloat(to) + at) * TextFirstDragNote.lineStep)
            let finger = TextFirstTouch(down: note.screen(line: line)).hold(0.6)
                .move(to: target, over: 0.5).hold(0.8).lift()
            let states = try note.puppet.watch { try TextFirstTouch.perform([finger]) }
            let held = try XCTUnwrap(states.last { $0.blockDrag != nil }, text)
            XCTAssertEqual(held.preview, "reflow", text)
            XCTAssertTrue(held.reflowOpen, "the gap moved: \(text)")
            XCTAssertNil(held.dropLineY, "no drop line with the preview: \(text)")
            let copy = try XCTUnwrap(held.copyRect, text)
            XCTAssertTrue(note.saved(after), "it lands where the gap was: \(text)")
            // The lifted line is now drawn where the copy was (both rounded to whole points).
            let lifted = text.components(separatedBy: "\n")[line]
                .replacingOccurrences(of: "- ", with: "")
            let landed = try XCTUnwrap(
                note.puppet.post("/show", ["text": lifted])?["rect"] as? [String: Int], text)
            XCTAssertLessThanOrEqual(
                abs(landed["y"]! - copy["y"]!), 4, "\(text): drawn at \(landed), copy \(copy)")
            // The drop settled under the preview, which came down within 0.4 s of the release
            // (as the app timed it, from the release to the curtain's removal).
            let landing = Self.lastLanding(note)
            XCTAssertNotNil(landing, "\(text): a landing was made")
            XCTAssertLessThanOrEqual(landing ?? 1, 0.41, "\(text)")
            note.app.terminate()
        }
    }

    /// A plain line dropped into a checklist becomes a task when it lands (the copy in the gap
    /// shows it as it looked where it was lifted).
    @MainActor
    func testABlockDroppedIntoAListTakesItsShapeOnArrival() throws {
        let note = try TextFirstDragNote.open("alpha\n- [ ] one\n- [ ] two\nend")
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: 4 + 2.2 * TextFirstDragNote.lineStep), over: 0.5)
            .hold(0.8).lift()
        let states = try note.puppet.watch { try TextFirstTouch.perform([finger]) }
        let held = try XCTUnwrap(states.last { $0.blockDrag != nil })
        XCTAssertEqual(held.landsBefore, 3)
        XCTAssertTrue(note.saved("- [ ] one\n- [ ] alpha\n- [ ] two\nend"))
    }

    /// The preview appears without changing what the screen shows: the note with its block
    /// dimmed, and the curtain with the gap back home, are the same pixels, light and dark.
    @MainActor
    func testThePreviewAppearsWithoutChangingAPixel() throws {
        for appearance in [XCUIDevice.Appearance.light, .dark] {
            XCUIDevice.shared.appearance = appearance
            let note = try TextFirstDragNote.open(
                "# Title\nSome **bold** text and `code`.\nlifted\n- one\n  - nested\n- [x] done\n"
                    + "> quoted\n[link](https://example.com)\nlast line")
            let start = note.screen(line: 2)
            // Held 1.6 s, carried down three lines and back, held 1.6 s.
            let finger = TextFirstTouch(down: start).hold(1.6)
                .move(to: note.screen(line: 5), over: 0.3).hold(0.6)
                .move(to: start, over: 0.3).hold(1.6).lift()
            var shots: [UIImage] = []
            var looks: [[String: Any]] = []
            let began = Date()
            try TextFirstTouch.perform([finger]) {
                for at in [1.2, 3.9] {
                    Thread.sleep(forTimeInterval: max(0, at - Date().timeIntervalSince(began)))
                    looks.append(note.puppet.editor() ?? [:])
                    let shot = XCUIScreen.main.screenshot()
                    shots.append(shot.image)
                    let kept = XCTAttachment(screenshot: shot)
                    kept.name = "preview-\(appearance == .dark ? "dark" : "light")-\(at)"
                    kept.lifetime = .keepAlways
                    add(kept)
                }
            }
            XCTAssertFalse(looks[0].reflowOpen, "first: the note itself, its block dimmed")
            XCTAssertTrue(looks[1].reflowOpen && looks[1].landsBefore == nil, "then the curtain")
            let differing = Self.differing(shots[0], shots[1], in: note.editor.frame)
            XCTAssertEqual(differing, 0, "\(appearance.rawValue): \(differing) pixels differ")
            note.app.terminate()
        }
        XCUIDevice.shared.appearance = .light
    }

    /// A paragraph taller than the screen rides a card at most 40% of the screen tall, under
    /// the finger and clear of the screen's sides.
    @MainActor
    func testATallBlockRidesACappedCardOnScreen() throws {
        let tall = Array(repeating: "a paragraph taller than the screen", count: 40)
            .joined(separator: " ")
        let note = try TextFirstDragNote.open("first\n\(tall)\nlast")
        let finger = TextFirstTouch(down: note.screen(dy: note.editor.frame.height / 2)).hold(1.6)
            .lift()
        var held: [String: Any]?
        var shot: UIImage?
        try TextFirstTouch.perform([finger]) {
            Thread.sleep(forTimeInterval: 1.0)
            held = note.puppet.editor()
            shot = XCUIScreen.main.screenshot().image
        }
        let card = try XCTUnwrap(held?.blockDrag?["card"] as? [String: Int])
        let screen = note.app.frame
        XCTAssertLessThanOrEqual(CGFloat(card["h"]!), screen.height * 0.4 * 1.04 + 2, "\(card)")
        XCTAssertGreaterThanOrEqual(card["x"]!, 7, "\(card)")
        XCTAssertLessThanOrEqual(CGFloat(card["x"]! + card["w"]!), screen.width - 7, "\(card)")
        let y = note.editor.frame.minY + note.editor.frame.height / 2
        XCTAssertTrue(CGFloat(card["y"]!) < y && y < CGFloat(card["y"]! + card["h"]!), "\(card)")
        // The card shows the block's words, not only its background: dark text in its top half.
        let top = CGRect(
            x: CGFloat(card["x"]! + 20), y: CGFloat(card["y"]! + 20),
            width: CGFloat(card["w"]! - 40), height: CGFloat(card["h"]! / 2 - 20))
        XCTAssertGreaterThan(Self.dark(try XCTUnwrap(shot), in: top), 200, "\(card)")
    }

    /// With Reduce Motion on (here the debug build's stand-in for the setting) the drag shows
    /// the drop line and nothing slides.
    @MainActor
    func testWithReduceMotionTheDragShowsTheDropLine() throws {
        let note = try TextFirstDragNote.open(
            "alpha\nbravo\ncharlie\ndelta", arguments: ["-FUTODebugReduceMotion"])
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: 4 + 2.8 * TextFirstDragNote.lineStep), over: 0.5)
            .hold(0.8).lift()
        let states = try note.puppet.watch { try TextFirstTouch.perform([finger]) }
        let held = try XCTUnwrap(states.last { $0.blockDrag != nil })
        XCTAssertEqual(held.preview, "dropLine")
        XCTAssertNotNil(held.dropLineY)
        XCTAssertFalse(states.contains { $0.dragPreview }, "nothing slid")
        XCTAssertEqual(held.dropLineBefore, 4)
        XCTAssertTrue(note.saved("bravo\ncharlie\nalpha\ndelta"))
    }

    /// How long the last drop's preview covered the note after the release, once it has come
    /// down (within a second); nil when none did.
    static func lastLanding(_ note: TextFirstDragNote) -> Double? {
        let start = Date()
        while Date().timeIntervalSince(start) < 1 {
            if let seconds = note.puppet.editor()?["lastLanding"] as? Double { return seconds }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return nil
    }

    /// Pixels of `a` and `b` (screenshots) inside `frame` (points) that differ by more than
    /// 24 in a channel.
    static func differing(_ a: UIImage, _ b: UIImage, in frame: CGRect) -> Int {
        let (pa, pb) = (rgba(a), rgba(b))
        guard pa.width == pb.width, pa.bytes.count == pb.bytes.count else { return .max }
        let scale = a.scale
        var count = 0
        for row in Int(frame.minY * scale)..<min(pa.height, Int(frame.maxY * scale)) {
            for col in Int(frame.minX * scale)..<min(pa.width, Int(frame.maxX * scale)) {
                let i = (row * pa.width + col) * 4
                if (0..<3).contains(where: {
                    abs(Int(pa.bytes[i + $0]) - Int(pb.bytes[i + $0])) > 24
                }) {
                    count += 1
                }
            }
        }
        return count
    }

    /// Pixels of a screenshot inside `frame` (points) darker than mid grey (whose channels sum
    /// to less than `below`: 600 counts dimmed text too).
    static func dark(_ image: UIImage, in frame: CGRect, below: Int = 300) -> Int {
        let p = rgba(image)
        let scale = image.scale
        var count = 0
        for row in max(0, Int(frame.minY * scale))..<min(p.height, Int(frame.maxY * scale)) {
            for col in max(0, Int(frame.minX * scale))..<min(p.width, Int(frame.maxX * scale)) {
                let i = (row * p.width + col) * 4
                if Int(p.bytes[i]) + Int(p.bytes[i + 1]) + Int(p.bytes[i + 2]) < below {
                    count += 1
                }
            }
        }
        return count
    }

    private static func rgba(_ image: UIImage) -> (width: Int, height: Int, bytes: [UInt8]) {
        let cg = image.cgImage!
        var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        bytes.withUnsafeMutableBytes { raw in
            CGContext(
                data: raw.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8,
                bytesPerRow: cg.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )?.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        }
        return (cg.width, cg.height, bytes)
    }
}
