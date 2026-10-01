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

// ── Handler state, pre-computed at install ──────────────────────────────────
// The signal handler must not allocate or call Foundation: everything it needs
// (per-signal file path, the JSON around the stack, the loaded-image table, the
// output buffer) is allocated by install(), and at crash time it only reads
// memory and write()s. The buffers are optionals install() assigns, never
// globals with an allocating initializer: Swift runs those lazily on first
// touch, which would malloc inside the handler. The NSException handler
// unwinds on a normal thread, so Foundation is fine there.

/// One crash file per fatal signal: C-string path, plus the pre-rendered JSON
/// split around the stack value the handler renders at crash time.
private struct FutoSignalEntry {
    var sig: Int32
    var path: UnsafePointer<CChar>
    var prefix: UnsafeBufferPointer<UInt8>
    var suffix: UnsafeBufferPointer<UInt8>
}
private nonisolated(unsafe) var futoSignalEntries: UnsafeMutablePointer<FutoSignalEntry>?
private nonisolated(unsafe) var futoSignalEntryCount = 0
private nonisolated(unsafe) var futoCrashlogsDir: URL?
private nonisolated(unsafe) var futoCrashSessionId = ""
private nonisolated(unsafe) var futoCrashVersion = "0.0.0"
private nonisolated(unsafe) var futoCrashDeviceInfo = ""
private nonisolated(unsafe) var futoPreviousExceptionHandler:
    (@convention(c) (NSException) -> Void)?
/// Set once the NSException handler has written its report: the runtime then
/// calls abort(), and the SIGABRT that follows must not file a second report
/// for the same crash. A plain Bool read is async-signal-safe.
private nonisolated(unsafe) var futoExceptionReported = false
/// Taken by the first thread into the handler: a second crashing thread, or a
/// fault inside the handler itself, must not render into the shared buffer.
private let futoHandlingSignal = Atomic<Bool>(false)

/// A loaded image, so a crash-time frame can be written as `<image> <offset>`
/// and symbolicated against the dSYM with that UUID (ASLR moves absolute
/// addresses on every launch, so offsets also group identical crashes).
private struct FutoImage {
    var start: UInt
    /// start + the __TEXT segment's size.
    var end: UInt
    /// Basename of the dyld-owned path.
    var name: UnsafePointer<CChar>
    var uuid: uuid_t
    /// The image's `__crash_info` section (`crashreporter_annotations_t`). The
    /// Swift runtime parks a `fatalError`/`try!` message there before trapping
    /// (libdispatch and libobjc do the same); it is the only copy that survives.
    var crashInfo: UnsafePointer<UInt64>?
}

private let futoImageCapacity = 2048
private nonisolated(unsafe) var futoImages: UnsafeMutablePointer<FutoImage>!
private nonisolated(unsafe) var futoImageCount = 0

private let futoMaxFrames = 64
/// Indices into futoImages of the images the current backtrace touched.
private nonisolated(unsafe) var futoFrameImages: UnsafeMutablePointer<Int>!
private nonisolated(unsafe) var futoFrameImageCount = 0

private let futoReportCapacity = 32 * 1024
private nonisolated(unsafe) var futoReport: UnsafeMutablePointer<UInt8>!
private nonisolated(unsafe) var futoReportLength = 0
private nonisolated(unsafe) var futoReportLimit = 0

/// Fatal-signal handler: render the report from the crashing thread's context,
/// open + write + close it, then re-raise with the default disposition so the
/// process still dies normally.
private func futoHandleSignal(
    _ sig: Int32, _ info: UnsafeMutablePointer<__siginfo>?, _ context: UnsafeMutableRawPointer?
) {
    if futoExceptionReported {
        // The NSException report already covers this abort().
    } else if !futoHandlingSignal.exchange(true, ordering: .acquiring) {
        futoWriteSignalReport(sig, context)
    } else {
        // ponytail: another thread is rendering — give it time to finish and
        // kill the process; a fault inside the handler itself waits too.
        sleep(2)
    }
    signal(sig, SIG_DFL)
    raise(sig)
}

private func futoWriteSignalReport(_ sig: Int32, _ context: UnsafeMutableRawPointer?) {
    var pc: UInt = 0
    var lr: UInt = 0
    var fp: UInt = 0
    if let machineContext = context?.assumingMemoryBound(to: ucontext_t.self).pointee.uc_mcontext {
        #if arch(arm64)
            pc = UInt(machineContext.pointee.__ss.__pc)
            lr = UInt(machineContext.pointee.__ss.__lr)
            fp = UInt(machineContext.pointee.__ss.__fp)
        #elseif arch(x86_64)
            pc = UInt(machineContext.pointee.__ss.__rip)
            fp = UInt(machineContext.pointee.__ss.__rbp)
        #endif
    }
    // A synchronous signal is delivered on the faulting thread, so its frame
    // chain lies within this thread's stack.
    let thread = pthread_self()
    let stackHigh = UInt(bitPattern: pthread_get_stackaddr_np(thread))
    let stackLow = stackHigh - UInt(pthread_get_stacksize_np(thread))

    guard let entries = futoSignalEntries else { return }
    for index in 0..<futoSignalEntryCount where entries[index].sig == sig {
        let report = futoRenderSignalReport(
            prefix: entries[index].prefix, suffix: entries[index].suffix, pc: pc, lr: lr,
            fp: fp, stackLow: stackLow, stackHigh: stackHigh)
        let fd = open(entries[index].path, O_CREAT | O_WRONLY | O_TRUNC, 0o644)
        guard fd >= 0 else { return }
        _ = write(fd, report.baseAddress, report.count)
        close(fd)
        return
    }
}

