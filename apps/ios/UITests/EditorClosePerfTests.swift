import XCTest

/// The finger for `scripts/perf/ios-close-bench.mjs`: how long leaving a note
/// takes, from the Back tap to the list being back on screen, on notes of the
/// sizes the runner asks for, clean and with an unsaved edit.
///
/// XCUITest is the only driver that reaches a headless simulator (`axe tap`
/// reports success and does nothing there), and it is also the only observer
/// of the tap itself: the app first hears of a system pop when the path
/// shrinks. So this records the host wall clock around the tap and the moment
/// the list is back, one JSON line per sample, and the in-app `CloseLedger`
/// (os_log, same clock) supplies the phases in between.
///
/// The tap is a coordinate tap at the Back button's frame, captured before
/// the measured window: resolving the element at tap time snapshots the open
/// web view's accessibility tree, which cost 21 s on a 1k-line note and would
/// swamp the number being measured.
///
/// Configured by `FUTO_CLOSE_PERF_CONFIG` (JSON: `{"sizes":[1000,10000],
/// "repeat":5}`) and `FUTO_CLOSE_PERF_OUT` (an absolute results path on this
/// machine); without both it skips, so a plain `just test-ios-native-ui` run is
/// unaffected. Each sample launches the app fresh against its own seeded vault
/// under the results directory — never a developer's vault.
final class EditorClosePerfTests: XCTestCase {
    /// Center of the keyboard's "x" key, learned on the first dirty sample.
    @MainActor private var keyCenter: CGPoint?

    private struct Config: Decodable {
        var sizes: [Int]
        var samples: Int
        enum CodingKeys: String, CodingKey {
            case sizes
            case samples = "repeat"
        }
    }

