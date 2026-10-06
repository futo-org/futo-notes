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
            _ = await awaitEditorSignal(deadline: 60) { _ in }
        }
        flush.run { wrote = true }
        await Task.yield()
        expiry?()
        #expect(ends == 1)
        while !wrote { await Task.yield() }
        await Task.yield()
        #expect(ends == 1)
    }
    @Test func behindFlushWaitPublishesLatestBeforeRegisterWrite() async {
        let mailbox = EditorMailbox()
        mailbox.loaded("note", generation: 1, content: "base")
        mailbox.edited("note", generation: 2)
        var draft: String?
        var wrote: String?
        var flushes = 0
        mailbox.bind(1, id: "note") { draft = $0 }
        let background = BackgroundEditorFlush(
            background: BackgroundTaskProvider(begin: { _, _ in 1 }, end: { _ in }))
        background.register(token: 1) {
            _ = await mailbox.awaitCurrent("note") { _ in
                flushes += 1
                mailbox.change("note", generation: 2, content: "base + latest")
            }
        }
        background.run { wrote = draft }
        while wrote == nil { await Task.yield() }
        #expect(flushes == 1)
        #expect(wrote == "base + latest")
    }

}
