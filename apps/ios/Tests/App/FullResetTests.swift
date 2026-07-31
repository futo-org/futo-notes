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
            }
        )

        #expect(
            await recorder.events == ["disconnect-start", "disconnect-finished", "reset"]
        )
    }
}
