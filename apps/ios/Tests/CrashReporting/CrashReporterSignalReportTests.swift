import Foundation
import Testing

@testable import FutoNotesNative

// Serialized: futoRenderSignalReport writes one process-wide buffer, as the
// signal handler does. Relies on the host app's install() having allocated it.
@Suite("CrashReporter fatal-signal report", .serialized)
struct CrashReporterSignalReportTests {
    @Test("the report is valid JSON whose frames name their image, offset, and UUID")
    func reportIsSymbolicatable() throws {
        // The test bundle loads after install() snapshotted the images.
        CrashReporter.trackLoadedImages()
        let template = CrashReporter.signalReportTemplate(error: "Fatal signal SIGTRAP")
        // Frames inside this test bundle's image, reached through two chained
        // frame records ([caller's fp, return address]) on a fake stack.
        let image = UInt(bitPattern: #dsohandle)
        let stack = UnsafeMutablePointer<UInt>.allocate(capacity: 4)
        defer { stack.deallocate() }
        let stackLow = UInt(bitPattern: stack)
        stack[0] = stackLow + 16
        stack[1] = image + 0x20
        stack[2] = 0
        stack[3] = image + 0x3C

        let report = template.prefix.withUnsafeBufferPointer { prefix in
            template.suffix.withUnsafeBufferPointer { suffix in
                Array(
                    futoRenderSignalReport(
                        prefix: prefix, suffix: suffix, pc: image + 0x10, lr: 0, fp: stackLow,
                        stackLow: stackLow, stackHigh: stackLow + 32))
            }
        }

        let json = try #require(
            try JSONSerialization.jsonObject(with: Data(report)) as? [String: Any])
        #expect(json["error"] as? String == "Fatal signal SIGTRAP")
        #expect(json["platform"] as? String == "ios-native")
        let lines = try #require(json["stack"] as? String).split(separator: "\n").map(String.init)
        #expect(lines.contains("0 FutoNotesNativeTests 0x10"))
        #expect(lines.contains("1 FutoNotesNativeTests 0x20"))
        #expect(lines.contains("2 FutoNotesNativeTests 0x3C"))
        let imageLines = lines.drop { $0 != "images:" }.dropFirst()
        #expect(
            imageLines.contains {
                $0.wholeMatch(of: /FutoNotesNativeTests [0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}/)
                    != nil
            })
    }

    @Test("a smashed frame pointer near the top of the address space ends the walk, not the report")
    func frameWalkSurvivesOverflowingFramePointer() throws {
        let template = CrashReporter.signalReportTemplate(error: "Fatal signal SIGSEGV")
        // `frame + 16` would overflow (and trap inside the handler) here.
        let report = template.prefix.withUnsafeBufferPointer { prefix in
            template.suffix.withUnsafeBufferPointer { suffix in
                Array(
                    futoRenderSignalReport(
                        prefix: prefix, suffix: suffix, pc: 0, lr: 0, fp: UInt.max - 7,
                        stackLow: 0, stackHigh: UInt.max))
            }
        }
        let json = try #require(
            try JSONSerialization.jsonObject(with: Data(report)) as? [String: Any])
        #expect(json["error"] as? String == "Fatal signal SIGSEGV")
        let lines = try #require(json["stack"] as? String).split(separator: "\n")
        #expect(lines.contains("0 ? 0x0"))
        #expect(!lines.contains { $0.hasPrefix("1 ") })
    }
}
