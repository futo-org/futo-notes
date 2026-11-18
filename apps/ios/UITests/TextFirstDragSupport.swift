import UIKit
import XCTest

/// A note open in the editor with the keyboard down, its file on disk, and the app's puppet
/// listener, for the block drag's UI tests.
struct TextFirstDragNote {
    let app: XCUIApplication
    let editor: XCUIElement
    let file: URL
    let puppet: TextFirstPuppetProbe

    static let lineStep = UIFont.systemFont(ofSize: 17).lineHeight + 4

    /// Open `text` as `drag.md` in a fresh vault holding `files` beside it.
    @MainActor
    static func open(_ text: String, files: [String: Data] = [:]) throws -> TextFirstDragNote {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("text-first-block-drag-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("drag.md")
        try text.write(to: file, atomically: true, encoding: .utf8)
        for (name, data) in files { try data.write(to: root.appendingPathComponent(name)) }
        let app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = root.path
        let puppet = TextFirstPuppetProbe()
        app.launchEnvironment["FUTO_PUPPET_PORT"] = String(puppet.port)
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "drag"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let editor = app.textViews["text-first-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        return TextFirstDragNote(app: app, editor: editor, file: file, puppet: puppet)
    }

    /// A point on plain body line `index` (from 0, as laid out unscrolled): a 4 pt inset, then
    /// the body font's line plus 4 pt spacing each.
    func line(_ index: Int, x: CGFloat = 60) -> XCUICoordinate {
        let y = 4 + (CGFloat(index) + 0.5) * Self.lineStep
        return editor.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    /// Screen points for the synthesized touches: `dy` below the editor's top, `x` from its left.
    func screen(x: CGFloat = 60, dy: CGFloat) -> CGPoint {
        CGPoint(x: editor.frame.minX + x, y: editor.frame.minY + dy)
    }

    /// Screen point of body line `index` as laid out unscrolled.
    func screen(line index: Int, x: CGFloat = 60) -> CGPoint {
        screen(x: x, dy: 4 + (CGFloat(index) + 0.5) * Self.lineStep)
    }

    func saved(_ matches: @escaping (String) -> Bool, within timeout: TimeInterval = 5) -> Bool {
        let landed = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                (try? String(contentsOf: file, encoding: .utf8)).map(matches) ?? false
            }, object: nil)
        return XCTWaiter.wait(for: [landed], timeout: timeout) == .completed
    }

    func saved(_ text: String) -> Bool { saved { $0 == text } }

    var onDisk: String? { try? String(contentsOf: file, encoding: .utf8) }
}

/// Real touches with several segments (hold, carry, hold again, lift) and more than one finger,
/// which XCUICoordinate's single press-drag-hold cannot make. They are XCTest's own synthesized
/// events, the private `XCPointerEventPath` and `XCSynthesizedEventRecord` behind every
/// XCUICoordinate gesture, reached through the Objective-C runtime.
final class TextFirstTouch {
    fileprivate let path: NSObject
    private var at: TimeInterval
    private var position: CGPoint

    /// A finger coming down at screen point `p`, `at` seconds into the gesture.
    init(down p: CGPoint, at time: TimeInterval = 0) {
        let type: AnyClass = NSClassFromString("XCPointerEventPath")!
        let make = NSSelectorFromString("initForTouchAtPoint:offset:")
        typealias Make =
            @convention(c) (AnyObject, Selector, CGPoint, Double) -> Unmanaged<
                NSObject
            >
        let blank = (type as! NSObject.Type).perform(NSSelectorFromString("alloc"))!
        path = unsafeBitCast(class_getMethodImplementation(type, make), to: Make.self)(
            blank.takeUnretainedValue(), make, p, time
        ).takeRetainedValue()
        (at, position) = (time, p)
    }

    /// Keep still for `seconds`. XCTest glides a finger from one event to the next, so the
    /// hold ends with an event where it is: the next move starts from there, then.
    @discardableResult func hold(_ seconds: TimeInterval) -> Self {
        at += seconds
        moveTo(position, at: at)
        return self
    }

    /// Carry the finger to `p` over `seconds`, at 60 moves a second.
    @discardableResult func move(to p: CGPoint, over seconds: TimeInterval) -> Self {
        let steps = max(1, Int(seconds * 60))
        let from = position
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let q = CGPoint(x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t)
            moveTo(q, at: at + seconds * Double(t))
        }
        (at, position) = (at + seconds, p)
        return self
    }

