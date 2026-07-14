import Foundation
import SwiftUI

// Native crash pipeline for the iOS app — the counterpart of the desktop pair
// src/features/system/crashHandler.ts (capture) + src/features/system/crashReporter.ts (upload) and
// Tauri-Android's logcat capture. Handlers write a JSON report into
// `<vault>/.crashlogs/`; the NEXT launch scans the dir and either auto-uploads
// ("Always send") or surfaces the Crash Report sheet. Files are deleted after
// send/dismiss, mirroring desktop App.svelte's initCrashReporting lifecycle.

// ── Handler state, pre-computed at install ──────────────────────────────────
// The signal handler must not allocate or call Foundation; everything it needs
// (per-signal file path + complete JSON payload) is rendered up front. The
// NSException handler unwinds on a normal thread, so Foundation is fine there.

/// One pre-rendered crash file per fatal signal: C-string path + JSON bytes.
private nonisolated(unsafe) var futoSignalEntries:
    [(sig: Int32, path: [CChar], json: [UInt8])] = []
private nonisolated(unsafe) var futoCrashlogsDir: URL?
private nonisolated(unsafe) var futoCrashSessionId = ""
private nonisolated(unsafe) var futoCrashVersion = "0.0.0"
private nonisolated(unsafe) var futoCrashDeviceInfo = ""
private nonisolated(unsafe) var futoPreviousExceptionHandler:
    (@convention(c) (NSException) -> Void)?

/// Fatal-signal handler: open + write + close of a pre-rendered payload, then
/// re-raise with the default disposition so the process still dies normally.
private func futoHandleSignal(_ sig: Int32) {
    for entry in futoSignalEntries where entry.sig == sig {
        entry.path.withUnsafeBufferPointer { path in
            guard let base = path.baseAddress else { return }
            let fd = open(base, O_CREAT | O_WRONLY | O_TRUNC, 0o644)
            guard fd >= 0 else { return }
            entry.json.withUnsafeBytes { bytes in
                _ = write(fd, bytes.baseAddress, bytes.count)
            }
            close(fd)
        }
        break
    }
    signal(sig, SIG_DFL)
    raise(sig)
}

/// Uncaught-NSException handler: full report with callStackSymbols.
private func futoHandleException(_ exception: NSException) {
    CrashReporter.writeExceptionReport(exception)
    futoPreviousExceptionHandler?(exception)
}

// ── Reporter ─────────────────────────────────────────────────────────────────

@MainActor
final class CrashReporter: ObservableObject {
    static let shared = CrashReporter()

    /// Reports found on launch that need the user's decision (reporting enabled
    /// but not always-send). Non-empty drives the Crash Report sheet.
    @Published var pendingReports: [PendingReport] = []

    struct PendingReport: Identifiable {
        /// The on-disk filename — doubles as the stable identity.
        let id: String
        let report: [String: Any]

        var summary: String { report["error"] as? String ?? "Native crash" }
        var stack: String { report["stack"] as? String ?? "" }
    }

    // nonisolated: read from the nonisolated install() as well as the actor.
    private nonisolated static let enabledKey = "futo.crashReporting.enabled"
    private nonisolated static let alwaysSendKey = "futo.crashReporting.alwaysSend"

    /// Upload endpoints — mirror src/features/system/crashReporter.ts exactly: single report
    /// to /api/crash, batch to /api/crashes. DEBUG talks to the local crash
    /// server (simulator reaches the Mac's localhost directly).
    #if DEBUG
    private static let crashApiUrl = URL(string: "http://localhost:5100/api/crash")!
    private static let crashBatchApiUrl = URL(string: "http://localhost:5100/api/crashes")!
    #else
    private static let crashApiUrl = URL(string: "https://notes-crashlog.futo.org/api/crash")!
    private static let crashBatchApiUrl = URL(string: "https://notes-crashlog.futo.org/api/crashes")!
    #endif

