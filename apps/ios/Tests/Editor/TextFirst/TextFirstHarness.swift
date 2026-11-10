#if DEBUG
    import Foundation
    import Testing
    import ImageIO
    import UIKit

    @testable import FutoNotesNative

    /// A real text-first editor on a real vault, in a window, for driving UITextInput calls.
    @MainActor
    final class TextFirstHarness {
        let root: URL
        let store: NoteStore
        let controller: TextFirstEditorController
        let window: UIWindow
        var tv: TextFirstTextView { controller.textView }

        init(
            _ source: String, id: String = "note", imageProtocols: [AnyClass]? = nil,
            files: [String: Data] = [:]
        ) {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-\(UUID().uuidString)")
            try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            for (name, data) in files {
                let url = root.appendingPathComponent(name)
                try! FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try! data.write(to: url)
            }
            store = NoteStore(notesRoot: root.path)
            _ = try! store.createNote(title: id, folder: "", content: source)

            controller = try! TextFirstEditorController(
                noteId: id, session: try! store.openEditor(id: id), imageRoot: root,
                imageProtocols: imageProtocols)
            controller.verifyDivergence = true
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            tv.layoutIfNeeded()
            _ = tv.becomeFirstResponder()
        }

        /// The store writes every note with a final line ending; the rows are written without one.
        static func trimmed(_ text: String) -> String {
            text.hasSuffix("\n") && !text.hasSuffix("\n\n") ? String(text.dropLast()) : text
        }
        var source: String { Self.trimmed(try! controller.session.sourceText()) }
        var display: String { Self.trimmed(tv.text ?? "") }
        var isComposing: Bool { (try? controller.session.composition()).flatMap { $0 } != nil }

        /// A solid-colour PNG of the given point size at scale 1.
        static func png(_ width: Int, _ height: Int) -> Data {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(
                size: CGSize(width: width, height: height), format: format
            )
            .pngData { ctx in
                UIColor.systemOrange.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
            }
        }

        /// A JPEG of the given pixel size whose EXIF orientation says "rotate 90 degrees".
        static func rotatedJpeg(_ width: Int, _ height: Int) -> Data {
            let source = UIImage(data: png(width, height))!.cgImage!
            let data = NSMutableData()
            let destination = CGImageDestinationCreateWithData(
                data, "public.jpeg" as CFString, 1, nil)!
            CGImageDestinationAddImage(
                destination, source, [kCGImagePropertyOrientation: 6] as CFDictionary)
            CGImageDestinationFinalize(destination)
            return data as Data
        }

        /// Spin the main loop until `condition` holds (an image load, a coalesced restyle).
        func until(_ seconds: Double = 5, _ condition: () -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            while !condition() && Date() < deadline {
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            return condition()
        }

        func select(_ a: Int, _ b: Int) { tv.selectedRange = NSRange(location: a, length: b - a) }

        /// The laid-out heights of the visual lines of the paragraph holding UTF-16 offset `i`.
        func lineHeights(at i: Int = 0) -> [CGFloat] {
            tv.layoutIfNeeded()
            let manager = tv.textLayoutManager!
            guard
                let location = manager.location(manager.documentRange.location, offsetBy: i),
                let fragment = manager.textLayoutFragment(for: location)
            else { return [] }
            return fragment.textLineFragments.map { $0.typographicBounds.height }
        }

        /// The visual lines of the paragraph holding UTF-16 offset `i`: the display characters each
        /// holds (newline included) and its laid-out height. The empty line after a final newline is
        /// left out.
        func visualLines(at i: Int = 0) -> [(range: NSRange, text: String, height: CGFloat)] {
            tv.layoutIfNeeded()
            let manager = tv.textLayoutManager!
            guard
                let location = manager.location(manager.documentRange.location, offsetBy: i),
                let fragment = manager.textLayoutFragment(for: location)
            else { return [] }
            let start = manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            let text = (tv.text ?? "") as NSString
            return fragment.textLineFragments.filter { $0.characterRange.length > 0 }.map { line in
                let range = NSRange(
                    location: start + line.characterRange.location,
                    length: line.characterRange.length)
                return (range, text.substring(with: range), line.typographicBounds.height)
            }
        }

        /// One keyboard key: the delegate is asked first, as UIKeyboardImpl does, then UIKit inserts.
        func type(_ text: String) {
            for character in text {
                let s = String(character)
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: s) ?? true
                {
                    tv.insertText(s)
                }
            }
        }

        /// Re-attach a fresh editor to the same vault (the previous one must be detached).
        func reopen(id: String = "note") throws -> TextFirstHarness {
            TextFirstHarness(root: root, id: id)
        }

        init(root: URL, id: String) {
            self.root = root
            store = NoteStore(notesRoot: root.path)
            controller = try! TextFirstEditorController(
                noteId: id, session: try! store.openEditor(id: id), imageRoot: root)
            controller.verifyDivergence = true
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            tv.layoutIfNeeded()
            _ = tv.becomeFirstResponder()
        }
    }
#endif
