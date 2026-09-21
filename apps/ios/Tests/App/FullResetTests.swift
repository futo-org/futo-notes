import Testing

@testable import FutoNotesNative

@MainActor
@Suite("Full reset")
struct FullResetTests {
    @Test("disconnect completes before the vault is wiped")
    func disconnectsBeforeReset() async throws {
        actor Recorder {
            private(set) var events: [String] = []

            func append(_ event: String) {
                events.append(event)
            }
        }

        let recorder = Recorder()
        try await performFullReset(
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
    func clearsTheLicense() async throws {
        final class Trail: @unchecked Sendable {
            var events: [String] = []
        }

        let trail = Trail()
        try await performFullReset(
            disconnectSync: { trail.events.append("disconnect") },
            resetStore: { trail.events.append("reset") },
            clearLicense: { trail.events.append("license") }
        )

        #expect(trail.events == ["disconnect", "reset", "license"])
    }

    @Test("admission closes before disconnect and reset failures propagate")
    func closesAdmissionAndReportsFailure() async {
        enum ResetFailure: Error { case disk }
        var events: [String] = []
        do {
            try await performFullReset(
                beginStoreReset: { events.append("closed") },
                disconnectSync: { events.append("disconnected") },
                resetStore: {
                    events.append("reset")
                    throw ResetFailure.disk
                },
                clearLicense: { events.append("license") }
            )
            Issue.record("reset failure was swallowed")
        } catch {
            #expect(error is ResetFailure)
        }
        // No "license": a reset that failed did not wipe preferences either.
        #expect(events == ["closed", "disconnected", "reset"])
    }
}