    /// Install the NSException + fatal-signal hooks. Call EARLY (FutoNotesApp
    /// init) — everything crash time needs (dir, session id, version, the
    /// per-signal payloads) is pre-computed here so the handlers stay minimal.
    nonisolated static func install() {
        // Default-on crash reporting (matches desktop's default prefs).
        UserDefaults.standard.register(defaults: [enabledKey: true])

        let dir = NotesStore.resolveNotesRoot().appendingPathComponent(
            ".crashlogs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        futoCrashlogsDir = dir
        futoCrashSessionId = UUID().uuidString
        futoCrashVersion = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        futoCrashDeviceInfo = "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)"

        // Pre-render one payload per fatal signal. The timestamp is install
        // time — a crash-time clock read isn't signal-safe; close enough for
        // grouping. The signal name stands in for a backtrace (capturing one
        // inside a signal handler is not safe without a dedicated stack).
        let signals: [(Int32, String)] = [
            (SIGABRT, "SIGABRT"), (SIGSEGV, "SIGSEGV"), (SIGBUS, "SIGBUS"),
            (SIGILL, "SIGILL"), (SIGFPE, "SIGFPE"), (SIGTRAP, "SIGTRAP"),
        ]
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let sid8 = String(futoCrashSessionId.prefix(8))
        futoSignalEntries = signals.map { sig, name in
            let report = crashReportDict(
                error: "Fatal signal \(name)",
                stack: "signal \(name) (no backtrace — signal context)")
            let json = (try? JSONSerialization.data(withJSONObject: report))
                ?? Data("{}".utf8)
            let path = dir.appendingPathComponent("crash-\(ms)-\(sid8)-\(name).json").path
            return (sig: sig, path: Array(path.utf8CString), json: [UInt8](json))
        }

        futoPreviousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler(futoHandleException)
        for (sig, _) in signals {
            signal(sig, futoHandleSignal)
        }
    }

    /// Shared payload shape — matches the desktop CrashReport interface
    /// (src/features/system/crashHandler.ts) so the crashlog server accepts it unchanged.
    private nonisolated static func crashReportDict(
        error: String, stack: String
    ) -> [String: Any] {
        [
            "error": error,
            "stack": stack,
            "app_version": futoCrashVersion,
            "platform": "ios-native",
            "device_info": futoCrashDeviceInfo,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "type": "native_crash",
            "session_id": futoCrashSessionId,
        ]
    }

    /// Write an uncaught-NSException report (Foundation is fine here — the
    /// exception unwinds on a normal thread, unlike the signal path).
    nonisolated static func writeExceptionReport(_ exception: NSException) {
        guard let dir = futoCrashlogsDir else { return }
        let report = crashReportDict(
            error: "\(exception.name.rawValue): \(exception.reason ?? "uncaught exception")",
            stack: exception.callStackSymbols.joined(separator: "\n"))
        guard let json = try? JSONSerialization.data(withJSONObject: report) else { return }
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let sid8 = String(futoCrashSessionId.prefix(8))
        try? json.write(to: dir.appendingPathComponent("crash-\(ms)-\(sid8)-exception.json"))
    }

    // ── Next-launch processing ──

    /// Scan `.crashlogs` from the previous run. Called from FutoNotesApp's
    /// backgrounded `.task` — never gates first render. Disabled → leave files
    /// (mirrors desktop); always-send → upload + delete; otherwise surface the
    /// sheet for the user's decision.
    func processPendingReports() async {
        guard UserDefaults.standard.bool(forKey: Self.enabledKey) else { return }
        let loaded = await Self.loadReports()
        guard !loaded.isEmpty else { return }

        if UserDefaults.standard.bool(forKey: Self.alwaysSendKey) {
            let ok = await Self.upload(loaded.map(\.report), userDescription: nil)
            if ok { await Self.deleteFiles(loaded.map(\.id)) }
        } else {
            pendingReports = loaded
        }
    }

    /// Resolve the Crash Report sheet. Send → upload (deleting files on
    /// success), persisting Always-send when toggled. Don't Send → permanent
    /// opt-out + discard, exactly like desktop's dialog resolution.
    func resolve(send: Bool, alwaysSend: Bool, userNote: String) async {
        let reports = pendingReports
        pendingReports = []
        if send {
            if alwaysSend {
                UserDefaults.standard.set(true, forKey: Self.alwaysSendKey)
            }
            let note = userNote.trimmingCharacters(in: .whitespacesAndNewlines)
            let ok = await Self.upload(
                reports.map(\.report), userDescription: note.isEmpty ? nil : note)
            // Keep the files when the send failed — they'll re-prompt next launch.
            if ok { await Self.deleteFiles(reports.map(\.id)) }
        } else {
            UserDefaults.standard.set(false, forKey: Self.enabledKey)
            await Self.deleteFiles(reports.map(\.id))
        }
    }

    // ── File + network plumbing ──

    private static func loadReports() async -> [PendingReport] {
        guard let dir = futoCrashlogsDir else { return [] }
        return await Task.detached(priority: .utility) { () -> [PendingReport] in
            let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
            return files.filter { $0.hasSuffix(".json") }.sorted().compactMap { name in
                guard
                    let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
                    let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                else { return nil }
                return PendingReport(id: name, report: dict)
            }
        }.value
    }

    private static func deleteFiles(_ names: [String]) async {
        guard let dir = futoCrashlogsDir else { return }
        await Task.detached(priority: .utility) {
            for name in names {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            }
        }.value
    }

    /// Batch POST first ({crashes: [...]}), individual fallback — the same
    /// strategy as crashReporter.ts sendAllPendingReports.
    private static func upload(
        _ reports: [[String: Any]], userDescription: String?
    ) async -> Bool {
        var bodies = reports
        if let note = userDescription {
            bodies = bodies.map { report in
                var annotated = report
                annotated["user_description"] = note
                return annotated
            }
        }
        if await post(crashBatchApiUrl, body: ["crashes": bodies]) { return true }
        var allOk = true
        for body in bodies {
            if !(await post(crashApiUrl, body: body)) { allOk = false }
        }
        return allOk
    }

    private static func post(_ url: URL, body: Any) async -> Bool {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard
            let (_, response) = try? await URLSession.shared.data(for: request),
            let http = response as? HTTPURLResponse
        else { return false }
        return (200..<300).contains(http.statusCode)
    }
}

// ── Sheet ────────────────────────────────────────────────────────────────────

/// "Send crash report?" sheet shown on the launch after a native crash (unless
/// Always send is on). Mirrors the desktop CrashReportDialog: expandable
/// report, optional "What were you doing?", Always-send toggle, Send / Don't
/// Send (Don't Send = permanent opt-out, re-enable in Settings).
struct CrashReportSheet: View {
    @ObservedObject var reporter: CrashReporter