/// Render one signal report into the preallocated buffer: prefix, then the
/// stack value — crash-info messages, `<n> <image> <offset>` frames (frame 0 is
/// the faulting pc, `lr` the link register, the rest the frame-pointer chain),
/// then `images:` with each touched image's UUID — then suffix. Async-signal-
/// safe: no allocation, only reads of memory prepared at install. Symbolicate a
/// frame with `atos -o <dSYM>/Contents/Resources/DWARF/<image> -l 0x100000000
/// <0x100000000 + offset>`.
func futoRenderSignalReport(
    prefix: UnsafeBufferPointer<UInt8>, suffix: UnsafeBufferPointer<UInt8>,
    pc: UInt, lr: UInt, fp: UInt, stackLow: UInt, stackHigh: UInt
) -> UnsafeBufferPointer<UInt8> {
    futoReportLength = 0
    futoFrameImageCount = 0
    futoReportLimit = futoReportCapacity - suffix.count
    futoAppend(prefix)

    for index in 0..<futoImageCount {
        guard let crashInfo = futoImages[index].crashInfo else { continue }
        // crashreporter_annotations_t: [1] message, [4] message2.
        futoAppendCrashMessage(image: futoImages[index].name, address: crashInfo[1])
        futoAppendCrashMessage(image: futoImages[index].name, address: crashInfo[4])
    }

    futoAppend("0 ")
    futoAppendFrame(futoStripPointerAuthentication(pc))
    if lr != 0 {
        futoAppend("lr ")
        futoAppendFrame(futoStripPointerAuthentication(lr))
    }
    // Each frame record is [caller's fp, return address].
    var frame = fp
    var index = 1
    while index < futoMaxFrames, frame >= stackLow, frame < stackHigh, stackHigh - frame >= 16,
        frame % 8 == 0,
        let record = UnsafePointer<UInt>(bitPattern: frame)
    {
        let returnAddress = futoStripPointerAuthentication(record[1])
        if returnAddress == 0 { break }
        futoAppendDecimal(index)
        futoAppend(" ")
        futoAppendFrame(returnAddress)
        index += 1
        if record[0] <= frame { break }
        frame = record[0]
    }

    futoAppend("images:")
    futoAppendLineBreak()
    for touched in 0..<futoFrameImageCount {
        let image = futoImages[futoFrameImages[touched]]
        futoAppendEscaped(image.name, limit: 256)
        futoAppend(" ")
        withUnsafeBytes(of: image.uuid) { uuid in
            for (position, byte) in uuid.enumerated() {
                if position == 4 || position == 6 || position == 8 || position == 10 {
                    futoAppend("-")
                }
                futoAppend(futoHexDigit(byte >> 4))
                futoAppend(futoHexDigit(byte & 0xF))
            }
        }
        futoAppendLineBreak()
    }

    futoReportLimit = futoReportCapacity
    futoAppend(suffix)
    return UnsafeBufferPointer(start: futoReport, count: futoReportLength)
}

private func futoStripPointerAuthentication(_ address: UInt) -> UInt {
    #if arch(arm64)
        // ponytail: iOS user code sits below 64 GB, so a 36-bit mask strips the
        // PAC bits system (arm64e) frames sign return addresses with; a larger
        // address space would need ptrauth_strip.
        return address & 0x0000_000F_FFFF_FFFF
    #else
        return address
    #endif
}

private func futoAppendFrame(_ address: UInt) {
    for index in 0..<futoImageCount {
        let image = futoImages[index]
        guard address >= image.start && address < image.end else { continue }
        futoAppendEscaped(image.name, limit: 256)
        futoAppend(" 0x")
        futoAppendHex(address - image.start)
        futoAppendLineBreak()
        for touched in 0..<futoFrameImageCount where futoFrameImages[touched] == index { return }
        if futoFrameImageCount < futoMaxFrames {
            futoFrameImages[futoFrameImageCount] = index
            futoFrameImageCount += 1
        }
        return
    }
    futoAppend("? 0x")
    futoAppendHex(address)
    futoAppendLineBreak()
}