    private func moveTo(_ p: CGPoint, at time: TimeInterval) {
        let move = NSSelectorFromString("moveToPoint:atOffset:")
        typealias Move = @convention(c) (AnyObject, Selector, CGPoint, Double) -> Void
        unsafeBitCast(path.method(for: move), to: Move.self)(path, move, p, time)
    }

    @discardableResult func lift() -> Self {
        let up = NSSelectorFromString("liftUpAtOffset:")
        typealias Up = @convention(c) (AnyObject, Selector, Double) -> Void
        unsafeBitCast(path.method(for: up), to: Up.self)(path, up, at)
        return self
    }

    /// Play `touches` together; returns when the last has lifted.
    static func perform(_ touches: [TextFirstTouch]) throws {
        let type: AnyClass = NSClassFromString("XCSynthesizedEventRecord")!
        let make = NSSelectorFromString("initWithName:interfaceOrientation:")
        typealias Make = @convention(c) (AnyObject, Selector, NSString, Int) -> Unmanaged<NSObject>
        let blank = (type as! NSObject.Type).perform(NSSelectorFromString("alloc"))!
        let record = unsafeBitCast(class_getMethodImplementation(type, make), to: Make.self)(
            blank.takeUnretainedValue(), make, "block drag" as NSString,
            UIInterfaceOrientation.portrait.rawValue
        ).takeRetainedValue()
        let add = NSSelectorFromString("addPointerEventPath:")
        typealias Add = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        for touch in touches {
            unsafeBitCast(record.method(for: add), to: Add.self)(record, add, touch.path)
        }
        let play = NSSelectorFromString("synthesizeWithError:")
        typealias Play =
            @convention(c) (
                AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>
            ) -> Bool
        var error: NSError?
        let played = unsafeBitCast(record.method(for: play), to: Play.self)(record, play, &error)
        guard played else { throw error ?? NSError(domain: "TextFirstTouch", code: 1) }
    }
}

/// The app's debug puppet listener, read and driven over loopback HTTP from a background
/// thread, so a test can see the editor's state (the drag's drop line among it) and change the
/// note while a synthesized finger is still held.
final class TextFirstPuppetProbe: @unchecked Sendable {
    let port = UInt16.random(in: 20_000..<40_000)

    /// POST `path` with `body`; the JSON reply, nil on any failure.
    func post(_ path: String, _ body: [String: Any] = [:]) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = "POST"
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 5
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var reply: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            reply = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.signal()
        }.resume()
        done.wait()
        return reply
    }

    /// The open editor's state.
    func editor() -> [String: Any]? {
        guard let state = post("/state") else { return nil }
        return state["editor"] as? [String: Any] ?? state
    }

    /// Poll the editor's state every 50 ms on a background thread while `run` runs (the
    /// touches), handing each to `look` there; the states seen, in order.
    func watch(
        while run: () throws -> Void, look: @escaping @Sendable ([String: Any]) -> Void = { _ in }
    ) rethrows -> [[String: Any]] {
        let seen = TextFirstStates()
        let stop = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        Thread.detachNewThread { [self] in
            while stop.wait(timeout: .now() + 0.05) == .timedOut {
                if let state = editor() {
                    seen.append(state)
                    look(state)
                }
            }
            stopped.signal()
        }
        defer {
            stop.signal()
            stopped.wait()
        }
        try run()
        return seen.all
    }
}

/// States collected on the watcher's thread.
final class TextFirstStates: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [[String: Any]] = []
    func append(_ state: [String: Any]) { lock.withLock { states.append(state) } }
    var all: [[String: Any]] { lock.withLock { states } }
}

extension Dictionary where Key == String, Value == Any {
    /// The drag's report in an editor state (`blockDrag`), nil with no drag.
    var blockDrag: [String: Any]? { self["blockDrag"] as? [String: Any] }
    /// The line the drop line shows a release would land above; 0 for the note's end.
    var dropLineBefore: Int? {
        guard let shows = blockDrag?["dropLine"] as? [String: Any] else { return nil }
        return shows["end"] != nil ? 0 : shows["before"] as? Int
    }
    var firstLineOnScreen: Int? { (self["onScreen"] as? [String: Any])?["first"] as? Int }
    var lastLineOnScreen: Int? { (self["onScreen"] as? [String: Any])?["last"] as? Int }
}