    @State private var userNote = ""
    @State private var alwaysSend = false
    @State private var showDetails = false
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("FUTO Notes crashed last time it ran. Send the crash report so we can fix it?")
                }
                Section {
                    DisclosureGroup("View report", isExpanded: $showDetails) {
                        ForEach(reporter.pendingReports) { pending in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(pending.summary)
                                    .font(.caption.bold())
                                Text(pending.stack)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                Section("What were you doing?") {
                    TextField("Optional details", text: $userNote, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    Toggle("Always send automatically", isOn: $alwaysSend)
                }
                Section {
                    Button {
                        finish(send: true)
                    } label: {
                        if sending {
                            ProgressView()
                        } else {
                            Text("Send")
                        }
                    }
                    .disabled(sending)
                    Button("Don't Send", role: .destructive) {
                        finish(send: false)
                    }
                    .disabled(sending)
                }
            }
            .navigationTitle("Crash Report")
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
        }
        // Resolution must be explicit (Send / Don't Send) — swipe-dismiss would
        // leave the files in limbo.
        .interactiveDismissDisabled()
    }

    private func finish(send: Bool) {
        sending = true
        Task {
            await reporter.resolve(send: send, alwaysSend: alwaysSend, userNote: userNote)
            sending = false
        }
    }
}