private func futoAppendCrashMessage(image: UnsafePointer<CChar>, address: UInt64) {
    guard let message = UnsafePointer<CChar>(bitPattern: UInt(address)) else { return }
    futoAppendEscaped(image, limit: 256)
    futoAppend(": ")
    futoAppendEscaped(message, limit: 4096)
    futoAppendLineBreak()
}

private func futoAppend(_ byte: UInt8) {
    guard futoReportLength < futoReportLimit else { return }
    futoReport[futoReportLength] = byte
    futoReportLength += 1
}

private func futoAppend(_ bytes: UnsafeBufferPointer<UInt8>) {
    for byte in bytes { futoAppend(byte) }
}

/// All or nothing, so truncation never leaves half an escape sequence that
/// would break the JSON.
private func futoAppend(_ text: StaticString) {
    guard futoReportLimit - futoReportLength >= text.utf8CodeUnitCount else { return }
    text.withUTF8Buffer { futoAppend($0) }
}

/// A JSON-escaped newline inside the stack string.
private func futoAppendLineBreak() {
    futoAppend("\\n")
}

private func futoHexDigit(_ value: UInt8) -> UInt8 {
    value < 10 ? UInt8(ascii: "0") + value : UInt8(ascii: "A") + value - 10
}

private func futoAppendHex(_ value: UInt) {
    var shift = UInt.bitWidth - 4
    while shift > 0 && (value >> UInt(shift)) & 0xF == 0 { shift -= 4 }
    while true {
        futoAppend(futoHexDigit(UInt8((value >> UInt(shift)) & 0xF)))
        if shift == 0 { return }
        shift -= 4
    }
}

private func futoAppendDecimal(_ value: Int) {
    if value >= 10 { futoAppendDecimal(value / 10) }
    futoAppend(UInt8(ascii: "0") + UInt8(value % 10))
}

/// Copy a C string into the JSON string value. Quotes, backslashes and
/// newlines are escaped; any other control or non-ASCII byte becomes `?`, which
/// keeps the file valid JSON without UTF-8 validation at crash time.
private func futoAppendEscaped(_ text: UnsafePointer<CChar>, limit: Int) {
    for index in 0..<limit {
        let byte = UInt8(bitPattern: text[index])
        switch byte {
        case 0:
            return
        case UInt8(ascii: "\""):
            futoAppend("\\\"")
        case UInt8(ascii: "\\"):
            futoAppend("\\\\")
        case UInt8(ascii: "\n"):
            futoAppendLineBreak()
        case 0x20..<0x7F:
            futoAppend(byte)
        default:
            futoAppend(UInt8(ascii: "?"))
        }
    }
}

/// Copy into memory that lives for the process, for the signal handler.
private func futoPermanentCopy<Element>(_ elements: [Element]) -> UnsafeBufferPointer<Element> {
    let copy = UnsafeMutableBufferPointer<Element>.allocate(capacity: elements.count)
    _ = copy.initialize(from: elements)
    return UnsafeBufferPointer(copy)
}

/// Uncaught-NSException handler: full report with callStackSymbols.
private func futoHandleException(_ exception: NSException) {
    CrashReporter.writeExceptionReport(exception)
    futoExceptionReported = true
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

// ── Sheet ────────────────────────────────────────────────────────────────────

/// "Send crash report?" sheet shown on the launch after a native crash (unless
/// Always send is on). Mirrors the desktop CrashReportDialog: expandable
/// report, optional "What were you doing?", Always-send toggle, Send / Don't
/// Send (Don't Send = permanent opt-out, re-enable in Settings).
struct CrashReportSheet: View {
    @ObservedObject var reporter: CrashReporter
    @Environment(\.localization) private var localization

    @State private var userNote = ""
    @State private var alwaysSend = false
    @State private var showDetails = false
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(
                        localization.localizedText("crashReporting.prompt")
                    )
                }
                Section {
                    DisclosureGroup(
                        localization.localizedText("crashReporting.viewReport"),
                        isExpanded: $showDetails
                    ) {
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
                Section(localization.localizedText("crashReporting.activityPrompt")) {
                    TextField(
                        localization.localizedText("crashReporting.optionalDetails"),
                        text: $userNote,
                        axis: .vertical
                    )
                    .lineLimit(2...5)
                }
                Section {
                    Toggle(
                        localization.localizedText("crashReporting.sendAutomatically"),
                        isOn: $alwaysSend
                    )
                }
                Section {
                    Button {
                        finish(send: true)
                    } label: {
                        if sending {
                            ProgressView()
                        } else {
                            Text(localization.localizedText("common.actions.send"))
                        }
                    }
                    .disabled(sending)
                    Button(
                        localization.localizedText("crashReporting.dontSend"), role: .destructive
                    ) {
                        finish(send: false)
                    }
                    .disabled(sending)
                }
            }
            .navigationTitle(localization.localizedText("crashReporting.heading"))
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
