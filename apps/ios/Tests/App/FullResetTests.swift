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
            }
        )

        #expect(
            await recorder.events == ["disconnect-start", "disconnect-finished", "reset"]
        )
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
                }
            )
            Issue.record("reset failure was swallowed")
        } catch {
            #expect(error is ResetFailure)
        }
        #expect(events == ["closed", "disconnected", "reset"])
    }

}
