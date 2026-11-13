import CryptoKit
import Darwin
import XCTest

/// Kill loop: 10 runs of 10 s of steady typing into a note, then SIGKILL of the app's own pid.
/// A simulator app is a Mac process, so this runner (another one) sends the signal itself to the
/// pid the app wrote at the head of `steady.log`; nothing is found or killed by name. The typist
/// is the debug build's TextFirstSteadyTyper (`FUTO_TF_STEADY_LOG`): one digit per 100 ms.
///
/// There is no recovery log: the Store saves on its debounce (500 ms idle, 2 s max wait), so a
/// kill may lose the keys since the last save. What must hold, byte for byte, is that the `.md`
/// the kill leaves is the pristine note plus a PREFIX of the typed digits (never torn or
/// mixed), that at most the 2 s max-wait window of keys is missing, and that reopening shows
/// exactly the file. Run: `just test-ios-native-ui TextFirstKillLoopTests`.
final class TextFirstKillLoopTests: XCTestCase {
    private static let pristine: String = {
        var lines = ["Kill loop", ""]
        for i in 0..<100 { lines += ["paragraph \(i) with plain words and a number \(i * 7)", ""] }
        return (lines + ["typing lands here: "]).joined(separator: "\n")
    }()

    /// Keys the 2 s max wait plus scheduling slack may leave unsaved at the kill.
    private static let maxLostKeys = 30

    private var root: URL!
    private var vault: URL { root.appendingPathComponent("vault") }
    private var steadyLog: URL { root.appendingPathComponent("steady.log") }
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = true
        let base = ProcessInfo.processInfo.environment["TF_DIR"] ?? NSTemporaryDirectory() + "tf-ui"
        root = URL(fileURLWithPath: base).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
    }

    private func expected(_ keys: Int) -> String {
        Self.pristine + (0..<keys).map { String($0 % 10) }.joined()
    }

    private func logLines() -> [String] {
        let text = (try? String(contentsOf: steadyLog, encoding: .utf8)) ?? ""
        var lines = text.components(separatedBy: "\n")
        lines.removeLast()  // after the last "\n": empty, or a line the kill tore
        return lines
    }

    @MainActor
    private func launch(_ name: String, typing: Bool) {
        app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = vault.path
        if typing { app.launchEnvironment["FUTO_TF_STEADY_LOG"] = steadyLog.path }
        app.launchArguments += ["-futo.textFirstEditor", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "note \(name) not listed")
        row.tap()
        XCTAssertTrue(
            app.textViews["text-first-editor"].waitForExistence(timeout: 15),
            "text-first editor did not appear")
    }

    @MainActor
    private func killRun(_ run: Int) throws -> String? {
        let name = "kill-r\(run)-" + UUID().uuidString.prefix(6).lowercased()
        let file = vault.appendingPathComponent("\(name).md")
        try Self.pristine.write(to: file, atomically: true, encoding: .utf8)
        try? FileManager.default.removeItem(at: steadyLog)
        launch(name, typing: true)

        let started = Date()
        while logLines().count < 2, Date().timeIntervalSince(started) < 10 {
            Thread.sleep(forTimeInterval: 0.05)
        }
        guard let head = logLines().first, head.hasPrefix("pid "),
            let pid = pid_t(head.dropFirst(4))
        else { return "run \(run): typist never started" }
        Thread.sleep(forTimeInterval: 10)
        XCTAssertEqual(app.state, .runningForeground, "run \(run): app not running before the kill")
        guard kill(pid, SIGKILL) == 0 else {
            return "run \(run): kill(\(pid)) failed, errno \(errno)"
        }
        guard app.wait(for: .notRunning, timeout: 15) else {
            return "run \(run): pid \(pid) still running after SIGKILL"
        }

        guard let last = logLines().last?.split(separator: " "), last.count == 2,
            let typed = Int(last[0])
        else { return "run \(run): no keystroke logged" }
        let onDisk = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        guard let kept = (0...typed + 1).last(where: { expected($0) == onDisk }) else {
            return "run \(run): CORRUPT: the file the kill left is not the note plus a prefix of the keys"
        }

        launch(name, typing: false)
        let shown = (app.textViews["text-first-editor"].value as? String) ?? "<none>"
        let line =
            "KILLRUN \(run) pid=\(pid) typed=\(typed) kept=\(kept) lost=\(max(0, typed - kept)) "
            + "reopened-matches-disk=\(shown == onDisk)"
        print(line)
        XCTContext.runActivity(named: line) { _ in }
        app.terminate()
        if shown != onDisk { return "run \(run): reopened text differs from the file (\(line))" }
        if typed - kept > Self.maxLostKeys {
            return "run \(run): lost more than the save window: \(line)"
        }
        return nil
    }

    @MainActor
    func testKillLoop() throws {
        var failures: [String] = []
        for run in 1...10 { if let failure = try killRun(run) { failures.append(failure) } }
        XCTAssertTrue(
            failures.isEmpty,
            "\(failures.count)/10 runs lost or corrupted bytes:\n"
                + failures.joined(separator: "\n"))
    }
}
