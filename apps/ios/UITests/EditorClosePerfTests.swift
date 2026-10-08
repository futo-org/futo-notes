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
/// `tap()` returns only once XCUITest judges the app idle, which can include
/// the pop animation; the wall-clock number therefore bounds the perceived
/// close from above, and the ledger's `listFrame` mark is the tighter one.
///
/// Configured by `FUTO_CLOSE_PERF_CONFIG` (JSON: `{"sizes":[1000,10000],
/// "repeat":5}`) and `FUTO_CLOSE_PERF_OUT` (an absolute results path on this
/// machine); without both it skips, so a plain `just test-ios-native` run is
/// unaffected. Each sample launches the app fresh against its own seeded vault
/// under the results directory — never a developer's vault.
final class EditorClosePerfTests: XCTestCase {
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
            out.hasPrefix("/"), let config = try? JSONDecoder().decode(Config.self, from: Data(raw.utf8))
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
            for size in config.sizes {
                for dirty in [false, true] {
                    let record = try measure(size: size, dirty: dirty, sample: sample, workDir: workDir)
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
    private func measure(size: Int, dirty: Bool, sample: Int, workDir: URL) throws -> [String: Any] {
        let title = "Perf \(size)"
        let vault = workDir.appendingPathComponent("vault-\(size)-\(dirty ? "dirty" : "clean")-\(sample)")
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        try noteBody(lines: size).write(
            to: vault.appendingPathComponent("\(title).md"), atomically: true, encoding: .utf8)

        let app = XCUIApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = vault.path
        app.launchEnvironment["FUTO_NOTES_UI_TEST_RUN_ID"] = "close-perf-\(size)-\(sample)"
        app.launch()

        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the seeded note is not listed")
        row.tap()
        let back = app.navigationBars.buttons["BackButton"]
        XCTAssertTrue(back.waitForExistence(timeout: 10), "the editor did not open")
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 10))
        XCTAssertTrue(
            web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'paragraph 0 '")).firstMatch
                .waitForExistence(timeout: 20),
            "the note's first block did not render")
        // Let the open settle (the progressive tail streams in behind the first
        // viewport) so the close is measured on its own.
        sleep(2)

        if dirty {
            web.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "tapping the body raised no keyboard")
            app.typeText("x")
            // Past the editor's 200 ms change debounce, before the shell's
            // debounced save: the editor has reported, nothing is on disk.
            usleep(300_000)
        }

        let tapEpochMs = nowEpochMs()
        back.tap()
        // The list is "back" once the editor's Back button is gone from the
        // bar and the list's own bar is there. Polled with `exists` — each
        // query is an accessibility snapshot, so the resolution is tens of ms.
        let notes = app.navigationBars["Notes"]
        let deadline = Date().addingTimeInterval(20)
        var listEpochMs: Int64 = 0
        while Date() < deadline {
            if notes.exists, !back.exists {
                listEpochMs = nowEpochMs()
                break
            }
            usleep(10_000)
        }
        XCTAssertNotEqual(listEpochMs, 0, "Back did not return to the list")
        // The commit chain keeps running after the pop; give it time to finish
        // before the app is torn down, so the ledger has every phase.
        sleep(3)
        app.terminate()

        return [
            "size": size,
            "dirty": dirty,
            "sample": sample,
            "tapEpochMs": tapEpochMs,
            "listEpochMs": listEpochMs,
            "wallMs": listEpochMs - tapEpochMs,
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
                out += "paragraph \(index) with **bold** and [a link](https://example.test/\(index))\n\n"
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
