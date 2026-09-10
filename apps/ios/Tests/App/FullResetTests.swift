import Testing

@testable import FutoNotesNative

@Suite("Full reset")
struct FullResetTests {
    @Test("disconnect completes before the vault is wiped")
    func disconnectsBeforeReset() async {
        actor Recorder {
            private(set) var events: [String] = []

            func append(_ event: String) {
                events.append(event)
            }
        }

        let recorder = Recorder()
        await performFullReset(
            disconnectSync: {
                await recorder.append("disconnect-start")
                await Task.yield()
                await recorder.append("disconnect-finished")
            },
            resetStore: {
                await recorder.append("reset")
            },
            clearLicense: {}
        )

        #expect(
            await recorder.events == ["disconnect-start", "disconnect-finished", "reset"]
        )
    }

    /// The license is a preference, and Full reset wipes preferences
    /// (docs/spec/license.md § Storage). It runs last: nothing above it depends
    /// on the license, and clearing it cannot fail.
    @Test("the stored license is wiped, after the vault")
    func clearsTheLicense() async {
        final class Trail: @unchecked Sendable {
            var events: [String] = []
        }

        let trail = Trail()
        await performFullReset(
            disconnectSync: { trail.events.append("disconnect") },
            resetStore: { trail.events.append("reset") },
            clearLicense: { trail.events.append("license") }
        )

        #expect(trail.events == ["disconnect", "reset", "license"])
    }
}
