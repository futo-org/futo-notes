import XCTest

/// Real-finger driver for `scripts/perf/block-drag-bench.mjs --device ios-app`.
///
/// XCUITest supplies the touches (a long-press drag cannot be synthesised from
/// the page); the measurement lives in the page, where
/// `scripts/perf/block-drag-bench/ios-app.mjs` injects a frame recorder over the
/// WebKit inspector (ios_webkit_debug_proxy). The two meet through the page: the
/// runner puts a one-line command in a tiny accessible element
/// (`BENCH:<verb>:<x>:<y>:<x2>:<y2>:<holdMs>`), this test performs it and the
/// element goes away when the finger lifts. Coordinates are page CSS px, which
/// are WebView points.
///
/// The probe script is `BlockDragBenchProbe.js`, generated into this directory
/// (gitignored) by the runner; without it this test skips. It reaches the app
/// through `FUTO_BLOCK_DRAG_BENCH_JS` (BlockDragBenchProbe.swift, DEBUG only).
final class BlockDragBenchTests: XCTestCase {
    @MainActor
    func testDriveBlockDragBench() throws {
        guard
            let probeURL = Bundle(for: Self.self).url(
                forResource: "BlockDragBenchProbe", withExtension: "js"),
            let probe = try? String(contentsOf: probeURL, encoding: .utf8)
        else { throw XCTSkip("no generated BlockDragBenchProbe.js: device-only perf driver") }
        let app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_BLOCK_DRAG_BENCH_JS"] = probe
        app.launch()
        let create = app.buttons["nav-create"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 10))

        let origin = web.coordinate(withNormalizedOffset: .zero)
        func at(_ x: Double, _ y: Double) -> XCUICoordinate {
            origin.withOffset(CGVector(dx: x, dy: y))
        }
        var shots = 0
        let deadline = Date().addingTimeInterval(900)
        let command = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'BENCH:'")).firstMatch
        while Date() < deadline {
            guard command.waitForExistence(timeout: 2) else { continue }
            let parts = command.label.split(separator: ":").map(String.init)
            guard parts.count >= 7, let x = Double(parts[2]), let y = Double(parts[3]),
                let x2 = Double(parts[4]), let y2 = Double(parts[5]), let hold = Double(parts[6])
            else { continue }
            switch parts[1] {
            case "lift":
                // Long press, then a slow drag through many slots, then rest.
                at(x, y).press(
                    forDuration: 0.6, thenDragTo: at(x2, y2),
                    withVelocity: XCUIGestureVelocity(300), thenHoldForDuration: hold / 1000)
            case "edge":
                // Long press, drag to the top/bottom edge, hold there to auto-scroll.
                at(x, y).press(
                    forDuration: 0.6, thenDragTo: at(x2, y2),
                    withVelocity: XCUIGestureVelocity(500), thenHoldForDuration: hold / 1000)
            case "scroll":
                // Touch-down on a block, then an ordinary scroll.
                at(x, y).press(
                    forDuration: 0.05, thenDragTo: at(x2, y2),
                    withVelocity: XCUIGestureVelocity(hold), thenHoldForDuration: 0.3)
            case "hold":
                // Long hold with no motion; screenshots at 1.5s, mid-press.
                let name = parts.count > 7 ? parts[7] : "hold\(shots)"
                shots += 1
                let t = Thread {
                    Thread.sleep(forTimeInterval: 1.5)
                    let shot = XCUIScreen.main.screenshot()
                    let a = XCTAttachment(screenshot: shot)
                    a.name = name
                    a.lifetime = .keepAlways
                    self.add(a)
                }
                t.start()
                at(x, y).press(forDuration: hold / 1000)
                Thread.sleep(forTimeInterval: 0.6)
            case "tap":
                at(x, y).tap()
            case "done":
                return
            default:
                break
            }
            // The runner removes the element on its own; this just stops a
            // finished command being replayed if it is slow to.
            let gone = NSPredicate(format: "exists == false")
            wait(for: [expectation(for: gone, evaluatedWith: command)], timeout: 20)
        }
    }
}
