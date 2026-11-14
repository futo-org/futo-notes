import Foundation
import Testing

@testable import FutoNotesNative

@Suite @MainActor
struct BackgroundEditorFlushTests {
    @Test func waitsBeforeWritingAndKeepsBackgroundTimeUntilDurable() async {
        var events: [String] = []
        let flush = BackgroundEditorFlush(
            background: BackgroundTaskProvider(
                begin: { _, _ in
                    events.append("begin")
                    return 1
                },
                end: { _ in events.append("end") }
            ))
        flush.register(token: 1) { events.append("mailbox") }
        flush.run { events.append("durable") }
        while events.last != "end" { await Task.yield() }
        #expect(events == ["begin", "mailbox", "durable", "end"])
    }
    @Test func expiryEndsBackgroundTimeExactlyOnceAndStillFlushesKnownDraft() async {
        var expiry: (() -> Void)?
        var ends = 0
        var wrote = false
        let flush = BackgroundEditorFlush(
            background: BackgroundTaskProvider(
                begin: { _, expired in
                    expiry = expired
                    return 1
                },
                end: { _ in ends += 1 }
            ))
        flush.register(token: 1) {
            // Stand in for a checkpoint that remains pending until cancellation.
            try? await Task.sleep(for: .seconds(60))
        }
        flush.run { wrote = true }
        await Task.yield()
        expiry?()
        #expect(ends == 1)
        while !wrote { await Task.yield() }
        await Task.yield()
        #expect(ends == 1)
    }

}