    @MainActor
    func testMeasureLeavingANote() throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["FUTO_CLOSE_PERF_CONFIG"], let out = env["FUTO_CLOSE_PERF_OUT"],
            out.hasPrefix("/"),
            let config = try? JSONDecoder().decode(Config.self, from: Data(raw.utf8))
        else {
            throw XCTSkip("TEST_RUNNER_FUTO_CLOSE_PERF_CONFIG / _OUT absent: bench-only driver")
        }
        let outURL = URL(fileURLWithPath: out)
        let workDir = outURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: out, contents: Data())

        // Interleave: every (size, dirty) pair gets its n-th sample before any
        // pair gets its (n+1)-th, so a drift in the machine's load lands on
        // every cell alike.
        for sample in 0..<config.samples {
            // Smallest first, so the one keyboard query (keyCenter) runs
            // against the cheapest page.
            for size in config.sizes.sorted() {
                for dirty in [false, true] {
                    let record = try measure(
                        size: size, dirty: dirty, sample: sample, workDir: workDir)
                    let line = try JSONSerialization.data(withJSONObject: record)
                    let handle = try FileHandle(forWritingTo: outURL)
                    handle.seekToEndOfFile()
                    handle.write(line + Data("\n".utf8))
                    try handle.close()
                }
            }
        }
    }

    @MainActor
    private func measure(size: Int, dirty: Bool, sample: Int, workDir: URL) throws -> [String: Any]
    {
        let title = "Perf \(size)"
        let vault = workDir.appendingPathComponent(
            "vault-\(size)-\(dirty ? "dirty" : "clean")-\(sample)")
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        try noteBody(lines: size).write(
            to: vault.appendingPathComponent("\(title).md"), atomically: true, encoding: .utf8)

        let app = XCUIApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = vault.path
        app.launchEnvironment["FUTO_NOTES_UI_TEST_RUN_ID"] = "close-perf-\(size)-\(sample)"
        // Touch marks for the tap anchor, and the debounced save held so a
        // "dirty" sample is still dirty when Back lands (CloseLedger.swift).
        app.launchEnvironment["FUTO_CLOSE_PERF"] = "1"
        app.launch()

        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the seeded note is not listed")
        row.tap()
        // Every XCUITest query snapshots the accessibility tree, and the open
        // note's web view makes that cost SECONDS: resolving the Back button
        // at tap time took 21 s on a 1k-block note. Worse, a query that
        // reaches INTO the web view makes WebKit build the whole document's
        // accessibility tree, which on a 10k-block note held the app's main
        // run loop past XCTest's 60 s limit. So the one query here is the nav
        // bar's Back button, `firstMatch` so it stops before the web view, and
        // its frame is read at once. Nothing after this looks inside the page.
        let back = app.navigationBars.buttons["BackButton"].firstMatch
        guard back.waitForExistence(timeout: 60) else {
            // Leave the screen behind for the runner: the assertion alone
            // says nothing about WHAT was on screen instead of the editor.
            try? app.debugDescription.write(
                to: workDir.appendingPathComponent("no-editor-\(size)-\(sample).txt"),
                atomically: true, encoding: .utf8)
            XCTFail("the editor did not open")
            return [:]
        }
        let backFrame = back.frame
        let backPoint = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: backFrame.midX, dy: backFrame.midY))
        // Let the open settle (the progressive tail streams in behind the
        // first viewport) so the close is measured on its own. A fixed wait,
        // scaled to the note, because asking the page whether it is done is
        // the query that stalls it. A dirty sample proves the note loaded:
        // the bench fails one whose Back commit wrote nothing.
        sleep(UInt32(2 + size / 1000))

        if dirty {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            sleep(1)
            // `typeText` resolves the focused element through the page, so
            // the edit is a coordinate tap on the keyboard's "x" key, whose
            // place is learned once, on the first and smallest dirty sample.
            if keyCenter == nil {
                XCTAssertTrue(
                    app.keyboards.firstMatch.waitForExistence(timeout: 30),
                    "tapping the body raised no keyboard")
                let key = app.keyboards.keys
                    .matching(NSPredicate(format: "label ==[c] 'x' OR identifier ==[c] 'x'"))
                    .firstMatch
                guard key.waitForExistence(timeout: 10) else {
                    try? app.keyboards.firstMatch.debugDescription.write(
                        to: workDir.appendingPathComponent("keyboard-\(size)-\(sample).txt"),
                        atomically: true, encoding: .utf8)
                    XCTFail("the keyboard has no x key")
                    return [:]
                }
                keyCenter = CGPoint(x: key.frame.midX, y: key.frame.midY)
            }
            let center = try XCTUnwrap(keyCenter)
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: center.x, dy: center.y)).tap()
            // Past the editor's 200 ms change debounce. The shell's own body
            // save is held for the bench (FUTO_CLOSE_PERF), so nothing is on
            // disk: the Back commit is the write.
            usleep(500_000)
        }

        // XCUITest spends 1-3 s inside this call before the touch is
        // synthesized, so these clock reads only bracket the tap; the app's
        // `touchUp` ledger mark is the anchor every phase is measured from.
        // No query runs during the pop: an accessibility snapshot of the
        // departing web view would load the very main thread being measured.
        let tapEpochMs = nowEpochMs()
        backPoint.tap()
        let tapReturnedEpochMs = nowEpochMs()
        // The commit chain keeps running after the pop; give it time to finish
        // before the app is torn down, so the ledger has every phase.
        sleep(4)
        XCTAssertTrue(app.navigationBars["Notes"].exists, "Back did not return to the list")
        XCTAssertFalse(back.exists, "the editor is still on screen after Back")
        app.terminate()

        return [
            "size": size,
            "dirty": dirty,
            "sample": sample,
            "tapEpochMs": tapEpochMs,
            "tapReturnedEpochMs": tapReturnedEpochMs,
        ]
    }

    private func nowEpochMs() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded())
    }

    /// The device perf runner's real-note shape: four block kinds in rotation,
    /// a blank line between blocks, so the open streams and the close is what
    /// is measured.
    private func noteBody(lines: Int) -> String {
        var out = ""
        for index in 0..<lines {
            switch index % 4 {
            case 0:
                out +=
                    "paragraph \(index) with **bold** and [a link](https://example.test/\(index))\n\n"
            case 1:
                out += "- list item \(index)\n\n"
            case 2:
                out += "> quoted line \(index)\n\n"
            default:
                out += "`inline code \(index)`\n\n"
            }
        }
        return out
    }
}
