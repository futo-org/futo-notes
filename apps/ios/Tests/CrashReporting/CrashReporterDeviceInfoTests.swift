import Foundation
import Testing

@testable import FutoNotesNative

@Suite("CrashReporter device info")
struct CrashReporterDeviceInfoTests {
    @Test("hardware model is a non-empty, NUL-free machine string")
    func hardwareModelIsUsable() {
        let hardware = DeviceInfo.hardwareModel()
        #expect(!hardware.isEmpty)
        #expect(!hardware.contains("\0"))
        #expect(hardware.trimmingCharacters(in: .whitespaces) == hardware)
    }

    @Test("device info is the hardware model, then the OS, matching Android's shape")
    func composedInfoMatchesAndroidShape() {
        let composed = CrashReporter.deviceInfo(
            hardware: "iPhone17,1", osVersion: "Version 18.2 (Build 22C152)")
        #expect(composed == "iPhone17,1 | iOS Version 18.2 (Build 22C152)")
    }

    @Test("the string install() reports carries the hardware model, not just the OS")
    func installedInfoIdentifiesTheHardware() {
        let composed = CrashReporter.currentDeviceInfo()
        let hardware = DeviceInfo.hardwareModel()
        let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        #expect(composed.hasPrefix("\(hardware) | "))
        #expect(composed.hasSuffix(osVersion))
        #expect(composed != "iOS \(osVersion)")
    }
}
