import Foundation
import MachO
import Synchronization

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
struct FutoSignalEntry {
    var sig: Int32
    var path: UnsafePointer<CChar>
    var prefix: UnsafeBufferPointer<UInt8>
    var suffix: UnsafeBufferPointer<UInt8>
}
nonisolated(unsafe) var futoSignalEntries: UnsafeMutablePointer<FutoSignalEntry>?
nonisolated(unsafe) var futoSignalEntryCount = 0
nonisolated(unsafe) var futoCrashlogsDir: URL?
nonisolated(unsafe) var futoCrashSessionId = ""
nonisolated(unsafe) var futoCrashVersion = "0.0.0"
nonisolated(unsafe) var futoCrashDeviceInfo = ""
nonisolated(unsafe) var futoPreviousExceptionHandler: (@convention(c) (NSException) -> Void)?
/// Set once the NSException handler has written its report: the runtime then
/// calls abort(), and the SIGABRT that follows must not file a second report
/// for the same crash. A plain Bool read is async-signal-safe.
private nonisolated(unsafe) var futoExceptionReported = false
/// Taken by the first thread into the handler: a second crashing thread, or a
/// fault inside the handler itself, must not render into the shared buffer.
let futoHandlingSignal = Atomic<Bool>(false)

/// A loaded image, so a crash-time frame can be written as `<image> <offset>`
/// and symbolicated against the dSYM with that UUID (ASLR moves absolute
/// addresses on every launch, so offsets also group identical crashes).
struct FutoImage {
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

let futoImageCapacity = 2048
nonisolated(unsafe) var futoImages: UnsafeMutablePointer<FutoImage>!
nonisolated(unsafe) var futoImageCount = 0

let futoMaxFrames = 64
/// Indices into futoImages of the images the current backtrace touched.
nonisolated(unsafe) var futoFrameImages: UnsafeMutablePointer<Int>!
private nonisolated(unsafe) var futoFrameImageCount = 0

let futoReportCapacity = 32 * 1024
nonisolated(unsafe) var futoReport: UnsafeMutablePointer<UInt8>!
private nonisolated(unsafe) var futoReportLength = 0
private nonisolated(unsafe) var futoReportLimit = 0

/// Fatal-signal handler: render the report from the crashing thread's context,
/// open + write + close it, then re-raise with the default disposition so the
/// process still dies normally.
func futoHandleSignal(
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
func futoPermanentCopy<Element>(_ elements: [Element]) -> UnsafeBufferPointer<Element> {
    let copy = UnsafeMutableBufferPointer<Element>.allocate(capacity: elements.count)
    _ = copy.initialize(from: elements)
    return UnsafeBufferPointer(copy)
}

/// Uncaught-NSException handler: full report with callStackSymbols.
func futoHandleException(_ exception: NSException) {
    CrashReporter.writeExceptionReport(exception)
    futoExceptionReported = true
    futoPreviousExceptionHandler?(exception)
}
