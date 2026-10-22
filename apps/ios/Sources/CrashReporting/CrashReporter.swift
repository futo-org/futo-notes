import Foundation
import MachO
import SwiftUI
import Synchronization

// Native crash pipeline for the iOS app — the counterpart of the desktop pair
// src/features/system/crashHandler.ts (capture) + src/features/system/crashReporter.ts (upload) and
// Tauri-Android's logcat capture. Handlers write a JSON report into
// `<vault>/.crashlogs/`; the NEXT launch scans the dir and either auto-uploads
// ("Always send") or surfaces the Crash Report sheet. Files are deleted after
// send/dismiss, mirroring desktop App.svelte's initCrashReporting lifecycle.

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

    // nonisolated: read from the nonisolated install() as well as the actor. The one
    // home for these keys: SettingsView's toggles and the debug puppet listener read
    // and write the same two entries.
    nonisolated static let enabledKey = "futo.crashReporting.enabled"
    nonisolated static let alwaysSendKey = "futo.crashReporting.alwaysSend"

    /// Upload endpoints — mirror src/features/system/crashReporter.ts exactly: single report
    /// to /api/crash, batch to /api/crashes.
    private static var crashApiUrl: URL { CrashlogEndpoint.url("/api/crash") }
    private static var crashBatchApiUrl: URL { CrashlogEndpoint.url("/api/crashes") }

    /// Install the NSException + fatal-signal hooks. Call EARLY (FutoNotesApp
    /// init) — everything crash time needs (dir, session id, version, the
    /// per-signal payloads, the loaded-image table) is pre-computed here so the
    /// handlers stay minimal.
    nonisolated static func install() {
        // Default-on crash reporting (matches desktop's default prefs).
        UserDefaults.standard.register(defaults: [enabledKey: true])

        let dir = NotesStore.resolveNotesRoot().appendingPathComponent(
            ".crashlogs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        futoCrashlogsDir = dir
        futoCrashSessionId = UUID().uuidString
        futoCrashVersion =
            Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        futoCrashDeviceInfo = currentDeviceInfo()

        // Pre-render one payload per fatal signal, split around the stack the
        // handler fills in. The timestamp is install time — a crash-time clock
        // read isn't signal-safe; close enough for grouping.
        let signals: [(Int32, String)] = [
            (SIGABRT, "SIGABRT"), (SIGSEGV, "SIGSEGV"), (SIGBUS, "SIGBUS"),
            (SIGILL, "SIGILL"), (SIGFPE, "SIGFPE"), (SIGTRAP, "SIGTRAP"),
        ]
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let sid8 = String(futoCrashSessionId.prefix(8))
        let entries = UnsafeMutablePointer<FutoSignalEntry>.allocate(capacity: signals.count)
        for (index, (sig, name)) in signals.enumerated() {
            let template = signalReportTemplate(error: "Fatal signal \(name)")
            let path = dir.appendingPathComponent("crash-\(ms)-\(sid8)-\(name).json").path
            entries[index] = FutoSignalEntry(
                sig: sig, path: futoPermanentCopy(Array(path.utf8CString)).baseAddress!,
                prefix: futoPermanentCopy(template.prefix),
                suffix: futoPermanentCopy(template.suffix))
        }
        futoSignalEntries = entries
        futoSignalEntryCount = signals.count
        futoImages = .allocate(capacity: futoImageCapacity)
        futoFrameImages = .allocate(capacity: futoMaxFrames)
        futoReport = .allocate(capacity: futoReportCapacity)
        // Not a reset: first touch runs the global's lazy initializer, which
        // must happen here and never inside the handler.
        futoHandlingSignal.store(false, ordering: .relaxed)
        trackLoadedImages()

        futoPreviousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler(futoHandleException)
        var action = sigaction()
        action.__sigaction_u.__sa_sigaction = futoHandleSignal
        action.sa_flags = SA_SIGINFO
        for (sig, _) in signals {
            sigaction(sig, &action, nil)
        }
    }

    /// The report JSON split around its stack value, which
    /// futoRenderSignalReport writes at crash time.
    nonisolated static func signalReportTemplate(error: String) -> (
        prefix: [UInt8], suffix: [UInt8]
    ) {
        let placeholder = "FUTO_SIGNAL_STACK_PLACEHOLDER"
        // An all-string dictionary always serializes and keeps the placeholder
        // verbatim; failing loudly here beats writing reports loadReports drops.
        let json = [UInt8](
            try! JSONSerialization.data(
                withJSONObject: crashReportDict(error: error, stack: placeholder)))
        let range = json.firstRange(of: Array(placeholder.utf8))!
        return (Array(json[..<range.lowerBound]), Array(json[range.upperBound...]))
    }

    /// Snapshot every loaded image's address range, name, UUID and
    /// `__crash_info` for the signal handler. Images loaded after this (a late
    /// dlopen) render as `? <address>`.
    nonisolated static func trackLoadedImages() {
        var count = 0
        for index in 0..<min(Int(_dyld_image_count()), futoImageCapacity) {
            guard let header = _dyld_get_image_header(UInt32(index)),
                header.pointee.magic == MH_MAGIC_64,
                let path = _dyld_get_image_name(UInt32(index))
            else { continue }
            let start = UInt(bitPattern: header)
            var image = FutoImage(
                start: start, end: start,
                name: strrchr(path, Int32(UInt8(ascii: "/"))).map { UnsafePointer($0 + 1) } ?? path,
                uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), crashInfo: nil)
            var command = UnsafeRawPointer(header) + MemoryLayout<mach_header_64>.size
            for _ in 0..<header.pointee.ncmds {
                let load = command.loadUnaligned(as: load_command.self)
                if load.cmd == LC_UUID {
                    image.uuid = command.loadUnaligned(as: uuid_command.self).uuid
                }
                command += Int(load.cmdsize)
            }
            header.withMemoryRebound(to: mach_header_64.self, capacity: 1) { header64 in
                var size: UInt = 0
                if getsegmentdata(header64, "__TEXT", &size) != nil { image.end = start + size }
                // Shared-cache dylibs may move the section to __DATA_DIRTY
                // (libobjc does). Fields [0] version … [4] message2, 8 bytes each.
                for segment in ["__DATA", "__DATA_DIRTY"] where image.crashInfo == nil {
                    if let section = getsectiondata(header64, segment, "__crash_info", &size),
                        size >= 5 * 8
                    {
                        image.crashInfo = UnsafeRawPointer(section).assumingMemoryBound(
                            to: UInt64.self)
                    }
                }
            }
            futoImages[count] = image
            count += 1
        }
        futoImageCount = count
    }

    nonisolated static func deviceInfo(hardware: String, osVersion: String) -> String {
        "\(hardware) | iOS \(osVersion)"
    }

    nonisolated static func currentDeviceInfo() -> String {
        deviceInfo(
            hardware: DeviceInfo.hardwareModel(),
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
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
